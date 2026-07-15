// app/page.tsx — a Server Component (can be async, can fetch).
import { BridgeSignal } from '../src/client';
import { appStore } from './store';
import { Cart, NameForm } from './components';

export default async function Page() {
  // Imagine this came from your database during the server render.
  const planFromDb = 'pro' as const;

  return (
    <main>
      {/*
        The explicit server → client channel: render a signal into the RSC
        tree and the client store applies it after hydration. This replaces
        the old __NEXT_DATA__ interception, which does not exist in the App
        Router. Works with streaming — the signal applies when its chunk
        arrives and mounts.
      */}
      <BridgeSignal signal={appStore.send('user', 'setPlan', { plan: planFromDb })} />
      <NameForm />
      <Cart />
    </main>
  );
}
