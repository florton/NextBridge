// Shared Client-Side Zustand Store
interface UIState {
  isOpen: boolean;
  theme: string;
}
const useUIStore = create<UIState>(() => ({
  isOpen: false,
  theme: 'light',
}));

// Instantiate your generic bridge locked to your type contract
const bridge = new ActionBridgeReceiver<ActionContract>();

// The developer writes the execution logic explicitly on the client
bridge
  .on('TOGGLE_SIDEBAR', (payload) => {
    const currentState = useUIStore.getState().isOpen;
    useUIStore.setState({ isOpen: payload.forceState ?? !currentState });
  })
  .on('UPDATE_THEME', (payload) => {
    useUIStore.setState({ theme: payload.mode });
    document.documentElement.style.setProperty('--primary', payload.primaryColor);
  });

// app/actions.ts (Server-side)
'use server';

export async function processCheckout() {
  // ... perform database operations ...

  // Construct a perfectly typed signal to return to the browser
  const serverSignal: ActionSignal<ActionContract> = {
    type: 'UPDATE_THEME',
    payload: {
      primaryColor: '#ff0000',
      mode: 'dark'
    }
  };

  return { success: true, signal: serverSignal };
}
