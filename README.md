# Bridge

**Typed, deduplicated state deltas from a Next.js server to the browser — over SSE, a Server
Action's return value, or the RSC tree. One contract, any store, zero dependencies.**

TypeScript · React 18/19 · Node ≥ 18 · 129 tests · `tsc --strict` clean · MIT

A state change happens on the server. How does it reach the client *with its types intact?*
You declare a contract once in server-safe code — initial state, plus a reducer per
`"slice/action"` — and both sides check against it:

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

This repo holds **three implementations of that idea**, built in sequence. Each one gives away
more of your app than the last, and the third — [`signal-bridge/`](signal-bridge/README.md) — is
the current, publishable one.

---

## Start here

**[`signal-bridge/` → full documentation](signal-bridge/README.md)** — published as
`next-signal-bridge`. It is the most recent, the most agnostic, and the only one built to ship:
own `package.json`, `tsup` build, LICENSE, changelog, and a CI matrix (Node 18/20/22 × React
18/19) that arms itself the moment the folder is extracted to its own repo.

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

## Why three versions

The repo reads as a straight line. Each version was written because the previous one owned
something it had no business owning.

| | [`next-bridge/`](next-bridge/) | [`zustand-bridge/`](zustand-bridge/) | [`signal-bridge/`](signal-bridge/) |
|---|---|---|---|
| Owns | the store | the channel | the channel |
| State engine | written from scratch | plain Zustand | **yours — any** |
| Delivery | Server Action, RSC | Server Action, RSC | + **live SSE push** |
| Package | `next-bridge` 0.12.0 | not packaged | `next-signal-bridge` 0.2.0 |
| Tests | 17 | 34 | **78** |
| Status | superseded | experiment | **current** |

**v1 · `next-bridge` — own the store.** A slice store written from nothing with the signal
channel built in. It works, and it is genuinely tiny (~1.3 kB min+gzip, zero dependencies). But
owning the store means owning SSR, devtools, persistence, middleware, and the per-request
instantiation that keeps one user's state from bleeding into another's — a large surface to
re-earn, all of it solved elsewhere already.

**v2 · `zustand-bridge` — own only the channel.** Keep plain Zustand; add one thing on top. The
server-singleton hazard disappears by construction (the store is created per request in the
provider, never at module scope), and Zustand's ecosystem comes along for free. This is also
where request *ordering* got worked out: `execute` takes a **thunk**, not a promise, because a
promise handed to a library is already in flight — you can only watch the race, never prevent
it. Owning *when* the request fires is what makes `order: 'queue'` possible, and that matters
more than it looks: dropping a stale response doesn't undo a stale write. Optimistic patches
roll back on failure, and ordering is scoped by key, so unrelated resources still run in parallel.

**v3 · `signal-bridge` — own nothing.** The last thing to give away was Zustand itself. With the
store gone, the interesting problem moved to the wire: deltas now arrive over an SSE Route
Handler with replay dedupe, a resume cursor, heartbeats and two stall guards — and the same
contract still covers a Server Action's return value and the RSC tree.

## Engineering notes

The parts that were actually hard, and what each solution turned on:

- **Per-property type errors.** Payload types are read off each reducer's first parameter and
  checked property-by-property, so a malformed reducer is a compile error *at that reducer* —
  one bad property can't silently degrade the whole contract. `InferState` / `InferSignals`
  extract the types back out for a Server Action's `signal` slot.
- **A trust boundary drawn in the API surface.** `ingest` takes signals you already trust;
  `accept` takes untrusted values off the wire and validates the envelope against the contract —
  unknown types, junk, prototype-shaped strings and malformed ids (which would corrupt SSE
  framing) are *dropped, never thrown*. Payload validation is opt-in per signal type,
  zero-dependency, and zod drops straight in.
- **Exactly-once under reconnection.** `Signal.id` doubles as the SSE `id:`, so the browser
  replays it as `Last-Event-ID` and the handler resumes precisely where the client left off.
  Fresh connections — a remount, a restored tab — resume too, via a cursor query param that
  `EventSource` alone can't provide. Overlap is absorbed by a replay window; a reducer that
  throws is contained, so the batch continues, the cursor doesn't advance past the failure, and a
  replay of that id doesn't retry it.
- **Failure treated as routine.** An immediate comment flush (so buffering proxies release the
  stream), 15s heartbeats, and two independent stall guards — a buffer bound and a no-reads
  clock. Closing a stalled stream is *safe* precisely because resume exists, so the design leans
  on reconnection instead of fighting it.
- **Connection sharing.** Mounts sharing a receiver and URL share one refcounted `EventSource`,
  because `next dev` speaks HTTP/1.1 and browsers cap ~6 connections per origin — scattering the
  hook across a page shouldn't cost you that budget.
- **Multi-tenancy that isn't decorative.** `createSignalHubs` is a keyed channel registry, and
  replay isolation falls out of `since()` only ever reaching one channel's backlog. Channels
  evict LRU, but never one with live subscribers — that would silently split it from future
  publishes.
- **An honest serverless story.** In-memory hubs are per-instance, and that failure mode is
  *silent*: a publish on one instance never reaches a stream pinned to another. So the hub shape
  is exposed as `AsyncSignalHub` — reads allowed to be async — and a route written against it
  swaps to a Redis backing without a line changing. The docs say plainly where the library is the
  wrong tool: thousands of concurrent connections on serverless, multi-region fan-out, presence
  at scale.

## Testing and tooling

```bash
npm install
npm run check    # tsc --noEmit, strict, across all three variants
npm test         # 129 tests (17 next-bridge · 34 zustand-bridge · 78 signal-bridge)
```

Type-level behaviour is tested, not just runtime: inference-preservation checks live alongside
the unit tests, so a refactor that quietly widens a type fails the suite. The stream is tested
end to end — server → SSE wire → client — plus heartbeat, both stall guards, abort, async
`start`, resume by header *and* by query param, a reconnecting client, and the React hooks under
Strict Mode. `signal-bridge` builds with `tsup` and a post-build script that asserts the
`'use client'` directive survived into `dist/react.js`.

`next-bridge/archive/` is excluded from both commands by design — the root `tsconfig.json` names
its includes rather than globbing.

## Layout

```
signal-bridge/    next-signal-bridge — current. Own package.json, dist, LICENSE, CHANGELOG, CI.
zustand-bridge/   the boundary-layer experiment. Unit-tested, deliberately unpackaged.
next-bridge/      v1: the from-scratch store.
  src/              the library
  demo12/           a full runnable example app
  test/             unit + type tests
  archive/          suss0…suss11 — the prototypes behind v1. Not typechecked, not shipped.
```

The root `package.json` is both the v1 `next-bridge` manifest and the shared dev toolchain
(TypeScript, Vitest, React) for all three. `signal-bridge/` additionally carries its own
manifest, because it is the one that gets published.

## Status

Nothing here is on npm yet. `signal-bridge` is pre-1.0 with a well-tested core, but has not been
run against a live Next app — treat it as a solid core, not a proven product. Next up: a live
Next integration, and a websocket transport (it only needs to call `receiver.accept(frame)`).

## Author

Flanders Lorton — Senior Fullstack Developer, 8+ years shipping production web apps.
[GitHub](https://github.com/florton) ·
[LinkedIn](https://www.linkedin.com/in/flanders-lorton/) ·
[flanders.lorton@gmail.com](mailto:flanders.lorton@gmail.com)

## License

MIT.
