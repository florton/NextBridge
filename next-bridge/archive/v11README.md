# Action-State Bridge Framework

An ultra-lightweight, zero-boilerplate global state manager and server event-bus custom-built for Next.js App Router applications. It bridges the asynchronous gap between Next.js **Server Actions** and reactive client-side components with true micro-state isolation and zero external dependencies.

## Key Features
* 🔋 **Zero External Dependencies**: Engineered purely using native React primitives (`useSyncExternalStore`).
* ⚡ **Maximum Performance Isolation**: Category-level slicing and granular property selectors completely bypass root re-render bottlenecks.
* 🛰️ **Implicit Layout Streaming**: Automatically intercepts layout data frames (`__NEXT_DATA__`) embedded inside server-streamed payloads.
* 🪄 **Type-Inferred Developer Experience**: Define your baseline stores as plain JavaScript objects and enjoy seamless, automatic TypeScript autocomplete across client hooks and server data payloads.

---

## Installation & Setup

Save the monolith code to a file in your project directory (e.g., `lib/bridge.ts`).

### 1. Initialize Your Store (`store.ts`)
Organize your application logic into self-contained category configurations.

```typescript
import { createStore } from '@/lib/bridge';

export const appStore = createStore({
  counter: {
    state: { count: 0, status: 'idle' },
    handlers: {
      increment: (payload: { amount: number }, state) => ({
        ...state,
        count: state.count + payload.amount,
      }),
      setStatus: (payload: { status: string }, state) => ({
        ...state,
        status: payload.status,
      }),
    },
  },
});
```

### 2. Wrap the Root Layout (`layout.tsx`)
Inject the engine into your high-level Next.js layout structure to track implicit background stream frames.

```typescript
import { BridgeProvider } from '@/lib/bridge';
import { appStore } from './store';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BridgeProvider store={appStore}>
          {children}
        </BridgeProvider>
      </body>
    </html>
  );
}
```

---

## Core Usage Patterns

### Pattern A: Standard Client Mutations
Use the tuple destructured syntax to read category state and execute local business logic dynamically.

```typescript
'use client';

import { useBridgeStore } from '@/lib/bridge';
import { appStore } from './store';

export function Counter() {
  // Pulls the entire object slice automatically
  const [counter, actions] = useBridgeStore(appStore, 'counter');

  return (
    <button onClick={() => actions.increment({ amount: 1 })}>
      Count: {counter.count}
    </button>
  );
}
```

### Pattern B: Maximum Performance Deep Selectors
Pass an optional third parameter callback function to subscribe to a singular deep-nested property. The component **will not re-render** if other unrelated properties inside that category change.

```typescript
'use client';

import { useBridgeStore } from '@/lib/bridge';
import { appStore } from './store';

export function StatusIndicator() {
  // Component ONLY renders if 'status' actively changes value
  const [status, actions] = useBridgeStore(appStore, 'counter', s => s.status);

  return <p>System Status: {status}</p>;
}
```

### Pattern C: Typed Server Action Back-Channels
Return a telemetry payload from a server-side action using `appStore.send`. When wrapped in `execute()`, the client engine automatically absorbs the instruction and runs the mutation loop in the background.

```typescript
// actions.ts (Server Component)
'use server';

import { appStore } from './store';

export async function processPayment(amount: number) {
  // ... execute backend database operations safely
  
  return {
    success: true,
    data: { transactionId: 'TX-9901' },
    // Fully type-checked payload criteria
    signal: appStore.send('counter', 'increment', { amount: 10 }),
  };
}
```

```typescript
// CheckoutButton.tsx (Client Component)
'use client';

import { useActionBridge } from '@/lib/bridge';
import { processPayment } from './actions';

export function CheckoutButton() {
  const { execute } = useActionBridge();

  const handleCheckout = async () => {
    // Automatically executes background increment handler upon successful return
    const result = await execute(processPayment(100));
    console.log(result.transactionId);
  };

  return <button onClick={handleCheckout}>Pay Now</button>;
}
```

---

## API Reference

### `createStore(config)`
Allocates isolated categories outside of the standard React render loop space. Returns a centralized repository configuration bundle.

### `<BridgeProvider store={...}>`
Mounts the root layout subscription tunnel. Hooks into the underlying client history stack and parses initial hydration variables out-of-the-box.

### `useBridgeStore(store, category, selector?)`
Granular micro-state consumption layer. If a custom selector callback is present, execution paths are automatically memoized to enforce micro-render isolation targets.

### `useActionBridge()`
Exposes an asynchronous execution wrapper helper (`execute()`) designed to cleanly consume Next.js Server Action telemetry packets.
