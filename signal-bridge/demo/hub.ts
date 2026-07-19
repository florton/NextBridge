// app/hub.ts
// One hub per server process, shared by the stream route and every publisher
// (Server Actions, webhooks, queue consumers). In-memory is right for a
// single Node server (`next start`, a container). Pinned to `globalThis`
// because dev-mode HMR re-evaluates modules — without the pin, every edit
// silently replaces the hub and splits new publishes from old subscribers.
// For serverless/multi-instance, implement the `AsyncSignalHub` shape over
// Redis — see README → Deploying for a reference implementation.
//
// Broadcasts here are global (presence, notices) — data every client may
// see. Per-user or per-tenant data belongs on `createSignalHubs` channels
// instead; see README → Scoping.
import { createSignalHub, type SignalHub } from '../hub'; // in your app: 'next-signal-bridge/server'

const g = globalThis as typeof globalThis & { __appSignalHub?: SignalHub };

export const hub = (g.__appSignalHub ??= createSignalHub({ capacity: 500 }));
