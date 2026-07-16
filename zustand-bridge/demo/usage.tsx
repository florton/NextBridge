// Combined for documentation: a Server Action, a Server Component, and a
// client component. In a real app these are separate files.
import { appBridge } from './bridge';

// ---- app/actions.ts -------------------------------------------------------
// 'use server'
export async function checkout(skus: string[]) {
  const orderId = `ord_${skus.length}_${Date.now()}`;
  // Fully type-checked against the client reducers — wrong type/payload = tsc error.
  return { ok: true as const, orderId, signal: appBridge.send('cart/clear') };
}

export async function saveName(name: string) {
  if (!name.trim()) return { ok: false as const, error: 'Name required', signal: null };
  return { ok: true as const, error: null, signal: appBridge.send('user/rename', { name }) };
}

// ---- app/page.tsx (Server Component) --------------------------------------
import { BridgeSignal } from '../react';

export async function Page({ plan }: { plan: 'free' | 'pro' }) {
  return (
    <main>
      {/* Explicit server→client push — no framework internals involved. */}
      <BridgeSignal signal={appBridge.send('user/setPlan', { plan })} />
      <NameForm />
    </main>
  );
}

// ---- app/NameForm.tsx (Client Component) ----------------------------------
('use client');
import { useState } from 'react';
import { useApp, useAppStore } from './provider';

export function NameForm() {
  const name = useApp((s) => s.user.name); // Zustand selector — re-renders on name only
  const store = useAppStore();
  const [draft, setDraft] = useState('');

  const submit = async () => {
    // `() =>` matters: execute owns *when* the request fires, so ops sharing a
    // key are sent one at a time. Two fast saves can't race — on the client or
    // on the server. Optimistic still applies instantly, then rolls back if the
    // action fails or returns ok:false.
    const result = await store.execute(() => saveName(draft), {
      optimistic: appBridge.send('user/rename', { name: draft }),
      key: 'user:me',
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
