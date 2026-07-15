import { create, StoreApi } from 'zustand';

// ==========================================
// 1. TYPES & SCHEMAS
// ==========================================

export type BaseState = Record<string, any>;

type SetterKey<K extends string> = `set${Capitalize<K>}`;

// Explicitly maps each generated setter to its exact value type
type AutoSetters<T extends BaseState> = {
  [K in keyof T as SetterKey<Extract<K, string>>]: (value: T[K]) => void;
};

// Safe JSON tokens allowed to cross the server-client boundary
export type BridgeToken<T extends BaseState> = {
  type: 'SET_PROPERTY';
  payload: {
    key: Extract<keyof T, string>;
    value: T[keyof T];
  };
};

type CombinedState<T extends BaseState> = T & AutoSetters<T>;

// ==========================================
// 2. THE BOILERPLATE-FREE STATE ENGINE
// ==========================================

export function createStoreWithSetters<T extends BaseState>(
  defaultState: T
) {
  // Returns a standard React hook containing the generated setters
  return create<CombinedState<T>>((set) => {
    const state: any = { ...defaultState };
    const setters: any = {};

    for (const key of Object.keys(defaultState)) {
      const setterName = `set${key.charAt(0).toUpperCase() + key.slice(1)}`;
      
      setters[setterName] = (value: any) => {
        set({ [key]: value } as any);
      };
    }

    return { ...state, ...setters };
  });
}

// ==========================================
// 3. THE SAFE CLIENT-SIDE BRIDGE CONSUMER
// ==========================================

export class TokenBridgeReceiver<T extends BaseState> {
  // Expects the vanilla Zustand store API for mutations
  private storeApi: StoreApi<CombinedState<T>>;

  constructor(useStore: any) {
    // Zustand hooks expose their internal API via .getState / .setState
    this.storeApi = useStore;
  }

  /**
   * Receives a plain token from the server, 
   * maps it to the correct generated setter, and executes it.
   */
  public receiveFromServer(token: BridgeToken<T>): void {
    if (token.type === 'SET_PROPERTY') {
      const { key, value } = token.payload;
      const setterName = `set${key.charAt(0).toUpperCase() + key.slice(1)}`;
      const currentStoreState = this.storeApi.getState() as any;

      if (typeof currentStoreState[setterName] === 'function') {
        currentStoreState[setterName](value);
      } else {
        console.warn(`Bridge Error: Dynamic setter ${setterName} not found.`);
      }
    }
  }
}
