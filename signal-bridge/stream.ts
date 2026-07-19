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
 * touches EventSource only. Production posture is built in on both sides:
 * heartbeats, dead-client detection, backpressure, and resume across *fresh*
 * connections (the browser only replays `Last-Event-ID` on its own retries).
 */

import { devWarn, type AnySignal } from './core';
import type { Receiver } from './receiver';

// ---------------------------------------------------------------------------
// Server — use inside a Next Route Handler
// ---------------------------------------------------------------------------

export interface StreamContext {
  /** Push a signal to this client. */
  emit(signal: AnySignal): void;
  /** End the stream. Cleanup returned from `start` runs exactly once. */
  close(): void;
  /**
   * The client's cursor: the id of the last signal it applied. Arrives as the
   * `Last-Event-ID` header on an automatic EventSource retry, or as the cursor
   * query param (`?lastEventId=`) on a fresh connection made by
   * `connectSignalStream`. Replay from just after this — the client's replay
   * guard absorbs any overlap. `undefined` on a first connection.
   */
  lastEventId?: string;
}

export interface StreamOptions {
  /**
   * Interval for `: hb` comment heartbeats. Keep-alive traffic stops proxies
   * and load balancers from idling the connection out, and a failed write is
   * how the server *notices* a silently vanished client — without one, a
   * dropped connection leaks its subscription until the next real emit.
   * `false` disables. Default 15s.
   */
  heartbeatMs?: number | false;
  /**
   * Close the stream once this many frames sit unconsumed (a stalled client).
   * Safe by construction: the client reconnects and resumes from its cursor,
   * so this turns unbounded server-side buffering into a designed reconnect.
   * `false` disables. Default 1000.
   */
  maxBufferedFrames?: number | false;
  /**
   * Query param read as the resume cursor when the `Last-Event-ID` header is
   * absent (i.e. on fresh connections, which cannot set headers). Must match
   * the client's `cursorParam`. `false` disables. Default `"lastEventId"`.
   */
  cursorParam?: string | false;
}

const encoder = new TextEncoder();

/** SSE wire frame. `id:` is what the browser echoes back as `Last-Event-ID`. */
function frame(signal: AnySignal): string | null {
  // A line break in the id would terminate the `id:` field early and let the
  // remainder inject arbitrary SSE fields. Ids from `send()` are uuids, but a
  // server echoing stored or parsed signals may carry ids it didn't mint.
  if (/[\r\n]/.test(signal.id)) {
    devWarn(`Dropped signal "${signal.type}": its id contains a line break, which would corrupt SSE framing.`);
    return null;
  }
  return `id: ${signal.id}\ndata: ${JSON.stringify(signal)}\n\n`;
}

/** Header if present (fresher — set by the browser's own retry), else query param. */
function cursorFrom(request: Request, cursorParam: string | false): string | undefined {
  const header = request.headers.get('last-event-id');
  if (header) return header;
  if (cursorParam === false) return undefined;
  try {
    return new URL(request.url).searchParams.get(cursorParam) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a streaming `Response` of signals:
 *
 *   // app/api/stream/route.ts
 *   export const dynamic = 'force-dynamic';
 *   export function GET(req: Request) {
 *     return signalStream(req, ({ emit }) => {
 *       const off = bus.subscribe((s) => emit(s));
 *       return off;            // runs once, however the stream ends
 *     });
 *   }
 *
 * Return a cleanup function from `start` to release resources. It runs exactly
 * once, whichever way the stream ends: the client disconnects, the request
 * aborts, the server calls `close()`, the backpressure guard trips, or `start`
 * itself throws.
 */
export function signalStream(
  request: Request,
  start: (ctx: StreamContext) => void | (() => void),
  options: StreamOptions = {},
): Response {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBufferedFrames =
    options.maxBufferedFrames === false ? false : Math.max(1, options.maxBufferedFrames ?? 1_000);

  // Assigned inside `start` below; `cancel` (consumer-side teardown) needs it.
  let finish: (closeController: boolean) => void = () => {};

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      let open = true;
      let cleanup: (() => void) | void;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const runCleanup = () => {
        try {
          cleanup?.();
        } catch (error) {
          devWarn(`Stream cleanup threw: ${String(error)}`);
        }
        cleanup = undefined; // exactly once
      };

      const onAbort = () => finish(true);

      finish = (closeController) => {
        if (!open) return;
        open = false;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        request.signal?.removeEventListener('abort', onAbort);
        runCleanup(); // no-op if start() hasn't returned yet — handled below
        if (closeController) {
          try {
            controller.close();
          } catch {
            /* consumer already gone */
          }
        }
      };

      const write = (text: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish(false); // client vanished mid-write
          return;
        }
        // desiredSize goes negative as unread frames queue; a healthy consumer
        // keeps it near 1. Deeply negative means the client stalled.
        if (maxBufferedFrames !== false && (controller.desiredSize ?? 0) <= -maxBufferedFrames) {
          devWarn(
            `Stream buffered ${maxBufferedFrames}+ frames with no consumer progress — closing so the client reconnects and resumes.`,
          );
          finish(true);
        }
      };

      const ctx: StreamContext = {
        emit(signal) {
          const text = frame(signal);
          if (text !== null) write(text);
        },
        close: () => finish(true),
        lastEventId: cursorFrom(request, options.cursorParam ?? 'lastEventId'),
      };

      request.signal?.addEventListener('abort', onAbort);
      // Flush a comment immediately: intermediaries that buffer "empty"
      // responses release the connection once bytes flow.
      write(': ok\n\n');
      if (open && heartbeatMs !== false && heartbeatMs > 0) {
        heartbeat = setInterval(() => write(': hb\n\n'), heartbeatMs);
      }

      try {
        cleanup = start(ctx);
      } catch (error) {
        devWarn(`Stream start() threw: ${String(error)} — closing the stream.`);
        finish(true);
      }
      if (!open) runCleanup(); // start() ended the stream synchronously; its cleanup still runs
    },
    cancel: () => finish(false),
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
  /**
   * `info.fatal` is true when EventSource has given up permanently (an HTTP
   * error status or wrong content type — e.g. an expired session). The library
   * then rebuilds the connection with capped backoff unless `reconnect: false`.
   * Non-fatal errors are EventSource's own retries; it handles them itself.
   */
  onError?: (event: Event, info: { fatal: boolean }) => void;
  /**
   * Query param that carries `receiver.lastId()` on fresh connections, so a
   * remount or a rebuilt connection resumes instead of starting blank (the
   * browser only sends `Last-Event-ID` on its own automatic retries, and
   * EventSource cannot set headers). Must match the server's `cursorParam`.
   * `false` disables. Default `"lastEventId"`.
   */
  cursorParam?: string | false;
  /** Rebuild the connection (capped backoff) after a fatal failure. Default `true`. */
  reconnect?: boolean;
}

/** EventSource.CLOSED, without assuming the global exists (tests inject an impl). */
const CLOSED = 2;

/**
 * Streams signals into a receiver. Returns a disconnect function — call it on
 * unmount, or the connection outlives the component.
 *
 * Transient drops are EventSource's job: it retries on its own and replays
 * `Last-Event-ID`. This wrapper adds the two things EventSource won't do:
 * carry the resume cursor on *fresh* connections (via `cursorParam`), and
 * rebuild the connection with capped, jittered backoff when EventSource gives
 * up permanently. Junk frames are dropped, never thrown.
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
  const cursorParam = opts.cursorParam ?? 'lastEventId';
  const reconnect = opts.reconnect ?? true;

  let source: EventSource | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let disconnected = false;

  const urlWithCursor = () => {
    const cursor = receiver.lastId();
    if (!cursor || cursorParam === false) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${encodeURIComponent(cursorParam)}=${encodeURIComponent(cursor)}`;
  };

  const connect = () => {
    const es = new Impl(urlWithCursor(), { withCredentials: opts.withCredentials });
    source = es;

    es.onopen = () => {
      attempts = 0;
      opts.onOpen?.();
    };

    es.onmessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        devWarn('Discarded a stream frame that was not JSON.');
        return;
      }
      receiver.accept(parsed);
    };

    es.onerror = (event: Event) => {
      // Anything short of CLOSED is EventSource retrying on its own (it will
      // replay `Last-Event-ID` itself) — surface it and stand back.
      const fatal = es.readyState === CLOSED;
      opts.onError?.(event, { fatal });
      if (!fatal || disconnected) return;
      es.close();
      if (!reconnect) return;
      // EventSource has given up. Rebuild it ourselves — the cursor param lets
      // the new connection resume. Capped exponential backoff with jitter, so
      // a restarted server isn't stampeded by every client at once.
      const cap = Math.min(30_000, 1_000 * 2 ** attempts++);
      const delay = cap / 2 + Math.random() * (cap / 2);
      devWarn(`Stream failed permanently (HTTP error?) — reconnecting in ~${Math.round(delay / 1000)}s.`);
      retryTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    disconnected = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    source?.close();
  };
}
