'use client';

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// ==========================================
// 1. CLEAN ARCHITECTURE STORE CREATOR
// ==========================================

export function createStore<
  T extends Record<string, { 
    state: any; 
    handlers: Record<string, (payload: any, state: any) => any> 
  }>
>(config: T) {
  return {
    config,
    // Server helper: Gives flawless autocomplete based on your config methods
    send: <
      K extends keyof T, 
      A extends keyof T[K]['handlers']
    >(
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
// 2. CORE PROVIDER & HOOK
// ==========================================

const BridgeContext = createContext<{ state: any; setState: any; config: any } | null>(null);

export function BridgeProvider({ children, store }: { children: React.ReactNode; store: any }) {
  const [state, setState] = useState(() => {
    const initial: Record<string, any> = {};
    for (const [k, v] of Object.entries(store.config)) {
      initial[k] = (v as any).state;
    }
    return initial;
  });

  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Unified runner for background layout frames and server action responses
  const runSignal = useMemo(() => {
    return (signal: { type: string; payload: any }) => {
      if (!signal?.type) return;
      const [sliceName, actionName] = signal.type.split('/');
      const slice = store.config[sliceName];
      const handler = slice?.handlers?.[actionName];

      if (handler) {
        setState(prev => ({
          ...prev,
          [sliceName]: handler(signal.payload, prev[sliceName])
        }));
      }
    };
  }, [store]);

  useEffect(() => {
    const implicitSignal = (window as any).__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal) runSignal(implicitSignal);
  }, [pathname, searchParams, runSignal]);

  return (
    <BridgeContext.Provider value={{ state, setState, config: store.config }}>
      {children}
    </BridgeContext.Provider>
  );
}

// ==========================================
// 3. THE SMART HOOK (No Boilerplate, Full Utility)
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

  const currentSliceState = context.state[sliceName as string];

  // The Proxy dynamically maps your predefined handlers straight into callable functions!
  const actions = useMemo(() => {
    return new Proxy({}, {
      get(_, actionName: string) {
        return (payload: any) => {
          const handler = context.config[sliceName]?.[ 'handlers' ]?.[actionName];
          if (handler) {
            context.setState((prev: any) => ({
              ...prev,
              [sliceName]: handler(payload, prev[sliceName])
            }));
          }
        };
      }
    });
  }, [context, sliceName]);

  return [currentSliceState, actions as any];
}

export function useActionBridge() {
  const context = useContext(BridgeContext);
  return {
    execute: async (serverActionPromise: Promise<any>) => {
      const response = await serverActionPromise;
      // Handle the background signal out-of-the-box if it exists
      if (response?.success && response?.signal) {
        const [sliceName, actionName] = response.signal.type.split('/');
        const handler = context?.config[sliceName]?.handlers?.[actionName];
        if (handler) {
          context?.setState((prev: any) => ({
            ...prev,
            [sliceName]: handler(response.signal.payload, prev[sliceName])
          }));
        }
      }
      return response?.data;
    }
  };
}
