// features/sidebar/sidebar.slice.ts
import { createSlice } from './bridgeCore';

export const sidebarSlice = createSlice('sidebar', {
  TOGGLE: (payload: { forceState?: boolean }) => {
    console.log("Modifying local sidebar state:", payload.forceState);
  }
});

// features/theme/theme.slice.ts
import { createSlice } from './bridgeCore';

export const themeSlice = createSlice('theme', {
  TOGGLE: (payload: { variant: 'light' | 'dark' }) => {
    console.log("Modifying local theme system:", payload.variant);
  }
});

// app/globalBridge.ts
import { combineSlices } from './bridgeCore';
import { sidebarSlice } from '../features/sidebar/sidebar.slice';
import { themeSlice } from '../features/theme/theme.slice';

// Auto-prefixing merges both identical "TOGGLE" triggers safely!
export const appBridge = combineSlices(sidebarSlice, themeSlice);

// app/actions.ts
'use server';

import { appBridge } from './globalBridge';

export async function processCheckout() {
  // ... database write ...

  // IDE Autocomplete now forces: "sidebar/TOGGLE" or "theme/TOGGLE"
  // Completely eliminating global name collisions without boilerplate!
  return {
    success: true,
    signal: appBridge.send('theme/TOGGLE', { variant: 'dark' })
  };
}

// app/layout.tsx (Server Component Layout wrapper)
import { BridgeProvider } from './bridgeCore';
import { appBridge } from './globalBridge';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BridgeProvider bridgeInstance={appBridge}>
          {children}
        </BridgeProvider>
      </body>
    </html>
  );
}

// components/Button.tsx (Client Component)
'use client';

import { useActionBridge } from '../app/bridgeCore';
import { processCheckout } from '../app/actions';

export function CheckoutButton() {
  const { execute } = useActionBridge();
  return <button onClick={() => execute(processCheckout())}>Buy Now</button>;
}
