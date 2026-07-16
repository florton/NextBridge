/**
 * signal-bridge · SSE transport
 *
 * The piece nothing else offers: a typed, deduplicated, resumable server→client
 * delta stream for Next. Server-Sent Events rather than websockets because SSE
 * rides plain HTTP — it needs no second server, works through a Route Handler,
 * reconnects on its own, and has a resume cursor built into the protocol
 * (`id:` / `Last-Event-ID`) that `Signal.id` slots straight into.
 *
 * The server half is runtime-agnostic (Web Streams + Response); the client half
 * touches EventSource only.
 */

import { devWarn, type AnySignal } from './core';
import type { Receiver } from './receiver';

// ---------------------------------------------------------------------------
// Server — use inside a Next Route Handler
// ---------------------------------------------------------------------------

export interface StreamContext {
  /** Push a signal to this client. */
  emit(signal: AnySignal): void;
  /** End the stream. */
  close(): void;
  /**
   * The client's cursor on reconnect: the id of the last signal it applied.
   * Replay from just after this, and the client's replay guard covers any
   * overlap. `undefined` on a first connection.
   */
  lastEventId?: string;
}

/** SSE wire frame. `id:` is what the browser echoes back as `Last-Event-ID`. */
function frame(signal: AnySignal): string {
  return `id: ${signal.id}\ndata: ${JSON.stringify(signal)}\n\n`;
}

/**
 * Builds a streaming `Response` of signals:
 *
 *   // app/api/stream/route.ts
 *   export const dynamic = 'force-dynamic';
 *   export function GET(req: Request) {
 *     return signalStream(req, ({ emit }) => {
 *       const off = bus.subscribe((s) => emit(s));
 *       return off;            // called when the client disconnects
 *     });
 *   }
 *
 * Return a cleanup function from `start` to release resources on disconnect —
 * without it you leak a subscription per dropped connection.
 */
export function signalStream(
  request: Request,
  start: (ctx: StreamContext) => void | (() => void),
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | void;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const ctx: StreamContext = {
        emit(signal) {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(frame(signal)));
          } catch {
            open = false; // client vanished mid-write
          }
        },
        close() {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        lastEventId: request.headers.get('last-event-id') ?? undefined,
      };
      cleanup = start(ctx);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform matters: a proxy that buffers or gzips will stall the stream.
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  withCredentials?: boolean;
  /** Injectable for tests; defaults to the global EventSource. */
  EventSourceImpl?: typeof EventSource;
  onOpen?: () => void;
  onError?: (event: Event) => void;
}

/**
 * Streams signals into a receiver. Returns a disconnect function — call it on
 * unmount, or the connection outlives the component.
 *
 * EventSource reconnects by itself and replays `Last-Event-ID`, so resume is
 * the browser's job; overlap on reconnect is absorbed by the receiver's id
 * dedupe. Junk frames are dropped, never thrown.
 */
export function connectSignalStream<P>(
  receiver: Receiver<P>,
  url: string,
  opts: ConnectOptions = {},
): () => void {
  const Impl = opts.EventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (!Impl) {
    devWarn('No EventSource available — stream not connected.');
    return () => {};
  }

  const source = new Impl(url, { withCredentials: opts.withCredentials });

  source.onmessage = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      devWarn('Discarded a stream frame that was not JSON.');
      return;
    }
    receiver.accept(parsed);
  };

  if (opts.onOpen) source.onopen = opts.onOpen;
  source.onerror = (event: Event) => {
    // EventSource retries on its own; surface it without tearing down.
    opts.onError?.(event);
  };

  return () => source.close();
}
