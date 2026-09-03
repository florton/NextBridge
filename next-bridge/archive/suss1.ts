import { create } from 'zustand';

// ==========================================
// 1. THE GENERIC CONTRACT (Shared Schema)
// ==========================================

/**
 * The developer defines their own application-specific events and payloads.
 * Zero magic strings required by the library.
 */
export interface ActionContract {
  TOGGLE_SIDEBAR: { forceState?: boolean };
  LOG_OUT_USER: { reason: string };
  UPDATE_THEME: { primaryColor: string; mode: 'light' | 'dark' };
}

// A utility type that transforms the contract map into a safe union type
// e.g., { type: 'TOGGLE_SIDEBAR', payload: { forceState?: boolean } }
export type ActionSignal<T> = {
  [K in keyof T]: { type: K; payload: T[K] };
}[keyof T];


// ==========================================
// 2. THE GENERIC CLIENT RECEIVER
// ==========================================

export class ActionBridgeReceiver<TContract> {
  private handlers: Partial<{ [K in keyof TContract]: (payload: TContract[K]) => void }> = {};

  /**
   * Register a custom execution handler for a specific contract type.
   * Gives full architectural logic control back to the developer.
   */
  public on<K extends keyof TContract>(
    type: K, 
    handler: (payload: TContract[K]) => void
  ): this {
    this.handlers[type] = handler;
    return this;
  }

  /**
   * Safe entrypoint for incoming JSON data streaming from Next.js Server Components.
   */
  public receiveFromServer(signal: ActionSignal<TContract>): void {
    const handler = this.handlers[signal.type];
    if (handler) {
      handler(signal.payload);
    } else {
      console.warn(`Bridge Warning: No client handler registered for action "${String(signal.type)}"`);
    }
  }
}
