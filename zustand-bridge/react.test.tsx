// @vitest-environment jsdom
/**
 * Covers the React surface: SSR, hydration, StrictMode, and <BridgeSignal>.
 * These exercise the demo's own Providers, so the documented wiring is what's
 * under test — not a bespoke rig that only exists here.
 */
import { StrictMode, useEffect } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { devtools, persist } from 'zustand/middleware';
import { BridgeSignal, attachBridge } from './react';
import { appBridge, type AppState } from './demo/bridge';
import { Providers, useApp } from './demo/provider';

afterEach(cleanup);

const Plan = () => <span data-testid="plan">{useApp((s) => s.user.plan)}</span>;
const Cart = () => <span data-testid="cart">{useApp((s) => s.cart.items).join(',')}</span>;
const Notice = () => <span data-testid="notice">{useApp((s) => s.notice.text) ?? '-'}</span>;

describe('SSR', () => {
  it('renders seeded server state into the HTML, correct on the first byte', () => {
    const html = renderToString(
      <Providers initialState={{ user: { name: 'Ada', plan: 'pro' } }}>
        <Plan />
      </Providers>,
    );
    expect(html).toContain('pro');
  });

  it('does NOT apply signals during SSR — the reason they are wrong for initial data', () => {
    const html = renderToString(
      <Providers>
        <BridgeSignal signal={appBridge.send('user/setPlan', { plan: 'pro' })} />
        <Plan />
      </Providers>,
    );
    // Documents the hazard: the server knows 'pro', but ships 'free' because a
    // signal can only land after hydration. Seed instead — see the SSR test above.
    expect(html).toContain('free');
    expect(html).not.toContain('pro');
  });
});

describe('hydration', () => {
  it('hydrates seeded state without a mismatch, then applies signals', async () => {
    const initialState = { user: { name: 'Ada', plan: 'pro' as const } };
    const tree = (
      <Providers initialState={initialState}>
        <Plan />
        <BridgeSignal signal={appBridge.send('notice/show', { text: 'Paid' })} />
        <Notice />
      </Providers>
    );

    const container = document.createElement('div');
    container.innerHTML = renderToString(tree);
    document.body.appendChild(container);

    // The seed is in the server markup; the signal hasn't run yet.
    expect(container.textContent).toContain('pro');
    expect(container.textContent).toContain('-');

    // React reports hydration mismatches through console.error.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));

    const root = await act(async () => hydrateRoot(container, tree));

    expect(errors).toEqual([]); // no mismatch: seeding is hydration-safe
    expect(container.textContent).toContain('pro'); // seed survived
    // Effects only run once hydration completes, so this also proves hydration
    // actually happened — without it the assertions above could pass vacuously
    // against the untouched server markup.
    expect(container.textContent).toContain('Paid');

    spy.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  });
});

describe('<BridgeSignal>', () => {
  it('applies a server signal once mounted', () => {
    render(
      <Providers>
        <BridgeSignal signal={appBridge.send('notice/show', { text: 'Payment received' })} />
        <Notice />
      </Providers>,
    );
    expect(screen.getByTestId('notice').textContent).toBe('Payment received');
  });

  it('applies an array of signals', () => {
    render(
      <Providers>
        <BridgeSignal
          signal={[appBridge.send('cart/add', { sku: 'a' }), appBridge.send('cart/add', { sku: 'b' })]}
        />
        <Cart />
      </Providers>,
    );
    expect(screen.getByTestId('cart').textContent).toBe('a,b');
  });

  it('accepts a null signal', () => {
    render(
      <Providers>
        <BridgeSignal signal={null} />
        <Cart />
      </Providers>,
    );
    expect(screen.getByTestId('cart').textContent).toBe('');
  });

  it('warns and drops the signal when rendered outside a provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<BridgeSignal signal={appBridge.send('cart/add', { sku: 'a' })} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside <BridgeProvider>'));
    warn.mockRestore();
  });

  it('does not re-apply when the parent re-renders with an equivalent signal', () => {
    const signal = appBridge.send('cart/add', { sku: 'a' });
    const view = (
      <Providers>
        <BridgeSignal signal={signal} />
        <Cart />
      </Providers>
    );
    const { rerender } = render(view);
    rerender(view);
    rerender(view);
    expect(screen.getByTestId('cart').textContent).toBe('a');
  });
});

describe('attachBridge', () => {
  it('leaves the caller store untouched and keeps its middleware API', () => {
    const plain = createStore<AppState>()(
      persist(() => appBridge.initialState, { name: 'zb-attach-test' }),
    );
    const bridged = attachBridge(plain, appBridge);

    // A new object — the input is not mutated into something its type denies.
    expect(bridged).not.toBe(plain);
    expect('execute' in plain).toBe(false);

    // Whatever the middleware added still works, and is still typed (this line
    // wouldn't compile if the return type erased `persist`).
    expect(typeof bridged.persist.rehydrate).toBe('function');

    // Both objects are views onto the same underlying state.
    bridged.ingest(appBridge.send('cart/add', { sku: 'a' }));
    expect(plain.getState().cart.items).toEqual(['a']);
    expect(bridged.getState().cart.items).toEqual(['a']);
  });

  it('gives each attach an independent channel rather than clobbering the last', () => {
    const plain = createStore<AppState>(() => appBridge.initialState);
    const first = attachBridge(plain, appBridge);
    const second = attachBridge(plain, appBridge);

    expect(first.ingest).not.toBe(second.ingest);

    // Replay guards are per-attach, so the same signal id applies once per
    // channel — the second attach hasn't silently taken over the first.
    const signal = appBridge.send('cart/add', { sku: 'a' });
    first.ingest(signal);
    first.ingest(signal); // deduped within its own channel
    expect(plain.getState().cart.items).toEqual(['a']);
  });
});

describe('devtools labels', () => {
  /** Stands in for the Redux DevTools browser extension. */
  function mockExtension() {
    const actions: string[] = [];
    const connection = {
      init: vi.fn(),
      send: (action: { type: string }) => void actions.push(action.type),
      subscribe: vi.fn(() => () => {}),
      unsubscribe: vi.fn(),
    };
    (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__ = {
      connect: () => connection,
    };
    return {
      actions,
      restore: () =>
        delete (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__,
    };
  }

  it('names every server-driven update, instead of anonymous setState entries', async () => {
    const { actions, restore } = mockExtension();
    const store = attachBridge(
      createStore<AppState>()(devtools(() => appBridge.initialState)),
      appBridge,
    );

    store.ingest(appBridge.send('cart/add', { sku: 'a' }));
    await store.execute(
      () => Promise.resolve({ ok: false as const, signal: null }),
      { optimistic: appBridge.send('user/rename', { name: 'Optimistic' }) },
    );

    // A signal, an optimistic patch, and its rollback are each legible in the
    // timeline rather than three mystery writes.
    expect(actions).toEqual([
      'cart/add',
      'user/rename (optimistic)',
      'user/rename (rollback)',
    ]);

    restore();
  });
});

describe('StrictMode', () => {
  it('applies an accumulative signal exactly once despite double-invoked effects', () => {
    let effectRuns = 0;
    const Probe = () => {
      useEffect(() => {
        effectRuns += 1;
      }, []);
      return null;
    };

    render(
      <StrictMode>
        <Providers>
          <Probe />
          <BridgeSignal signal={appBridge.send('cart/add', { sku: 'a' })} />
          <Cart />
        </Providers>
      </StrictMode>,
    );

    // Guards against a vacuous pass: if StrictMode weren't double-invoking
    // effects in this environment, the assertion below would prove nothing.
    expect(effectRuns).toBe(2);

    // StrictMode mounts, unmounts, then remounts effects in dev, so the signal
    // is delivered twice. Without the id replay guard this reads 'a,a'.
    expect(screen.getByTestId('cart').textContent).toBe('a');
  });
});
