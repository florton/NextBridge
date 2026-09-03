'use client';

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// ==========================================
// 1. ULTRA-LEAN TYPE DEFINITIONS
// ==========================================

export type ActionBridgeSignal = { type: string; payload: any };

// This type gives developers automatic autocomplete when sending actions from the server
export type InferSignals<T extends Record<string, () => { handlers: Record<string, any> }>> = {
  [K in keyof T]: {
    [A in keyof ReturnType<T[K]>['handlers']]: {
      type: `${Extract<K, string>}/${Extract<A, string>}`;
      payload: Parameters<ReturnType<T[K]>['handlers'][A]>[0];
    };
  }[keyof ReturnType<T[K]>['handlers']];
}[keyof T];

// ==========================================
// 2. THE ZERO-BOILERPLATE STORE CREATOR
// ==========================================

type SetStateFn<S> = (arg: S | ((prev: S) => S)) => void;

/**
 * Creates a global bridge registry.
 * Developers just pass an object of initial states and action handlers.
 */
export function createBridgeRegistry<
  T extends Record<string, { 
    state: any; 
    handlers: Record<string, (payload: any, state: any) => any> 
  }>
>(config: T) {
  
  return {
    config,
    // Type-safe server helper for flawless autocomplete
    send: <S extends { type: string; payload: any }>(type: S['type'], payload: S['payload']) => ({ type, payload })
  };
}

// ==========================================
// 3. CORE REACT DRIVER
// ==========================================

const BridgeContext = createContext<{
  state: Record<string, any>;
  dispatch: (signal: ActionBridgeSignal) => void;
  execute: (promise: Promise<any>) => Promise<any>;
} | null>(null);

export function BridgeProvider({ 
  children, 
  registry 
}: { 
  children: React.ReactNode; 
  registry: ReturnType<typeof createBridgeRegistry<any>>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 1. Build the initial unified state object automatically
  const [globalState, setGlobalState] = useState(() => {
    const initial: Record<string, any> = {};
    for (const [sliceName, slice] of Object.entries(registry.config)) {
      initial[sliceName] = slice.state;
    }
    return initial;
  });

  // 2. Pure, lightning-fast dynamic dispatcher
  const dispatch = useMemo(() => {
    return (signal: ActionBridgeSignal) => {
      if (!signal?.type) return;

      const [sliceName, actionName] = signal.type.split('/');
      const slice = registry.config[sliceName];
      const handler = slice?.handlers?.[actionName];

      if (!handler) {
        console.warn(`Bridge Error: Action "${signal.type}" not found.`);
        return;
      }

      // Compute the next state snapshot by executing the pure developer handler
      setGlobalState(prev => {
        const currentSliceState = prev[sliceName];
        const nextSliceState = handler(signal.payload, currentSliceState);
        
        return {
          ...prev,
          [sliceName]: nextSliceState
        };
      });
    };
  }, [registry]);

  useEffect(() => {
    const implicitSignal = (window as any).__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal) dispatch(implicitSignal);
  }, [pathname, searchParams, dispatch]);

  const contextValue = useMemo(() => ({
    state: globalState,
    dispatch,
    execute: async (promise) => {
      const res = await promise;
      if (res?.success && res?.signal) dispatch(res.signal);
      return res?.data;
    }
  }), [globalState, dispatch]);

  return <BridgeContext.Provider value={contextValue}>{children}</BridgeContext.Provider>;
}

// ==========================================
// 4. THE CLEAN HOOKS
// ==========================================

export function useActionBridge() {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useActionBridge missing BridgeProvider');
  return { execute: ctx.execute, dispatch: ctx.dispatch };
}

export function useBridgeSelector<T = any>(sliceName: string, selector: (state: any) => T): T {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useBridgeSelector missing BridgeProvider');
  
  const sliceState = ctx.state[sliceName];
  return useMemo(() => selector(sliceState), [sliceState, selector]);
}
