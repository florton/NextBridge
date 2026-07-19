// app/providers.tsx
'use client';

/**
 * Wires a state container to the stream. Zustand is used here as an example —
 * the library never imports it. A `Target` is two functions, so Redux, Jotai,
 * a plain object, or a test double drop in at exactly this seam.
 */
import { createContext, useContext, useRef, type ReactNode } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createReceiver } from '../receiver';
import { SignalProvider } from '../react';
import { appBridge, type AppState } from './bridge';

function createApp(initialState?: Partial<AppState>, initialCursor?: string) {
  const store = createStore<AppState>(() => ({ ...appBridge.initialState, ...initialState }));

  const receiver = createReceiver(
    appBridge,
    {
      getState: () => store.getState(),
      // Zustand's third setState arg is the devtools action label, so every
      // server-pushed delta shows up named in the timeline.
      setState: (patch, label) =>
        (store.setState as (p: Partial<AppState>, r?: false, a?: string) => void)(
          patch,
          false,
          label,
        ),
    },
    // The snapshot's cursor: the first connection resumes from the moment
    // the server rendered `initialState`, so nothing falls in the gap.
    { initialCursor },
  );

  return { store, receiver };
}

type App = ReturnType<typeof createApp>;

const AppContext = createContext<App | null>(null);

export function Providers({
  initialState,
  initialCursor,
  children,
}: {
  /** Server-known data, seeded so the SSR HTML is already correct. */
  initialState?: Partial<AppState>;
  /** The hub's `lastId()` captured alongside `initialState` (see layout). */
  initialCursor?: string;
  children: ReactNode;
}) {
  // Per mount, never a module singleton: client components render on the
  // server too, and a shared store would bleed state between users.
  const ref = useRef<App | null>(null);
  ref.current ??= createApp(initialState, initialCursor);

  return (
    <AppContext.Provider value={ref.current}>
      <SignalProvider receiver={ref.current.receiver}>{children}</SignalProvider>
    </AppContext.Provider>
  );
}

function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp must be used within <Providers>');
  return app;
}

/** Read state the ordinary way — this is just Zustand, unchanged. */
export function useAppState<T>(selector: (s: AppState) => T): T {
  return useStore(useApp().store, selector);
}

/** For applying a Server Action's returned signal. */
export function useAppReceiver() {
  return useApp().receiver;
}
