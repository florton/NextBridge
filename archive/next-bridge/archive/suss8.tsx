'use client';

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// ==========================================
// 1. THE ACTION ENGINES
// ==========================================

export function createBridgeStore<T extends Record<string, any>>(initialState: T) {
  return {
    state: initialState,
    // Pure server helper for simple event signaling
    send: (slice: keyof T, action: string, payload: any) => ({
      type: `${String(slice)}/${action}`,
      payload
    })
  };
}

// ==========================================
// 2. THE PROVIDER
// ==========================================

const BridgeContext = createContext<{
  state: any;
  setState: React.Dispatch<React.SetStateAction<any>>;
} | null>(null);

export function BridgeProvider({ children, store }: { children: React.ReactNode; store: any }) {
  const [state, setState] = useState(store.state);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Handle incoming background actions from Next.js server streams
  useEffect(() => {
    const implicitSignal = (window as any).__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal?.type) {
      const [slice, action] = implicitSignal.type.split('/');
      // If a match is found on your store, update it automatically
      setState((prev: any) => ({
        ...prev,
        [slice]: { ...prev[slice], ...implicitSignal.payload }
      }));
    }
  }, [pathname, searchParams]);

  return (
    <BridgeContext.Provider value={{ state, setState }}>
      {children}
    </BridgeContext.Provider>
  );
}

// ==========================================
// 3. THE MAGIC HOOK
// ==========================================

export function useBridge<T>(sliceName: keyof T) {
  const context = useContext(BridgeContext);
  if (!context) throw new Error('useBridge must be used inside a <BridgeProvider>');

  const currentSliceState = context.state[sliceName];

  // A JavaScript Proxy lets developers update state by just changing properties
  const actions = useMemo(() => {
    return new Proxy({}, {
      get(_, actionName: string) {
        return (payload: any) => {
          context.setState((prev: any) => ({
            ...prev,
            [sliceName]: {
              ...prev[sliceName],
              // If the payload is a function, run it. Otherwise merge the object directly.
              ...(typeof payload === 'function' ? payload(prev[sliceName]) : payload)
            }
          }));
        };
      }
    });
  }, [context, sliceName]);

  return [currentSliceState, actions] as const;
}

/**
 * Executes a Server Action promise and auto-applies returned background updates
 */
export function useActionBridge() {
  const context = useContext(BridgeContext);
  if (!context) throw new Error('useActionBridge must be used inside a <BridgeProvider>');

  return {
    execute: async (serverActionPromise: Promise<any>) => {
      const response = await serverActionPromise;
      if (response?.success && response?.signal) {
        const [slice, action] = response.signal.type.split('/');
        context.setState((prev: any) => ({
          ...prev,
          [slice]: { ...prev[slice], ...response.signal.payload }
        }));
      }
      return response?.data;
    }
  };
}
