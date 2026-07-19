/**
 * signal-bridge · hub (server, zero-dependency)
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
 * In-memory means one server process (`next start`, a container). On
 * serverless / multi-instance deployments, implement this same three-function
 * shape over shared infrastructure (Redis pub/sub + a capped stream, Postgres
 * LISTEN/NOTIFY) and the route handler doesn't change — see README → Deploying.
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
  };
}
