# signal-bridge

**Typed, deduplicated state deltas from your Next.js server to your client — over any transport.**

Your server declares a state change once, type-checked against the client's reducers. It reaches the browser through a live stream, a Server Action's return value, or the RSC tree. Same contract, same guarantees, whichever way it travels.

```ts
// server — checked by tsc, here and everywhere
emit(appBridge.send('order/status', { status: 'shipped' }));
```

```tsx
// client — connected while mounted; reconnect and resume are handled
useSignalStream('/api/stream');
const status = useAppState((s) => s.order.status);
```

- **Live server push, typed.** An SSE Route Handler streams deltas; the client applies them with replay protection and a resume cursor. Nothing else in the Next ecosystem offers this with end-to-end types.
- **Store-agnostic.** A `Target` is two functions (`getState`/`setState`), so Zustand, Redux, Jotai, or a plain object all work. The library never imports a state library.
- **Doesn't own your mutations.** No `useMutation` clone, no optimistic engine, no request queue — see [Scope](#scope).
- **Small and server-safe.** Zero dependencies, React only for two optional helpers, no Next import at all, so no private framework internals to break.

---

## Install

Three entries keep server code out of client bundles by construction:

```ts
import { defineBridge, createReceiver } from 'signal-bridge';          // universal: the contract + receiver
import { signalStream, createSignalHub } from 'signal-bridge/server';  // Route Handlers, Server Actions
import { SignalProvider, useSignalStream } from 'signal-bridge/react'; // 'use client' — hooks + stream client
```

`npm run build` produces `dist/` (ESM + `.d.ts`, `sideEffects: false`, the react entry banner-marked `'use client'`). React is an optional peer dep — skip it and the universal + server entries still work.

## Scope

**What it does:** carry type-checked, deduplicated deltas across the boundary and apply them to your state.

**What it deliberately doesn't:** mutations, optimistic updates, retries, request de-duplication, caching. TanStack Query does all of that well, and this **composes with it** rather than competing:

```ts
useMutation({
  mutationFn: () => markPaid(orderId),
  onSuccess: (r) => receiver.ingest(r.signal),
});
```

Not using TanStack? A Server Action's signal is just another delivery — no wrapper required:

```ts
const result = await markPaid(orderId);
receiver.ingest(result.signal);
```

That's the whole integration. The library has no opinion about *how* you called the server.

## The contract

Declared once, server-safe, shared by both sides:

```ts
// app/bridge.ts
import { defineBridge } from 'signal-bridge';

export interface AppState {
  notices: string[];
  order: { status: 'idle' | 'paid' | 'shipped' };
}
const initialState: AppState = { notices: [], order: { status: 'idle' } };

export const appBridge = defineBridge(initialState, {
  'notice/add':   (p: { text: string }, s) => ({ notices: [...s.notices, p.text] }),
  'order/status': (p: { status: AppState['order']['status'] }) => ({ order: { status: p.status } }),
});
```

Annotate **payloads**; `state` is typed for you. Reducers return a patch to merge, so each touches only the keys it names.

**When the contract grows.** Payload inference rides on TypeScript reverse-inferring the whole reducer literal — and one malformed property makes it silently give up, typing *every* payload `unknown`. For loud errors instead, declare the signal map once and pass both type arguments:

```ts
type AppSignals = {
  'notice/add': { text: string };
  'order/status': { status: AppState['order']['status'] };
};
export const appBridge = defineBridge<AppState, AppSignals>(initialState, { /* reducers */ });
```

A bad reducer is then a per-property error at that reducer, not a silent collapse everywhere else. `InferState<typeof appBridge>` and `InferSignals<typeof appBridge>` extract the types back out — the latter is the right type for a Server Action's `signal` slot.

## Wiring a store

The seam is two functions — swap Zustand for anything here:

```ts
const receiver = createReceiver(appBridge, {
  getState: () => store.getState(),
  setState: (patch, label) => store.setState(patch, false, label),
});
```

Create it **per request**, not at module scope: client components render on the server too, and a shared store bleeds state between users. The `label` is the signal type — with Zustand's `devtools` middleware every server-pushed delta shows up named in the timeline, for free.

An optional third argument tunes the receiver: `replayWindow` sizes the dedupe guard (default 500 — keep it ≥ the hub's `capacity`), and `initialCursor` seeds the resume cursor for a store built from a snapshot (see below).

## The live stream

The hub is the backbone: publish from anywhere on the server, and the stream route is just replay + follow-along.

```ts
// app/hub.ts — one per server process
import { createSignalHub } from 'signal-bridge/server';
export const hub = createSignalHub({ capacity: 500 });

// anywhere on the server — a Server Action, a webhook, a queue consumer:
hub.publish(appBridge.send('order/status', { status: 'shipped' }));
```

```ts
// app/api/stream/route.ts
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return signalStream(request, ({ emit, lastEventId }) => {
    for (const missed of hub.since(lastEventId)) emit(missed); // replay what this client missed
    return hub.subscribe(emit); // follow along live; cleanup runs exactly once, however the stream ends
  });
}
```

```tsx
useSignalStream('/api/stream'); // connected while mounted
```

`publish` returns the signal, so a Server Action can broadcast *and* hand the same signal to its caller in one expression — both paths carry one id, so a client reached by both applies it once.

**Why SSE, not websockets.** SSE rides plain HTTP: no second server, it works from an ordinary Route Handler, it reconnects on its own, and it has a resume cursor built into the protocol. `Signal.id` doubles as the SSE `id:`, so the browser replays it as `Last-Event-ID` and your handler resumes from exactly where the client left off. Overlap on reconnect is absorbed by the receiver's replay guard, so a generous replay window is safe. (A websocket transport is a small addition — it only needs to call `receiver.accept(frame)`.)

**Production posture is built in.** The server flushes a comment immediately (so buffering proxies release the stream), heartbeats every 15s (so idle timeouts don't kill the connection, and a silently vanished client is *noticed* instead of leaking its subscription), and closes a stream whose client has stalled past a buffer bound — safe, because closing just triggers reconnect-and-resume. The client covers the two cases EventSource won't: it carries `receiver.lastId()` as a `?lastEventId=` query param, so *fresh* connections (a remount, a restored tab) resume too, not just automatic retries — and when EventSource fails permanently (an expired session, a deploy), it rebuilds the connection with capped, jittered backoff. All of it is tunable: `heartbeatMs`, `maxBufferedFrames`, `cursorParam`, `reconnect`, and `onError` reports `{ fatal }` so you can tell a blip from a dead stream.

## Trust and the wire

`ingest` takes signals you already trust (your own `send`, a Server Action's result). `accept` takes **untrusted** values off the wire and validates the envelope against the contract — unknown types, junk, prototype-shaped strings, and malformed ids (empty, over 256 chars, or containing line breaks, which would corrupt SSE framing) are dropped, never thrown. A reducer that throws is contained too: the batch continues, the cursor doesn't advance past the failed signal, and a replay of the same id doesn't retry it.

**Payload shape is not validated at runtime.** Signals come from your own server, so this trusts them exactly as much as you already trust your own API responses. If a stream is reachable by untrusted parties, validate payloads yourself (zod et al) before calling `ingest`.

## Signals are for events, not initial data

Signals apply after hydration. For an event that's correct — a payment confirmation has no earlier value it could have had. For data the server already knew it's a bug: the HTML ships the stale value and stays wrong until hydration, and permanently so for crawlers or if a script throws.

| The data is… | Use |
|---|---|
| Known by the server, needed by a component at first paint | **RSC prop** |
| Known by the server, needed by the *store* at first paint | **Seed it** (`Providers initialState`) |
| Something that *happened* after the page exists | **A signal** |

This isn't a tradeoff you pay to avoid — the alternatives are *less* code.

**Seeding without a gap.** A seeded snapshot and a stream subscription start at different moments; events in between would be lost. Close it by capturing the cursor *with* the snapshot: read `hub.lastId()` in the layout, pass it to the receiver as `initialCursor`, and the first connection replays exactly what happened since the render. Snapshot → cursor → resume, with the replay guard absorbing any overlap.

## Deploying

**One Node server** (`next start`, a container, a VPS): the in-memory hub at module scope is all you need — every request lands in the same process. In dev, pin it to `globalThis` (`globalThis.__hub ??= createSignalHub()`) so hot reload doesn't reset the buffer.

**Serverless / multi-instance** (Vercel and friends): each stream is pinned to the instance that opened it, and a Server Action publishing from *another* invocation never reaches an in-memory hub there. Put the backbone in shared infrastructure — Redis pub/sub plus a capped stream (`XADD`/`XRANGE` map 1:1 onto `publish`/`since`), or Postgres LISTEN/NOTIFY — behind the same three functions, and the route handler doesn't change. Function duration caps are not fatal: when the platform kills a long-lived stream at `maxDuration`, the client reconnects with its cursor and resumes. Heartbeat + resume turn forced termination into a routine, invisible reconnect — the design assumes connections die.

**Auth.** EventSource cannot set headers, so streams authenticate with cookies: same-origin sends them by default; cross-origin needs `withCredentials: true` and CORS configured for credentials. The resume cursor rides a query param on fresh connections — it's an opaque signal id, safe for logs — but treat the stream URL as unauthenticated input and authorize inside the handler like any other route.

## API

| Export | Entry | Notes |
|---|---|---|
| `defineBridge(initialState, reducers)` | `signal-bridge` | The contract; `send` / `parse` live on it |
| `createReceiver(bridge, target, options?)` | `signal-bridge` | `ingest` / `accept` / `lastId`; options: `replayWindow`, `initialCursor` |
| `InferState<B>` / `InferSignals<B>` | `signal-bridge` | Extract the state / signal-union types from a bridge |
| `signalStream(request, start, options?)` | `signal-bridge/server` | SSE `Response`; options: `heartbeatMs`, `maxBufferedFrames`, `cursorParam`, `retryMs` |
| `createSignalHub(options?)` | `signal-bridge/server` | `publish` / `subscribe` / `since` / `lastId`; in-memory, one per process |
| `connectSignalStream(receiver, url, options?)` | `signal-bridge/react` | Disconnect fn returned; resumes fresh connections, rebuilds on fatal errors |
| `SignalProvider` / `useReceiver` / `useSignalStream` / `BridgeSignal` | `signal-bridge/react` | `'use client'` React helpers |

## Status

Prototype, untested against a running Next server. The suite (54 tests) covers the contract, the receiver (throw containment, replay window, seeded cursor), the hub (fanout, eviction, best-effort replay), the stream's lifecycle (heartbeat, backpressure, abort, resume via header and query param), a reconnecting client, the React hooks under Strict Mode, and a real server → SSE wire → client round trip — but jsdom and `renderToString` are not streaming RSC. Next up: pointing it at a live Next app, a Redis-backed hub recipe, and a websocket transport (it only needs to call `receiver.accept(frame)`).
