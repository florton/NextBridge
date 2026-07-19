# next-signal-bridge

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

```sh
npm install next-signal-bridge
```

Requires Node ≥ 18; React ≥ 18 is an optional peer dependency (only the `/react` entry needs it). Ships ESM only. Three entries keep server code out of client bundles by construction:

```ts
import { defineBridge, createReceiver } from 'next-signal-bridge';          // universal: the contract + receiver
import { signalStream, createSignalHub } from 'next-signal-bridge/server';  // Route Handlers, Server Actions
import { SignalProvider, useSignalStream } from 'next-signal-bridge/react'; // 'use client' — hooks + stream client
```

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
import { defineBridge } from 'next-signal-bridge';

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
// app/hub.ts — one per server process, pinned so dev HMR doesn't re-create it
import { createSignalHub, type SignalHub } from 'next-signal-bridge/server';

const g = globalThis as typeof globalThis & { __appSignalHub?: SignalHub };
export const hub = (g.__appSignalHub ??= createSignalHub({ capacity: 500 }));

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

**Production posture is built in.** The server flushes a comment immediately (so buffering proxies release the stream), heartbeats every 15s (so idle timeouts don't kill the connection, and a silently vanished client is *noticed* instead of leaking its subscription), and closes a stalled stream on either of two guards — a buffer bound (`maxBufferedFrames`) and a no-reads-for-too-long clock (`maxStallMs`) — safe, because closing just triggers reconnect-and-resume. The client covers the two cases EventSource won't: it carries `receiver.lastId()` as a `?lastEventId=` query param, so *fresh* connections (a remount, a restored tab) resume too, not just automatic retries — and when EventSource fails permanently (an expired session, a deploy), it rebuilds the connection with capped, jittered backoff. All of it is tunable: `heartbeatMs`, `maxBufferedFrames`, `maxStallMs`, `cursorParam`, `reconnect`, and `onError` reports `{ fatal }` so you can tell a blip from a dead stream.

**One connection, however many mounts.** Mounts of `useSignalStream` that share a receiver and URL share one EventSource (refcounted; closed when the last unmounts), so scattering the hook across components costs one connection, not one each. That matters in dev: `next dev` speaks HTTP/1.1, where browsers allow ~6 connections per origin. Every sharer's `onOpen`/`onError` still fire; pass `shared: false` to isolate a mount.

## Scoping to users, tenants, rooms

A single hub broadcasts everything to everyone. That's right for genuinely global data — a deploy banner, a status ticker — and **wrong the moment signals belong to someone**: a global hub would replay user A's deltas to user B. `createSignalHubs` is the scoping primitive — a keyed registry of hubs:

```ts
// app/hub.ts
import { createSignalHubs, type SignalHubs } from 'next-signal-bridge/server';

const g = globalThis as typeof globalThis & { __appSignalHubs?: SignalHubs };
export const hubs = (g.__appSignalHubs ??= createSignalHubs({ capacity: 500 }));

// publishing: scope by the data's owner
hubs.channel(`user:${order.userId}`).publish(appBridge.send('order/status', { status: 'shipped' }));
```

```ts
// app/api/stream/route.ts — scope by the *authenticated* caller
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await getSession(request); // your auth — see Deploying → Auth
  if (!session) return new Response('unauthorized', { status: 401 });

  const hub = hubs.channel(`user:${session.userId}`);
  return signalStream(request, ({ emit, lastEventId }) => {
    for (const missed of hub.since(lastEventId)) emit(missed);
    return hub.subscribe(emit);
  });
}
```

Replay isolation falls out: `since()` only ever reaches one channel's backlog, so one user's history cannot be replayed to another. Two rules keep it real:

1. **Derive channel keys from the authenticated session on the server** — never from a client-supplied param, or the scoping is decorative.
2. A client that should see several scopes (their own channel plus a global one) either mounts one `useSignalStream` per stream URL, or the route subscribes the same `emit` to several channels.

Channels are created on first use and evicted least-recently-used past `maxChannels` (default 1000). Eviction never touches a channel with live subscribers — that would silently split them from future publishes — and an evicted channel only loses its replay backlog: the next access starts fresh, exactly like a server restart. Call `hubs.delete(key)` on logout or room teardown for eager cleanup.

## Trust and the wire

`ingest` takes signals you already trust (your own `send`, a Server Action's result). `accept` takes **untrusted** values off the wire and validates the envelope against the contract — unknown types, junk, prototype-shaped strings, and malformed ids (empty, over 256 chars, or containing line breaks, which would corrupt SSE framing) are dropped, never thrown. A reducer that throws is contained too: the batch continues, the cursor doesn't advance past the failed signal, and a replay of the same id doesn't retry it.

**Payload validation is opt-in.** By default payloads are trusted exactly as much as you already trust your own API responses — they come from your own server. Where a stream crosses a trust boundary, add per-type guards; they run inside `parse`, are zero-dependency, and zod drops straight in:

```ts
export const appBridge = defineBridge(initialState, reducers, {
  payloadGuards: {
    'notice/add': (p) => noticeSchema.safeParse(p).success, // or any (payload: unknown) => boolean
  },
});
```

Types without a guard skip payload validation, so you can guard only the boundary-crossing signals. A guard that returns `false` (or throws) rejects the signal; `parse` never throws.

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

**One Node server** (`next start`, a container, a VPS, Fly, Railway): the in-memory hub at module scope is all you need — every request lands in the same process. Pin it to `globalThis` (as in the examples above) so dev-mode hot reload doesn't reset the buffer.

**Serverless / multi-instance** (Vercel and friends) — two separate issues; don't conflate them:

1. **Stream lifetime.** Function duration caps end long-lived responses at `maxDuration`. This degrades gracefully: the client reconnects with its cursor and resumes, so a capped stream becomes periodic reconnection, not data loss. Heartbeat + resume turn forced termination into a routine, invisible reconnect — the design assumes connections die. Do cost-model it: every open stream holds a warm function.
2. **Hub visibility.** In-memory state is per-instance: a Server Action publishing on one instance never reaches a stream pinned to another. **This failure is silent** — whether a client sees a publish depends on which instance served which request — so the backbone must move to shared infrastructure.

The seam is `AsyncSignalHub`: the same hub shape with reads allowed to be async (`signalStream` accepts an async `start` for exactly this). The in-memory hub satisfies it too, so a route written against it — `await hub.since(...)` — works with either backing and swaps without touching the route. A reference Redis implementation:

```ts
// app/hub.redis.ts — reference implementation; adapt to your infra
import { Redis } from 'ioredis';
import type { AnySignal } from 'next-signal-bridge';
import type { AsyncSignalHub } from 'next-signal-bridge/server';

export function createRedisSignalHub(
  channel: string,
  { capacity = 500, url = process.env.REDIS_URL! } = {},
): AsyncSignalHub & { close(): Promise<void> } {
  const pub = new Redis(url);
  const sub = new Redis(url); // subscriber connections are dedicated in Redis
  const listeners = new Set<(s: AnySignal) => void>();
  const logKey = `nsb:${channel}:log`;
  const feed = `nsb:${channel}`;

  sub.subscribe(feed);
  sub.on('message', (_from, raw) => {
    let signal: AnySignal;
    try {
      signal = JSON.parse(raw);
    } catch {
      return;
    }
    for (const fn of [...listeners]) {
      try {
        fn(signal);
      } catch {
        /* one broken listener must not cost the rest their delivery */
      }
    }
  });

  return {
    publish(signal) {
      const raw = JSON.stringify(signal);
      // Append to the capped log and fan out to every instance — one round trip.
      pub.multi().rpush(logKey, raw).ltrim(logKey, -capacity, -1).publish(feed, raw).exec();
      return signal;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    async since(cursor) {
      if (!cursor) return [];
      const raws = await pub.lrange(logKey, 0, -1);
      const all: AnySignal[] = [];
      for (const raw of raws) {
        try {
          all.push(JSON.parse(raw));
        } catch {
          /* skip junk */
        }
      }
      const i = all.findLastIndex((s) => s.id === cursor);
      return i === -1 ? all : all.slice(i + 1); // unknown cursor → whole log, best effort
    },
    async lastId() {
      const [raw] = await pub.lrange(logKey, -1, -1);
      try {
        return raw ? (JSON.parse(raw) as AnySignal).id : undefined;
      } catch {
        return undefined;
      }
    },
    close: async () => void (await Promise.all([pub.quit(), sub.quit()])),
  };
}
```

With an async hub there's a gap between reading the backlog and subscribing live. Close it by subscribing first and buffering — the receiver's dedupe absorbs the overlap:

```ts
export async function GET(request: Request) {
  const hub = redisHubFor('global');
  return signalStream(request, async ({ emit, lastEventId }) => {
    const buffered: AnySignal[] = [];
    let replaying = true;
    const unsubscribe = hub.subscribe((s) => (replaying ? void buffered.push(s) : emit(s)));

    for (const missed of await hub.since(lastEventId)) emit(missed);
    for (const s of buffered) emit(s);
    replaying = false;

    return unsubscribe;
  });
}
```

**When not to use this library.** Thousands of concurrent long-lived connections on serverless, multi-region fan-out, presence/typing at scale: that's managed-realtime territory (Ably, Pusher, PartyKit, Liveblocks), and this library won't pretend otherwise. Its lane is your Next server, your data, typed deltas, no extra vendor.

**Auth.** EventSource cannot set headers, so streams authenticate with cookies: same-origin sends them by default; cross-origin needs `withCredentials: true` and CORS configured for credentials. The resume cursor rides a query param on fresh connections — it's an opaque signal id, safe for logs — but treat the stream URL as unauthenticated input and authorize inside the handler like any other route (and derive channel keys from the session, never the URL).

## API

| Export | Entry | Notes |
|---|---|---|
| `defineBridge(initialState, reducers, options?)` | `next-signal-bridge` | The contract; `send` / `parse` live on it; `options.payloadGuards` adds opt-in payload validation |
| `createReceiver(bridge, target, options?)` | `next-signal-bridge` | `ingest` / `accept` / `lastId`; options: `replayWindow`, `initialCursor` |
| `uuid()` | `next-signal-bridge` | The id generator `send` uses (collision-proof fallback without `crypto.randomUUID`) |
| `InferState<B>` / `InferSignals<B>` | `next-signal-bridge` | Extract the state / signal-union types from a bridge |
| `signalStream(request, start, options?)` | `next-signal-bridge/server` | SSE `Response`; `start` may be async; options: `heartbeatMs`, `maxBufferedFrames`, `maxStallMs`, `cursorParam`, `retryMs` |
| `createSignalHub(options?)` | `next-signal-bridge/server` | `publish` / `subscribe` / `since` / `lastId` / `subscriberCount`; in-memory, one per process |
| `createSignalHubs(options?)` | `next-signal-bridge/server` | Keyed channel registry: `channel(key)` / `delete(key)` / `keys()`; options: `capacity`, `maxChannels` |
| `AsyncSignalHub` | `next-signal-bridge/server` | The hub shape with async reads — the seam for Redis/Postgres backings |
| `connectSignalStream(receiver, url, options?)` | `next-signal-bridge/react` | Disconnect fn returned; resumes fresh connections, rebuilds on fatal errors |
| `SignalProvider` / `useReceiver` / `useSignalStream` / `BridgeSignal` | `next-signal-bridge/react` | `'use client'` React helpers; `useSignalStream` shares connections per receiver + URL (`shared: false` opts out) |

## Status

Pre-1.0 and not yet battle-tested against a running Next app — treat it as a well-tested core, not a proven product. The suite (74 tests) covers the contract (including payload guards and inference-preservation type tests), the receiver (throw containment, replay window, seeded cursor), hubs (fanout, eviction, best-effort replay, channel isolation and LRU eviction that never splits a live channel), the stream's lifecycle (heartbeat, both stall guards, abort, async `start`, resume via header and query param), a reconnecting client, the React hooks under Strict Mode (including connection sharing), and a real server → SSE wire → client round trip — but jsdom and `renderToString` are not streaming RSC. Next up: pointing it at a live Next app, and a websocket transport (it only needs to call `receiver.accept(frame)`).

## License

[MIT](LICENSE)
