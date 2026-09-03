'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// ==========================================
// 1. ADVANCED TYPES & NAMESPACE PREPENDER
// ==========================================

export type BasePayloads = Record<string, any>;

/**
 * The Magic Step: This type automatically loops through a slice's actions
 * and transforms them into a prefixed string: "sliceName/actionName"
 */
type PrefixedSignals<Name extends string, Payloads extends BasePayloads> = {
  [K in keyof Payloads]: {
    type: `${Name}/${Extract<K, string>}`;
    payload: Payloads[K];
  };
}[keyof Payloads];

export interface FeatureSlice<Name extends string, Payloads extends BasePayloads> {
  name: Name;
  handlers: { [K in keyof Payloads]: (payload: Payloads[K]) => void };
}

// Extract types cleanly from a collection of slices
type ExtractSignals<T> = T extends FeatureSlice<infer N, infer P> ? PrefixedSignals<N, P> : never;

// Dynamic mapped union type representing every allowed action across the app
export type AppSignals<Slices extends FeatureSlice<any, any>[]> = ExtractSignals<Slices[number]>;

// ==========================================
// 2. THE BOILERPLATE-FREE ENGINES
// ==========================================

/**
 * Creates a localized feature slice. 
 * The developer writes pure local logic; namespacing happens under the hood.
 */
export function createSlice<Name extends string, Payloads extends BasePayloads>(
  name: Name,
  handlers: { [K in keyof Payloads]: (payload: Payloads[K]) => void }
): FeatureSlice<Name, Payloads> {
  return { name, handlers };
}

/**
 * Combines modular feature slices into a single unified global tunnel.
 */
export function combineSlices<Slices extends FeatureSlice<any, any>[]>(...slices: Slices) {
  type GlobalSignal = AppSignals<Slices>;
  const globalHandlers: Record<string, Function> = {};

  // Build a fast lookup map at startup using the "sliceName/actionName" pattern
  for (const slice of slices) {
    for (const [actionKey, handler] of Object.entries(slice.handlers)) {
      const namespacedKey = `${slice.name}/${actionKey}`;
      globalHandlers[namespacedKey] = handler;
    }
  }

  return {
    /**
     * Client-side runner: Routes incoming strings directly to the slice
     */
    receive: (signal: GlobalSignal) => {
      const handler = globalHandlers[signal.type as string];
      if (handler) {
        handler(signal.payload);
      } else {
        console.warn(`Bridge Error: Action "${String(signal.type)}" not found on any registered slice.`);
      }
    },

    /**
     * Server-side helper: Enforces perfect autocomplete across all slices
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
// 3. NEXT.JS LAYOUT INTEGRATION PROVIDER
// ==========================================

const BridgeContext = createContext<any>(null);

interface ProviderProps {
  children: React.ReactNode;
  bridgeInstance: ReturnType<typeof combineSlices>;
}

export function BridgeProvider({ children, bridgeInstance }: ProviderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Intercepts optional layout payloads bundled into Next.js data stream frames
    const implicitSignal = (window as any).__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal) {
      bridgeInstance.receive(implicitSignal);
    }
  }, [pathname, searchParams, bridgeInstance]);

  return (
    <BridgeContext.Provider value={bridgeInstance}>
      {children}
    </BridgeContext.Provider>
  );
}

export function useActionBridge() {
  const bridgeInstance = useContext(BridgeContext);
  if (!bridgeInstance) {
    throw new Error('useActionBridge must be used within a <BridgeProvider>');
  }

  return {
    /**
     * Wraps a Server Action promise, extracts returned UI signals,
     * and triggers them automatically in the background.
     */
    execute: async <T,>(
      serverActionPromise: Promise<{ success: boolean; signal?: any; data?: T }>
    ): Promise<T | undefined> => {
      const response = await serverActionPromise;
      if (response.success && response.signal) {
        bridgeInstance.receive(response.signal);
      }
      return response.data;
    }
  };
}
