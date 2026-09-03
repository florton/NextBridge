import { createSlice, combineSlices } from './bridge'; // assuming the monolith is saved here

// 1. Define types for the slice
interface CounterState {
  count: number;
  lastUpdatedBy: 'client' | 'server' | null;
}

type CounterPayloads = {
  increment: { amount: number };
  setCountFromServer: { newCount: number };
};

// 2. Create the slice
const counterSlice = createSlice<"counter", CounterState, CounterPayloads>(
  'counter',
  { count: 0, lastUpdatedBy: null }, // Initial State
  {
    increment: (payload, state, setState) => {
      setState({
        count: state.count + payload.amount,
        lastUpdatedBy: 'client',
      });
    },
    setCountFromServer: (payload, state, setState) => {
      setState({
        count: payload.newCount,
        lastUpdatedBy: 'server',
      });
    },
  }
);

// 3. Export combined instance and signals for export
export const appBridge = combineSlices(counterSlice);

'use server';

import { appBridge } from './store';

export async function saveCountToDatabase(currentCount: number) {
  try {
    // Simulate API delay or database write
    await new Promise((resolve) => setTimeout(resolve, 800));
    const savedCount = currentCount + 10; // e.g., server appends bonus points

    return {
      success: true,
      data: { message: "Saved successfully!" },
      // Return a typed signal that the client bridge will instantly parse
      signal: appBridge.send('counter/setCountFromServer', { newCount: savedCount }),
    };
  } catch (error) {
    return { success: false };
  }
}

import { BridgeProvider } from './bridge';
import { appBridge } from './store';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BridgeProvider bridgeInstance={appBridge}>
          {children}
        </BridgeProvider>
      </body>
    </html>
  );
}

'use client';

import { useActionBridge, useBridgeSelector } from './bridge';
import { saveCountToDatabase } from './actions';

export default function CounterComponent() {
  const { execute, receive } = useActionBridge();

  // Fine-grained selection: Component ONLY re-renders if these properties change
  const count = useBridgeSelector('counter', (state: any) => state.count);
  const lastUpdatedBy = useBridgeSelector('counter', (state: any) => state.lastUpdatedBy);

  // Handle local UI changes directly without server interaction
  const handleLocalIncrement = () => {
    // Type checking ensures you pass exactly what 'counter/increment' expects
    receive({ type: 'counter/increment', payload: { amount: 1 } });
  };

  // Trigger server action & pipe response UI state changes automatically
  const handleServerSave = async () => {
    await execute(saveCountToDatabase(count));
  };

  return (
    <div style={{ padding: '24px', border: '1px solid #ccc', borderRadius: '8px' }}>
      <h2>Count: {count}</h2>
      <p>Last trigger origin: <strong>{lastUpdatedBy || 'None'}</strong></p>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button onClick={handleLocalIncrement}>
          Local Increment (+1)
        </button>
        
        <button onClick={handleServerSave}>
          Sync with Server Actions (+10 Server Side)
        </button>
      </div>
    </div>
  );
}
