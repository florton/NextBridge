// app/providers.tsx (Client Component)
'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { appBridge } from './globalBridge';

const BridgeContext = createContext(null);

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  
  // 1. Listen to Next.js navigation changes
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Optional: The server can attach operational signals directly to 
    // metadata or safe headers. If found, your bridge handles them.
    const implicitSignal = window.__NEXT_DATA__?.props?.pageProps?.serverSignal;
    if (implicitSignal) {
      appBridge.receive(implicitSignal);
    }
  }, [pathname, searchParams]);

  return (
    <BridgeContext.Provider value={null}>
      {children}
    </BridgeContext.Provider>
  );
}

// Custom hook to make executing actions and handling signals seamless
export function useActionBridge() {
  return {
    /**
     * Executes a Next.js Server Action, captures any returned UI signals,
     * and automatically plays them into your local state slices.
     */
    execute: async <T,>(serverActionPromise: Promise<{ success: boolean; signal?: any; data?: T }>) => {
      const response = await serverActionPromise;
      
      if (response.success && response.signal) {
        // Automatically route to the correct slice handler!
        appBridge.receive(response.signal);
      }
      
      return response.data;
    }
  };
}
