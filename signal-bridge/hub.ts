/**
 * next-signal-bridge · hub (server, zero-dependency)
 *
 * The backlog piece that makes resume real: an in-memory pub/sub with a
 * ring-buffer history, so a Route Handler can replay what a reconnecting
 * client missed and then follow along live:
 *
 *   const hub = createSignalHub();               // module scope: one per server process
 *   hub.publish(bridge.send('order/status', { status: 'shipped' }));
 *
 *   // app/api/stream/route.ts
 *   return signalStream(req, ({ emit, lastEventId }) => {
 *     for (const missed of hub.since(lastEventId)) emit(missed);
 *     return hub.subscribe(emit);
 *   });
 *
 * One global hub broadcasts everything to everyone — right for genuinely
 * global data (a status ticker, a deploy banner). The moment signals belong
 * to a user, a tenant, or a room, use `createSignalHubs` and key a channel
 * per scope, or private data will be replayed to strangers.
 *
 * In-memory means one server process (`next start`, a container). On
 * serverless / multi-instance deployments, implement the `AsyncSignalHub`
 * shape over shared infrastructure (Redis pub/sub + a capped list, Postgres
 * LISTEN/NOTIFY) and the route handler barely changes — see README → Deploying,
 * which includes a reference Redis implementation.
 */

import { devWarn, type AnySignal } from './core';

export interface SignalHubOptions {
  /**
   * How many signals the replay buffer keeps. A reconnecting client whose
   * cursor has been evicted gets the whole buffer (best effort). Keep it no
   * larger than the receivers' `replayWindow`, so a full-buffer replay to a
   * client that has seen some of it is fully absorbed by dedupe. Default 500.
   */
  capacity?: number;
}

export interface SignalHub {
  /**
   * Appends to the replay buffer and fans out to live subscribers. Returns
   * the signal, so a Server Action can broadcast and hand the same signal to
   * its caller in one expression — both paths carry one id, so a client
   * reached by both applies it once.
   */
  publish<S extends AnySignal>(signal: S): S;
  /** Live feed. Returns an unsubscribe function. A throwing subscriber is contained. */
  subscribe(fn: (signal: AnySignal) => void): () => void;
  /**
   * The backlog after a cursor, oldest first. `undefined` (a first connection)
   * gets `[]` — initial data should be seeded, not replayed. An unknown cursor
   * (evicted, or a restarted hub) gets the whole buffer: best effort, and safe
   * because the receiver's replay guard absorbs anything already applied.
   */
  since(cursor: string | undefined): AnySignal[];
  /**
   * The id of the most recently published signal. Capture it alongside a
   * state snapshot and seed it as the receiver's `initialCursor` — the first
   * connection then resumes from the snapshot's moment, gap-free.
   */
  lastId(): string | undefined;
  /**
   * Live subscribers right now. Lets `createSignalHubs` refuse to evict a
   * channel someone is still streaming from, and doubles as a cheap
   * "is anyone listening" check.
   */
  subscriberCount(): number;
}

/**
 * The loosened contract for hubs backed by shared infrastructure (Redis,
 * Postgres), where reads are necessarily async. The in-memory `SignalHub`
 * satisfies it as-is, so a route handler written against this shape —
 * `await hub.since(...)`, `await hub.lastId()` — works with either and lets
 * you swap the backing store without touching the route. `signalStream`
 * accepts an async `start` callback for exactly this. See README → Deploying.
 */
export interface AsyncSignalHub {
  publish<S extends AnySignal>(signal: S): S;
  subscribe(fn: (signal: AnySignal) => void): () => void;
  since(cursor: string | undefined): AnySignal[] | Promise<AnySignal[]>;
  lastId(): string | undefined | Promise<string | undefined>;
}

export function createSignalHub(options: SignalHubOptions = {}): SignalHub {
  const capacity = Math.max(1, options.capacity ?? 500);
  const ring: AnySignal[] = [];
  let head = 0; // index of the oldest entry once the ring is full
  const subscribers = new Set<(signal: AnySignal) => void>();

  /** Logical index (0 = oldest) → buffered signal. */
  const at = (i: number): AnySignal => ring[(head + i) % ring.length]!;

  return {
    publish(signal) {
      if (ring.length < capacity) {
        ring.push(signal);
      } else {
        ring[head] = signal;
        head = (head + 1) % capacity;
      }
      // Snapshot so a subscriber unsubscribing mid-fanout doesn't skip others.
      for (const fn of [...subscribers]) {
        try {
          fn(signal);
        } catch (error) {
          // One broken subscriber must not cost the rest their delivery.
          devWarn(`Hub subscriber threw on "${signal.type}": ${String(error)}`);
        }
      }
      return signal;
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    since(cursor) {
      if (!cursor || ring.length === 0) return [];
      // Newest-first search: a healthy reconnect's cursor sits near the tail.
      for (let i = ring.length - 1; i >= 0; i--) {
        if (at(i).id === cursor) {
          const out: AnySignal[] = [];
          for (let j = i + 1; j < ring.length; j++) out.push(at(j));
          return out;
        }
      }
      // Unknown cursor: the client is further behind than the buffer reaches.
      const all: AnySignal[] = [];
      for (let i = 0; i < ring.length; i++) all.push(at(i));
      return all;
    },

    lastId() {
      if (ring.length === 0) return undefined;
      return ring[(head + ring.length - 1) % ring.length]!.id;
    },

    subscriberCount: () => subscribers.size,
  };
}

// ---------------------------------------------------------------------------
// Channels — scoped hubs for multi-user apps
// ---------------------------------------------------------------------------

export interface SignalHubsOptions {
  /** Ring capacity of each channel's hub. Default 500. */
  capacity?: number;
  /**
   * How many channels to keep before evicting the least-recently-used one
   * (keyed maps grow forever otherwise — one channel per user who ever
   * visited). Eviction skips channels with live subscribers, so an active
   * stream is never split from its publishers; if every channel is live, the
   * cap is exceeded rather than break one. An evicted channel only loses its
   * replay backlog — the next `channel(key)` starts a fresh hub, and a
   * reconnecting client gets best-effort replay, exactly as after a server
   * restart. Default 1000.
   */
  maxChannels?: number;
}

export interface SignalHubs {
  /**
   * The hub for one scope key — `user:42`, `tenant:acme`, `room:7`. Created
   * on first use; the same key returns the same hub (and marks it
   * recently-used). Derive the key from the *authenticated* session on the
   * server, never from a client-supplied value, or scoping is decorative.
   */
  channel(key: string): SignalHub;
  /** Drop a channel and its backlog (e.g. on logout / room teardown). */
  delete(key: string): boolean;
  /** Current channel keys, least-recently-used first. */
  keys(): string[];
}

/**
 * A keyed registry of hubs — the scoping primitive:
 *
 *   const hubs = createSignalHubs();              // module scope, like a hub
 *
 *   // publish (Server Action, webhook): scope by the data's owner
 *   hubs.channel(`user:${order.userId}`).publish(bridge.send('order/status', ...));
 *
 *   // app/api/stream/route.ts: scope by the *authenticated* caller
 *   const hub = hubs.channel(`user:${session.userId}`);
 *   return signalStream(req, ({ emit, lastEventId }) => {
 *     for (const missed of hub.since(lastEventId)) emit(missed);
 *     return hub.subscribe(emit);
 *   });
 *
 * Replay isolation falls out: `since()` only ever reaches one channel's
 * backlog, so one user's deltas cannot be replayed to another.
 */
export function createSignalHubs(options: SignalHubsOptions = {}): SignalHubs {
  const maxChannels = Math.max(1, options.maxChannels ?? 1000);
  // Map iteration order is insertion order; `channel()` re-inserts on access,
  // making the first key the least recently used.
  const hubs = new Map<string, SignalHub>();

  return {
    channel(key) {
      const existing = hubs.get(key);
      if (existing) {
        hubs.delete(key);
        hubs.set(key, existing);
        return existing;
      }
      const hub = createSignalHub({ capacity: options.capacity });
      hubs.set(key, hub);
      if (hubs.size > maxChannels) {
        // Evict idle channels, LRU first — never the one just created, and
        // never one someone is streaming from (that would silently split its
        // subscribers from future publishes).
        for (const [candidate, candidateHub] of hubs) {
          if (hubs.size <= maxChannels) break;
          if (candidate !== key && candidateHub.subscriberCount() === 0) hubs.delete(candidate);
        }
        if (hubs.size > maxChannels) {
          devWarn(
            `${hubs.size} channels all have live subscribers — exceeding maxChannels (${maxChannels}) rather than splitting one.`,
          );
        }
      }
      return hub;
    },

    delete: (key) => hubs.delete(key),

    keys: () => [...hubs.keys()],
  };
}
