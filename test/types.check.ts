/**
 * Compile-time assertions. This file never runs — it exists so `npm run
 * check` (tsc --noEmit) fails if the public API's inference regresses.
 * Every `@ts-expect-error` line MUST be an error, or tsc reports it.
 */
import { createStore, slice, type Signal } from '../src/core';
import { useBridge } from '../src/client';

const store = createStore({
  user: slice(
    { name: 'Ada', plan: 'free' as 'free' | 'pro' },
    {
      rename: (payload: { name: string }, state) => ({ ...state, name: payload.name }),
      reset: (_: void, state) => ({ ...state, name: 'Ada' }),
    },
  ),
});

// ---- handler `state` is contextually typed from the slice's initial state
slice({ count: 0 }, {
  add: (payload: { by: number }, state) => ({ count: state.count + payload.by }),
  // @ts-expect-error — handler must return the slice's state shape
  broken: (_: void, state) => ({ wrong: true }),
});

// ---- actions: payload inference
store.actions.user.rename({ name: 'Grace' });
store.actions.user.reset(); // void payload → zero-arg
// @ts-expect-error — wrong payload property type
store.actions.user.rename({ name: 42 });
// @ts-expect-error — unknown action
store.actions.user.destroy;
// @ts-expect-error — unknown slice
store.actions.ghost;

// ---- send: slice/action/payload all checked, template-literal type
const sig = store.send('user', 'rename', { name: 'Grace' });
const _sigType: Signal<'user/rename', { name: string }> = sig;
store.send('user', 'reset'); // void payload → two-arg call
// @ts-expect-error — wrong payload shape
store.send('user', 'rename', { nom: 'Grace' });
// @ts-expect-error — unknown action
store.send('user', 'destroy', {});
// @ts-expect-error — unknown slice
store.send('ghost', 'rename', { name: 'Grace' });

// ---- state reads
const _name: string = store.get().user.name;
const _initialPlan: 'free' | 'pro' = store.initial.user.plan;
// @ts-expect-error — unknown slice
store.get().ghost;

// ---- execute: result type flows through untouched
async function _exec() {
  const result = await store.execute(
    Promise.resolve({ ok: true as const, orderId: 'x', signal: store.send('user', 'reset') }),
  );
  const _orderId: string = result.orderId;
  // @ts-expect-error — property does not exist on the declared result
  result.missing;
}

// ---- useBridge: slice + selector inference (types only; never executed)
function _Component() {
  const [user, actions] = useBridge(store, 'user');
  const _plan: 'free' | 'pro' = user.plan;
  actions.rename({ name: 'Grace' });

  const [nameLen] = useBridge(store, 'user', (s) => s.name.length);
  const _len: number = nameLen;

  // @ts-expect-error — unknown slice name
  useBridge(store, 'ghost');
  // @ts-expect-error — selector param is typed; no `.missing` on user state
  useBridge(store, 'user', (s) => s.missing);
  return null;
}
