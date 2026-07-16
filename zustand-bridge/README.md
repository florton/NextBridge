# zustand-bridge (experimental)

A prototype of the "boundary layer, not a store" direction: keep **plain Zustand** for state, and add one thing on top — a **typed, serializable signal channel** across the Next.js server/client boundary. This is the alternative to the from-scratch store in [`../src`](../src/core.ts); it exists so the two approaches can be compared side by side.

## The idea

You declare a *signal contract* once — the initial state plus a reducer per `"slice/action"`. Both sides share it:

- **Server** imports it to build type-checked signals (`bridge.send(...)`) inside Server Actions / Server Components. Wrong type or payload fails `tsc`.
- **Client** attaches it to an ordinary Zustand store, which then knows how to apply those signals — with replay dedupe, out-of-order protection, and optimistic rollback.

Everything else — selectors, `useStore`, middleware, devtools, `persist`, and the **per-request store factory** — stays vanilla Zustand. Nothing is reinvented, so the server-singleton hazard from the standalone build goes away: the store is created per request in the provider, never at module scope.

## Files

| File | Role | Boundary |
|---|---|---|
| [`core.ts`](core.ts) | `defineBridge`, `send`, `Signal` types | server-safe, zero-dep |
| [`react.tsx`](react.tsx) | `attachBridge` (adds `execute`/`ingest`), `BridgeProvider`, `BridgeSignal` | `'use client'` |
| [`demo/`](demo/bridge.ts) | contract, per-request store factory, provider, server actions, components | — |

## Shape

```ts
// bridge.ts — server-safe, shared by both sides
interface AppState { user: { name: string; plan: 'free' | 'pro' }; cart: { items: string[] } }
const initialState: AppState = { user: { name: 'Ada', plan: 'free' }, cart: { items: [] } };

export const appBridge = defineBridge(initialState, {
  'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
  'cart/clear':  (_: void, s)            => ({ cart: { ...s.cart, items: [] } }),
});
```

```ts
// actions.ts — 'use server'.  send() is fully type-checked here.
export async function checkout(skus: string[]) {
  return { ok: true as const, orderId: await placeOrder(skus), signal: appBridge.send('cart/clear') };
}
```

```tsx
// client — plain Zustand read + the bridge channel
const name  = useApp((s) => s.user.name);      // Zustand selector
const store = useAppStore();

await store.execute(() => saveName(draft), {
  optimistic: appBridge.send('user/rename', { name: draft }),
  key: 'user:me',   // ops sharing a key are sent one at a time
});
```

### Why `execute` takes a function

A promise is already in flight the moment you write `saveName(draft)`, so a library handed a promise can only *watch* the race — it can never prevent one. Taking a thunk means `execute` owns **when** the request fires.

That's what makes `order: 'queue'` possible, and it matters more than it first looks: with parallel requests, dropping a stale *response* doesn't undo the stale *write*. The server may still have applied the older one last, so the client shows the new value while the database holds the old one — and the edit reappears on refresh. Queueing fixes the ordering end to end instead of hiding it.

| `order` | Behaviour | Use for |
|---|---|---|
| `queue` (default with `key`) | Next request waits for the previous to settle | Mutations to one resource |
| `last-wins` | Parallel; only the newest response applies | Type-ahead / search |
| `none` (default without `key`) | Parallel; every response applies | Independent or accumulative work |

`key` is the ordering scope — usually a resource identity like `todo:${id}`. Different keys never block each other, which is why ordering is keyed by resource rather than by signal type: two concurrent edits to *different* todos must not cancel one another.

### Optimistic updates must declare success

Pass `optimistic` and the result type is required to include `ok: boolean`. The library has to be told whether to keep the patch or undo it, and a result that reports failure its own way (`{ success: false }`, `{ error }`) would otherwise leave a failed optimistic update on screen with no error and no warning:

```ts
// ✗ won't compile — optimistic is in play, so `ok` is mandatory
store.execute(() => Promise.resolve({ success: false }), { optimistic: sig });

// ✓
store.execute(() => saveName(draft), {
  optimistic: appBridge.send('user/rename', { name: draft }),
  key: 'user:me',
});
```

Without `optimistic` there's nothing to roll back, so `ok` stays optional. A thrown error always rolls back regardless — `ok` exists for actions that *return* their failures instead of throwing, which is the common Next.js style. JS callers who slip past the types get a dev warning rather than silence.

**Head-of-line blocking** is the queue's inherent risk, so it's designed for: a queued op that exceeds `timeoutMs` (default 30s, `Infinity` disables) releases its slot, rejects with `BridgeTimeoutError`, rolls back its optimistic patch, and has its late result ignored. A rejected op doesn't strand the ops behind it, and drained keys are dropped from the internal map. The one honest limit: an in-flight Server Action can't actually be cancelled — on timeout we stop waiting, we don't stop the server.

```tsx
// any Server Component → client, no framework internals
<BridgeSignal signal={appBridge.send('user/setPlan', { plan })} />
```

## What this buys over standalone-store next-bridge

- **No reinvented store** → inherits Zustand's SSR story, devtools, persistence, middleware.
- **Correct server safety by construction** — per-request store, so no cross-request state bleed.
- Same three channels (Server Action, RSC, client) and the same guarantees (dedupe, ordering, optimistic rollback), but the state engine is battle-tested.

## Where it could go next

The natural extension is a **real-time transport**: `ingest()` already accepts externally-delivered signals, so a websocket/SSE stream of typed deltas would patch client state with dedupe + ordering already handled — something neither Zustand nor TanStack Query offers in a typed form. That, plus the type-safe `send()`, is the sharpest reason to pick this over rolling your own.

## Status

Prototype. `defineBridge` + `attachBridge` + `execute`/`ingest`/`BridgeSignal` are implemented and unit-tested ([`bridge.test.ts`](bridge.test.ts)); the typed-signal contract is locked by [`types.check.ts`](types.check.ts). Not packaged — this folder is for evaluating the approach, not publishing.
