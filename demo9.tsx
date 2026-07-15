import { createStore } from './bridge';

export const appStore = createStore({
  counter: {
    state: { count: 0 },
    handlers: {
      increment: (payload: { amount: number }, state) => ({ count: state.count + payload.amount }),
      reset: (_, state) => ({ count: 0 })
    }
  }
});

'use server';
import { appStore } from './store';

export async function syncFromServer() {
  return {
    success: true,
    // 💡 Completely type-checked! Autocompletes 'counter', 'increment', and payload requirements.
    signal: appStore.send('counter', 'increment', { amount: 10 })
  };
}

'use client';
import { useBridgeStore, useActionBridge } from './bridge';
import { appStore } from './store';
import { syncFromServer } from './actions';

export function Counter() {
  const [counter, actions] = useBridgeStore(appStore, 'counter');
  const { execute } = useActionBridge();

  return (
    <div>
      <h1>{counter.count}</h1>
      
      {/* 💡 actions.increment autocompletes the exact required object shape! */}
      <button onClick={() => actions.increment({ amount: 1 })}>Local +1</button>
      <button onClick={() => actions.reset()}>Reset</button>
      <button onClick={() => execute(syncFromServer())}>Server sync</button>
    </div>
  );
}
