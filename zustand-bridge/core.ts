/**
 * zustand-bridge · core (server-safe, zero-dependency)
 *
 * The boundary layer only. No React, no Zustand imports — safe to pull into
 * Server Actions and Server Components. It does exactly two things:
 *
 *   1. Defines the *signal contract* — a map of `"slice/action"` → reducer —
 *      shared by both sides so `send()` is type-checked against the same
 *      reducers the client applies.
 *   2. Provides `send()`, a pure typed factory for serializable signals.
 *
 * The store itself stays plain Zustand (see ./react). We do not reinvent it.
 */

export interface Signal<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload: P;
}

export type AnySignal = Signal<string, any>;

/**
 * The union of every Signal a given contract can produce — one member per
 * signal type, each pinned to its own payload. This is what lets the
 * *receive* site (`ingest`/`execute`) reject a typo'd type, a mismatched
 * payload, or a signal belonging to a different bridge, rather than trusting
 * that every signal came from `send()`.
 */
export type SignalOf<P> = { [K in keyof P & string]: Signal<K, P[K]> }[keyof P & string];

/**
 * A reducer patches state: `(payload, state) => partial`. The returned
 * partial is shallow-merged by Zustand's `setState`, so a reducer touches
 * only the keys it names and can't accidentally drop the rest.
 */
export type Reducer<State> = (payload: any, state: State) => Partial<State>;

/**
 * Reducers keyed by signal type, written as a homomorphic mapped type over
 * `keyof P`. Inferring it from an object literal preserves the literal keys
 * *and* reverse-infers each payload into the payload map `P`, while giving
 * `state` a contextual type. (A `Record<string, …>` constraint instead
 * widens the keys to `string`; a `Record<keyof R, …>` one resolves to never.)
 *
 * Caveat: one property that violates this shape makes TypeScript abandon
 * reverse-inference for the whole literal — every payload silently becomes
 * `unknown`. Keep negative type tests in their own `defineBridge` call.
 */
export type Reducers<State, P> = {
  [K in keyof P]: (payload: P[K], state: State) => Partial<State>;
};

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/**
 * One call signature per signal type, intersected into a single overloaded
 * function. Each key gets its exact arity (void payloads take no second arg)
 * and its exact payload type — so no reliance on generic narrowing.
 */
export type SendFn<P> = UnionToIntersection<
  {
    [K in keyof P & string]: [P[K]] extends [void | undefined]
      ? (type: K) => Signal<K, P[K]>
      : (type: K, payload: P[K]) => Signal<K, P[K]>;
  }[keyof P & string]
>;

export interface Bridge<State, P> {
  /** The initial state — reused by the store factory so it's declared once. */
  initialState: State;
  /** The shared reducer map — consumed by the client store via `attachBridge`. */
  reducers: Reducers<State, P>;
  /**
   * Builds a typed, serializable Signal. Server-safe: call inside Server
   * Actions / Server Components. Wrong `type` or payload shape fails `tsc`.
   */
  send: SendFn<P>;
}

/**
 * Declares the signal contract: the initial state plus a reducer per signal
 * type. `State` is inferred from `initialState` (annotate that once) and each
 * payload is reverse-inferred from the reducer you write, so inside a reducer
 * `state` is typed for you and you annotate only the payload:
 *
 *   interface AppState { user: { name: string } }
 *   const initial: AppState = { user: { name: 'Ada' } };
 *
 *   export const bridge = defineBridge(initial, {
 *     'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
 *   });
 *
 * Reducers return a partial to shallow-merge, so they touch only the keys
 * they name; an unrecognised key fails `tsc`.
 */
export function defineBridge<State, P>(
  initialState: State,
  reducers: Reducers<NoInfer<State>, P>,
): Bridge<State, P> {
  return {
    initialState,
    reducers,
    send: ((type: string, payload?: unknown) => ({ id: uuid(), type, payload })) as SendFn<P>,
  };
}

export function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

declare const process: { env: Record<string, string | undefined> } | undefined;

export function devWarn(message: string): void {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.warn(`[zustand-bridge] ${message}`);
  }
}
