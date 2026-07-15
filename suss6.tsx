'use client';

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// ==========================================
// 1. ADVANCED TYPES & NAMESPACE PREPENDER
// ==========================================

export type BasePayloads = Record<string, any>;

/**
 * Automatically transforms local slice action keys into namespaced global strings:
 * e.g., "counter/increment"
 */
type PrefixedSignals<Name extends string, Payloads extends BasePayloads> = {
  [K in keyof Payloads]: {
    type: `${Name}/${Extract<K, string>}`;
    payload: Payloads[K];
  };
}[keyof Payloads];

export interface FeatureSlice<Name extends string, State, Payloads extends BasePayloads> {
  name: Name;
  initialState: State;
  handlers: {
    [K in keyof Payloads]: (
      payload: Payloads[K],
      state: State,
      setState: React.Dispatch<React.SetStateAction<State>>
    ) => void;
  };
}

type ExtractSignals<T> = T extends FeatureSlice<infer N, any, infer P> ? PrefixedSignals<N, P> : never;

// Dynamic mapped union type representing every allowed action across the entire app
export type AppSignals<Slices extends FeatureSlice<any, any, any>[]> = ExtractSignals<Slices[number]>;

// ==========================================
// 2. THE BOILERPLATE-FREE ENGINES
// ==========================================

/**
 * Creates a localized feature slice holding its own isolated initial state and handlers.
 */
export function createSlice<Name extends string, State, Payloads extends BasePayloads>(
  name: Name,
  initialState: State,
  handlers: {
    [K in keyof Payloads]: (
      payload: Payloads[K],
      state: State,
      setState: React.Dispatch<React.SetStateAction<State>>
    ) => void;
  }
): FeatureSlice<Name, State, Payloads> {
  return { name, initialState, handlers };
}

/**
 * Combines multiple modular feature slices into a single unified global tunnel.
 */
export function combineSlices<Slices extends FeatureSlice<any, any, any>[]>(...slices: Slices) {
  type GlobalSignal = AppSignals<Slices>;
  
  // Fast runtime lookup cache map built at initialization
  const registry: Record<string, { 
    sliceName: string; 
    handler: Function 
  }> = {};

  for (const slice of slices) {
    for (const [actionKey, handler] of Object.entries(slice.handlers)) {
      const namespacedKey = `${slice.name}/${actionKey}`;
      registry[namespacedKey] = {
        sliceName: slice.name,
        handler
      };
    }
  }

  return {
    slices,
    registry,
    
    /**
     * Server-side helper: Enforces perfect TypeScript autocomplete across all slices.
     */
    send: <K extends GlobalSignal['type']>(
      type: K,
      payload: Extract<GlobalSignal, { type: K }>['payload']
    ): GlobalSignal => {
      return { type, payload } as any;
    }
  };
}

// ==========================================
// 3. REACT STATE CORE INTEGRATION
// ==========================================

interface BridgeContextType {
  state: Record<string, any>;
  receive: (signal: any) => void;
  execute: <T>(serverActionPromise: Promise<{ success: boolean; signal?: any; data?: T }>) => Promise<T | undefined>;
}

const BridgeContext = createContext<BridgeContextType | null>(null);

interface ProviderProps {
  children: React.ReactNode;
  bridgeInstance: ReturnType<typeof combineSlices>;
}

export function BridgeProvider({ children, bridgeInstance }: ProviderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Initialize unified global React state from all slice initialState baselines
  const [globalState, setGlobalState] = useState<Record<string, any>>(() => {
    const baseState: Record<string, any> = {};
    for (const slice of bridgeInstance.slices) {
      baseState[slice.name] = slice.initialState;
    }
    return baseState;
  });

  // Core internal router that wires up external actions to the internal React state loop
  const receive = useMemo(() => {
    return (signal: any) => {
      if (!signal || !signal.type) return;

      const matched = bridgeInstance.registry[signal.type];
      if (!matched) {
        console.warn(`Bridge Error: Action "${String(signal.type)}" not found on any registered slice.`);
        return;
      }

      const { sliceName, handler } = matched;

      // Execute the slice handler, injecting the current local state snapshot 
      // and a custom scoped functional React state modifier function
      setGlobalState((prevGlobalState) => {
        let executionSnapshot = prevGlobalState[sliceName];

        handler(
          signal.payload,
          executionSnapshot,
          (updateOrFn: any) => {
            executionSnapshot = typeof updateOrFn === 'function' 
              ? updateOrFn(executionSnapshot) 
              : updateOrFn;
          }
        );

        return {
          ...prevGlobalState,
          [sliceName]: executionSnapshot,
        };
      });
    };
  }, [bridgeInstance]);

  // Intercept layout payloads bundled inside Next.js data stream updates
  useEffect(() => {
    const implicitSignal = (window as any).__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal) {
      receive(implicitSignal);
    }
  }, [pathname, searchParams, receive]);

  // Unified context payload package
  const contextValue = useMemo(() => {
    return {
      state: globalState,
      receive,
      execute: async <T,>(
        serverActionPromise: Promise<{ success: boolean; signal?: any; data?: T }>
      ): Promise<T | undefined> => {
        const response = await serverActionPromise;
        if (response.success && response.signal) {
          receive(response.signal);
        }
        return response.data;
      }
    };
  }, [globalState, receive]);

  return (
    <BridgeContext.Provider value={contextValue}>
      {children}
    </BridgeContext.Provider>
  );
}

// ==========================================
// 4. CONSUMPTION HOOKS
// ==========================================

/**
 * Access the server-action trigger bridge utilities.
 */
export function useActionBridge() {
  const context = useContext(BridgeContext);
  if (!context) {
    throw new Error('useActionBridge must be used within a <BridgeProvider>');
  }
  return { execute: context.execute, receive: context.receive };
}

/**
 * Hook to selectively query reactive global state with fine-grained control.
 * Extracted values prevent total re-renders unless your custom returned value updates.
 */
export function useBridgeSelector<SliceState, Selected>(
  sliceName: string,
  selector: (state: SliceState) => Selected
): Selected {
  const context = useContext(BridgeContext);
  if (!context) {
    throw new Error('useBridgeSelector must be used within a <BridgeProvider>');
  }

  const rawSliceState = context.state[sliceName];
  return useMemo(() => selector(rawSliceState), [rawSliceState, selector]);
}
