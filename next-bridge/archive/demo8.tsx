import { createBridgeStore } from './bridge';

export const appStore = createBridgeStore({
  counter: { count: 0 },
  user: { name: 'Guest', loggedIn: false }
});

'use server';
import { appStore } from './store';

export async function incrementOnServer(currentCount: number) {
  // Simulating an operation
  return {
    success: true,
    // Sends a direct update instruction to the client background bridge
    signal: appStore.send('counter', 'sync', { count: currentCount + 10 })
  };
}

'use client';
import { useBridge, useActionBridge } from './bridge';
import { incrementOnServer } from './actions';
import { appStore } from './store';

export function Counter() {
  // Native React-like tuple destructing syntax
  const [counter, setCounter] = useBridge<typeof appStore.state>('counter');
  const { execute } = useActionBridge();

  return (
    <div>
      <h1>Count: {counter.count}</h1>

      {/* 1. Local update: just pass an object to merge */}
      <button onClick={() => setCounter.increment({ count: counter.count + 1 })}>
        Local +1
      </button>

      {/* 2. Local update: functional state style */}
      <button onClick={() => setCounter.decrement((prev) => ({ count: prev.count - 1 }))}>
        Local -1
      </button>

      {/* 3. Server Action integration */}
      <button onClick={() => execute(incrementOnServer(counter.count))}>
        Server +10
      </button>
    </div>
  );
}
