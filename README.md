# next-signal-bridge

**Typed, deduplicated, resumable state deltas from a Next.js server to the browser — over SSE, a
Server Action's return value, or the RSC tree. One contract, any store, zero dependencies.**

TypeScript · React 18/19 · Node ≥ 18 · 78 tests · `tsc --strict` clean · MIT

A state change happens on the server. How does it reach the client *with its types intact?* You
declare a contract once in server-safe code — initial state, plus a reducer per `"slice/action"` —
and both sides check against it:

```ts
// server: a Server Action, a webhook, a queue consumer
hub.publish(appBridge.send('order/status', { status: 'shipped' }));
//                          ^ unknown action or wrong payload shape = tsc error, not a prod bug
```

```tsx
// client: connected while mounted; reconnect, replay and resume are handled
useSignalStream('/api/stream');
const status = useAppState((s) => s.order.status);
```

**→ [Full documentation: `signal-bridge/README.md`](signal-bridge/README.md)**

---

## What it is

| | |
|---|---|
| Client runtime | **< 3 kB gzipped** — contract, receiver, hooks, and reconnecting stream client |
| Server entry | ~2.4 kB gzipped, and never enters the client bundle |
| Dependencies | **zero.** React is an *optional* peer, needed only by the `/react` entry |
| Framework coupling | **no `next` import anywhere** — no private internals to break on upgrade |
| Transport | SSE Route Handler, Server Action return value, RSC tree — same contract for all three |
| State engine | yours. A `Target` is two functions, `getState` and `setState` |
| Tests | 78, covering the contract, receiver, hubs, stream lifecycle, and a real wire round trip |

Three entry points keep server code out of client bundles by construction:

```ts
import { defineBridge, createReceiver } from 'next-signal-bridge';          // universal
import { signalStream, createSignalHub } from 'next-signal-bridge/server';  // Route Handlers
import { SignalProvider, useSignalStream } from 'next-signal-bridge/react'; // 'use client'
```

## What it deliberately isn't

No mutation hook, no optimistic engine, no request queue, no cache. TanStack Query does all of
that well, so this composes with it instead of competing:

```ts
useMutation({ mutationFn: () => markPaid(id), onSuccess: (r) => receiver.ingest(r.signal) });
```

Not using TanStack? A Server Action's signal is just `receiver.ingest(result.signal)`. The library
has no opinion about *how* you called the server.

## Where it sits

The word *signal* is overloaded, so: these are **serialized event deltas that cross a network
boundary**, not in-process reactive primitives.

- **Signal libraries** — [alien-signals](https://github.com/stackblitz/alien-signals), Preact
  Signals, Vue reactivity — are a *reactivity graph* inside one JS runtime: fine-grained
  subscriptions, computeds, effects. They have no server, no wire format, no replay. They sit
  *under* this library, not beside it: any of them can be the store a `Target` reads and writes.
- **Realtime backends** — Pusher, Ably, Convex, Liveblocks, Supabase Realtime — solve fan-out at
  scale, and own your backend or your bill. This is a library, not a service: it runs in your own
  Route Handler and never phones home.
- **RPC subscriptions** — tRPC's are the closest typed neighbour, and cost you the tRPC stack.
  This one is ~3 kB, transport-agnostic, and independent of how you call the server.

The gap it fills is narrow and real: **typed, resumable server→client push for Next.js with no
service and no framework buy-in**. Its real limits are documented in
[Deploying](signal-bridge/README.md#deploying) — in-memory hubs are per-instance, so multi-region
fan-out and presence at scale want a real broker (a Redis-backed `AsyncSignalHub` drops in).

## Engineering notes

The parts that were actually hard, and what each solution turned on:

- **Per-property type errors.** Payload types are read off each reducer's first parameter and
  checked property-by-property, so a malformed reducer is a compile error *at that reducer* — one
  bad property can't silently degrade the whole contract. `InferState` / `InferSignals` extract the
  types back out for a Server Action's `signal` slot.
- **A trust boundary drawn in the API surface.** `ingest` takes signals you already trust; `accept`
  takes untrusted values off the wire and validates the envelope against the contract — unknown
  types, junk, prototype-shaped strings and malformed ids (which would corrupt SSE framing) are
  *dropped, never thrown*. Payload validation is opt-in per signal type, zero-dependency, and zod
  drops straight in.
- **Exactly-once under reconnection.** `Signal.id` doubles as the SSE `id:`, so the browser replays
  it as `Last-Event-ID` and the handler resumes precisely where the client left off. Fresh
  connections — a remount, a restored tab — resume too, via a cursor query param that `EventSource`
  alone can't provide. Overlap is absorbed by a replay window; a reducer that throws is contained,
  so the batch continues, the cursor doesn't advance past the failure, and a replay of that id
  doesn't retry it.
- **Failure treated as routine.** An immediate comment flush (so buffering proxies release the
  stream), 15s heartbeats, and two independent stall guards — a buffer bound and a no-reads clock.
  Closing a stalled stream is *safe* precisely because resume exists, so the design leans on
  reconnection instead of fighting it.
- **Connection sharing.** Mounts sharing a receiver and URL share one refcounted `EventSource`,
  because `next dev` speaks HTTP/1.1 and browsers cap ~6 connections per origin — scattering the
  hook across a page shouldn't cost you that budget.
- **Multi-tenancy that isn't decorative.** `createSignalHubs` is a keyed channel registry, and
  replay isolation falls out of `since()` only ever reaching one channel's backlog. Channels evict
  LRU, but never one with live subscribers — that would silently split it from future publishes.

## Testing and tooling

```bash
npm install --prefix signal-bridge
npm run check    # tsc --noEmit, strict
npm test         # 78 tests
npm run build    # tsup -> dist, plus a post-build 'use client' assertion
```

Type-level behaviour is tested, not just runtime: inference-preservation checks live alongside the
unit tests, so a refactor that quietly widens a type fails the suite. The stream is tested end to
end — server → SSE wire → client — plus heartbeat, both stall guards, abort, async `start`, resume
by header *and* by query param, a reconnecting client, and the React hooks under Strict Mode.

## Layout

```
signal-bridge/    the library. Own package.json, tsconfig, dist, LICENSE, CHANGELOG, CI.
archive/          superseded work, kept for the record. Not part of the package.
  zustand-bridge/   v2: the boundary layer over plain Zustand.
  next-bridge/      v1: the from-scratch store, and the suss0…suss11 prototypes behind it.
```

The root `package.json` is a private dev root: its `check`/`test`/`build` delegate into
`signal-bridge/`, and `check:archive` / `test:archive` still run the archived variants (51 tests)
so they can't rot unnoticed.

## The archive

The repo reads as a straight line — three implementations of one idea, each giving away more of
your app than the last.

| | [v1 `next-bridge`](archive/next-bridge/) | [v2 `zustand-bridge`](archive/zustand-bridge/) | **v3 `signal-bridge`** |
|---|---|---|---|
| Owns | the store | the channel | the channel |
| State engine | written from scratch | plain Zustand | **yours — any** |
| Delivery | Server Action, RSC | Server Action, RSC | + **live SSE push** |
| Tests | 17 | 34 | **78** |
| Status | superseded | superseded | **current** |

**v1 — own the store.** A slice store written from nothing with the signal channel built in. It
works, and it's genuinely tiny. But owning the store means owning SSR, devtools, persistence,
middleware, and the per-request instantiation that keeps one user's state out of another's — a
large surface to re-earn, all of it solved elsewhere already.

**v2 — own only the channel.** Keep plain Zustand; add one thing on top. The server-singleton
hazard disappears by construction. This is also where request *ordering* got worked out: `execute`
takes a **thunk**, not a promise, because a promise handed to a library is already in flight — you
can only watch the race, never prevent it. That layer was then cut deliberately: it had drifted
onto TanStack Query's lawn.

**v3 — own nothing.** The last thing to give away was Zustand itself. With the store gone, the
interesting problem moved to the wire.

## Status

Not on npm yet. Pre-1.0 with a well-tested core, but it has **not been run against a live Next
app** — treat it as a solid core, not a proven product. Next up: a live Next integration, and a
websocket transport (it only needs to call `receiver.accept(frame)`).

## Author

Flanders Lorton — Senior Fullstack Developer, 8+ years shipping production web apps.
[GitHub](https://github.com/florton) ·
[LinkedIn](https://www.linkedin.com/in/flanders-lorton/) ·
[flanders.lorton@gmail.com](mailto:flanders.lorton@gmail.com)

## License

MIT.
