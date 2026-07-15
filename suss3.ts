// Generic types to extract types from individual features
export type SlicePayloads<T> = T extends FeatureSlice<any, infer P> ? P : never;

export interface FeatureSlice<Name extends string, Payloads extends Record<string, any>> {
  name: Name;
  // We keep a runtime array of keys so the bridge knows which slice to route to
  actionKeys: string[]; 
  handlers: { [K in keyof Payloads]: (payload: Payloads[K]) => void };
}

/**
 * 1. Creates a localized feature slice.
 * The developer gets local safety, encapsulation, and zero boilerplate.
 */
export function createSlice<Name extends string, Payloads extends Record<string, any>>(
  name: Name,
  handlers: { [K in keyof Payloads]: (payload: Payloads[K]) => void }
): FeatureSlice<Name, Payloads> {
  return {
    name,
    actionKeys: Object.keys(handlers),
    handlers
  };
}

/**
 * 2. Combines multiple slices into a single, unified bridge.
 * Generates perfect global types dynamically without any manual registration boilerplate.
 */
export function combineSlices<Slices extends FeatureSlice<any, any>[]>(...slices: Slices) {
  // Extract all actions from all slices into a single union type
  type AllSignals = {
    [I in keyof Slices]: {
      [K in keyof SlicePayloads<Slices[I]>]: {
        type: K;
        payload: SlicePayloads<Slices[I]>[K];
      };
    }[keyof SlicePayloads<Slices[I]>];
  }[number];

  // Create a runtime map of all handlers for fast lookups
  const globalHandlers: Record<string, Function> = {};
  for (const slice of slices) {
    for (const [key, handler] of Object.entries(slice.handlers)) {
      globalHandlers[key] = handler;
    }
  }

  return {
    // Client-side centralized router
    receive: (signal: AllSignals) => {
      const handler = globalHandlers[signal.type as string];
      if (handler) {
        handler(signal.payload);
      } else {
        console.warn(`Bridge Error: Action "${String(signal.type)}" not found on any slice.`);
      }
    },

    // Server-side typesafe helper
    send: <K extends AllSignals['type']>(
      type: K,
      payload: Extract<AllSignals, { type: K }>['payload']
    ): AllSignals => {
      return { type, payload } as any;
    }
  };
}
