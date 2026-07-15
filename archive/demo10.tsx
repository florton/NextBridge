import { createStore } from './bridge'; // assuming the engine is in bridge.ts

export const appStore = createStore({
  counter: {
    state: { count: 0 },
    handlers: {
      increment: (payload: { amount: number }, state) => ({
        ...state,
        count: state.count + payload.amount,
      }),
      reset: (_, state) => ({ count: 0 }),
    },
  },
  user: {
    state: { name: 'Jane Doe', role: 'Guest' },
    handlers: {
      updateProfile: (payload: { name: string; role: string }, state) => ({
        ...state,
        name: payload.name,
        role: payload.role,
      }),
    },
  },
});

// Extract unified signals type-safety to export for Server Actions
export type AppStore = typeof appStore;

'use server';

import { appStore } from './store';

export async function processServerIncrement(currentCount: number) {
  // Simulate database latency or validation logic
  await new Promise((resolve) => setTimeout(resolve, 500));
  
  const bonusAmount = 5;
  const newTotal = currentCount + bonusAmount;

  return {
    success: true,
    data: { message: `Successfully added +${bonusAmount} on server.` },
    // 💡 Strict autocomplete ensures you target an existing slice and action!
    signal: appStore.send('counter', 'increment', { amount: bonusAmount }),
  };
}

import { BridgeProvider } from './bridge';
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

'use client';

import { useBridgeStore, useActionBridge } from './bridge';
import { appStore } from './store';
import { processServerIncrement } from './actions';

export function CounterComponent() {
  const [counter, actions] = useBridgeStore(appStore, 'counter');
  const { execute } = useActionBridge();

  console.log('⚡ [CounterComponent] Rendered');

  return (
    <div style={{ padding: '16px', border: '1px solid #000', marginBottom: '16px' }}>
      <h3>Counter Category</h3>
      <p>Current Count: <strong>{counter.count}</strong></p>
      
      <div style={{ display: 'flex', gap: '8px' }}>
        {/* Local UI mutation via Proxy */}
        <button onClick={() => actions.increment({ amount: 1 })}>
          Local +1
        </button>
        
        {/* Server Action Execution with background telemetry syncing */}
        <button onClick={() => execute(processServerIncrement(counter.count))}>
          Server Action (+5 Bonus)
        </button>
      </div>
    </div>
  );
}

'use client';

import { useBridgeStore } from './bridge';
import { appStore } from './store';

export function UserComponent() {
  const [user, actions] = useBridgeStore(appStore, 'user');

  console.log('👤 [UserComponent] Rendered');

  return (
    <div style={{ padding: '16px', border: '1px solid #000' }}>
      <h3>User Category</h3>
      <p>Name: <strong>{user.name}</strong></p>
      <p>Role: <strong>{user.role}</strong></p>
      
      <button onClick={() => actions.updateProfile({ name: 'Alex Smith', role: 'Admin' })}>
        Promote User to Admin
      </button>
    </div>
  );
}

'use client';

import { CounterComponent } from './CounterComponent';
import { UserComponent } from './UserComponent';

export default function DashboardPage() {
  return (
    <main style={{ maxWidth: '400px', margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h2>Micro-State Architecture Dashboard</h2>
      <CounterComponent />
      <UserComponent />
    </main>
  );
}
