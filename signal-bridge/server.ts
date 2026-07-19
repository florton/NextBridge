/**
 * signal-bridge · server entry
 *
 * The SSE Route Handler response and the in-memory backlog hub. Import from
 * Route Handlers, Server Actions, and other server modules — never from
 * client components (the split exists so your bundler enforces that).
 */

export { signalStream } from './stream';
export type { StreamContext, StreamOptions } from './stream';

export { createSignalHub } from './hub';
export type { SignalHub, SignalHubOptions } from './hub';
