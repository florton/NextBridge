// app/hub.ts
// One hub per server process, shared by the stream route and every publisher
// (Server Actions, webhooks, queue consumers). In-memory is right for a
// single Node server (`next start`, a container); in dev, pin it to
// `globalThis` so HMR doesn't re-create it. For serverless/multi-instance,
// implement the same three-function shape over Redis — see README → Deploying.
import { createSignalHub } from '../hub'; // in your app: 'signal-bridge/server'

export const hub = createSignalHub({ capacity: 500 });
