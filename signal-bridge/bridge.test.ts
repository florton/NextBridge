import { describe, expect, it, vi } from 'vitest';
import { defineBridge, type AnySignal } from './core';
import { createReceiver, type Target } from './receiver';
import { signalStream } from './stream';

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
    expect(body).toBe(`id: ${sig.id}\ndata: ${JSON.stringify(sig)}\n\n`);
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
    expect(await drain(res)).toBe('');
  });
});
