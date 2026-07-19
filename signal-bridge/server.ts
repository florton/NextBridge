/**
 * next-signal-bridge · server entry
 *
 * The SSE Route Handler response, the in-memory backlog hub, and the keyed
 * channel registry. Import from Route Handlers, Server Actions, and other
 * server modules — never from client components (the split exists so your
 * bundler enforces that).
 */

export { signalStream } from './stream';
export type { StreamContext, StreamOptions } from './stream';

export { createSignalHub, createSignalHubs } from './hub';
export type {
  AsyncSignalHub,
  SignalHub,
  SignalHubOptions,
  SignalHubs,
  SignalHubsOptions,
} from './hub';
