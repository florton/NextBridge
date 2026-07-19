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

## Wiring a store

The seam is two functions — swap Zustand for anything here:

```ts
const receiver = createReceiver(appBridge, {
  getState: () => store.getState(),
  setState: (patch, label) => store.setState(patch, false, label),
});
```

Create it **per request**, not at module scope: client components render on the server too, and a shared store bleeds state between users. The `label` is the signal type — with Zustand's `devtools` middleware every server-pushed delta shows up named in the timeline, for free.

## The live stream

```ts
// app/api/stream/route.ts
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return signalStream(request, ({ emit, lastEventId }) => {
    for (const missed of backlogSince(lastEventId)) emit(missed);

    const off = orderEvents.subscribe((status) =>
      emit(appBridge.send('order/status', { status })),
    );
    return off; // cleanup on disconnect — without it you leak a subscription per client
  });
}
```

```tsx
useSignalStream('/api/stream'); // connected while mounted
```

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

## API

| Export | Where | Notes |
|---|---|---|
| `defineBridge(initialState, reducers)` | server-safe | The contract |
| `bridge.send(type, payload?)` | server-safe | Typed signal factory |
| `bridge.parse(raw)` | server-safe | Envelope validation for untrusted input |
| `createReceiver(bridge, target)` | any runtime | `ingest` / `accept` / `lastId` |
| `signalStream(request, start, options?)` | server | SSE `Response` for a Route Handler — heartbeat, backpressure, resume built in |
| `connectSignalStream(receiver, url, options?)` | client | Returns a disconnect function; resumes fresh connections, rebuilds on fatal errors |
| `SignalProvider` / `useSignalStream` / `BridgeSignal` | `'use client'` | React helpers |

## Status

Prototype, and untested against a running Next server — the suite covers the contract, the receiver (including throw containment), the stream's lifecycle (heartbeat, backpressure, abort, resume via header and query param), a reconnecting client, and a real server → SSE wire → client round trip, but jsdom and `renderToString` are not streaming RSC. Next up: a websocket transport, React tests for `useSignalStream`, and pointing it at a live app.

Related experiments in this repo: [`../zustand-bridge`](../zustand-bridge/README.md) (this plus a Zustand-coupled mutation layer) and [`../src`](../src/core.ts) (a from-scratch store). This folder is the focused version — the other two overlap with TanStack Query on purpose, and lost.
