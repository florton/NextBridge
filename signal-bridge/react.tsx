'use client';

/**
 * next-signal-bridge · React glue
 *
 * Two transports that need React: the RSC tree (`<BridgeSignal>`) and a live
 * stream's lifecycle (`useSignalStream`). Everything else — the contract, the
 * receiver, the SSE plumbing — works without React at all.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { devWarn, type AnySignal } from './core';
import type { Receiver } from './receiver';
import { connectSignalStream, type ConnectOptions } from './stream';

// Client-side stream plumbing, re-exported so `next-signal-bridge/react` is
// the one client entry (and server code stays out of client bundles).
export { connectSignalStream } from './stream';
export type { ConnectOptions } from './stream';

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

interface StreamListeners {
  onOpen?: ConnectOptions['onOpen'];
  onError?: ConnectOptions['onError'];
}

interface SharedConnection {
  count: number;
  disconnect: () => void;
  /** Latest-ref boxes from every mounted hook — fanned out per event. */
  listeners: Set<{ readonly current: StreamListeners }>;
  /** True between onOpen and the next error — lets a late joiner get onOpen. */
  opened: boolean;
  withCredentials?: boolean;
}

// One EventSource per (receiver, url), refcounted across hook mounts.
// Browsers cap HTTP/1.1 connections per origin at ~6 — which is what
// `next dev` on localhost speaks — so per-mount connections exhaust fast.
// Keyed by receiver so distinct apps/providers on a page never share.
const sharedConnections = new WeakMap<Receiver<any>, Map<string, SharedConnection>>();

function acquireSharedConnection(
  receiver: Receiver<any>,
  url: string,
  opts: ConnectOptions,
  listener: { readonly current: StreamListeners },
): () => void {
  let byUrl = sharedConnections.get(receiver);
  if (!byUrl) {
    byUrl = new Map();
    sharedConnections.set(receiver, byUrl);
  }

  let conn = byUrl.get(url);
  if (!conn) {
    const created: SharedConnection = {
      count: 0,
      disconnect: () => {},
      listeners: new Set(),
      opened: false,
      withCredentials: opts.withCredentials,
    };
    created.disconnect = connectSignalStream(receiver, url, {
      ...opts,
      onOpen: () => {
        created.opened = true;
        for (const l of [...created.listeners]) l.current.onOpen?.();
      },
      onError: (event, info) => {
        // Any error means the connection is down (EventSource retrying, or a
        // rebuild pending) — recovery fires a fresh onOpen to everyone.
        created.opened = false;
        for (const l of [...created.listeners]) l.current.onError?.(event, info);
      },
    });
    byUrl.set(url, created);
    conn = created;
  } else if (conn.withCredentials !== opts.withCredentials) {
    // First mount's transport options win for a shared connection.
    devWarn(
      `useSignalStream("${url}"): withCredentials differs from the connection already open for this URL — the first mount's value is in effect. Pass shared: false to isolate.`,
    );
  }

  conn.count++;
  conn.listeners.add(listener);
  // A mount joining an already-open connection missed the open event — fire
  // its callback now so "am I connected" state initializes correctly.
  if (conn.opened) listener.current.onOpen?.();
  const owned = conn;
  return () => {
    owned.listeners.delete(listener);
    if (--owned.count === 0) {
      byUrl.delete(url);
      owned.disconnect();
    }
  };
}

/**
 * Subscribes to a signal stream for as long as the component is mounted.
 *
 *   useSignalStream('/api/stream');
 *
 * Mounts sharing a receiver and URL share one connection (see `shared`), so
 * scattering this hook across components costs one EventSource, not one
 * each. Reconnection and resume are EventSource's job; overlap is absorbed
 * by the receiver's replay guard. Pass `enabled: false` to hold off (e.g.
 * until you know who the user is).
 */
export function useSignalStream(
  url: string,
  opts: ConnectOptions & {
    enabled?: boolean;
    /**
     * Share one connection across mounts with the same receiver and URL
     * (refcounted; closes when the last mount unmounts). All sharers' onOpen/
     * onError fire per event — a mount joining an already-open connection
     * gets an immediate onOpen. Non-callback options are fixed by whichever
     * mount connected first. `false` opts this mount out. Default `true`.
     */
    shared?: boolean;
  } = {},
): void {
  const receiver = useReceiver();
  const { enabled = true, shared = true, withCredentials, EventSourceImpl, cursorParam, reconnect } =
    opts;

  // Latest-ref: an inline callback must neither churn the connection (so it
  // can't be an effect dependency) nor go stale (so the effect can't close
  // over it). The stable wrappers below always call the current render's.
  const callbacks = useRef<StreamListeners>({ onOpen: opts.onOpen, onError: opts.onError });
  useEffect(() => {
    callbacks.current = { onOpen: opts.onOpen, onError: opts.onError };
  });

  useEffect(() => {
    if (!enabled) return;
    const connectOpts: ConnectOptions = { withCredentials, EventSourceImpl, cursorParam, reconnect };
    if (!shared) {
      return connectSignalStream(receiver, url, {
        ...connectOpts,
        onOpen: () => callbacks.current.onOpen?.(),
        onError: (event, info) => callbacks.current.onError?.(event, info),
      });
    }
    return acquireSharedConnection(receiver, url, connectOpts, callbacks);
  }, [receiver, url, enabled, shared, withCredentials, EventSourceImpl, cursorParam, reconnect]);
}
