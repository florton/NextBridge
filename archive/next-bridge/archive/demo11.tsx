import { createStore } from './bridge';

export const appStore = createStore({
  user: {
    state: { 
      name: 'John Doe', 
      isSubmitting: false, 
      themePreference: 'dark' 
    },
    handlers: {
      updateName: (payload: { name: string }, state) => ({ ...state, name: payload.name }),
      setSubmitting: (payload: { status: boolean }, state) => ({ ...state, isSubmitting: payload.status })
    }
  }
});

'use client';

import { useBridgeStore } from './bridge';
import { appStore } from './store';

export function SubmitButton() {
  // 💡 Pass a custom nested key selector. 
  // TypeScript accurately infers that 'isSubmitting' is a boolean primitive!
  const [isSubmitting, actions] = useBridgeStore(appStore, 'user', state => state.isSubmitting);

  console.log('🔄 [SubmitButton] Render checked.');

  return (
    <button 
      disabled={isSubmitting} 
      onClick={() => actions.setSubmitting({ status: true })}
    >
      {isSubmitting ? 'Processing Task...' : 'Submit Profile Data'}
    </button>
  );
}

