// app/store.ts
// Shared module — importable from Server Actions, Server Components, and
// client components alike. No 'use client' / 'use server' directive here.
//
// In your app, import from 'next-bridge' instead of the relative path.
import { createStore, slice } from '../src/core';

export const appStore = createStore({
  user: slice(
    { name: 'Ada', plan: 'free' as 'free' | 'pro' },
    {
      rename: (payload: { name: string }, state) => ({ ...state, name: payload.name }),
      setPlan: (payload: { plan: 'free' | 'pro' }, state) => ({ ...state, plan: payload.plan }),
    },
  ),

  cart: slice(
    { items: [] as string[], syncing: false },
    {
      add: (payload: { sku: string }, state) => ({
        ...state,
        items: [...state.items, payload.sku],
      }),
      setSyncing: (payload: { on: boolean }, state) => ({ ...state, syncing: payload.on }),
      // Void payload → callable as actions.cart.clear() with no argument.
      clear: (_: void, state) => ({ ...state, items: [] }),
    },
  ),
});
