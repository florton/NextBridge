// app/api/stream/route.ts
//
// The flagship: a typed, resumable delta stream, served from an ordinary Next
// Route Handler. No websocket server, no extra infrastructure.
import { signalStream } from '../stream';
import { appBridge } from './bridge';
import type { AnySignal } from '../core';

// A stream must never be cached or statically rendered.
export const dynamic = 'force-dynamic';

// ---- stand-ins for your real infrastructure -------------------------------
const orderEvents = {
  subscribe(_fn: (status: 'paid' | 'shipped') => void): () => void {
    return () => {};
  },
};
/** Signals produced after `id`, so a reconnecting client can catch up. */
const backlogSince = (_id?: string): AnySignal[] => [];
const countOnline = () => 1;
// ---------------------------------------------------------------------------

export function GET(request: Request) {
  return signalStream(request, ({ emit, lastEventId }) => {
    // Resume. `lastEventId` is the client's cursor from either channel — the
    // `Last-Event-ID` header on an automatic EventSource retry, or the
    // `?lastEventId=` query param that `connectSignalStream` adds to a fresh
    // connection (a remount, a rebuilt stream). Send what the client missed
    // rather than the whole history; any overlap is absorbed by the
    // receiver's id dedupe, so a generous replay window is safe.
    for (const missed of backlogSince(lastEventId)) emit(missed);

    // `send` is type-checked here exactly as it is in a Server Action — a
    // typo'd type or a wrong payload fails `tsc` on the server.
    const unsubscribe = orderEvents.subscribe((status) =>
      emit(appBridge.send('order/status', { status })),
    );

    // Real data on an interval — NOT keep-alive plumbing. The library already
    // heartbeats comment frames on its own (see `heartbeatMs`), detects dead
    // clients, and closes stalled streams so they reconnect and resume.
    const presence = setInterval(
      () => emit(appBridge.send('presence/set', { online: countOnline() })),
      30_000,
    );

    // Returned cleanup runs exactly once, however the stream ends: client
    // disconnect, request abort, backpressure close, or close(). Without it
    // you leak a subscription and a timer per connection.
    return () => {
      unsubscribe();
      clearInterval(presence);
    };
  });
}
