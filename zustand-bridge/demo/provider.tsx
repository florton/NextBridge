// app/provider.tsx
'use client';

// Creates one store per client mount (lazy useRef), then exposes it both to
// Zustand consumers (via a context) and to <BridgeSignal> (via BridgeProvider).
import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { BridgeProvider } from '../react';
import { createAppStore, type AppStore } from './store';
import type { AppState } from './bridge';

const AppStoreContext = createContext<AppStore | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const storeRef = useRef<AppStore | null>(null);
  storeRef.current ??= createAppStore();
  return (
    <AppStoreContext.Provider value={storeRef.current}>
      <BridgeProvider store={storeRef.current}>{children}</BridgeProvider>
    </AppStoreContext.Provider>
  );
}

/** Typed selector hook — this is just Zustand's useStore, nothing new. */
export function useApp<T>(selector: (s: AppState) => T): T {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error('useApp must be used within <Providers>');
  return useStore(store, selector);
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error('useAppStore must be used within <Providers>');
  return store;
}
