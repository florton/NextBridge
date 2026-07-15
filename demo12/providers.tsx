// app/providers.tsx
'use client';

// The store holds functions, so a Server Component can't pass it as a prop.
// This one-time client wrapper imports the store directly instead — the
// same pattern the Redux and Zustand Next.js guides use.
import { BridgeProvider } from '../src/client';
import { appStore } from './store';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return <BridgeProvider store={appStore}>{children}</BridgeProvider>;
}
