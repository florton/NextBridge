/**
 * signal-bridge · universal entry
 *
 * The contract and the receiver: server-safe, zero-dependency, no React.
 * Server-only pieces live in `signal-bridge/server`; React glue and the
 * stream client live in `signal-bridge/react`.
 */

export { defineBridge, uuid } from './core';
export type {
  AnySignal,
  Bridge,
  InferSignals,
  InferState,
  Reducers,
  SendFn,
  Signal,
  SignalOf,
} from './core';

export { createReceiver } from './receiver';
export type { Receiver, ReceiverOptions, Target } from './receiver';
