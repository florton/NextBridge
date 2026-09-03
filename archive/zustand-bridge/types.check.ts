/**
 * Compile-time contract for the typed-signal boundary. Never runs; every
 * `@ts-expect-error` must stay an error or `tsc` fails.
 *
 * Note: a reducer that violates the contract breaks reverse-inference for the
 * whole object literal (every payload collapses to `unknown`), so negative
 * reducer cases live in their own `defineBridge` call, away from `bridge`.
 */
import { createStore } from 'zustand/vanilla';
import { defineBridge, type Signal } from './core';
import { withBridge } from './react';

interface S {
  user: { name: string; plan: 'free' | 'pro' };
  cart: { items: string[] };
}

const initialState: S = { user: { name: 'Ada', plan: 'free' }, cart: { items: [] } };

const bridge = defineBridge(initialState, {
  'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
  'cart/clear': (_: void, s) => ({ cart: { ...s.cart, items: [] } }),
});

// ---- reducers must return a patch of S (isolated: see note above)
defineBridge(initialState, {
  // @ts-expect-error — 'nope' is not a key of S
  'bad/shape': (_: void, s) => ({ nope: true }),
});

// ---- a patched slice must still match its own shape
defineBridge(initialState, {
  // @ts-expect-error — user.plan must be 'free' | 'pro'
  'bad/slice': (_: void, s) => ({ user: { ...s.user, plan: 'enterprise' } }),
});

// ---- state is contextually typed inside reducers (no annotation needed)
defineBridge(initialState, {
  'ok/typed': (_: void, s) => ({ user: { ...s.user, name: s.user.name.trim() } }),
});

// ---- send: exact key, payload, and arity
const sig = bridge.send('user/rename', { name: 'Grace' });
const _sig: Signal<'user/rename', { name: string }> = sig;
const _payload: { name: string } = sig.payload;
bridge.send('cart/clear'); // void payload → no second arg

// @ts-expect-error — unknown signal type
bridge.send('user/destroy', {});
// @ts-expect-error — wrong payload shape
bridge.send('user/rename', { nom: 'Grace' });
// @ts-expect-error — payload is required for this signal
bridge.send('user/rename');

// ---- the RECEIVE site is typed too: the store only accepts this bridge's
// signals, so a hand-rolled or foreign signal can't reach a reducer.
const store = withBridge(createStore<S>(() => initialState), bridge);

store.ingest(bridge.send('cart/clear'));
store.ingest([bridge.send('user/rename', { name: 'Grace' })]);
store.ingest(null);

// @ts-expect-error — type isn't in this bridge's contract
store.ingest({ id: '1', type: 'ghost/nope', payload: null });
// @ts-expect-error — payload doesn't match this signal type
store.ingest({ id: '1', type: 'user/rename', payload: { nom: 'Grace' } });

// execute: takes a thunk, and the action's declared signal must belong to
// this bridge
async function _exec() {
  const ok = await store.execute(() =>
    Promise.resolve({ ok: true as const, orderId: 'x', signal: bridge.send('cart/clear') }),
  );
  const _orderId: string = ok.orderId;

  await store.execute(() => Promise.resolve({ ok: true as const, signal: null }), {
    optimistic: bridge.send('user/rename', { name: 'Grace' }),
    key: 'user:1',
    order: 'queue',
    timeoutMs: 5_000,
  });

  await store.execute(
    // @ts-expect-error — signal is not part of this bridge's contract
    () => Promise.resolve({ ok: true as const, signal: { id: '1', type: 'ghost/x', payload: 1 } }),
  );

  await store.execute(() => Promise.resolve({ ok: true as const, signal: null }), {
    // @ts-expect-error — optimistic signal must belong to this bridge
    optimistic: { id: '1', type: 'ghost/x', payload: 1 },
  });

  await store.execute(() => Promise.resolve({ ok: true as const, signal: null }), {
    // @ts-expect-error — unknown ordering policy
    order: 'whenever',
  });

  // @ts-expect-error — execute takes a thunk, not an already-hot promise
  await store.execute(Promise.resolve({ ok: true as const, signal: null }));

  // ---- `ok` is required exactly when `optimistic` is in play ---------------

  // Without optimistic there's nothing to roll back, so `ok` is optional.
  const plain = await store.execute(() => Promise.resolve({ orderId: 'x', signal: null }));
  const _plainId: string = plain.orderId;

  // @ts-expect-error — optimistic requires `ok`; this reports failure as `success`
  await store.execute(() => Promise.resolve({ success: false, signal: null }), {
    optimistic: bridge.send('user/rename', { name: 'Grace' }),
  });

  // A discriminated result satisfies it, and stays narrowable afterwards.
  const settled = await store.execute(
    () =>
      Promise.resolve(
        Math.random() > 0.5
          ? { ok: true as const, error: null, signal: bridge.send('cart/clear') }
          : { ok: false as const, error: 'nope', signal: null },
      ),
    { optimistic: bridge.send('cart/clear'), key: 'cart:1' },
  );
  if (!settled.ok) {
    const _err: string = settled.error;
  }
}

export { _sig, _payload, _exec };
