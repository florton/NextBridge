'use client';

/**
 * next-bridge · client
 *
 * The React-facing half of the library: the provider, the RSC signal
 * receiver, and the subscription hook. Everything here runs only in the
 * client bundle; the store itself lives in `./core` so Server Actions and
 * Server Components can import it too.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { devWarn, type Actions, type AnySignal, type SliceConfig, type Store } from './core';

const BridgeContext = createContext<Store<SliceConfig> | null>(null);

/**
 * Binds a store on the client so `<BridgeSignal>` can reach it from anywhere
 * in the RSC tree. Because a store holds functions, it cannot be passed as a
 * prop from a Server Component — render this inside your own small
 * 'use client' wrapper (see README "Providers file") and put that wrapper in
 * the root layout.
 */
export function BridgeProvider({
  store,
  children,
}: {
  store: Store<any>;
  children: ReactNode;
}) {
  return <BridgeContext.Provider value={store}>{children}</BridgeContext.Provider>;
}

/**
 * Delivers server-created signals into the client store. Render it from any
 * Server Component with a serializable `signal` prop:
 *
 *   <BridgeSignal signal={appStore.send('user', 'upgrade', { plan })} />
 *
 * Signals apply after hydration (in an effect), and each signal id applies
 * at most once — Strict Mode double-effects and back/forward re-mounts do
 * not double-fire.
 */
export function BridgeSignal({ signal }: { signal: AnySignal | AnySignal[] | null }) {
  const store = useContext(BridgeContext);

  // Re-run only when the actual signal ids change, not on every parent
  // render (server components recreate the signal object each render).
  const idKey = Array.isArray(signal) ? signal.map((s) => s.id).join('|') : (signal?.id ?? '');
  const signalRef = useRef(signal);
  signalRef.current = signal;

  useEffect(() => {
    if (!store) {
      devWarn('<BridgeSignal> rendered outside <BridgeProvider> — signal dropped.');
      return;
    }
    store.ingest(signalRef.current);
  }, [store, idKey]);

  return null;
}

/**
 * Subscribes one component to one slice — or, with a selector, to one
 * derived value. The component re-renders only when the subscribed value
 * actually changes (`Object.is`), never for unrelated slices or properties.
 *
 *   const [cart, actions] = useBridge(appStore, 'cart');
 *   const [count] = useBridge(appStore, 'cart', s => s.items.length);
 *
 * SSR-safe: during server render and hydration it reads `store.initial`,
 * satisfying React 18's `getServerSnapshot` contract.
 */
export function useBridge<
  C extends SliceConfig,
  K extends keyof C & string,
  R = C[K]['state'],
>(
  store: Store<C>,
  sliceName: K,
  selector?: (state: C[K]['state']) => R,
): [R, Actions<C[K]['handlers']>] {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const subscribe = useMemo(
    () => (onChange: () => void) => store.subscribe(sliceName, onChange),
    [store, sliceName],
  );

  const getSnapshot = useMemo(() => {
    let cache: { raw: unknown; out: R } | undefined;
    return (): R => {
      const raw = store.get()[sliceName];
      if (cache && cache.raw === raw) return cache.out;
      const out = (selectorRef.current ? selectorRef.current(raw) : raw) as R;
      // Selected value unchanged → keep the old reference so React bails out.
      if (cache && Object.is(cache.out, out)) {
        cache.raw = raw;
        return cache.out;
      }
      cache = { raw, out };
      return out;
    };
  }, [store, sliceName]);

  const getServerSnapshot = useMemo(() => {
    let cached: { out: R } | undefined;
    return (): R => {
      cached ??= {
        out: (selectorRef.current
          ? selectorRef.current(store.initial[sliceName])
          : store.initial[sliceName]) as R,
      };
      return cached.out;
    };
  }, [store, sliceName]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [value, store.actions[sliceName]];
}
