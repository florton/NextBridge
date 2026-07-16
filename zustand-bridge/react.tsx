'use client';

/**
 * zustand-bridge · client
 *
 * Augments an ordinary Zustand store with the boundary layer. You keep
 * Zustand's store, selectors, middleware, devtools, and per-request store
 * factory exactly as-is — this only adds the server→client channel.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { StoreApi } from 'zustand';
import { devWarn, type AnySignal, type Bridge, type Reducer, type SignalOf } from './core';

/** Shape a Server Action result needs for `execute` to apply its signal. */
export type ExecResult<P> = {
  ok?: boolean;
  signal?: SignalOf<P> | SignalOf<P>[] | null;
};

/**
 * The result shape required once an optimistic patch is in play: `ok` becomes
 * mandatory, because the library has to be told whether to keep the patch or
 * undo it. Without this, an action that reports failure its own way — say
 * `{ success: false }` — would leave a failed optimistic update on screen with
 * no error and no warning.
 *
 * A thrown error still rolls back regardless; `ok` is for actions that return
 * their failures instead of throwing (the common Next.js style).
 */
export type FallibleResult<P> = ExecResult<P> & { ok: boolean };

/**
 * How operations sharing a `key` relate in time.
 *
 * - `queue` — run one at a time, in call order. The next request isn't sent
 *   until the previous one settles, so no race can occur on the client *or*
 *   the server. Costs serialized latency for that key.
 * - `last-wins` — send in parallel, but apply only the newest response; older
 *   ones are discarded. Right for type-ahead/search, where serializing would
 *   be slow and stale results are worthless.
 * - `none` — send in parallel, apply every response as it lands.
 */
export type Order = 'queue' | 'last-wins' | 'none';

interface OrderingOptions {
  /**
   * Ordering scope — usually a resource identity like `todo:${id}`. Ops with
   * the same key are ordered against each other; different keys never
   * interfere. Without a key there is no ordering relationship at all.
   */
  key?: string;
  /** Defaults to `queue` when `key` is set, otherwise `none`. */
  order?: Order;
  /**
   * Queued ops only: how long this op may hold its key's queue before the
   * slot is released so the next op can run. Guards against one hung request
   * wedging every later mutation to that resource. Default 30s; `Infinity`
   * disables. The in-flight request cannot actually be cancelled — on timeout
   * we stop waiting, roll back, and ignore whatever it eventually returns.
   */
  timeoutMs?: number;
}

/** Options for a plain execute. Optimistic updates use the overload below. */
export interface ExecuteOptions extends OrderingOptions {
  optimistic?: never;
}

/** Options that opt into an optimistic patch — and so require `ok`. */
export interface OptimisticExecuteOptions<P> extends OrderingOptions {
  /** Applied immediately (even while queued); undone on failure. */
  optimistic: SignalOf<P>;
}

/** Rejects a queued op that outlived its `timeoutMs` and released the queue. */
export class BridgeTimeoutError extends Error {
  constructor(ms: number, key: string) {
    super(`Action for key "${key}" exceeded ${ms}ms; released the queue.`);
    this.name = 'BridgeTimeoutError';
  }
}

/**
 * The server→client channel, typed against one bridge's contract `P`. Only
 * signals that contract can produce are accepted, so a typo'd type, a
 * mismatched payload, or a signal from another bridge fails `tsc` here — not
 * at runtime.
 */
export interface BridgeApi<P> {
  /** Apply signal(s) once each; ids already seen are skipped (replay guard). */
  ingest(signal: SignalOf<P> | SignalOf<P>[] | null | undefined): void;
  /**
   * Run a Server Action and apply the signal(s) on its result.
   *
   * Takes a *function*, not a promise: a promise is already in flight by the
   * time it's passed, so the library could never decide when it runs. Owning
   * the call is what makes `queue` possible.
   *
   *   store.execute(() => saveTodo(id, text), { key: `todo:${id}` })
   */
  execute<R extends ExecResult<P>>(action: () => Promise<R>, opts?: ExecuteOptions): Promise<R>;
  /**
   * With `optimistic`, the result must declare `ok` — the patch is kept when
   * it's true and undone when it's false, so the library can't be left
   * guessing whether a returned failure counts as one.
   *
   *   store.execute(() => saveName(draft), {
   *     optimistic: bridge.send('user/rename', { name: draft }),
   *     key: 'user:me',
   *   })
   */
  execute<R extends FallibleResult<P>>(
    action: () => Promise<R>,
    opts: OptimisticExecuteOptions<P>,
  ): Promise<R>;
}

/** A Zustand store with the bridge channel attached. */
export type BridgedStore<State, P> = StoreApi<State> & BridgeApi<P>;

const SEEN_LIMIT = 500;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

const toList = (s: AnySignal | AnySignal[] | null | undefined): AnySignal[] =>
  !s ? [] : Array.isArray(s) ? s : [s];

function withTimeout<T>(pending: Promise<T>, ms: number, key: string): Promise<T> {
  if (!Number.isFinite(ms)) return pending;
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeTimeoutError(ms, key)), ms);
  });
  return Promise.race([pending, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Wraps a Zustand store so it can receive server signals. Returns the same
 * store with `.ingest` and `.execute` added — pass it to `<BridgeProvider>`
 * and read it with Zustand's own `useStore(store, selector)`.
 */
export function attachBridge<State, P>(
  store: StoreApi<State>,
  bridge: Bridge<State, P>,
): BridgedStore<State, P> {
  const seen = new Set<string>();
  /** key → seq of the newest response applied, for `last-wins`. */
  const applied = new Map<string, number>();
  /** key → tail of that key's serialized chain, for `queue`. */
  const chains = new Map<string, Promise<void>>();
  let opSeq = 0;
  const reducers = bridge.reducers as Record<string, Reducer<State>>;

  function apply(sig: AnySignal): void {
    const reducer = reducers[sig.type];
    if (!reducer) {
      devWarn(`Unknown signal "${sig.type}" — no matching reducer. Ignored.`);
      return;
    }
    // Functional setState → reducer sees live state at execution time, so
    // rapid signals can't overwrite each other with stale reads.
    store.setState((state) => reducer(sig.payload, state));
  }

  /**
   * Applies `signal`, snapshotting only the keys its patch touches and
   * returning an undo for exactly those keys. Scoping matters: rolling back
   * the whole state tree would revert unrelated writes that landed while the
   * action was in flight. (Concurrent writes to the *same* keys are still
   * last-write-wins on rollback — keep optimistic signals scoped to state
   * they own.)
   */
  function applyWithUndo(sig: AnySignal): (() => void) | null {
    const reducer = reducers[sig.type];
    if (!reducer) {
      devWarn(`Unknown optimistic signal "${sig.type}" — no matching reducer. Ignored.`);
      return null;
    }
    const state = store.getState();
    const patch = reducer(sig.payload, state);
    const before: Partial<State> = {};
    for (const key of Object.keys(patch) as (keyof State)[]) {
      before[key] = state[key];
    }
    store.setState(patch);
    return () => store.setState(before);
  }

  function ingest(signal: SignalOf<P> | SignalOf<P>[] | null | undefined): void {
    for (const sig of toList(signal)) {
      if (sig.id) {
        if (seen.has(sig.id)) continue;
        seen.add(sig.id);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      }
      apply(sig);
    }
  }

  async function runOp<R extends ExecResult<P>>(
    action: () => Promise<R>,
    rollback: (() => void) | null,
    o: { key?: string; seq?: number; timeoutMs?: number },
  ): Promise<R> {
    let result: R;
    try {
      const pending = action();
      // If a timeout already released the queue, this promise still settles
      // later with nobody awaiting it — swallow so it can't surface as an
      // unhandled rejection.
      pending.catch(() => {});
      result =
        o.key && o.timeoutMs !== undefined
          ? await withTimeout(pending, o.timeoutMs, o.key)
          : await pending;
    } catch (error) {
      rollback?.();
      throw error;
    }

    // The types require `ok` alongside `optimistic`, but JS callers (or an
    // `any`) can still slip past. Say so rather than silently keeping a patch
    // that may represent a failed write.
    if (rollback && result && typeof result === 'object' && !('ok' in result)) {
      devWarn(
        'An optimistic execute resolved without an `ok` field, so the patch is being kept. ' +
          'Return `{ ok: false }` from the action to roll it back.',
      );
    }

    if (result?.ok === false) {
      rollback?.();
      return result;
    }

    // last-wins only: a newer response for this key already landed.
    if (o.key && o.seq !== undefined) {
      if (o.seq < (applied.get(o.key) ?? 0)) return result;
      applied.set(o.key, o.seq);
    }

    for (const sig of toList(result?.signal)) apply(sig);
    return result;
  }

  function execute<R extends ExecResult<P>>(
    action: () => Promise<R>,
    opts?: OrderingOptions & { optimistic?: SignalOf<P> },
  ): Promise<R> {
    // Optimistic applies now, not when the slot opens — a queued click still
    // gets instant feedback while its request waits its turn.
    const rollback = opts?.optimistic ? applyWithUndo(opts.optimistic) : null;

    const key = opts?.key;
    const order: Order = opts?.order ?? (key ? 'queue' : 'none');

    if (!key || order === 'none') return runOp(action, rollback, {});
    if (order === 'last-wins') return runOp(action, rollback, { key, seq: ++opSeq });

    // queue: start only once the previous op for this key has settled —
    // pass or fail, so one rejection can't strand everything behind it.
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    const start = () => runOp(action, rollback, { key, timeoutMs });
    const prev = chains.get(key);
    // Uncontended keys fire synchronously — chaining off a resolved promise
    // would defer the request by a microtask for no reason.
    const run = prev ? prev.then(start, start) : start();

    // The stored tail must never reject, or every later op inherits it.
    const tail = run.then(
      () => {},
      () => {},
    );
    chains.set(key, tail);
    // Once this op is the last one for its key, drop the entry so the map
    // tracks only in-flight work rather than growing forever.
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });

    return run;
  }

  // `execute` is written as one permissive signature; the public type is the
  // overload pair on BridgeApi, which is what enforces `ok` with `optimistic`.
  const api: BridgeApi<P> = { ingest, execute: execute as BridgeApi<P>['execute'] };
  return Object.assign(store, api);
}

// ---------------------------------------------------------------------------
// React glue: a context so <BridgeSignal> can reach the per-request store.
// ---------------------------------------------------------------------------

// The context is module-scoped, so it can't carry one bridge's `P`.
// `BridgeApi<any>` widens to accept any signal here; the type-checking that
// matters happens at `send()` (creation) and on the store's own typed
// `ingest`/`execute`.
const StoreContext = createContext<BridgeApi<any> | null>(null);

/**
 * Provides the bridged store to the tree. Create the store per request in a
 * client wrapper (see demo/provider.tsx) so nothing is shared across users —
 * the standard Zustand-in-Next pattern.
 */
export function BridgeProvider({
  store,
  children,
}: {
  store: BridgeApi<any>;
  children: ReactNode;
}) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/**
 * Delivers server-created signals into the client store from any Server
 * Component: `<BridgeSignal signal={bridge.send('user/setPlan', { plan })} />`.
 * Applies after hydration; each id applies at most once.
 */
export function BridgeSignal({ signal }: { signal: AnySignal | AnySignal[] | null }) {
  const store = useContext(StoreContext);
  const idKey = Array.isArray(signal) ? signal.map((s) => s.id).join('|') : (signal?.id ?? '');
  const ref = useRef(signal);
  ref.current = signal;

  useEffect(() => {
    if (!store) return devWarn('<BridgeSignal> outside <BridgeProvider> — signal dropped.');
    store.ingest(ref.current);
  }, [store, idKey]);

  return null;
}
