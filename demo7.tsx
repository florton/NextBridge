import { createBridgeRegistry, InferSignals } from './bridge';

export const appBridge = createBridgeRegistry({
  counter: {
    state: { count: 0 },
    handlers: {
      // Pure functions: accept payload + current state -> return NEXT state. 
      // No messy React setState parameters required!
      increment: (payload: { amount: number }, state) => ({
        ...state,
        count: state.count + payload.amount
      }),
      setCount: (payload: { newCount: number }, state) => ({
        ...state,
        count: payload.newCount
      })
    }
  }
});

// One line extracts full type safety across your entire Next.js app
export type AppSignals = InferSignals<typeof appBridge.config>;

'use server';
import { appBridge, AppSignals } from './store';

export async function syncCounter(current: number) {
  // Enforces perfect type-safe autocomplete for 'counter/setCount' and its payload!
  return {
    success: true,
    signal: appBridge.send<AppSignals>('counter/setCount', { newCount: current + 10 })
  };
}

'use client';
import { useActionBridge, useBridgeSelector } from './bridge';
import { syncCounter } from './actions';

export function Counter() {
  const { dispatch, execute } = useActionBridge();
  const count = useBridgeSelector('counter', s => s.count);

  return (
    <div>
      <h1>{count}</h1>
      <button onClick={() => dispatch({ type: 'counter/increment', payload: { amount: 1 } })}>
        Local +1
      </button>
      <button onClick={() => execute(syncCounter(count))}>
        Server Sync
      </button>
    </div>
  );
}
