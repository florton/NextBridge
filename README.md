# Next Bridge

Typed, serializable **signals** across the Next.js server/client boundary, plus a tiny slice store to receive them. Server Actions and Server Components return plain-data instructions; the client store applies them with full TypeScript inference end to end.

- **Type-safe end to end** — slice names, action names, and payloads are all inferred. A typo'd action or wrong payload shape in a Server Action fails `tsc`, not production.
- **Fast by construction** — per-slice subscriptions and `Object.is` selector bailouts mean a component re-renders only when the exact value it reads changes. Store updates are an O(1) map lookup, not a reducer scan.
- **Small** — ~1.4 kB min+gzip total, zero dependencies, React 18+ as the only peer. No Next.js import, so it can't break on a Next internals refactor.
- **Honest about the platform** — works *with* the App Router (RSC props, Server Action return values), not against it. No `__NEXT_DATA__` or other undocumented internals.

```
npm: not yet published — see "Publishing" below.
Until then: copy src/core.ts and src/client.tsx into your app (e.g. lib/bridge/).
```

---

## Mental model

A **Signal** is a JSON-safe instruction: `{ id, type: 'slice/action', payload }`. Anything that can serialize a signal can drive the client store:

| Channel | You write | Client applies it via |
|---|---|---|
| Server Action → client | `return { ok, ...data, signal: store.send(...) }` | `store.execute(actionPromise)` |
| Server Component → client | `<BridgeSignal signal={store.send(...)} />` | effect after hydration, deduped by id |
| Client → client | `actions.cart.add({ sku })` | immediate dispatch |

Handlers are pure reducers `(payload, state) => nextState`. They always run against the state **at the moment of execution** — never a captured snapshot — so rapid-fire dispatches can't regress each other.

## Quickstart

### 1. Define the store — `app/store.ts` (no directive; importable everywhere)

```ts
import { createStore, slice } from 'next-bridge';

export const appStore = createStore({
  user: slice(
    { name: 'Ada', plan: 'free' as 'free' | 'pro' },
    {
      rename:  (payload: { name: string }, state) => ({ ...state, name: payload.name }),
      setPlan: (payload: { plan: 'free' | 'pro' }, state) => ({ ...state, plan: payload.plan }),
    },
  ),
  cart: slice(
    { items: [] as string[] },
    {
      add:   (payload: { sku: string }, state) => ({ items: [...state.items, payload.sku] }),
      clear: (_: void, state) => ({ ...state, items: [] }), // void payload → zero-arg action
    },
  ),
});
```

Annotate **payloads**; `state` is typed for you from the slice's initial state.

### 2. Providers file — `app/providers.tsx`

A store holds functions, so a Server Component can't pass it as a prop. Bind it inside a one-time client wrapper (the same pattern Redux and Zustand document for Next.js):

```tsx
'use client';
import { BridgeProvider } from 'next-bridge/client';
import { appStore } from './store';

export function Providers({ children }: { children: React.ReactNode }) {
  return <BridgeProvider store={appStore}>{children}</BridgeProvider>;
}
```

```tsx
// app/layout.tsx — stays a Server Component
import { Providers } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
```

### 3. Read and write from client components

```tsx
'use client';
import { useBridge } from 'next-bridge/client';
import { appStore } from './store';

export function Cart() {
  const [cart, actions] = useBridge(appStore, 'cart');           // whole slice
  return <button onClick={() => actions.add({ sku: 'A1' })}>{cart.items.length}</button>;
}

export function PlanBadge() {
  const [plan] = useBridge(appStore, 'user', (s) => s.plan);     // selector: re-renders
  return <span>{plan}</span>;                                    // only when plan changes
}
```

`store.actions` also works outside React — event handlers, tests, anywhere.

### 4. Server Action back-channel

```ts
// app/actions.ts
'use server';
import { appStore } from './store';

export async function checkout(skus: string[]) {
  const orderId = await placeOrder(skus);
  return { ok: true as const, orderId, signal: appStore.send('cart', 'clear') };
}
```

```tsx
// client
const result = await appStore.execute(checkout(cart.items));
console.log(result.orderId); // typed — execute returns your result as-is
```

### 5. Server Component → client signal

```tsx
// app/page.tsx — Server Component
import { BridgeSignal } from 'next-bridge/client';
import { appStore } from './store';

export default async function Page() {
  const plan = await getPlanFromDb();
  return (
    <main>
      <BridgeSignal signal={appStore.send('user', 'setPlan', { plan })} />
      {/* ... */}
    </main>
  );
}
```

Streaming-safe: the signal applies when its chunk mounts. Each signal id applies at most once, so Strict Mode double-effects and back/forward re-mounts don't double-fire.

### 6. Optimistic updates

```tsx
const result = await appStore.execute(saveName(draft), {
  optimistic: appStore.send('user', 'rename', { name: draft }),
});
```

The optimistic signal applies immediately. If the promise **rejects** or resolves with **`ok: false`**, the affected slice rolls back to its pre-optimistic state.

A full runnable example lives in [`demo12/`](demo12/store.ts).

---

## API

### `next-bridge` (server-safe core — no React)

| Export | Signature | Notes |
|---|---|---|
| `slice` | `slice(initialState, handlers)` | Inference helper; handlers are `(payload, state) => nextState` |
| `createStore` | `createStore({ name: slice(...) })` | Builds routes and bound actions once, at creation |
| `store.get()` | `() => state tree` | Slice references are replaced on every update |
| `store.initial` | readonly state tree | Frozen at creation; the SSR snapshot |
| `store.actions` | `actions.user.rename({ name })` | Stable references; usable outside React |
| `store.send` | `send('user', 'rename', { name })` | Creates a `Signal` — server-safe, fully checked |
| `store.dispatch` | `dispatch(signal)` | Immediate, no dedupe/ordering guard |
| `store.ingest` | `ingest(signal \| signal[] \| null)` | Dedupes by signal id; for custom transports (SSE, WS) |
| `store.execute` | `execute(promise, { optimistic? })` | Applies `result.signal`, guards ordering, handles rollback |
| `store.subscribe` | `subscribe('user', fn) => unsub` | Per-slice; the hook uses this internally |

### `next-bridge/client` (`'use client'`)

| Export | Signature | Notes |
|---|---|---|
| `BridgeProvider` | `<BridgeProvider store={appStore}>` | Binds the store for `<BridgeSignal>`; render inside your providers file |
| `BridgeSignal` | `<BridgeSignal signal={...} />` | Renders `null`; applies signal(s) post-hydration, deduped by id |
| `useBridge` | `useBridge(store, 'slice', selector?)` → `[value, actions]` | SSR-safe subscription with selector bailout |

---

## Semantics and guarantees

**Rendering.** Subscriptions are registered per slice, so an update to `cart` never even evaluates `user` subscribers. With a selector, the hook keeps the previous result when `Object.is` says the selected value didn't change, and React bails out of the re-render.

**SSR / hydration.** `useBridge` passes a `getServerSnapshot` that reads `store.initial`, satisfying React 18's `useSyncExternalStore` contract — no SSR throw, no hydration mismatch. Server-created signals apply *after* hydration, in an effect. Consequence: the first client paint shows initial state. For data that must be correct at first paint, render it as ordinary RSC props/children; use signals for events and cache-sync, not initial data.

**Race protection** (the two desync traps):

1. *Stale client reads* — handlers are executed against live state at dispatch time, functional-update style. Two rapid `increment`s always see each other's writes.
2. *Chronological reversals* — every `execute` takes a monotonic sequence number at call time. If op #2's response lands before op #1's, op #1's late signal of the same type is dropped instead of overwriting newer data.

**Optimistic rollback** restores a slice-level snapshot taken just before the optimistic signal applied. If *other* writes hit the same slice while the action was in flight, rollback restores the snapshot over them (last-write-wins). Keep optimistic actions scoped to the state they own.

**Unknown signals** (e.g., a stale client receiving a signal for a handler you've since renamed) are dropped with a dev-only warning — never a crash. Routing is a `Map` lookup, so hostile-looking type strings like `"__proto__/x"` are inert.

**Module scope.** `createStore` state lives at module scope. On the server, nothing writes to it (signals apply client-side only), so there is no cross-request leakage; the server only ever reads `initial`.

---

## Design notes — v11 → v12

The v11 "finalthoughts" checklist, resolved:

| Concern | Resolution |
|---|---|
| Server Action race conditions | Handlers already run functionally against live state; added the `execute` sequence guard for out-of-order responses |
| SSR hydration safety | `getServerSnapshot` backed by `store.initial` (cached per hook — stable references) |
| `__NEXT_DATA__` fragility | **Removed.** It was a Pages Router internal and never fires under the App Router. Replaced by explicit `<BridgeSignal>` in the RSC tree — documented, streaming-safe, and testable |
| Functional reducers | Reducer contract `(payload, state) => next`; same-reference returns skip notification |
| Transaction identifiers | Signal `id` (replay dedupe) + per-`execute` sequence numbers (ordering) |
| Optimistic updates | `execute(promise, { optimistic })` with rollback on reject / `ok: false` |

Two v11 bugs fixed in passing:

- `send`'s payload was typed as the handler's whole `Parameters` tuple (`[payload, state]`), so the README's own example didn't type-check. Now `PayloadOf<H, A>` extracts the first parameter.
- The library was one `'use client'` monolith, but `store.send` is called inside `'use server'` files, and the store was passed as a prop from a server layout — both boundary violations at runtime. Hence the core/client split and the providers-file pattern.

## Testing

`npm test` runs the core suite (17 tests): action/state semantics, per-slice notification isolation, no-op change detection, signal serialization round-trip, ingest replay dedupe, and the full `execute` matrix — out-of-order responses, optimistic apply, rollback on reject, rollback on `ok: false`.

`npm run check` type-checks the library, the demo app, **and** [`test/types.check.ts`](test/types.check.ts), a compile-time contract: every `@ts-expect-error` in it must stay an error, so inference regressions fail CI.

Still to add (the "ruthless suite" blueprint):

- **Render-count assertions** — `@testing-library/react` + jsdom: assert a selector component records exactly one render when an unrelated property in its slice updates.
- **E2E network simulation** — Playwright: 2s-delayed Server Action, assert loading state, rollback on failure, and no flicker on out-of-order resolution.

## Publishing checklist

- **The name `next-bridge` is taken on npm** (an existing 0.0.1). Pick a scope (`@yourorg/next-bridge`) or a variant before publishing.
- Build `dist/` (`esbuild` for ESM + `tsc --emitDeclarationOnly` for types), point `exports` at it, and keep the `'use client'` banner on the client bundle (esbuild preserves it from the source directive with `--banner` if needed).
- Ship `sideEffects: false` (already set) so the core tree-shakes out of client-only apps and vice versa.

## License

MIT
