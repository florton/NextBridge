// app/api/stream/route.ts
//
// The flagship: a typed, resumable delta stream, served from an ordinary Next
// Route Handler. No websocket server, no extra infrastructure — and with the
// hub, the whole handler is replay + follow-along.
import { signalStream } from '../stream'; // in your app: 'next-signal-bridge/server'
import { appBridge } from './bridge';
import { hub } from './hub';

// A stream must never be cached or statically rendered.
export const dynamic = 'force-dynamic';

/** Stand-in for real infrastructure. */
const countOnline = () => 1;

export function GET(request: Request) {
  return signalStream(request, ({ emit, lastEventId }) => {
    // Resume. `lastEventId` is the client's cursor from either channel — the
    // `Last-Event-ID` header on an automatic EventSource retry, or the
    // `?lastEventId=` query param that `connectSignalStream` adds to a fresh
    // connection (a remount, a rebuilt stream). The hub replays what the
    // client missed; overlap is absorbed by the receiver's id dedupe.
    for (const missed of hub.since(lastEventId)) emit(missed);

    // Follow along live: anything published anywhere on the server —
    // a Server Action, a webhook — reaches this client.
    const unsubscribe = hub.subscribe(emit);

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
