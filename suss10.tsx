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
    // The Pub/Sub mechanism
    getSnapshot: () => internalState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Triggers pure logic updates, then notifies subscribers
    dispatchInternal: (sliceName: string, actionName: string, payload: any) => {
      const slice = config[sliceName];
      const handler = slice?.handlers?.[actionName];
      if (handler) {
        internalState[sliceName] = handler(payload, internalState[sliceName]);
        listeners.forEach((notify) => notify()); // Alert hooks to check changes
      }
    },
    // Server helper: Strict autocomplete based on your config methods
    send: <K extends keyof T, A extends keyof T[K]['handlers']>(
      slice: K, 
      action: A, 
      payload: Parameters<T[K]['handlers'][A]>[0]
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

  // Unified runner for background layout frames and server action responses
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
// 3. THE MICRO-STATE HOOK (Isolated Re-renders)
// ==========================================

type ActionsOf<H> = {
  [K in keyof H]: H[K] extends (payload: infer P, state: any) => any 
    ? (unknown extends P ? () => void : (payload: P) => void) 
    : never;
};

export function useBridgeStore<T extends ReturnType<typeof createStore>, K extends keyof T['config']>(
  store: T,
  sliceName: K
): [T['config'][K]['state'], ActionsOf<T['config'][K]['handlers']>] {
  
  const context = useContext(BridgeContext);
  if (!context) throw new Error('useBridgeStore must be used within <BridgeProvider>');

  // useSyncExternalStore intercepts the change event and natively performs 
  // Object.is equality checks on the targeted category state.
  // Component re-renders ONLY if the target category data actively changed.
  const sliceSnapshot = useSyncExternalStore(
    context.store.subscribe,
    () => context.store.getSnapshot()[sliceName as string]
  );

  // Dynamic actions proxy mapping
  const actions = useMemo(() => {
    return new Proxy({}, {
      get(_, actionName: string) {
        return (payload: any) => {
          context.store.dispatchInternal(sliceName as string, actionName, payload);
        };
      }
    });
  }, [context, sliceName]);

  return [sliceSnapshot, actions as any];
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
