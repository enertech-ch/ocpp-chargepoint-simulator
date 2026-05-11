// One Web Worker per active script. The worker hosts the user's code wrapped
// in an AsyncFunction. The script receives two args:
//   cp     — host ChargePoint (id, label, ocppVersion, sendMessage, onMessage,
//            waitForMessage)
//   script — script-local utilities (params, sleep, log, stop, signal)
//
// CSMS→CP CALL response model
// ----------------------------
// `cp.onMessage` REGISTERS handlers with the main-thread orchestrator
// (`active-runs.js`). All scripts on a CP feed the same chain; the
// orchestrator walks it in registration order on every CSMS-initiated CALL
// and posts exactly one response. The worker only stores handler functions
// locally and runs them when the orchestrator invokes them.
//
// Two registration shapes:
//   cp.onMessage((req, res) => …)             — global; runs for every CALL.
//   cp.onMessage('Action', (req, res) => …)   — filtered; the orchestrator
//                                               skips this handler when the
//                                               action doesn't match.
//
// Handlers receive a plain `response` object (starts at {}) and mutate it
// directly: `response.foo = …` or `Object.assign(response, …)`. Returning a
// new object replaces the response wholesale. Throwing turns into a
// CALLERROR. The same response object is threaded through every handler in
// registration order, so later handlers see what earlier ones set.
//
// Wire protocol (worker ↔ main):
//   main → worker: { type: 'init', code, params, cp }            // cp.state included
//   main → worker: { type: 'stop' }
//   main → worker: { type: 'cp-state', state, error? }            // CP transition
//   main → worker: { type: 'send-result', id, ok, response, error }
//   main → worker: { type: 'invoke', invocationId, handlerId, payload, response }
//   worker → main: { type: 'send', id, action, payload }
//   worker → main: { type: 'connect' | 'disconnect' }             // cp.connect/disconnect
//   worker → main: { type: 'register-handler', handlerId, filterAction? }
//   worker → main: { type: 'unregister-handler', handlerId }
//   worker → main: { type: 'invoke-result', invocationId, ok, response?|error? }
//   worker → main: { type: 'log', args }
//   worker → main: { type: 'stop' }   // script.stop() called from script
//   worker → main: { type: 'done' }   // natural return
//   worker → main: { type: 'error', message, stack }

let nextSendId = 1;
let nextHandlerId = 1;
const pendingSends = new Map();      // sendId → { resolve, reject }
const handlers = new Map();          // handlerId → fn
let stopped = false;

// CP connection state mirrored from the main thread. Updated by the
// 'cp-state' message; `cp.state` is a getter that reads it. Transitions
// into/out of 'open' fan out to onConnect/onDisconnect listeners.
let cpState = 'idle';
const connectHandlers = new Set();
const disconnectHandlers = new Set();

const abortCtl = new AbortController();

function postMain(msg) { self.postMessage(msg); }

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      cpState = msg.cp?.state || 'idle';
      run(msg.code, msg.params || {}, msg.cp || {});
      break;
    case 'stop':
      doStop();
      break;
    case 'send-result': {
      const p = pendingSends.get(msg.id);
      if (!p) return;
      pendingSends.delete(msg.id);
      if (msg.ok) p.resolve(msg.response);
      else p.reject(msg.error || new Error('send failed'));
      break;
    }
    case 'invoke':
      invokeHandler(msg);
      break;
    case 'cp-state':
      setCpState(msg.state, msg.error);
      break;
  }
});

function setCpState(newState, error) {
  const prev = cpState;
  cpState = newState || 'idle';
  if (cpState === 'open' && prev !== 'open') {
    for (const fn of connectHandlers) {
      try { fn(); } catch (e) { postMain({ type: 'log', args: [`onConnect handler threw: ${e?.message || e}`] }); }
    }
  } else if (cpState !== 'open' && prev === 'open') {
    for (const fn of disconnectHandlers) {
      try { fn(error); } catch (e) { postMain({ type: 'log', args: [`onDisconnect handler threw: ${e?.message || e}`] }); }
    }
  }
}

function doStop() {
  if (stopped) return;
  stopped = true;
  abortCtl.abort();
  for (const [, p] of pendingSends) p.reject(new Error('stopped'));
  pendingSends.clear();
}

async function invokeHandler({ invocationId, handlerId, payload, response }) {
  const fn = handlers.get(handlerId);
  if (!fn) {
    // Handler was unregistered between dispatch and invocation — pass through.
    postMain({ type: 'invoke-result', invocationId, ok: true, response: response || {} });
    return;
  }
  const resObj = (response && typeof response === 'object' && !Array.isArray(response)) ? response : {};
  try {
    const ret = await fn(payload || {}, resObj);
    const final = (ret && typeof ret === 'object' && !Array.isArray(ret)) ? ret : resObj;
    postMain({ type: 'invoke-result', invocationId, ok: true, response: final });
  } catch (err) {
    postMain({
      type: 'invoke-result', invocationId, ok: false,
      error: {
        code: err?.code || 'InternalError',
        description: err?.description || err?.message || String(err),
        details: err?.details || {},
      },
    });
  }
}

function makeCp(info) {
  return {
    id: info.id,
    label: info.label,
    ocppVersion: info.ocppVersion,
    params: info.params || {},

    // Current connection state — one of 'idle', 'connecting', 'open',
    // 'closing', 'closed', 'error'. Updated by the host on every transition.
    get state() { return cpState; },

    // Trigger a connect/disconnect on the host CP. Same as the toggle the
    // user has on each row — no auth or extra fields required.
    connect: () => postMain({ type: 'connect' }),
    disconnect: () => postMain({ type: 'disconnect' }),

    // Fire on each transition INTO the 'open' state (i.e., a fresh CSMS
    // session). Re-fires after reconnect.
    onConnect: (handler) => {
      if (typeof handler !== 'function') return () => {};
      connectHandlers.add(handler);
      return () => connectHandlers.delete(handler);
    },
    // Fire on each transition OUT of the 'open' state. Handler receives the
    // optional error string (close reason or 'websocket error').
    onDisconnect: (handler) => {
      if (typeof handler !== 'function') return () => {};
      disconnectHandlers.add(handler);
      return () => disconnectHandlers.delete(handler);
    },

    // CALL → CSMS; resolves with the CALLRESULT payload, rejects with the
    // CALLERROR { code, description, details } or Error('stopped').
    sendMessage: (action, payload) => {
      if (stopped) return Promise.reject(new Error('stopped'));
      const id = nextSendId++;
      postMain({ type: 'send', id, action, payload: payload || {} });
      return new Promise((resolve, reject) => pendingSends.set(id, { resolve, reject }));
    },

    // Register a CSMS→CP CALL handler with the main-thread orchestrator.
    //   cp.onMessage((req, res) => …)             global
    //   cp.onMessage('Action', (req, res) => …)   conditional on action match
    // Handlers receive a mutable `response` object that's threaded through
    // every registered handler on this CP in registration order. Mutate it
    // directly (`res.foo = …`) or return a new object to replace it.
    // Returns an unsubscribe fn.
    onMessage: (actionOrHandler, maybeHandler) => {
      let filterAction = null;
      let fn = actionOrHandler;
      if (typeof actionOrHandler === 'string') {
        filterAction = actionOrHandler;
        fn = maybeHandler;
      }
      if (typeof fn !== 'function') return () => {};
      const handlerId = nextHandlerId++;
      handlers.set(handlerId, fn);
      postMain({ type: 'register-handler', handlerId, filterAction });
      return () => {
        handlers.delete(handlerId);
        postMain({ type: 'unregister-handler', handlerId });
      };
    },

    // Wait for the next CSMS-initiated CALL of the given action. Resolves
    // with just the request payload — the script doesn't care about the
    // messageId because cp.onMessage's response routing handles that. The
    // handler the shim registers absorbs the CALL (and answers with its
    // current response object, which stays {}). Rejects on stop/timeout.
    waitForMessage: (action, { timeout = 30_000 } = {}) => new Promise((resolve, reject) => {
      if (stopped) return reject(new Error('stopped'));
      let done = false;
      let unsub = () => {};
      const finish = (fn, v) => {
        if (done) return; done = true;
        unsub(); clearTimeout(t);
        abortCtl.signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      unsub = makeCp(info).onMessage(action, (payload) => {
        finish(resolve, payload);
      });
      const onAbort = () => finish(reject, new Error('stopped'));
      const t = setTimeout(() => finish(reject, new Error(`timeout waiting for ${action}`)), timeout);
      abortCtl.signal.addEventListener('abort', onAbort, { once: true });
    }),
  };
}

function makeScript(params) {
  const postLog = (level) => (...args) => postMain({ type: 'log', level, args: args.map(safe) });
  return {
    params,
    signal: abortCtl.signal,
    // Three log levels, all routed into the app log. Default visual is
    // muted italic; warn renders yellow, error renders red.
    info: postLog('info'),
    warn: postLog('warn'),
    error: postLog('error'),
    sleep: (ms) => new Promise((resolve, reject) => {
      if (stopped) return reject(new Error('stopped'));
      const t = setTimeout(resolve, ms);
      abortCtl.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('stopped'));
      }, { once: true });
    }),
    stop: () => { postMain({ type: 'stop' }); doStop(); },
    // Recursive shallow-into-objects merge: target gets fields from source;
    // when both sides are plain objects, recurse; otherwise source wins.
    // Arrays are replaced wholesale (not merged element-wise). Mutates and
    // returns `target`.
    merge: deepMerge,
  };
}

function deepMerge(target, source) {
  if (!target || typeof target !== 'object') return source;
  if (!source || typeof source !== 'object') return target;
  for (const [k, v] of Object.entries(source)) {
    const tv = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
        && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      deepMerge(tv, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Args going back to the main thread must survive structured clone.
function safe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (t === 'function') return '[Function]';
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

async function run(code, params, info) {
  const cp = makeCp(info);
  const script = makeScript(params);
  let fn;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    fn = new AsyncFunction('cp', 'script', code);
  } catch (e) {
    postMain({ type: 'error', message: `SyntaxError: ${e.message}`, stack: e.stack || '' });
    postMain({ type: 'done' });
    return;
  }
  try {
    await fn(cp, script);
  } catch (e) {
    if (!stopped) {
      postMain({ type: 'error', message: String(e?.message || e), stack: e?.stack || '' });
    }
  }
  postMain({ type: 'done' });
}
