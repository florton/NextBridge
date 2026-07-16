// app/bridge.ts — server-safe. Importable from Server Actions, Server
// Components, and client alike. This is the shared signal contract.
import { defineBridge } from '../core';

// State shape lives on its own so both the store and the bridge reference it.
export interface AppState {
  user: { name: string; plan: 'free' | 'pro' };
  cart: { items: string[] };
}

const initialState: AppState = { user: { name: 'Ada', plan: 'free' }, cart: { items: [] } };

export const appBridge = defineBridge(initialState, {
  // Each reducer returns only the slice it patches — Zustand merges the rest.
  'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
  'user/setPlan': (p: { plan: 'free' | 'pro' }, s) => ({ user: { ...s.user, plan: p.plan } }),
  'cart/add': (p: { sku: string }, s) => ({ cart: { items: [...s.cart.items, p.sku] } }),
  'cart/clear': (_: void, s) => ({ cart: { ...s.cart, items: [] } }),
});
