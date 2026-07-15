// app/layout.tsx (Server Component)
import { BridgeProvider } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BridgeProvider>
          {children}
        </BridgeProvider>
      </body>
    </html>
  );
}

// components/CheckoutButton.tsx (Client Component)
'use client';

import { useActionBridge } from '../app/providers';
import { processCheckout } from '../app/actions'; // Your Server Action

export function CheckoutButton() {
  const { execute } = useActionBridge();

  return (
    <button onClick={() => execute(processCheckout())}>
      Complete Purchase
    </button>
  );
}

