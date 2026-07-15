// app/components.tsx
'use client';

import { useState } from 'react';
import { useBridge } from '../src/client';
import { appStore } from './store';
import { checkout, saveName } from './actions';

export function Cart() {
  // Whole-slice subscription: re-renders when anything in `cart` changes,
  // never when `user` changes.
  const [cart, actions] = useBridge(appStore, 'cart');

  const handleCheckout = async () => {
    actions.setSyncing({ on: true });
    // `execute` applies `result.signal` on success, drops it if a newer
    // execute already wrote the same signal type (out-of-order guard).
    const result = await appStore.execute(checkout(cart.items));
    actions.setSyncing({ on: false });
    console.log('order placed:', result.orderId); // fully typed
  };

  return (
    <section>
      <ul>
        {cart.items.map((sku) => (
          <li key={sku}>{sku}</li>
        ))}
      </ul>
      <button onClick={() => actions.add({ sku: `sku_${cart.items.length + 1}` })}>Add</button>
      <button disabled={cart.syncing || cart.items.length === 0} onClick={handleCheckout}>
        {cart.syncing ? 'Placing order…' : 'Checkout'}
      </button>
    </section>
  );
}

export function NameForm() {
  // Selector subscription: re-renders only when `name` itself changes —
  // not when `plan` or anything else in the slice does.
  const [name] = useBridge(appStore, 'user', (s) => s.name);
  const [draft, setDraft] = useState('');

  const submit = async () => {
    // Optimistic: the UI shows the new name immediately; if the action
    // rejects or returns `ok: false`, the slice rolls back.
    const result = await appStore.execute(saveName(draft), {
      optimistic: appStore.send('user', 'rename', { name: draft }),
    });
    if (!result.ok) console.warn(result.error);
  };

  return (
    <form action={submit}>
      <p>Hello, {name}</p>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="submit">Save</button>
    </form>
  );
}
