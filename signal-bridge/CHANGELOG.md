# Changelog

## 0.2.0 — 2026-07-19

Renamed **signal-bridge → next-signal-bridge** (the old name is taken on npm). No published users existed, so this window absorbs all breaking changes; semver discipline starts here.

### Added

- **`createSignalHubs`** (`/server`) — keyed channel registry for scoping streams to users, tenants, or rooms. Replay isolation per channel; LRU eviction past `maxChannels` that never evicts a channel with live subscribers.
- **`SignalHub.subscriberCount()`**.
- **`AsyncSignalHub`** type (`/server`) — the hub shape with async reads, the seam for Redis/Postgres backings. `signalStream`'s `start` callback may now be async (and its resolved cleanup is honored even if the stream ended first).
- **`maxStallMs`** stream option (default 60s) — time-based dead-client detection complementing the frame-count guard `maxBufferedFrames`, which alone could hold a vanished client for hours on a quiet stream.
- **Shared client connections** — `useSignalStream` mounts with the same receiver and URL now share one refcounted EventSource (HTTP/1.1 allows ~6 per origin; `next dev` is HTTP/1.1). Every sharer's callbacks fire; `shared: false` opts out.
- **`payloadGuards`** option on `defineBridge` — opt-in per-type payload validation inside `parse`, zod-compatible, for streams that cross a trust boundary.
- **`uuid()` fallback hardened** — a monotonic counter guarantees per-process uniqueness where `crypto.randomUUID` is unavailable (insecure contexts).
- README rewritten around deployment reality (single-process vs. serverless, reference Redis hub, scoping recipes), LICENSE file, this changelog, CI workflow (Node 18/20/22 × React 18/19).

### Changed

- **The reducer-inference footgun is gone.** `defineBridge` now infers payload types per property (from each reducer's first parameter) instead of reverse-inferring the whole reducers literal. Previously, one malformed reducer made TypeScript silently abandon inference and type *every* payload `unknown` — `send` stopped type-checking with no error anywhere. Now a malformed reducer is a compile error at that property. The explicit contract-first form (`defineBridge<State, Signals>`) still works via a second overload, with the same per-property errors. New exported types: `ReducerMap`, `PayloadsOf`.

- `hub.since()` resolves cursors in O(1) via an id→sequence map (was a ring scan), with re-published ids resolving to their latest occurrence.
- A `useSignalStream` mount joining an already-open shared connection now receives an immediate `onOpen`, so per-component "connected" state initializes correctly.
- `dist/react.js` carries a single `'use client'` directive (was doubled: banner + preserved source directive). The build now asserts the directive survives bundling (`scripts/assert-use-client.mjs`).

### Fixed

- `demo/hub.ts` now actually pins the hub to `globalThis` (the comment claimed it; the code didn't), so dev HMR can't split subscribers from publishers.

## 0.1.0

Initial extraction: the contract (`defineBridge`), the receiver, the SSE transport (server + client), the in-memory hub, and the React glue (`SignalProvider`, `useSignalStream`, `BridgeSignal`).
