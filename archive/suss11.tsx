'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSyncExternalStore } from 'react';

// ==========================================
// 1. CLEAN ARCHITECTURE STORE CREATOR
// ==========================================

export function createStore<
  T extends Record<string, { 
    state: any; 
    handlers: Record<string, (payload: any, state: any) => any> 
  }>
>(config: T) {
  // Plain JS memory allocation - bypasses the React render loop completely
  const internalState = {} as Record<string, any>;
  const listeners = new Set<() => void>();

  for (const [sliceName, slice] of Object.entries(config)) {
    internalState[sliceName] = slice.state;
  }

  return {
    config,
    getSnapshot: () => internalState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchInternal: (sliceName: string, actionName: string, payload: any) => {
      const slice = config[sliceName];
      const handler = slice?.handlers?.[actionName];
      if (handler) {
        internalState[sliceName] = handler(payload, internalState[sliceName]);
        listeners.forEach((notify) => notify()); // Alert hooks to evaluate snapshots
      }
    },
    // Server helper: Strict autocomplete based on your config methods
    send: <K extends keyof T, A extends keyof T[K]['handlers']>(
      slice: K, 
      action: A, 
      payload: Parameters<T[K]['handlers'][A]>
    ) => ({
      type: `${String(slice)}/${String(action)}`,
      payload
    })
  };
}

// ==========================================
// 2. CORE PROVIDER (Sits at Root Layout)
// ==========================================

const BridgeContext = createContext<{ store: any } | null>(null);

export function BridgeProvider({ children, store }: { children: React.ReactNode; store: any }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const runSignal = useMemo(() => {
    return (signal: { type: string; payload: any }) => {
      if (!signal?.type) return;
      const [sliceName, actionName] = signal.type.split('/');
      store.dispatchInternal(sliceName, actionName, signal.payload);
    };
  }, [store]);

  useEffect(() => {
    const implicitSignal = (window as any).__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal) runSignal(implicitSignal);
  }, [pathname, searchParams, runSignal]);

  return (
    <BridgeContext.Provider value={{ store }}>
      {children}
    </BridgeContext.Provider>
  );
}

// ==========================================
// 3. THE MICRO-STATE HOOK (Isolated Re-renders & Selectors)
// ==========================================

type ActionsOf<H> = {
  [K in keyof H]: H[K] extends (payload: infer P, state: any) => any 
    ? (unknown extends P ? () => void : (payload: P) => void) 
    : never;
};

export function useBridgeStore<
  T extends ReturnType<typeof createStore>, 
  K extends keyof T['config'],
  SelectorOutput = T['config'][K]['state']
>(
  store: T,
  sliceName: K,
  selector?: (state: T['config'][K]['state']) => SelectorOutput
): [SelectorOutput, ActionsOf<T['config'][K]['handlers']>] {
  
  const context = useContext(BridgeContext);
  if (!context) throw new Error('useBridgeStore must be used within <BridgeProvider>');

  // Keep an immutable local cache reference to compare selected deep-properties
  const memoizedSelectionRef = useRef<{ raw: any; selected: SelectorOutput } | null>(null);

  const getSnapshot = useMemo(() => {
    return () => {
      const rawSliceState = context.store.getSnapshot()[sliceName as string];
      
      // If there is no custom selector, return the whole slice state natively
      if (!selector) {
        return rawSliceState as unknown as SelectorOutput;
      }

      // If the raw store state reference hasn't changed, return the exact same cached output
      if (memoizedSelectionRef.current && memoizedSelectionRef.current.raw === rawSliceState) {
        return memoizedSelectionRef.current.selected;
      }

      // If the raw state changed, extract the targeted deep nested property
      const selectedValue = selector(rawSliceState);

      // Perform a strict equality check to see if the targeted data *actually* changed value
      if (memoizedSelectionRef.current && Object.is(memoizedSelectionRef.current.selected, selectedValue)) {
        return memoizedSelectionRef.current.selected;
      }

      // Update the cache reference with the fresh state mutation values
      memoizedSelectionRef.current = { raw: rawSliceState, selected: selectedValue };
      return selectedValue;
    };
  }, [context.store, sliceName, selector]);

  // Hook directly into React's sync subscription tracking model
  const activeSelection = useSyncExternalStore(context.store.subscribe, getSnapshot);

  // Dynamic actions proxy mapping remains lightweight and isolated
  const actions = useMemo(() => {
    return new Proxy({}, {
      get(_, actionName: string) {
        return (payload: any) => {
          context.store.dispatchInternal(sliceName as string, actionName, payload);
        };
      }
    });
  }, [context, sliceName]);

  return [activeSelection, actions as any];
}

export function useActionBridge() {
  const context = useContext(BridgeContext);
  if (!context) throw new Error('useActionBridge must be used within <BridgeProvider>');

  return {
    execute: async (serverActionPromise: Promise<any>) => {
      const response = await serverActionPromise;
      if (response?.success && response?.signal) {
        const [sliceName, actionName] = response.signal.type.split('/');
        context.store.dispatchInternal(sliceName, actionName, response.signal.payload);
      }
      return response?.data;
    }
  };
}
