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
    // Resume. EventSource replays the client's cursor as `Last-Event-ID` on
    // reconnect, so send what it missed rather than the whole history. Any
    // overlap is absorbed by the receiver's id dedupe, so a generous replay
    // window is safe.
    for (const missed of backlogSince(lastEventId)) emit(missed);

    // `send` is type-checked here exactly as it is in a Server Action — a
    // typo'd type or a wrong payload fails `tsc` on the server.
    const unsubscribe = orderEvents.subscribe((status) =>
      emit(appBridge.send('order/status', { status })),
    );

    const heartbeat = setInterval(
      () => emit(appBridge.send('presence/set', { online: countOnline() })),
      30_000,
    );

    // Returned cleanup runs when the client disconnects. Without it you leak a
    // subscription and a timer for every dropped connection — which, on a
    // long-lived stream, is every connection eventually.
    return () => {
      unsubscribe();
      clearInterval(heartbeat);
    };
  });
}
