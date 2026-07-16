// Combined for documentation: a Server Action, a Server Component, and client
// components. In a real app these are separate files.
//
// Three transports, one contract:
//
//   live stream     → useSignalStream('/api/stream')   ← the flagship
//   Server Action   → receiver.ingest(result.signal)
//   RSC render      → <BridgeSignal signal={...} />
import type { ReactNode } from 'react';
import { appBridge } from './bridge';

// ---- app/actions.ts -------------------------------------------------------
// 'use server'
export async function markPaid(orderId: string) {
  // ...charge the card, write the order...
  return {
    ok: true as const,
    orderId,
    // Type-checked on the server, against the client's reducers.
    signal: appBridge.send('order/status', { status: 'paid' as const }),
  };
}

// ---- app/layout.tsx (Server Component) ------------------------------------
import { Providers } from './providers';

export async function RootLayout({ children }: { children: ReactNode }) {
  // Server data the store needs at first paint is SEEDED, not signalled: the
  // store is built during SSR already correct, so the HTML is right on the
  // first byte and hydration matches.
  const presence = { online: 3 };

  return (
    <html lang="en">
      <body>
        <Providers initialState={{ presence }}>{children}</Providers>
      </body>
    </html>
  );
}

// ---- app/page.tsx (Server Component) --------------------------------------
import { BridgeSignal } from '../react';

export async function Page({ justPaid }: { justPaid: boolean }) {
  return (
    <main>
      {/* A real event: it didn't exist until the user came back from checkout,
          so landing after hydration is correct rather than a compromise. */}
      {justPaid && (
        <BridgeSignal signal={appBridge.send('notice/add', { text: 'Payment received' })} />
      )}
      <LiveOrder />
      <PayButton orderId="ord_1" />
    </main>
  );
}

// ---- app/live.tsx (Client Components) -------------------------------------
('use client');
import { useSignalStream } from '../react';
import { useAppReceiver, useAppState } from './providers';

export function LiveOrder() {
  // Connected while mounted; EventSource handles reconnect and resume, and the
  // receiver's id dedupe absorbs any replayed overlap.
  useSignalStream('/api/stream');

  const status = useAppState((s) => s.order.status);
  const online = useAppState((s) => s.presence.online);
  const notices = useAppState((s) => s.notices);

  return (
    <section>
      <p>
        Order: {status} · {online} online
      </p>
      <ul>
        {notices.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
    </section>
  );
}

export function PayButton({ orderId }: { orderId: string }) {
  const receiver = useAppReceiver();

  const pay = async () => {
    // No execute() wrapper: a Server Action's signal is just another delivery.
    // Want optimistic updates, retries, or request de-duplication? Reach for
    // TanStack Query and ingest in onSuccess — this library doesn't compete
    // with it:
    //
    //   useMutation({
    //     mutationFn: () => markPaid(orderId),
    //     onSuccess: (r) => receiver.ingest(r.signal),
    //   });
    const result = await markPaid(orderId);
    receiver.ingest(result.signal);
  };

  return <button onClick={pay}>Pay</button>;
}
