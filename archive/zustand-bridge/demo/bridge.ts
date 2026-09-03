// app/bridge.ts — server-safe. Importable from Server Actions, Server
// Components, and client alike. This is the shared signal contract.
import { defineBridge } from '../core';

// State shape lives on its own so both the store and the bridge reference it.
export interface AppState {
  user: { name: string; plan: 'free' | 'pro' };
  cart: { items: string[] };
  notice: { text: string | null };
}

// Defaults only. Real values are seeded per request in the layout — see
// usage.tsx — so the server-rendered HTML is already correct.
const initialState: AppState = {
  user: { name: 'Ada', plan: 'free' },
  cart: { items: [] },
  notice: { text: null },
};

export const appBridge = defineBridge(initialState, {
  // Each reducer returns only the slice it patches — Zustand merges the rest.
  'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
  // Fine as the *result of an upgrade action* (something happened). Not for
  // telling the client what plan it already had on page load — that's initial
  // data, and it belongs in the seed.
  'user/setPlan': (p: { plan: 'free' | 'pro' }, s) => ({ user: { ...s.user, plan: p.plan } }),
  'cart/add': (p: { sku: string }, s) => ({ cart: { items: [...s.cart.items, p.sku] } }),
  'cart/clear': (_: void, s) => ({ cart: { ...s.cart, items: [] } }),
  // A notice is a genuine event: it doesn't exist until something occurs, so
  // arriving after hydration is correct rather than a compromise.
  'notice/show': (p: { text: string }, _s) => ({ notice: { text: p.text } }),
  'notice/dismiss': (_: void, _s) => ({ notice: { text: null } }),
});
