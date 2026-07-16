// app/bridge.ts
// Server-safe: import it from Route Handlers, Server Actions, Server
// Components, and client code alike. No directive, no dependencies.
import { defineBridge } from '../core';

export interface AppState {
  notices: string[];
  presence: { online: number };
  order: { status: 'idle' | 'paid' | 'shipped' };
}

// Defaults only — real values come from the server, either seeded into your
// store at the layout or pushed later as signals.
const initialState: AppState = {
  notices: [],
  presence: { online: 0 },
  order: { status: 'idle' },
};

export const appBridge = defineBridge(initialState, {
  // Reducers return a patch to merge, so each one touches only what it names.
  'notice/add': (p: { text: string }, s) => ({ notices: [...s.notices, p.text] }),
  'notice/clear': (_: void) => ({ notices: [] }),
  'presence/set': (p: { online: number }) => ({ presence: { online: p.online } }),
  'order/status': (p: { status: AppState['order']['status'] }) => ({ order: { status: p.status } }),
});
