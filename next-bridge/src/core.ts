/**
 * next-bridge · core
 *
 * Safe to import anywhere: server components, server actions, client
 * components, plain Node tests. No React import, no Next.js import,
 * zero dependencies.
 *
 * The client-only pieces (provider, hooks, <BridgeSignal>) live in
 * `./client` behind a 'use client' boundary.
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * A serializable instruction that can cross the server → client boundary
 * (returned from a Server Action, or rendered into an RSC tree via
 * `<BridgeSignal>`). Contains only JSON data — never functions.
 */
export interface Signal<T extends string = string, P = unknown> {
  /** Unique id, used to drop replays (Strict Mode double-effects, re-mounts). */
  id: string;
  /** `"sliceName/actionName"` — routed to the matching handler. */
  type: T;
  payload: P;
}

export type AnySignal = Signal<string, any>;

// ---------------------------------------------------------------------------
// Slices
// ---------------------------------------------------------------------------

type Handler<S> = (payload: any, state: S) => S;

/** Handlers for a slice, derived from a payload map `P` (reverse-inferred). */
type Handlers<S, P> = { [A in keyof P]: (payload: P[A], state: S) => S };

export interface SliceDef<S, P> {
  state: S;
  handlers: Handlers<S, P>;
}

export type SliceConfig = Record<string, SliceDef<any, any>>;

/**
 * Defines one slice of the store. Exists purely for inference: TypeScript
 * reads the state type from the first argument and each payload type from
 * your annotation, then types `state` contextually — annotate payloads,
 * never state:
 *
 *   slice({ count: 0 }, {
 *     add: (payload: { by: number }, state) => ({ count: state.count + payload.by }),
 *   })
 *
 * Handlers are reducers: `(payload, state) => nextState`. They always receive
 * the state as of the moment they run (never a stale snapshot), and must
 * return a new object rather than mutating. Returning the same reference is
 * treated as "no change" and skips notification.
 */
export function slice<S, P>(state: S, handlers: Handlers<NoInfer<S>, P>): SliceDef<S, P> {
  return { state, handlers };
}

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

type PayloadOf<H, A extends keyof H> = H[A] extends (payload: infer P, state: any) => any
  ? P
  : never;

/** `[]` when the payload is void so the action can be called with no args. */
type PayloadArgs<P> = [P] extends [void | undefined] ? [] : [payload: P];

/** Bound, stable action creators derived from a slice's handlers. */
export type Actions<H> = {
  [A in keyof H]: (...args: PayloadArgs<PayloadOf<H, A>>) => void;
};

export type StateOf<C extends SliceConfig> = { [K in keyof C]: C[K]['state'] };

/** Minimum shape a Server Action result needs for `store.execute`. */
export interface ExecuteResult {
  /** `false` rolls back the optimistic signal (if any). Default: treated as ok. */
  ok?: boolean;
  /** Signal(s) to apply on the client after the action resolves. */
  signal?: AnySignal | AnySignal[] | null;
}

export interface Store<C extends SliceConfig> {
  /** Current state tree. Slice references are replaced on every update. */
  get(): StateOf<C>;
  /** State as of `createStore` — used as the SSR / hydration snapshot. */
  readonly initial: Readonly<StateOf<C>>;
  /**
   * Stable, typed action creators — usable inside or outside React:
   * `store.actions.cart.add({ sku: 'A1' })`
   */
  readonly actions: { [K in keyof C]: Actions<C[K]['handlers']> };
  /** Subscribe to one slice. Returns an unsubscribe function. */
  subscribe(sliceName: keyof C, listener: () => void): () => void;
  /**
   * Creates a serializable Signal. Server-safe: call it inside Server
   * Actions or Server Components and hand the result to the client
   * (`return { signal }` / `<BridgeSignal signal={...} />`).
   */
  send<K extends keyof C & string, A extends keyof C[K]['handlers'] & string>(
    sliceName: K,
    action: A,
    ...payload: PayloadArgs<PayloadOf<C[K]['handlers'], A>>
  ): Signal<`${K}/${A}`, PayloadOf<C[K]['handlers'], A>>;
  /** Applies a signal to the store immediately (no dedupe, no ordering guard). */
  dispatch(signal: AnySignal): void;
  /**
   * Applies signal(s) with replay protection: a signal id that was already
   * ingested is skipped. Used by `<BridgeSignal>`; call it yourself if you
   * deliver signals over your own transport (websocket, SSE, ...).
   */
  ingest(signal: AnySignal | AnySignal[] | null | undefined): void;
  /**
   * Runs a Server Action promise and applies the signal(s) on its result.
   *
   * - Out-of-order protection: if a *later* `execute` already applied a
   *   signal of the same `type`, a slower earlier response is dropped.
   * - `optimistic`: applied immediately; rolled back (slice-level snapshot
   *   restore) if the promise rejects or resolves with `ok: false`.
   *
   * Returns the action's full result, typed as you declared it.
   */
  execute<R extends ExecuteResult>(
    action: Promise<R>,
    opts?: { optimistic?: AnySignal },
  ): Promise<R>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

declare const process: { env: Record<string, string | undefined> } | undefined;

/** Dev-only console.warn — compiled out of production Next.js bundles. */
export function devWarn(message: string): void {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.warn(`[next-bridge] ${message}`);
  }
}

const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

const toList = (s: AnySignal | AnySignal[] | null | undefined): AnySignal[] =>
  !s ? [] : Array.isArray(s) ? s : [s];

const SEEN_LIMIT = 500;

// ---------------------------------------------------------------------------
// createStore
// ---------------------------------------------------------------------------

export function createStore<C extends SliceConfig>(config: C): Store<C> {
  const state = {} as StateOf<C>;
  const initial = {} as StateOf<C>;
  const listeners = new Map<keyof C, Set<() => void>>();
  const routes = new Map<string, { slice: keyof C; run: Handler<any> }>();
  const actions = {} as Store<C>['actions'];

  const seen = new Set<string>(); // ingest replay guard (bounded FIFO)
  const lastApplied = new Map<string, number>(); // signal type → newest op that wrote it
  let opSeq = 0; // execute ordering
  let localSeq = 0; // cheap ids for client-local dispatches

  for (const sliceName of Object.keys(config) as (keyof C & string)[]) {
    const def: SliceDef<any, any> = config[sliceName];
    state[sliceName] = def.state;
    initial[sliceName] = def.state;
    listeners.set(sliceName, new Set());
    const bound: Record<string, (payload?: unknown) => void> = {};
    for (const actionName of Object.keys(def.handlers)) {
      const type = `${sliceName}/${actionName}`;
      routes.set(type, { slice: sliceName, run: def.handlers[actionName] });
      bound[actionName] = (payload?: unknown) =>
        dispatch({ id: `local-${++localSeq}`, type, payload });
    }
    (actions as Record<string, unknown>)[sliceName] = bound;
  }

  function notify(sliceName: keyof C): void {
    listeners.get(sliceName)?.forEach((fn) => fn());
  }

  function dispatch(signal: AnySignal): void {
    const route = routes.get(signal.type);
    if (!route) {
      devWarn(`Unknown signal type "${signal.type}" — no matching slice/handler.`);
      return;
    }
    const prev = state[route.slice];
    const next = route.run(signal.payload, prev);
    if (!Object.is(prev, next)) {
      state[route.slice] = next;
      notify(route.slice);
    }
  }

  function ingest(signal: AnySignal | AnySignal[] | null | undefined): void {
    for (const sig of toList(signal)) {
      if (sig.id) {
        if (seen.has(sig.id)) continue;
        seen.add(sig.id);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      }
      dispatch(sig);
    }
  }

  async function execute<R extends ExecuteResult>(
    action: Promise<R>,
    opts?: { optimistic?: AnySignal },
  ): Promise<R> {
    const mySeq = ++opSeq;

    let rollback: (() => void) | null = null;
    const opt = opts?.optimistic;
    if (opt) {
      const route = routes.get(opt.type);
      if (route) {
        const before = state[route.slice];
        rollback = () => {
          state[route.slice] = before;
          notify(route.slice);
        };
      }
      dispatch(opt);
    }

    let result: R;
    try {
      result = await action;
    } catch (error) {
      rollback?.();
      throw error;
    }

    if (result?.ok === false) {
      rollback?.();
      return result;
    }

    for (const sig of toList(result?.signal)) {
      if (mySeq > (lastApplied.get(sig.type) ?? 0)) {
        lastApplied.set(sig.type, mySeq);
        dispatch(sig);
      }
    }
    return result;
  }

  return {
    get: () => state,
    initial,
    actions,
    subscribe(sliceName, listener) {
      const set = listeners.get(sliceName);
      if (!set) {
        devWarn(`subscribe: unknown slice "${String(sliceName)}".`);
        return () => {};
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    send: (sliceName, action, ...payload) => ({
      id: uuid(),
      type: `${sliceName}/${action}` as never,
      payload: payload[0] as never,
    }),
    dispatch,
    ingest,
    execute,
  };
}
