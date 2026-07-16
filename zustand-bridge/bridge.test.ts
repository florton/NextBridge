import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { defineBridge, type Signal } from './core';
import { withBridge } from './react';

interface S {
  user: { name: string };
  cart: { items: string[] };
}

const initialState: S = { user: { name: 'Ada' }, cart: { items: [] } };

const bridge = defineBridge(initialState, {
  'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
  'cart/add': (p: { sku: string }, s) => ({ cart: { items: [...s.cart.items, p.sku] } }),
  'cart/clear': (_: void, s) => ({ cart: { ...s.cart, items: [] } }),
});

const make = () =>
  withBridge(
    createStore<S>(() => ({ user: { name: 'Ada' }, cart: { items: [] } })),
    bridge,
  );

/** Lets every pending microtask (promise chain link) run before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('send', () => {
  it('builds a serializable signal with a unique id', () => {
    const a = bridge.send('user/rename', { name: 'Grace' });
    const b = bridge.send('user/rename', { name: 'Grace' });
    expect(a.type).toBe('user/rename');
    expect(a.payload).toEqual({ name: 'Grace' });
    expect(a.id).not.toBe(b.id);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('omits payload for void-payload signals', () => {
    expect(bridge.send('cart/clear').payload).toBeUndefined();
  });
});

describe('ingest', () => {
  it('applies a signal once and drops replays of the same id', () => {
    const store = make();
    const sig = bridge.send('cart/add', { sku: 'a' });
    store.ingest(sig);
    store.ingest(sig); // Strict Mode double-effect / re-mount
    expect(store.getState().cart.items).toEqual(['a']);
  });

  it('handles arrays and null, and warns on unknown types', () => {
    const store = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.ingest(null);
    store.ingest([bridge.send('cart/add', { sku: 'a' }), bridge.send('cart/add', { sku: 'b' })]);
    // `as never` deliberately escapes the type system: signals cross a network
    // boundary, so a stale client can still receive a type that no longer has
    // a reducer. That must warn, not throw.
    store.ingest({ id: 'x', type: 'ghost/nope', payload: null } as never);
    expect(store.getState().cart.items).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('zustand interop', () => {
  it('leaves normal selectors/subscribe working and isolates untouched slices', () => {
    const store = make();
    const cartBefore = store.getState().cart;
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.ingest(bridge.send('user/rename', { name: 'Grace' }));
    expect(store.getState().user.name).toBe('Grace');
    expect(store.getState().cart).toBe(cartBefore); // reducer didn't touch cart
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });
});

type RenameResult = { signal: Signal<'user/rename', { name: string }> };

describe('execute', () => {
  it('applies the result signal and returns the typed result', async () => {
    const store = make();
    const result = await store.execute(() =>
      Promise.resolve({ ok: true as const, orderId: 'x', signal: bridge.send('cart/clear') }),
    );
    expect(result.orderId).toBe('x');
  });

  it('applies optimistic immediately and rolls back on reject', async () => {
    const store = make();
    const pending = deferred<{ ok: true }>();
    const op = store.execute(() => pending.promise, {
      optimistic: bridge.send('user/rename', { name: 'Optimistic' }),
    });
    expect(store.getState().user.name).toBe('Optimistic');
    pending.reject(new Error('boom'));
    await expect(op).rejects.toThrow('boom');
    expect(store.getState().user.name).toBe('Ada');
  });

  it('rolls back only the keys the optimistic signal touched', async () => {
    const store = make();
    const pending = deferred<{ ok: true }>();
    const op = store.execute(() => pending.promise, {
      optimistic: bridge.send('user/rename', { name: 'Optimistic' }),
    });

    // An unrelated write lands while the action is still in flight.
    store.ingest(bridge.send('cart/add', { sku: 'a' }));

    pending.reject(new Error('boom'));
    await expect(op).rejects.toThrow('boom');

    expect(store.getState().user.name).toBe('Ada'); // reverted
    expect(store.getState().cart.items).toEqual(['a']); // preserved, not clobbered
  });

  it('warns instead of silently keeping the patch when an optimistic result omits ok', async () => {
    const store = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Types require `ok` here; `as never` stands in for a JS caller or an
    // `any` that slipped past them.
    await store.execute(() => Promise.resolve({ success: false, signal: null }) as never, {
      optimistic: bridge.send('user/rename', { name: 'Optimistic' }),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without an `ok` field'));
    warn.mockRestore();
  });

  it('does not warn about ok when there is no optimistic patch', async () => {
    const store = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.execute(() => Promise.resolve({ orderId: 'x', signal: null }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rolls back on ok:false without throwing', async () => {
    const store = make();
    const result = await store.execute(
      () => Promise.resolve({ ok: false as const, error: 'nope', signal: null }),
      { optimistic: bridge.send('user/rename', { name: 'Optimistic' }) },
    );
    expect(result.error).toBe('nope');
    expect(store.getState().user.name).toBe('Ada');
  });

  it('still applies the signal a failed action returns, after rolling back', async () => {
    const store = make();
    const result = await store.execute(
      // A failure that carries a signal — an error notice, or the server's
      // authoritative value. `cart/add` stands in for it here.
      () => Promise.resolve({ ok: false as const, signal: bridge.send('cart/add', { sku: 'x' }) }),
      { optimistic: bridge.send('user/rename', { name: 'Optimistic' }) },
    );

    expect(result.ok).toBe(false);
    expect(store.getState().user.name).toBe('Ada'); // optimistic undone
    expect(store.getState().cart.items).toEqual(['x']); // failure signal still delivered
  });
});

describe('execute · optimistic defaults', () => {
  type RenameOk = { ok: true; signal: Signal<'user/rename', { name: string }> };

  it('orders optimistic mutations by default, keyed by the signal type', async () => {
    const store = make();
    const a = deferred<RenameOk>();
    const b = deferred<RenameOk>();
    const sent: string[] = [];

    // Note: no `key`, no `order`. The naive call must still be protected —
    // an optimistic patch is exactly what a racing response would clobber.
    const first = store.execute(
      () => {
        sent.push('a');
        return a.promise;
      },
      { optimistic: bridge.send('user/rename', { name: 'A' }) },
    );
    const second = store.execute(
      () => {
        sent.push('b');
        return b.promise;
      },
      { optimistic: bridge.send('user/rename', { name: 'B' }) },
    );

    expect(sent).toEqual(['a']); // B waits, so the server can't see them out of order

    a.resolve({ ok: true, signal: bridge.send('user/rename', { name: 'A' }) });
    await first;
    await flush();
    expect(sent).toEqual(['a', 'b']);

    b.resolve({ ok: true, signal: bridge.send('user/rename', { name: 'B' }) });
    await second;
    expect(store.getState().user.name).toBe('B');
  });

  it('lets an explicit key parallelize unrelated resources', () => {
    const store = make();
    const sent: string[] = [];

    void store.execute(
      () => {
        sent.push('todo:1');
        return deferred<RenameOk>().promise;
      },
      { optimistic: bridge.send('user/rename', { name: 'A' }), key: 'todo:1' },
    );
    void store.execute(
      () => {
        sent.push('todo:2');
        return deferred<RenameOk>().promise;
      },
      { optimistic: bridge.send('user/rename', { name: 'B' }), key: 'todo:2' },
    );

    // Same signal type, different resources — the type-keyed default would
    // have serialized these needlessly.
    expect(sent).toEqual(['todo:1', 'todo:2']);
  });

  it('honours an explicit opt-out', () => {
    const store = make();
    const sent: string[] = [];
    const opts = { order: 'none' } as const;

    void store.execute(
      () => {
        sent.push('a');
        return deferred<RenameOk>().promise;
      },
      { ...opts, optimistic: bridge.send('user/rename', { name: 'A' }) },
    );
    void store.execute(
      () => {
        sent.push('b');
        return deferred<RenameOk>().promise;
      },
      { ...opts, optimistic: bridge.send('user/rename', { name: 'B' }) },
    );

    expect(sent).toEqual(['a', 'b']);
  });
});

describe('execute · order: queue', () => {
  it("doesn't send the next request until the previous one settles", async () => {
    const store = make();
    const a = deferred<RenameResult>();
    const b = deferred<RenameResult>();
    const sent: string[] = [];

    const first = store.execute(
      () => {
        sent.push('a');
        return a.promise;
      },
      { key: 'user' },
    );
    const second = store.execute(
      () => {
        sent.push('b');
        return b.promise;
      },
      { key: 'user' },
    );

    // B's request has not been sent yet — that's the whole point: the server
    // never sees the two writes concurrently.
    expect(sent).toEqual(['a']);

    a.resolve({ signal: bridge.send('user/rename', { name: 'A' }) });
    await first;
    await flush(); // B starts on the microtask after A's chain link settles
    expect(sent).toEqual(['a', 'b']);

    b.resolve({ signal: bridge.send('user/rename', { name: 'B' }) });
    await second;

    // B started last, so B wins — on the client and on the server.
    expect(store.getState().user.name).toBe('B');
  });

  it('keeps the chain moving when an earlier op rejects', async () => {
    const store = make();
    const a = deferred<RenameResult>();
    const b = deferred<RenameResult>();

    const first = store.execute(() => a.promise, { key: 'user' });
    const second = store.execute(() => b.promise, { key: 'user' });

    a.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');

    b.resolve({ signal: bridge.send('user/rename', { name: 'B' }) });
    await second;
    expect(store.getState().user.name).toBe('B');
  });

  it('releases the queue when an op times out, and ignores its late result', async () => {
    vi.useFakeTimers();
    try {
      const store = make();
      const hung = deferred<RenameResult>();
      const b = deferred<RenameResult>();

      const first = store.execute(() => hung.promise, { key: 'user', timeoutMs: 1000 });
      const timedOut = expect(first).rejects.toThrow(/exceeded 1000ms/);
      const second = store.execute(() => b.promise, { key: 'user' });

      await vi.advanceTimersByTimeAsync(1000);
      await timedOut;

      // The hung op no longer wedges the key.
      b.resolve({ signal: bridge.send('user/rename', { name: 'B' }) });
      await second;
      expect(store.getState().user.name).toBe('B');

      // The abandoned request eventually answers — it must not apply.
      hung.resolve({ signal: bridge.send('user/rename', { name: 'LATE' }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().user.name).toBe('B');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs different keys in parallel', async () => {
    const store = make();
    const sent: string[] = [];

    void store.execute(
      () => {
        sent.push('user');
        return deferred<RenameResult>().promise;
      },
      { key: 'user' },
    );
    void store.execute(
      () => {
        sent.push('cart');
        return deferred<RenameResult>().promise;
      },
      { key: 'cart' },
    );

    expect(sent).toEqual(['user', 'cart']); // no cross-key blocking
  });
});

describe('execute · order: last-wins', () => {
  it('drops a stale response that resolves after a newer one on the same key', async () => {
    const store = make();
    const slow = deferred<RenameResult>();
    const fast = deferred<RenameResult>();
    const opts = { key: 'user', order: 'last-wins' } as const;

    const first = store.execute(() => slow.promise, opts); // op 1, resolves last
    const second = store.execute(() => fast.promise, opts); // op 2, resolves first

    fast.resolve({ signal: bridge.send('user/rename', { name: 'NEW' }) });
    await second;
    slow.resolve({ signal: bridge.send('user/rename', { name: 'STALE' }) });
    await first;

    expect(store.getState().user.name).toBe('NEW');
  });

  it('forgets a key once nothing is racing on it, so the watermark map drains', async () => {
    const store = make();
    const opts = { key: 'user', order: 'last-wins' } as const;

    await store.execute(
      () => Promise.resolve({ signal: bridge.send('user/rename', { name: 'A' }) }),
      opts,
    );
    await flush();

    // With the bookkeeping dropped, a later op on the same key must still
    // apply — `opSeq` only ever increases, so it outranks anything settled.
    // (If the watermark leaked instead of draining, this still passes; the
    // point is that draining doesn't break correctness.)
    await store.execute(
      () => Promise.resolve({ signal: bridge.send('user/rename', { name: 'B' }) }),
      opts,
    );
    expect(store.getState().user.name).toBe('B');

    // And a genuine race on that key is still caught after a drain.
    const slow = deferred<RenameResult>();
    const fast = deferred<RenameResult>();
    const first = store.execute(() => slow.promise, opts);
    const second = store.execute(() => fast.promise, opts);
    fast.resolve({ signal: bridge.send('user/rename', { name: 'NEW' }) });
    await second;
    slow.resolve({ signal: bridge.send('user/rename', { name: 'STALE' }) });
    await first;
    expect(store.getState().user.name).toBe('NEW');
  });

  it('never drops across different keys (unrelated resources stay independent)', async () => {
    const store = make();
    const slow = deferred<{ signal: Signal<'cart/add', { sku: string }> }>();
    const fast = deferred<RenameResult>();

    const first = store.execute(() => slow.promise, { key: 'cart:1', order: 'last-wins' });
    const second = store.execute(() => fast.promise, { key: 'user:1', order: 'last-wins' });

    fast.resolve({ signal: bridge.send('user/rename', { name: 'NEW' }) });
    await second;
    slow.resolve({ signal: bridge.send('cart/add', { sku: 'a' }) });
    await first;

    // The older op targets a different resource, so it must still apply.
    expect(store.getState().user.name).toBe('NEW');
    expect(store.getState().cart.items).toEqual(['a']);
  });
});
