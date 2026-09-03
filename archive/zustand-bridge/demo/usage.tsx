// Combined for documentation: layout, actions, a Server Component, and client
// components. In a real app these are separate files.
//
// The through-line here is *which channel carries what*:
//
//   Server data a component needs at first paint  → RSC prop      (OrderList)
//   Server data the global store needs at paint   → seed          (RootLayout)
//   Something that HAPPENED after the page exists → BridgeSignal  (Notice)
//
// Signals apply in an effect, i.e. after hydration. That's correct for events
// and wrong for initial data: a signal carrying data the server already knew
// would ship HTML with the stale value, leaving it visibly wrong until JS
// downloads, parses and hydrates — and permanently wrong for crawlers, link
// unfurls, or any page where JS fails.
import type { ReactNode } from 'react';
import { appBridge } from './bridge';

// ---- app/actions.ts -------------------------------------------------------
// 'use server'
export async function checkout(skus: string[]) {
  const orderId = `ord_${skus.length}_${Date.now()}`;
  return { ok: true as const, orderId, signal: appBridge.send('cart/clear') };
}

export async function saveName(name: string) {
  if (!name.trim()) return { ok: false as const, error: 'Name required', signal: null };
  return { ok: true as const, error: null, signal: appBridge.send('user/rename', { name }) };
}

// ---- app/layout.tsx (Server Component) ------------------------------------
import { Providers } from './provider';

export async function RootLayout({ children }: { children: ReactNode }) {
  // Pretend this is `await getUserFromSession()`.
  const user = { name: 'Ada', plan: 'pro' as const };

  return (
    <html lang="en">
      <body>
        {/* Seeded, not signalled: the store is built during SSR with the real
            values, so the very first HTML says "pro". A <BridgeSignal> here
            would render "free" and only correct itself after hydration. */}
        <Providers initialState={{ user }}>{children}</Providers>
      </body>
    </html>
  );
}

// ---- app/page.tsx (Server Component) --------------------------------------
import { BridgeSignal } from '../react';

export async function Page({ justPaid }: { justPaid: boolean }) {
  // Pretend this is `await getOrders()`.
  const orders = ['ord_2_1738', 'ord_1_1902'];

  return (
    <main>
      {/* Server data rendered by a server component: no store, no client JS,
          correct with JavaScript disabled. Reach for this first. */}
      <OrderList orders={orders} />

      {/* A real event. This notice did not exist until the user came back from
          checkout, so applying it after hydration is the right semantics —
          there is no "correct" earlier value it could have had. */}
      {justPaid && (
        <BridgeSignal signal={appBridge.send('notice/show', { text: 'Payment received' })} />
      )}

      <Notice />
      <NameForm />
    </main>
  );
}

// A plain Server Component — props in, HTML out.
function OrderList({ orders }: { orders: string[] }) {
  return (
    <ul>
      {orders.map((id) => (
        <li key={id}>{id}</li>
      ))}
    </ul>
  );
}

// ---- app/client.tsx (Client Components) -----------------------------------
('use client');
import { useState } from 'react';
import { useApp, useAppStore } from './provider';

export function Notice() {
  const text = useApp((s) => s.notice.text);
  const store = useAppStore();
  if (!text) return null;

  return (
    <div role="status">
      {text}{' '}
      {/* Local-only UI change — plain Zustand. The bridge is only for the
          server boundary; it doesn't want to own your client state. */}
      <button onClick={() => store.setState({ notice: { text: null } })}>Dismiss</button>
    </div>
  );
}

export function NameForm() {
  // `plan` was seeded server-side, so this renders "pro" in the SSR HTML.
  const name = useApp((s) => s.user.name);
  const plan = useApp((s) => s.user.plan);
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
      <p>
        Hello, {name} ({plan})
      </p>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="submit">Save</button>
    </form>
  );
}
