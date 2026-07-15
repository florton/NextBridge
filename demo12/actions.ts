// app/actions.ts
'use server';

import { appStore } from './store';

// A Server Action returns plain data plus an optional `signal` — a typed,
// serializable instruction the client store knows how to apply.
export async function checkout(skus: string[]) {
  // ... charge the card, write the order to the database ...
  const orderId = `ord_${skus.length}_${Date.now()}`;

  return {
    ok: true as const,
    orderId,
    // Fully type-checked: wrong slice, action, or payload shape fails `tsc`.
    signal: appStore.send('cart', 'clear'),
  };
}

export async function saveName(name: string) {
  if (name.trim().length === 0) {
    // `ok: false` tells `execute` to roll back any optimistic signal.
    return { ok: false as const, error: 'Name required', signal: null };
  }
  // ... persist ...
  return { ok: true as const, error: null, signal: appStore.send('user', 'rename', { name }) };
}
