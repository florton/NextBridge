import { create } from 'zustand';

// ==========================================
// 1. THE GENERIC CONTRACT (Define Your Actions & Data)
// ==========================================
export interface AppContract {
  TOGGLE_SIDEBAR: { forceState?: boolean };
  UPDATE_THEME: { primaryColor: string; mode: 'light' | 'dark' };
  RESET_APP: null; // Supports payload-free actions
}

// ==========================================
// 2. THE ULTIMATE BREVITY ENGINE
// ==========================================

export type SignalPayload<C, K extends keyof C> = C[K];
export type SafeSignal<C> = { [K in keyof C]: { type: K; payload: C[K] } }[keyof C];

// A single function that maps your contract directly to executable client handlers
export function createSignalBridge<TContract>(
  handlers: { [K in keyof TContract]: (payload: TContract[K]) => void }
) {
  return {
    // Client-side entrypoint for Next.js Server Components / Actions
    receive: (signal: SafeSignal<TContract>) => {
      const handler = handlers[signal.type];
      if (handler) handler(signal.payload);
    },
    
    // Server-side helper to ensure complete type-safety when sending data
    send: <K extends keyof TContract>(type: K, payload: TContract[K]): SafeSignal<TContract> => {
      return { type, payload };
    }
  };
}
