/**
 * next-signal-bridge · universal entry
 *
 * The contract and the receiver: server-safe, zero-dependency, no React.
 * Server-only pieces live in `next-signal-bridge/server`; React glue and the
 * stream client live in `next-signal-bridge/react`.
 */

export { defineBridge, uuid } from './core';
export type {
  AnySignal,
  Bridge,
  BridgeOptions,
  InferSignals,
  InferState,
  PayloadsOf,
  ReducerMap,
  Reducers,
  SendFn,
  Signal,
  SignalOf,
} from './core';

export { createReceiver } from './receiver';
export type { Receiver, ReceiverOptions, Target } from './receiver';
