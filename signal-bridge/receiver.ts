/**
 * signal-bridge · receiver (framework-agnostic, zero-dependency)
 *
 * Applies signals to whatever holds your state. The library deliberately
 * doesn't own a store: a `Target` is two functions, so Zustand, Redux, Jotai,
 * a plain object, or a test double all work without an adapter package.
 */

import { devWarn, type Bridge, type Reducers, type SignalOf } from './core';

/**
 * The seam between the wire and your state container.
 *
 *   // Zustand — the third `setState` arg becomes the devtools action label
 *   const target = {
 *     getState: () => store.getState(),
 *     setState: (patch, label) => store.setState(patch, false, label),
 *   };
 */
export interface Target<State> {
  getState(): State;
  /** `label` is the signal type, for devtools timelines. Ignore it if unused. */
  setState(patch: Partial<State>, label?: string): void;
}

export interface Receiver<P> {
  /**
   * Applies signal(s) you already trust — a Server Action's return value, or
   * anything built by `bridge.send`. Each id applies at most once, so React
   * Strict Mode double-effects and re-mounts don't double-fire.
   */
  ingest(signal: SignalOf<P> | SignalOf<P>[] | null | undefined): void;
  /**
   * Applies one *untrusted* value off the wire: validates the envelope
   * against the contract, then ingests. Returns whether it was applied, so a
   * transport can count drops. Never throws: junk is dropped, and a throwing
   * reducer is contained rather than escaping into a transport's handler.
   */
  accept(raw: unknown): boolean;
  /**
   * The id of the most recent signal applied — the stream cursor. Hand it back
   * on reconnect (SSE does this automatically via `Last-Event-ID`) so the
   * server can resume rather than replay from the beginning.
   */
  lastId(): string | undefined;
}

/** Bounds the replay guard; ids older than this can re-apply after a replay. */
const SEEN_LIMIT = 500;

const toList = <T>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export function createReceiver<State, P>(
  bridge: Bridge<State, P>,
  target: Target<State>,
): Receiver<P> {
  const reducers = bridge.reducers as Reducers<State, P> & Record<string, unknown>;
  const seen = new Set<string>();
  let last: string | undefined;

  function apply(sig: SignalOf<P>): boolean {
    const reducer = (reducers as Record<string, (p: unknown, s: State) => Partial<State>>)[
      sig.type
    ];
    if (!reducer) {
      devWarn(`Unknown signal "${sig.type}" — no matching reducer. Ignored.`);
      return false;
    }
    if (sig.id) {
      // A replayed id is a no-op, not an error: reconnects and Strict Mode
      // both legitimately deliver the same signal twice. Marked seen *before*
      // applying — deliberately, so a reducer that throws deterministically
      // is not retried on every replay of the same id.
      if (seen.has(sig.id)) return false;
      seen.add(sig.id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
    }
    try {
      // Read state at apply time so a burst of signals can't overwrite each
      // other from a stale snapshot.
      target.setState(reducer(sig.payload, target.getState()), sig.type);
    } catch (error) {
      // One bad signal must not kill the batch or escape into a transport's
      // message handler. The delta is lost; the cursor stays put — `last`
      // never claims a signal that didn't apply, so a resume can replay it.
      devWarn(`Reducer for "${sig.type}" threw; signal ${sig.id || '(no id)'} dropped. ${String(error)}`);
      return false;
    }
    if (sig.id) last = sig.id;
    return true;
  }

  return {
    ingest(signal) {
      for (const sig of toList(signal)) apply(sig);
    },
    accept(raw) {
      const sig = bridge.parse(raw);
      if (!sig) {
        devWarn('Discarded a value that is not a signal for this contract.');
        return false;
      }
      return apply(sig);
    },
    lastId: () => last,
  };
}
