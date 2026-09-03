# Bridge

Three takes on one problem: **a state change happens on the Next.js server — how does it
reach the client with its types intact?**

All three share a shape. You declare a *contract* once in server-safe code: the initial
state, plus a reducer per `"slice/action"`. The server builds signals against it
(`send('order/status', { status: 'shipped' })`) and the client applies them. A wrong
action name or payload fails `tsc` rather than production.

They differ in **how much of your app they insist on owning**, and the repo reads as a
straight line: each version gives away more than the last.

| | [`next-bridge/`](next-bridge/) | [`zustand-bridge/`](zustand-bridge/) | [`signal-bridge/`](signal-bridge/) |
|---|---|---|---|
| Owns | the store | the channel | the channel |
| State engine | written from scratch | plain Zustand | **yours — any** |
| Delivery | Server Action, RSC | Server Action, RSC | + **live SSE push** |
| Package | `next-bridge` 0.12.0 | not packaged | `next-signal-bridge` 0.2.0 |
| Tests | 17 | 34 | 78 |
| Status | superseded | experiment | **current** |

## Start here

**[`signal-bridge/`](signal-bridge/README.md) is the one to read.** It is the most recent,
the most agnostic, and the only one built to be published — LICENSE, changelog, `tsup`
build, and a CI matrix (Node 18/20/22 × React 18/19) that arms itself the moment the
folder is extracted to its own repo. The other two are kept because the reasoning that
produced it is visible in them, not out of nostalgia.

## How it got here

**`next-bridge` — own the store.** The first answer: a small slice store written from
nothing, with the signal channel built in. It works, and it is genuinely tiny (~1.4 kB
min+gzip, zero dependencies). But owning the store means owning SSR, devtools,
persistence, middleware, and the per-request instantiation that keeps one user's state
from bleeding into another's — a large surface to re-earn, and all of it solved
elsewhere already.

**`zustand-bridge` — own only the channel.** So: keep plain Zustand, and add one thing on
top. The server-singleton hazard disappears by construction (the store is created per
request in the provider, never at module scope), and Zustand's ecosystem comes along for
free. This is also where request *ordering* got worked out — `execute` takes a thunk
rather than a promise, because a promise is already in flight by the time you hand it
over, so a library given one can only watch the race, never prevent it. Owning *when* the
request fires is what makes `order: 'queue'` possible, and that matters more than it
looks: dropping a stale response doesn't undo a stale write.

**`signal-bridge` — own nothing.** The last thing to give away was Zustand itself. A
`Target` is two functions, `getState` and `setState`, so Zustand, Redux, Jotai or a plain
object all work and the library never imports a state library at all. With the store
gone, the interesting problem moved to the wire: deltas now arrive over an SSE Route
Handler with replay dedupe, a resume cursor, heartbeats and two stall guards — and the
same contract still covers a Server Action's return value and the RSC tree. One contract,
any transport, any store.

## Layout

```
signal-bridge/    next-signal-bridge — current. Own package.json, dist, LICENSE, CHANGELOG.
zustand-bridge/   the boundary-layer experiment. Unit-tested, deliberately unpackaged.
next-bridge/      v1: the from-scratch store.
  src/              the library
  demo12/           a full runnable example app
  test/             unit + type tests
  archive/          suss0…suss11 — the prototypes behind v1. Not typechecked, not shipped.
```

The root `package.json` is both the v1 `next-bridge` manifest and the shared dev
toolchain (TypeScript, Vitest, React) for all three. `signal-bridge/` additionally carries
its own manifest, because it is the one that gets published.

## Running it

```bash
npm install
npm run check    # tsc --noEmit across all three
npm test         # 129 tests
```

`next-bridge/archive/` is excluded from both by design — the root `tsconfig.json` names
its includes rather than globbing.

## Status

Nothing here is on npm yet. `signal-bridge` is pre-1.0 with a well-tested core but has
not been run against a live Next app — treat it as a solid core, not a proven product.

## License

MIT.
