// app/store.ts — a plain Zustand store, created PER REQUEST (no module
// singleton), then wrapped with the bridge channel. This is what keeps the
// server safe: nothing here is shared across users.
import { createStore } from 'zustand/vanilla';
import { attachBridge } from '../react';
import { appBridge, type AppState } from './bridge';

export function createAppStore(initial?: Partial<AppState>) {
  // Initial state is declared once on the bridge and reused here.
  const store = createStore<AppState>(() => ({ ...appBridge.initialState, ...initial }));
  return attachBridge(store, appBridge);
}

// Derived, so the bridge's contract type flows through without naming it.
export type AppStore = ReturnType<typeof createAppStore>;
