import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineBridge, type AnySignal } from './core';
import { createReceiver, type Target } from './receiver';
import { connectSignalStream, signalStream, type StreamContext } from './stream';

interface S {
  notices: string[];
  user: { name: string };
}

const initialState: S = { notices: [], user: { name: 'Ada' } };

const bridge = defineBridge(initialState, {
  'notice/add': (p: { text: string }, s) => ({ notices: [...s.notices, p.text] }),
  'notice/clear': (_: void, _s) => ({ notices: [] }),
  'user/rename': (p: { name: string }, s) => ({ user: { ...s.user, name: p.name } }),
});

/** A Target over a plain object — proof the library needs no state library. */
function objectTarget(): Target<S> & { state: S; labels: string[] } {
  const box = {
    state: { ...initialState },
    labels: [] as string[],
    getState: () => box.state,
    setState(patch: Partial<S>, label?: string) {
      box.state = { ...box.state, ...patch };
      if (label) box.labels.push(label);
    },
  };
  return box;
}

const make = () => {
  const target = objectTarget();
  return { target, receiver: createReceiver(bridge, target) };
};

describe('send', () => {
  it('builds a serializable signal with a unique id', () => {
    const a = bridge.send('notice/add', { text: 'hi' });
    const b = bridge.send('notice/add', { text: 'hi' });
    expect(a.type).toBe('notice/add');
    expect(a.payload).toEqual({ text: 'hi' });
    expect(a.id).not.toBe(b.id);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('omits the payload arg for void-payload signals', () => {
    expect(bridge.send('notice/clear').payload).toBeUndefined();
  });
});

describe('parse', () => {
  it('accepts a well-formed signal for this contract', () => {
    const sig = bridge.send('notice/add', { text: 'hi' });
    expect(bridge.parse(JSON.parse(JSON.stringify(sig)))).toEqual(sig);
  });

  it('rejects junk without throwing', () => {
    for (const junk of [null, undefined, 42, 'nope', [], {}, { id: 1, type: 'notice/add' }]) {
      expect(bridge.parse(junk)).toBeNull();
    }
  });

  it('rejects a signal whose type this contract does not know', () => {
    expect(bridge.parse({ id: '1', type: 'ghost/nope', payload: null })).toBeNull();
  });

  it('is inert against prototype-shaped types', () => {
    expect(bridge.parse({ id: '1', type: '__proto__', payload: null })).toBeNull();
    expect(bridge.parse({ id: '1', type: 'constructor', payload: null })).toBeNull();
  });

  it('rejects ids that would break the replay guard or SSE framing', () => {
    const base = { type: 'notice/add', payload: { text: 'x' } };
    expect(bridge.parse({ ...base, id: '' })).toBeNull(); // empty skips dedupe
    expect(bridge.parse({ ...base, id: 'a\nb' })).toBeNull(); // injects SSE fields
    expect(bridge.parse({ ...base, id: 'a\rb' })).toBeNull();
    expect(bridge.parse({ ...base, id: 'x'.repeat(257) })).toBeNull(); // bloats the seen set
    expect(bridge.parse({ ...base, id: 'x'.repeat(256) })).not.toBeNull();
  });
});

describe('receiver', () => {
  it('applies a signal to any target', () => {
    const { target, receiver } = make();
    receiver.ingest(bridge.send('notice/add', { text: 'hi' }));
    expect(target.state.notices).toEqual(['hi']);
  });

  it('patches only the keys a reducer names', () => {
    const { target, receiver } = make();
    const user = target.state.user;
    receiver.ingest(bridge.send('notice/add', { text: 'hi' }));
    expect(target.state.user).toBe(user);
  });

  it('reads live state, so a burst cannot overwrite itself', () => {
    const { target, receiver } = make();
    receiver.ingest([
      bridge.send('notice/add', { text: 'a' }),
      bridge.send('notice/add', { text: 'b' }),
      bridge.send('notice/add', { text: 'c' }),
    ]);
    expect(target.state.notices).toEqual(['a', 'b', 'c']);
  });

  it('applies each id at most once', () => {
    const { target, receiver } = make();
    const sig = bridge.send('notice/add', { text: 'hi' });
    receiver.ingest(sig);
    receiver.ingest(sig);
    expect(target.state.notices).toEqual(['hi']);
  });

  it('passes the signal type as a label, for devtools timelines', () => {
    const { target, receiver } = make();
    receiver.ingest(bridge.send('user/rename', { name: 'Grace' }));
    expect(target.labels).toEqual(['user/rename']);
  });

  it('accept() validates untrusted values and reports what it did', () => {
    const { target, receiver } = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const good = JSON.parse(JSON.stringify(bridge.send('notice/add', { text: 'hi' })));
    expect(receiver.accept(good)).toBe(true);
    expect(receiver.accept({ id: 'x', type: 'ghost/nope' })).toBe(false);
    expect(receiver.accept('garbage')).toBe(false);

    expect(target.state.notices).toEqual(['hi']);
    warn.mockRestore();
  });

  it('tracks the last applied id as a resume cursor', () => {
    const { receiver } = make();
    expect(receiver.lastId()).toBeUndefined();
    const first = bridge.send('notice/add', { text: 'a' });
    const second = bridge.send('notice/add', { text: 'b' });
    receiver.ingest([first, second]);
    expect(receiver.lastId()).toBe(second.id);
  });

  it('warns but does not throw on a signal with no reducer', () => {
    const { receiver } = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    receiver.ingest({ id: '1', type: 'ghost/nope', payload: null } as never);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  /** Explicit type args: no reliance on inference surviving a `never` reducer. */
  const boomBridge = () =>
    defineBridge<{ n: number }, { boom: void; inc: void }>(
      { n: 0 },
      {
        boom: () => {
          throw new Error('kaboom');
        },
        inc: (_p, s) => ({ n: s.n + 1 }),
      },
    );

  const boomTarget = () => {
    const box = {
      state: { n: 0 },
      getState: () => box.state,
      setState: (patch: Partial<{ n: number }>) => {
        box.state = { ...box.state, ...patch };
      },
    };
    return box;
  };

  it('contains a throwing reducer: the batch survives and a replay does not retry it', () => {
    const b = boomBridge();
    const target = boomTarget();
    const receiver = createReceiver(b, target);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const boom = b.send('boom');
    const inc = b.send('inc');
    receiver.ingest([boom, inc]); // the throw must not abort the batch
    expect(target.state.n).toBe(1);
    expect(receiver.lastId()).toBe(inc.id);
    expect(warn).toHaveBeenCalledTimes(1);

    receiver.ingest(boom); // replayed failed id: already seen, so no retry storm
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not advance the cursor past a signal that failed to apply', () => {
    const b = boomBridge();
    const receiver = createReceiver(b, boomTarget());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    receiver.ingest(b.send('boom'));
    // Claiming this id would make a resume skip a delta that never applied.
    expect(receiver.lastId()).toBeUndefined();
    warn.mockRestore();
  });
});

describe('signalStream', () => {
  /** Reads the whole SSE body as text. */
  async function drain(response: Response): Promise<string> {
    return new TextDecoder().decode(await new Response(response.body).arrayBuffer());
  }

  it('sets headers that keep a stream from being buffered or cached', () => {
    const res = signalStream(new Request('http://x/stream'), ({ close }) => close());
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('Cache-Control')).toContain('no-transform');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
  });

  it('frames signals as SSE events with the id as the cursor', async () => {
    const sig = bridge.send('notice/add', { text: 'hi' });
    const res = signalStream(new Request('http://x/stream'), ({ emit, close }) => {
      emit(sig);
      close();
    });

    const body = await drain(res);
    expect(body).toBe(`: ok\n\nid: ${sig.id}\ndata: ${JSON.stringify(sig)}\n\n`);
  });

  it('exposes the client cursor on reconnect', () => {
    const seen: (string | undefined)[] = [];
    const req = new Request('http://x/stream', { headers: { 'Last-Event-ID': 'sig-42' } });
    signalStream(req, ({ lastEventId, close }) => {
      seen.push(lastEventId);
      close();
    });
    expect(seen).toEqual(['sig-42']);
  });

  it('runs cleanup when the client disconnects', async () => {
    const cleanup = vi.fn();
    const res = signalStream(new Request('http://x/stream'), () => cleanup);
    await res.body!.cancel();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('round-trips server → wire → receiver', async () => {
    const { target, receiver } = make();
    const res = signalStream(new Request('http://x/stream'), ({ emit, close }) => {
      emit(bridge.send('notice/add', { text: 'from server' }));
      emit(bridge.send('user/rename', { name: 'Grace' }));
      close();
    });

    // Parse the real SSE body the way a client would.
    for (const chunk of (await drain(res)).split('\n\n')) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) receiver.accept(JSON.parse(line.slice(6)));
    }

    expect(target.state.notices).toEqual(['from server']);
    expect(target.state.user.name).toBe('Grace');
  });

  it('ignores emit() after close instead of throwing', async () => {
    const res = signalStream(new Request('http://x/stream'), ({ emit, close }) => {
      close();
      expect(() => emit(bridge.send('notice/clear'))).not.toThrow();
    });
    // Only the open-flush comment made it out before close.
    expect(await drain(res)).toBe(': ok\n\n');
  });

  it('emits heartbeat comments so intermediaries see traffic and dead clients get noticed', async () => {
    let ctx!: StreamContext;
    const res = signalStream(new Request('http://x/stream'), (c) => void (ctx = c), {
      heartbeatMs: 5,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toBe(': ok\n\n');
    expect(dec.decode((await reader.read()).value)).toBe(': hb\n\n');
    ctx.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('reads the resume cursor from the query param when the header is absent', () => {
    const seen: (string | undefined)[] = [];
    signalStream(new Request('http://x/stream?lastEventId=sig-7'), ({ lastEventId, close }) => {
      seen.push(lastEventId);
      close();
    });
    expect(seen).toEqual(['sig-7']);
  });

  it('prefers the Last-Event-ID header over the query param — the header is fresher', () => {
    const seen: (string | undefined)[] = [];
    const req = new Request('http://x/stream?lastEventId=stale', {
      headers: { 'Last-Event-ID': 'fresh' },
    });
    signalStream(req, ({ lastEventId, close }) => {
      seen.push(lastEventId);
      close();
    });
    expect(seen).toEqual(['fresh']);
  });

  it('runs cleanup when the server itself ends the stream', async () => {
    const cleanup = vi.fn();
    const res = signalStream(new Request('http://x/stream'), ({ close }) => {
      close(); // synchronous close — cleanup is returned *after* this runs
      return cleanup;
    });
    await drain(res);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('runs cleanup when the request aborts', () => {
    const cleanup = vi.fn();
    const ac = new AbortController();
    signalStream(new Request('http://x/stream', { signal: ac.signal }), () => cleanup);
    ac.abort();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('runs cleanup at most once across close, cancel, and abort', async () => {
    const cleanup = vi.fn();
    let ctx!: StreamContext;
    const res = signalStream(new Request('http://x/stream'), (c) => {
      ctx = c;
      return cleanup;
    });
    ctx.close();
    await res.body!.cancel();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('closes the stream (with cleanup) when start() throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = signalStream(new Request('http://x/stream'), () => {
      throw new Error('subscribe exploded');
    });
    expect(await drain(res)).toBe(': ok\n\n'); // clean close, not an errored body
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('drops a signal whose id would corrupt SSE framing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = signalStream(new Request('http://x/stream'), ({ emit, close }) => {
      emit({ id: 'evil\ndata: {"x":1}', type: 'notice/add', payload: { text: 'x' } });
      emit(bridge.send('notice/add', { text: 'fine' }));
      close();
    });
    const body = await drain(res);
    expect(body).not.toContain('evil');
    expect(body).toContain('fine');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('closes a stalled stream past maxBufferedFrames so the client can resume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = vi.fn();
    const res = signalStream(
      new Request('http://x/stream'),
      ({ emit }) => {
        for (let i = 0; i < 100; i++) emit(bridge.send('notice/add', { text: String(i) }));
        return cleanup;
      },
      { maxBufferedFrames: 5 },
    );
    expect(cleanup).toHaveBeenCalledOnce(); // guard tripped during the burst
    const frames = (await drain(res)).split('\n\n').filter((c) => c.includes('data: '));
    expect(frames.length).toBeLessThan(100);
    warn.mockRestore();
  });
});

describe('connectSignalStream', () => {
  /** Minimal EventSource double: records instances, lets tests drive events. */
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    withCredentials: boolean;
    readyState = 0;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string, init?: { withCredentials?: boolean }) {
      this.url = url;
      this.withCredentials = !!init?.withCredentials;
      FakeEventSource.instances.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    emitOpen() {
      this.readyState = 1;
      this.onopen?.();
    }
    emitMessage(data: string) {
      this.onmessage?.({ data } as MessageEvent);
    }
    emitError(opts: { fatal: boolean }) {
      this.readyState = opts.fatal ? 2 : 0;
      this.onerror?.(new Event('error'));
    }
  }
  const Impl = FakeEventSource as unknown as typeof EventSource;

  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  it('feeds frames to the receiver and drops non-JSON without throwing', () => {
    const { target, receiver } = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = connectSignalStream(receiver, '/api/stream', { EventSourceImpl: Impl });
    const es = FakeEventSource.instances[0]!;

    es.emitMessage(JSON.stringify(bridge.send('notice/add', { text: 'live' })));
    expect(() => es.emitMessage('not json')).not.toThrow();
    expect(target.state.notices).toEqual(['live']);

    off();
    expect(es.closed).toBe(true);
    warn.mockRestore();
  });

  it('carries the resume cursor as a query param on fresh connections', () => {
    const { receiver } = make();
    const sig = bridge.send('notice/add', { text: 'x' });
    receiver.ingest(sig);

    connectSignalStream(receiver, '/api/stream', { EventSourceImpl: Impl })();
    connectSignalStream(receiver, '/api/stream?tenant=a', { EventSourceImpl: Impl })();
    expect(FakeEventSource.instances[0]!.url).toBe(`/api/stream?lastEventId=${sig.id}`);
    expect(FakeEventSource.instances[1]!.url).toBe(`/api/stream?tenant=a&lastEventId=${sig.id}`);
  });

  it('leaves the url alone with no cursor yet, or with cursorParam: false', () => {
    const { receiver } = make();
    connectSignalStream(receiver, '/api/stream', { EventSourceImpl: Impl })();
    receiver.ingest(bridge.send('notice/add', { text: 'x' }));
    connectSignalStream(receiver, '/api/stream', { EventSourceImpl: Impl, cursorParam: false })();
    expect(FakeEventSource.instances.map((es) => es.url)).toEqual(['/api/stream', '/api/stream']);
  });

  it('rebuilds after a fatal failure with backoff, resuming from the cursor', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { receiver } = make();
    const sig = bridge.send('notice/add', { text: 'x' });
    receiver.ingest(sig);
    const fatals: boolean[] = [];

    const off = connectSignalStream(receiver, '/api/stream', {
      EventSourceImpl: Impl,
      onError: (_e, info) => fatals.push(info.fatal),
    });
    FakeEventSource.instances[0]!.emitError({ fatal: true });
    expect(fatals).toEqual([true]);
    expect(FakeEventSource.instances).toHaveLength(1); // not synchronously

    vi.advanceTimersByTime(1_000); // first delay is ≤ 1s even with jitter
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain(`lastEventId=${sig.id}`);

    off();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('stands back during EventSource’s own retries (non-fatal errors)', () => {
    vi.useFakeTimers();
    const { receiver } = make();
    const fatals: boolean[] = [];
    const off = connectSignalStream(receiver, '/api/stream', {
      EventSourceImpl: Impl,
      onError: (_e, info) => fatals.push(info.fatal),
    });

    FakeEventSource.instances[0]!.emitError({ fatal: false });
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1); // EventSource handles it
    expect(fatals).toEqual([false]);

    off();
    vi.useRealTimers();
  });

  it('disconnecting cancels a pending rebuild; reconnect: false disables it entirely', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { receiver } = make();

    const off = connectSignalStream(receiver, '/api/stream', { EventSourceImpl: Impl });
    FakeEventSource.instances[0]!.emitError({ fatal: true });
    off(); // during the backoff wait
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    connectSignalStream(receiver, '/api/stream', { EventSourceImpl: Impl, reconnect: false });
    FakeEventSource.instances[1]!.emitError({ fatal: true });
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    warn.mockRestore();
    vi.useRealTimers();
  });
});
