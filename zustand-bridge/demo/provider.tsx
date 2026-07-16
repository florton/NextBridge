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

export function Providers({
  initialState,
  children,
}: {
  /**
   * Server data to seed the store with, passed down from the layout. It must
   * be plain serializable data (it crosses the RSC boundary).
   *
   * This is what keeps server-known state out of the flash-of-stale-content
   * trap: client components render on the server too, so the store is built
   * *during* SSR with these values already in it. The HTML is correct on the
   * first byte and hydration matches — no post-hydration patch.
   */
  initialState?: Partial<AppState>;
  children: ReactNode;
}) {
  const storeRef = useRef<AppStore | null>(null);
  storeRef.current ??= createAppStore(initialState);
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
