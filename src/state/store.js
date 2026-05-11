// Minimal pub/sub store. Lit components subscribe via subscribeStore() and
// re-render when emit() fires. Kept tiny and dependency-free.

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get() { return state; },
    set(next) {
      state = typeof next === 'function' ? next(state) : next;
      for (const s of subs) s(state);
    },
    update(patch) {
      state = { ...state, ...patch };
      for (const s of subs) s(state);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
