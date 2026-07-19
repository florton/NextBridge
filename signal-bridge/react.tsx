'use client';

/**
 * signal-bridge · React glue
 *
 * Two transports that need React: the RSC tree (`<BridgeSignal>`) and a live
 * stream's lifecycle (`useSignalStream`). Everything else — the contract, the
 * receiver, the SSE plumbing — works without React at all.
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { devWarn, type AnySignal } from './core';
import type { Receiver } from './receiver';
import { connectSignalStream, type ConnectOptions } from './stream';

const ReceiverContext = createContext<Receiver<any> | null>(null);

/**
 * Puts a receiver in scope. Build it in a client wrapper alongside your store
 * (per request — never a module singleton, or state leaks across users on the
 * server).
 */
export function SignalProvider({
  receiver,
  children,
}: {
  receiver: Receiver<any>;
  children: ReactNode;
}) {
  return <ReceiverContext.Provider value={receiver}>{children}</ReceiverContext.Provider>;
}

export function useReceiver<P = any>(): Receiver<P> {
  const receiver = useContext(ReceiverContext);
  if (!receiver) throw new Error('useReceiver must be used within <SignalProvider>');
  return receiver;
}

/**
 * Delivers signals created during a server render into the client:
 *
 *   <BridgeSignal signal={bridge.send('notice/add', { text: 'Payment received' })} />
 *
 * Applies after hydration, and each id applies at most once.
 *
 * Use it for things that *happened* — an event has no correct earlier value,
 * so post-hydration timing is right. Do NOT use it for data the server already
 * knew: the HTML would ship the stale value and stay wrong until hydration
 * (and permanently so for crawlers, or if a script throws). Pass that as an
 * RSC prop, or seed your store with it.
 */
export function BridgeSignal({ signal }: { signal: AnySignal | AnySignal[] | null }) {
  const receiver = useContext(ReceiverContext);
  const idKey = Array.isArray(signal) ? signal.map((s) => s.id).join('|') : (signal?.id ?? '');

  useEffect(() => {
    if (!receiver) return devWarn('<BridgeSignal> outside <SignalProvider> — signal dropped.');
    receiver.ingest(signal);
    // `signal` is deliberately not a dependency: a Server Component mints a
    // fresh object every render, so identity would re-run this constantly.
    // `idKey` is the real identity, and the effect closes over the signal from
    // the render it was committed with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiver, idKey]);

  return null;
}

/**
 * Subscribes to a signal stream for as long as the component is mounted.
 *
 *   useSignalStream('/api/stream');
 *
 * Reconnection and resume are EventSource's job; overlap is absorbed by the
 * receiver's replay guard. Pass `enabled: false` to hold off (e.g. until
 * you know who the user is).
 */
export function useSignalStream(
  url: string,
  opts: ConnectOptions & { enabled?: boolean } = {},
): void {
  const receiver = useReceiver();
  const { enabled = true, withCredentials, EventSourceImpl, onOpen, onError, cursorParam, reconnect } = opts;

  useEffect(() => {
    if (!enabled) return;
    return connectSignalStream(receiver, url, {
      withCredentials,
      EventSourceImpl,
      onOpen,
      onError,
      cursorParam,
      reconnect,
    });
    // Callbacks are intentionally excluded: a caller passing inline functions
    // would otherwise tear down and rebuild the connection on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiver, url, enabled, withCredentials, EventSourceImpl, cursorParam, reconnect]);
}
