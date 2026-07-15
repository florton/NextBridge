import { describe, expect, it, vi } from 'vitest';
import { createStore, slice, type AnySignal } from '../src/core';

const makeStore = () =>
  createStore({
    user: slice(
      { name: 'Ada', plan: 'free' as 'free' | 'pro' },
      {
        rename: (payload: { name: string }, state) => ({ ...state, name: payload.name }),
        setPlan: (payload: { plan: 'free' | 'pro' }, state) => ({ ...state, plan: payload.plan }),
        noop: (_: void, state) => state,
      },
    ),
    cart: slice(
      { items: [] as string[] },
      {
        add: (payload: { sku: string }, state) => ({ items: [...state.items, payload.sku] }),
        clear: (_: void, state) => ({ ...state, items: [] }),
      },
    ),
  });

/** A promise you can resolve/reject from the outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('actions and state', () => {
  it('updates state through bound actions and replaces the slice reference', () => {
    const store = makeStore();
    const before = store.get().user;
    store.actions.user.rename({ name: 'Grace' });
    expect(store.get().user.name).toBe('Grace');
    expect(store.get().user).not.toBe(before);
  });

  it('leaves untouched slices referentially identical', () => {
    const store = makeStore();
    const cartBefore = store.get().cart;
    store.actions.user.rename({ name: 'Grace' });
    expect(store.get().cart).toBe(cartBefore);
  });

  it('keeps store.initial frozen in time for SSR snapshots', () => {
    const store = makeStore();
    store.actions.user.rename({ name: 'Grace' });
    expect(store.initial.user.name).toBe('Ada');
  });

  it('exposes stable action references (safe for effect deps / memo)', () => {
    const store = makeStore();
    const ref = store.actions.cart.add;
    store.actions.cart.add({ sku: 'a' });
    expect(store.actions.cart.add).toBe(ref);
  });

  it('supports void-payload actions with no argument', () => {
    const store = makeStore();
    store.actions.cart.add({ sku: 'a' });
    store.actions.cart.clear();
    expect(store.get().cart.items).toEqual([]);
  });
});

describe('subscriptions', () => {
  it('notifies only listeners of the changed slice', () => {
    const store = makeStore();
    const userListener = vi.fn();
    const cartListener = vi.fn();
    store.subscribe('user', userListener);
    store.subscribe('cart', cartListener);

    store.actions.user.rename({ name: 'Grace' });
    expect(userListener).toHaveBeenCalledTimes(1);
    expect(cartListener).not.toHaveBeenCalled();
  });

  it('skips notification when a handler returns the same reference', () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe('user', listener);
    store.actions.user.noop();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsub = store.subscribe('user', listener);
    unsub();
    store.actions.user.rename({ name: 'Grace' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('signals', () => {
  it('send() builds a typed, serializable signal with a unique id', () => {
    const store = makeStore();
    const a = store.send('user', 'rename', { name: 'Grace' });
    const b = store.send('user', 'rename', { name: 'Grace' });
    expect(a.type).toBe('user/rename');
    expect(a.payload).toEqual({ name: 'Grace' });
    expect(a.id).not.toBe(b.id);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('ingest() applies a signal once and drops replays of the same id', () => {
    const store = makeStore();
    const signal = store.send('cart', 'add', { sku: 'a' });
    store.ingest(signal); // first mount
    store.ingest(signal); // Strict Mode double-effect / re-mount
    expect(store.get().cart.items).toEqual(['a']);
  });

  it('ingest() handles arrays and null', () => {
    const store = makeStore();
    store.ingest(null);
    store.ingest([store.send('cart', 'add', { sku: 'a' }), store.send('cart', 'add', { sku: 'b' })]);
    expect(store.get().cart.items).toEqual(['a', 'b']);
  });

  it('dispatch() warns (dev) and does nothing for unknown types', () => {
    const store = makeStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.dispatch({ id: 'x', type: 'nope/nothing', payload: null } as AnySignal);
    expect(warn).toHaveBeenCalledOnce();
    expect(store.get()).toEqual(store.initial);
    warn.mockRestore();
  });
});

describe('execute', () => {
  it('applies the result signal and returns the fully typed result', async () => {
    const store = makeStore();
    const result = await store.execute(
      Promise.resolve({ ok: true as const, orderId: 'ord_1', signal: store.send('cart', 'clear') }),
    );
    expect(result.orderId).toBe('ord_1');
  });

  it('drops a stale response that resolves after a newer one (network race)', async () => {
    const store = makeStore();
    const slow = deferred<{ signal: AnySignal }>();
    const fast = deferred<{ signal: AnySignal }>();

    const first = store.execute(slow.promise); // op 1 — will resolve LAST
    const second = store.execute(fast.promise); // op 2 — resolves first

    fast.resolve({ signal: store.send('user', 'rename', { name: 'NEW' }) });
    await second;
    slow.resolve({ signal: store.send('user', 'rename', { name: 'STALE' }) });
    await first;

    expect(store.get().user.name).toBe('NEW');
  });

  it('applies an optimistic signal immediately', () => {
    const store = makeStore();
    const pending = deferred<{ ok: true }>();
    void store.execute(pending.promise, {
      optimistic: store.send('user', 'rename', { name: 'Optimistic' }),
    });
    expect(store.get().user.name).toBe('Optimistic');
    pending.resolve({ ok: true });
  });

  it('rolls back the optimistic signal when the promise rejects, then rethrows', async () => {
    const store = makeStore();
    const pending = deferred<{ ok: true }>();
    const listener = vi.fn();
    store.subscribe('user', listener);

    const op = store.execute(pending.promise, {
      optimistic: store.send('user', 'rename', { name: 'Optimistic' }),
    });
    expect(store.get().user.name).toBe('Optimistic');

    pending.reject(new Error('boom'));
    await expect(op).rejects.toThrow('boom');
    expect(store.get().user.name).toBe('Ada');
    expect(listener).toHaveBeenCalledTimes(2); // optimistic apply + rollback
  });

  it('rolls back when the server answers ok: false (no throw)', async () => {
    const store = makeStore();
    const result = await store.execute(
      Promise.resolve({ ok: false as const, error: 'Name required', signal: null }),
      { optimistic: store.send('user', 'rename', { name: 'Optimistic' }) },
    );
    expect(result.error).toBe('Name required');
    expect(store.get().user.name).toBe('Ada');
  });
});
