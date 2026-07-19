/**
 * signal-bridge · core (server-safe, zero-dependency)
 *
 * A typed vocabulary of state deltas that can cross the server/client
 * boundary. Nothing here imports React, Next, or any state library — it's
 * safe in Server Actions, Route Handlers, Server Components, and Node.
 *
 * The library owns the *wire*, not your state. It does not do mutations,
 * optimistic updates, or request orchestration: that's what TanStack Query
 * and friends are for, and they do it well. This does the one thing they
 * don't — carry type-checked, deduplicated deltas from your server to your
 * client over any transport.
 */

/** A serializable instruction. This is the only thing that crosses the wire. */
export interface Signal<T extends string = string, P = unknown> {
  /** Unique, and doubles as the stream cursor (SSE `id:` / `Last-Event-ID`). */
  id: string;
  /** `"slice/action"` — routed to the matching reducer. */
  type: T;
  payload: P;
}

export type AnySignal = Signal<string, any>;

/** The union of every Signal a contract can produce — one member per type. */
export type SignalOf<P> = { [K in keyof P & string]: Signal<K, P[K]> }[keyof P & string];

/**
 * Reducers keyed by signal type. A homomorphic mapped type over `keyof P`, so
 * inferring it from an object literal preserves the literal keys *and*
 * reverse-infers each payload into `P`, while giving `state` a contextual
 * type.
 *
 * Caveat: one property that violates this shape makes TypeScript abandon
 * reverse-inference for the whole literal — every payload silently becomes
 * `unknown`. Keep negative type tests in their own `defineBridge` call.
 */
export type Reducers<State, P> = {
  [K in keyof P]: (payload: P[K], state: State) => Partial<State>;
};

/** `[]` for void-payload signals, so `send('cart/clear')` takes no second arg. */
type PayloadArgs<T> = [T] extends [void | undefined] ? [] : [payload: T];

/**
 * Builds a signal. `K` is inferred from the first argument, which then fixes
 * the payload's type and arity. Only narrows because `P` keeps its literal
 * keys — it would collapse if `P` ever widened to `string`.
 */
export type SendFn<P> = <K extends keyof P & string>(
  type: K,
  ...payload: PayloadArgs<P[K]>
) => Signal<K, P[K]>;

export interface Bridge<State, P> {
  /** Declared once, reused by the client's state container to seed itself. */
  initialState: State;
  reducers: Reducers<State, P>;
  /**
   * Creates a typed, serializable Signal. Server-safe: call it in a Server
   * Action, a Route Handler, or a Server Component. A wrong type or payload
   * fails `tsc` at the point of emission, not at runtime on the client.
   */
  send: SendFn<P>;
  /**
   * Runtime-checks an untrusted value (a parsed websocket frame, an SSE
   * `data:` line) against this contract. Returns `null` for anything that
   * isn't a signal this bridge knows.
   *
   * Envelope only: it verifies `id`/`type` and that `type` has a reducer.
   * Ids must be non-empty, at most 256 chars, and free of line breaks — they
   * feed the replay guard and are echoed into SSE `id:` lines, so anything
   * else is junk even from a trusted server.
   * Payload shape is **not** validated — signals come from your own server, so
   * this trusts them exactly as much as you already trust your own API
   * responses. If a stream is reachable by untrusted parties, validate
   * payloads yourself (zod et al) before calling `ingest`.
   */
  parse(raw: unknown): SignalOf<P> | null;
}

/** The state type a bridge manages — `InferState<typeof appBridge>`. */
export type InferState<B> = B extends Bridge<infer S, any> ? S : never;

/**
 * The union of every signal a bridge can produce — the type for a Server
 * Action's return slot: `{ signal: InferSignals<typeof appBridge> }`.
 */
export type InferSignals<B> = B extends Bridge<any, infer P> ? SignalOf<P> : never;

export function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

declare const process: { env: Record<string, string | undefined> } | undefined;

export function devWarn(message: string): void {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.warn(`[signal-bridge] ${message}`);
  }
}

/**
 * Declares the signal contract: the initial state plus a reducer per signal
 * type. `State` is inferred from `initialState` (annotate that once) and each
 * payload is reverse-inferred from the reducer, so `state` is typed for you
 * and you annotate only the payload:
 *
 *   interface AppState { notices: string[] }
 *   const initial: AppState = { notices: [] };
 *
 *   export const bridge = defineBridge(initial, {
 *     'notice/add': (p: { text: string }, s) => ({ notices: [...s.notices, p.text] }),
 *   });
 *
 * Reducers return a patch to merge, so they touch only the keys they name.
 */
export function defineBridge<State, P>(
  initialState: State,
  reducers: Reducers<NoInfer<State>, P>,
): Bridge<State, P> {
  // A Set (not `in`) so hostile-looking wire types like "__proto__/x" are inert.
  const known = new Set(Object.keys(reducers as object));

  return {
    initialState,
    reducers,
    send: ((type: string, payload?: unknown) => ({ id: uuid(), type, payload })) as SendFn<P>,
    parse(raw: unknown): SignalOf<P> | null {
      if (!raw || typeof raw !== 'object') return null;
      const sig = raw as Partial<AnySignal>;
      if (typeof sig.id !== 'string' || typeof sig.type !== 'string') return null;
      // Ids feed the replay guard and SSE `id:` framing: empty skips dedupe,
      // oversized bloats the seen set, a line break injects SSE fields.
      if (sig.id === '' || sig.id.length > 256 || /[\r\n]/.test(sig.id)) return null;
      if (!known.has(sig.type)) return null;
      return { id: sig.id, type: sig.type, payload: sig.payload } as SignalOf<P>;
    },
  };
}
