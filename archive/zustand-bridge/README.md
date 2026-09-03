> **Archived.** Superseded by [`next-signal-bridge`](../../signal-bridge/README.md) — see the
> [repo README](../../README.md#the-archive) for why. Kept for the record; run its tests from the
> repo root with `npm run test:archive` and `npm run check:archive`.

# zustand-bridge (experimental)

A prototype of the "boundary layer, not a store" direction: keep **plain Zustand** for state, and add one thing on top — a **typed, serializable signal channel** across the Next.js server/client boundary. This is the alternative to the from-scratch store in [`../next-bridge`](../next-bridge/src/core.ts); it exists so the two approaches can be compared side by side.

## The idea

You declare a *signal contract* once — the initial state plus a reducer per `"slice/action"`. Both sides share it:

- **Server** imports it to build type-checked signals (`bridge.send(...)`) inside Server Actions / Server Components. Wrong type or payload fails `tsc`.
- **Client** attaches it to an ordinary Zustand store, which then knows how to apply those signals — with replay dedupe, out-of-order protection, and optimistic rollback.

Everything else — selectors, `useStore`, middleware, devtools, `persist`, and the **per-request store factory** — stays vanilla Zustand. Nothing is reinvented, so the server-singleton hazard from the standalone build goes away: the store is created per request in the provider, never at module scope.

## Files

| File | Role | Boundary |
|---|---|---|
| [`core.ts`](core.ts) | `defineBridge`, `send`, `Signal` types | server-safe, zero-dep |
| [`react.tsx`](react.tsx) | `withBridge` (adds `execute`/`ingest`), `BridgeProvider`, `BridgeSignal` | `'use client'` |
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
| `queue` (default when `key` or `optimistic` is set) | Next request waits for the previous to settle | Mutations to one resource |
| `last-wins` | Parallel; only the newest response applies | Type-ahead / search |
| `none` (default otherwise) | Parallel; every response applies | Independent or accumulative work |

`key` is the ordering scope — usually a resource identity like `todo:${id}`. Different keys never block each other, which is why ordering is keyed by resource rather than by signal type: two concurrent edits to *different* todos must not cancel one another.

**Optimistic calls are ordered by default.** An optimistic patch is precisely what a slow earlier response would clobber, so if you pass `optimistic` without a `key`, the signal's own type becomes the key. Same-type mutations serialize — safe, if coarse. Pass a precise key to parallelize unrelated resources, or `order: 'none'` to opt out:

```ts
store.execute(() => saveName(draft), { optimistic: rename(draft) });                  // ordered
store.execute(() => saveTodo(id, t), { optimistic: upd(id, t), key: `todo:${id}` });  // per-resource
```

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

A failure rolls back the patch but **still delivers its signal**, so an action can report what went wrong:

```ts
return { ok: false, error: 'Save failed', signal: appBridge.send('notice/show', { text: 'Save failed' }) };
```

**Head-of-line blocking** is the queue's inherent risk, so it's designed for: a queued op that exceeds `timeoutMs` (default 30s, `Infinity` disables) releases its slot, rejects with `BridgeTimeoutError`, rolls back its optimistic patch, and has its late result ignored. A rejected op doesn't strand the ops behind it, and drained keys are dropped from the internal map. The one honest limit: an in-flight Server Action can't actually be cancelled — on timeout we stop waiting, we don't stop the server.

```tsx
// any Server Component → client, no framework internals
<BridgeSignal signal={appBridge.send('notice/show', { text: 'Payment received' })} />
```

### Signals are for events, not initial data

Signals apply in an effect — **after hydration**. For an event that's exactly right: a payment confirmation hasn't happened at first paint, so there's no earlier value it could have had.

For data the server already knew, it's a bug. The HTML ships the *stale* value and stays visibly wrong until JS downloads, parses, and hydrates — seconds on a mid-range phone, since hydration is CPU-bound as much as network-bound. It stays wrong permanently for crawlers, link unfurls, and any page where a script throws. Then it flips, which users read as jank:

```tsx
// ✗ `plan` is a fact the server already knew. This renders "free", then
//   corrects itself to "pro" after hydration.
<BridgeSignal signal={appBridge.send('user/setPlan', { plan })} />
```

This isn't a tradeoff you pay to avoid — the alternatives are *less* code:

| The data is… | Use | Why |
|---|---|---|
| Known by the server, needed by a component at first paint | **RSC prop** | Correct in the first byte; no store, no client JS |
| Known by the server, needed by the *store* at first paint | **Seed `Providers initialState`** | Client components render on the server too, so the store is built during SSR already correct — and hydration matches |
| Something that *happened* after the page exists | **`BridgeSignal`** | Post-hydration timing is the right semantics |

Nothing in the library can fix this: applying a signal during render would mean mutating an external store mid-render, which React forbids (it breaks concurrent rendering) and which would be order-dependent — components above the signal would read the old value, ones below the new one, producing inconsistent HTML. Post-hydration is architectural.

The rule of thumb: **the store holds client state; the server's own data belongs in props or the seed.** Pulling server-authoritative data into a client store is how you end up with two sources of truth that drift — the problem TanStack Query exists to manage.

### Devtools

If your store uses Zustand's `devtools` middleware, every server-driven update arrives **named** in Redux DevTools rather than as an anonymous `setState`:

```
cart/add
user/rename (optimistic)
user/rename (rollback)
```

Nothing to configure — the bridge passes the signal type as the action label, and a store without the middleware ignores it.

## What this buys over standalone-store next-bridge

- **No reinvented store** → inherits Zustand's SSR story, devtools, persistence, middleware.
- **Correct server safety by construction** — per-request store, so no cross-request state bleed.
- Same three channels (Server Action, RSC, client) and the same guarantees (dedupe, ordering, optimistic rollback), but the state engine is battle-tested.

## Where it could go next

The natural extension is a **real-time transport**: `ingest()` already accepts externally-delivered signals, so a websocket/SSE stream of typed deltas would patch client state with dedupe + ordering already handled — something neither Zustand nor TanStack Query offers in a typed form. That, plus the type-safe `send()`, is the sharpest reason to pick this over rolling your own.

## Packaging note

Zustand is a **devDependency** of this repo, because the published package here is the standalone `next-bridge` (`files: ["src"]`), which doesn't use Zustand at all — shipping it as a runtime dependency would make every consumer install it for nothing. If this direction becomes the shipped package, Zustand moves to `peerDependencies` (`"zustand": ">=5"`), never a dependency: a library bundling its own copy risks two Zustand instances and therefore two stores.

## Status

Prototype. `defineBridge` + `withBridge` + `execute`/`ingest`/`BridgeSignal` are implemented and unit-tested ([`bridge.test.ts`](bridge.test.ts)); the typed-signal contract is locked by [`types.check.ts`](types.check.ts). Not packaged — this folder is for evaluating the approach, not publishing.
