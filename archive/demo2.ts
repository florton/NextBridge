const useUIStore = create(() => ({ isOpen: false, theme: 'light' }));

// Everything is registered in one clean sweep
export const appBridge = createSignalBridge<AppContract>({
  TOGGLE_SIDEBAR: (payload) => {
    useUIStore.setState((s) => ({ isOpen: payload.forceState ?? !s.isOpen }));
  },
  UPDATE_THEME: (payload) => {
    useUIStore.setState({ theme: payload.mode });
  },
  RESET_APP: () => {
    useUIStore.setState({ isOpen: false, theme: 'light' });
  }
});

// app/actions.ts (Server-side Next.js Action)
'use server';

import { appBridge } from './shared-bridge-config';

export async function upgradeUserAccount() {
  // ... database adjustments ...

  // Zero guesswork. 100% autocompleted and verified by TypeScript.
  return {
    success: true,
    signal: appBridge.send('UPDATE_THEME', {
      primaryColor: '#gold',
      mode: 'dark'
    })
  };
}
