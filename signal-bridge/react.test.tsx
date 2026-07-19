// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineBridge } from './core';
import { createReceiver, type Receiver } from './receiver';
import { BridgeSignal, SignalProvider, useSignalStream } from './react';
import type { ConnectOptions } from './stream';

interface S {
  notices: string[];
}

const bridge = defineBridge({ notices: [] as string[] } as S, {
  'notice/add': (p: { text: string }, s) => ({ notices: [...s.notices, p.text] }),
});

function setup() {
  const box = {
    state: { notices: [] as string[] },
    getState: () => box.state,
    setState(patch: Partial<S>) {
      box.state = { ...box.state, ...patch };
    },
  };
  return { target: box, receiver: createReceiver(bridge, box) };
}

/** Just enough EventSource for the hook's lifecycle. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
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
}
const Impl = FakeEventSource as unknown as typeof EventSource;

function Stream({
  url,
  ...opts
}: { url: string } & ConnectOptions & { enabled?: boolean; shared?: boolean }) {
  useSignalStream(url, opts);
  return null;
}

const providers =
  (receiver: Receiver<any>) =>
  (children: React.ReactNode) => <SignalProvider receiver={receiver}>{children}</SignalProvider>;

afterEach(cleanup);
beforeEach(() => {
  FakeEventSource.instances = [];
});

describe('BridgeSignal', () => {
  it('applies a signal exactly once despite Strict Mode double-effects', () => {
    const { target, receiver } = setup();
    const sig = bridge.send('notice/add', { text: 'hi' });
    render(<StrictMode>{providers(receiver)(<BridgeSignal signal={sig} />)}</StrictMode>);
    expect(target.state.notices).toEqual(['hi']);
  });

  it('warns and drops the signal outside a provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<BridgeSignal signal={bridge.send('notice/add', { text: 'lost' })} />);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('useSignalStream', () => {
  it('holds one live connection under Strict Mode and closes it on unmount', () => {
    const { receiver } = setup();
    const { unmount } = render(
      <StrictMode>{providers(receiver)(<Stream url="/api/stream" EventSourceImpl={Impl} />)}</StrictMode>,
    );
    // Strict Mode runs connect → disconnect → connect; exactly one survives.
    expect(FakeEventSource.instances.filter((es) => !es.closed)).toHaveLength(1);
    unmount();
    expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true);
  });

  it('uses the latest callbacks without rebuilding the connection', () => {
    const { receiver } = setup();
    const first = vi.fn();
    const second = vi.fn();
    const ui = (onOpen: () => void) =>
      providers(receiver)(<Stream url="/api/stream" EventSourceImpl={Impl} onOpen={onOpen} />);

    const { rerender } = render(ui(first));
    const connections = FakeEventSource.instances.length;
    rerender(ui(second));
    expect(FakeEventSource.instances).toHaveLength(connections); // no churn from a new inline fn

    act(() => FakeEventSource.instances.at(-1)!.emitOpen());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce(); // and yet the fresh closure fired
  });

  it('enabled: false holds off until it flips true', () => {
    const { receiver } = setup();
    const ui = (enabled: boolean) =>
      providers(receiver)(<Stream url="/api/stream" EventSourceImpl={Impl} enabled={enabled} />);

    const { rerender } = render(ui(false));
    expect(FakeEventSource.instances).toHaveLength(0);
    rerender(ui(true));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('useSignalStream · shared connections', () => {
  it('mounts sharing a receiver and url share one EventSource', () => {
    const { receiver } = setup();
    const { unmount } = render(
      providers(receiver)(
        <>
          <Stream url="/api/stream" EventSourceImpl={Impl} />
          <Stream url="/api/stream" EventSourceImpl={Impl} />
        </>,
      ),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it('the connection survives until the last sharer unmounts', () => {
    const { receiver } = setup();
    const ui = (two: boolean) =>
      providers(receiver)(
        <>
          <Stream url="/api/stream" EventSourceImpl={Impl} />
          {two && <Stream url="/api/stream" EventSourceImpl={Impl} />}
        </>,
      );

    const { rerender, unmount } = render(ui(true));
    expect(FakeEventSource.instances).toHaveLength(1);
    rerender(ui(false)); // one sharer leaves
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    unmount(); // the last one leaves
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it("every sharer's callbacks fire on shared connection events", () => {
    const { receiver } = setup();
    const first = vi.fn();
    const second = vi.fn();
    render(
      providers(receiver)(
        <>
          <Stream url="/api/stream" EventSourceImpl={Impl} onOpen={first} />
          <Stream url="/api/stream" EventSourceImpl={Impl} onOpen={second} />
        </>,
      ),
    );
    act(() => FakeEventSource.instances[0]!.emitOpen());
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('different urls do not share; shared: false opts a mount out', () => {
    const { receiver } = setup();
    render(
      providers(receiver)(
        <>
          <Stream url="/api/stream" EventSourceImpl={Impl} />
          <Stream url="/api/other" EventSourceImpl={Impl} />
          <Stream url="/api/stream" EventSourceImpl={Impl} shared={false} />
        </>,
      ),
    );
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});
