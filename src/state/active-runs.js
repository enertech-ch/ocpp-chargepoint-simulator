// In-memory registry of active runs (sequences + scripts) per ChargePoint.
//
// Not persisted: a refresh wipes the slate. Each entry tracks its lifecycle
// state and exposes stop()/remove(). `tick(cpKey, kind)` is the chip-flash
// signal — every step start/end (sequences) or send/incoming (scripts)
// fires one tick that the UI listens to and animates for ~0.4s.
//
// Entry shape:
//   {
//     id,            // unique within this session, used as DOM key
//     cpKey,         // host CP's internal handle
//     kind,          // 'sequence' | 'script'
//     refId,         // id of the persisted sequence/script
//     name,
//     state,         // 'running' | 'stopped' | 'errored'
//     stop(),        // halt execution but keep the entry in the list
//     remove(),      // drop the entry from the list (also stops if running)
//     lastError,     // optional human-readable error
//   }
//
// CSMS→CP CALL routing
// --------------------
// Each script's Worker registers handlers via 'register-handler' messages.
// THIS file owns the per-CP handler chain (`_handlersByCp`) — handlers from
// every active script on a CP end up in one ordered list. When a CSMS-
// initiated CALL arrives, this file:
//   1. Walks the chain in registration order.
//   2. For each handler whose filterAction is null or matches the CALL,
//      messages the handler's owning Worker with the current response
//      object and awaits the updated response.
//   3. Posts exactly ONE Respond to the SharedWorker.
// Result: no matter how many scripts are active, the CSMS gets exactly one
// answer per CALL — the merged outcome of every registered handler.
//
// Subscribers:
//   subscribe(fn)  → fires for every entry-list mutation; payload is the
//                    full Map<cpKey, Entry[]>.
//   onTick(fn)     → fires on every tick({ cpKey, kind }).

import { connections } from './connections.js';
import { runSequence } from '../lib/sequences.js';
import { cpScope } from '../lib/templates.js';

const SCRIPT_WORKER_URL = new URL('../workers/script-runner.js', import.meta.url);

let nextRunId = 1;
let nextInvocationId = 1;

class ActiveRuns {
  constructor() {
    this._byCp = new Map();              // cpKey → Entry[]
    this._listSubs = new Set();
    this._tickSubs = new Set();
    this._handlersByCp = new Map();      // cpKey → [{ entry, handlerId, filterAction }] in registration order
    this._cpSubs = new Map();            // cpKey → unsubscribe fn from connections.onLog
    this._pendingInvocations = new Map();// invocationId → { resolve, reject }
  }

  list(cpKey) { return this._byCp.get(cpKey) || []; }
  subscribe(fn) { this._listSubs.add(fn); return () => this._listSubs.delete(fn); }
  onTick(fn) { this._tickSubs.add(fn); return () => this._tickSubs.delete(fn); }

  _emit() { for (const fn of this._listSubs) fn(this._byCp); }
  _tick(cpKey, kind) { for (const fn of this._tickSubs) fn({ cpKey, kind }); }

  _add(cpKey, entry) {
    const arr = this._byCp.get(cpKey) || [];
    arr.push(entry);
    this._byCp.set(cpKey, arr);
    this._emit();
  }
  _remove(cpKey, entry) {
    const arr = this._byCp.get(cpKey) || [];
    const i = arr.indexOf(entry);
    if (i < 0) return;
    arr.splice(i, 1);
    if (arr.length === 0) this._byCp.delete(cpKey);
    else this._byCp.set(cpKey, arr);
    this._emit();
  }
  _patch(entry, patch) {
    Object.assign(entry, patch);
    this._emit();
  }

  // ---- Per-CP handler chain ------------------------------------------------

  _ensureCpSubscribed(cpKey) {
    if (this._cpSubs.has(cpKey)) return;
    const unsub = connections.onLog((frame) => {
      if (frame.__hydrate) return;
      if (frame.connId !== cpKey || frame.dir !== 'in') return;
      this._dispatchCall(cpKey, frame);
    });
    this._cpSubs.set(cpKey, unsub);
  }

  _maybeUnsubscribeCp(cpKey) {
    const handlers = this._handlersByCp.get(cpKey);
    if (handlers && handlers.length) return;
    const unsub = this._cpSubs.get(cpKey);
    if (unsub) { unsub(); this._cpSubs.delete(cpKey); }
  }

  _registerHandler(entry, handlerId, filterAction) {
    const list = this._handlersByCp.get(entry.cpKey) || [];
    list.push({ entry, handlerId, filterAction: filterAction || null });
    this._handlersByCp.set(entry.cpKey, list);
    this._ensureCpSubscribed(entry.cpKey);
  }

  _unregisterHandler(entry, handlerId) {
    const list = this._handlersByCp.get(entry.cpKey);
    if (!list) return;
    const i = list.findIndex((h) => h.entry === entry && h.handlerId === handlerId);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this._handlersByCp.delete(entry.cpKey);
    this._maybeUnsubscribeCp(entry.cpKey);
  }

  _unregisterAllForEntry(entry) {
    const list = this._handlersByCp.get(entry.cpKey);
    if (!list) return;
    const remaining = list.filter((h) => h.entry !== entry);
    if (remaining.length) this._handlersByCp.set(entry.cpKey, remaining);
    else this._handlersByCp.delete(entry.cpKey);
    this._maybeUnsubscribeCp(entry.cpKey);
  }

  async _dispatchCall(cpKey, frame) {
    if (!Array.isArray(frame.parsed) || frame.parsed[0] !== 2) return;
    const [, messageId, action, payload] = frame.parsed;
    const handlers = (this._handlersByCp.get(cpKey) || []).slice();
    if (handlers.length === 0) return; // no responder; CSMS waits (by design)
    let response = {};
    try {
      for (const { entry, handlerId, filterAction } of handlers) {
        if (filterAction && filterAction !== action) continue;
        // Don't filter on entry.state — handlers stay valid as long as
        // they're still in `_handlersByCp`, which is the source of truth.
        // stop()/remove() are responsible for unregistering.
        response = await this._invokeHandler(entry, handlerId, payload || {}, response);
      }
    } catch (err) {
      connections.respondError(cpKey, messageId, {
        code: err?.code || 'InternalError',
        description: err?.description || err?.message || String(err),
        details: err?.details || {},
      });
      return;
    }
    connections.respond(cpKey, messageId, response);
  }

  _invokeHandler(entry, handlerId, payload, response) {
    return new Promise((resolve, reject) => {
      const invocationId = nextInvocationId++;
      this._pendingInvocations.set(invocationId, { resolve, reject });
      entry.worker.postMessage({ type: 'invoke', invocationId, handlerId, payload, response });
    });
  }

  // -------------------------------------------------------------------------
  // Sequences
  // -------------------------------------------------------------------------

  activateSequence(cpKey, sequence) {
    const ctl = new AbortController();
    const entry = {
      id: `r${nextRunId++}`,
      cpKey,
      kind: 'sequence',
      refId: sequence.id,
      name: sequence.label || 'Sequence',
      state: 'running',
      lastError: null,
      // When the runner is in a delay/pause, `waiting` describes which step
      // is about to fire and `skipDelay` is the function that fast-forwards
      // through it. Both cleared when the wait ends.
      waiting: null,
      skipDelay: null,
      stop: () => {
        if (entry.state === 'running') {
          ctl.abort();
          this._patch(entry, { state: 'stopped', waiting: null, skipDelay: null });
        }
      },
      remove: () => {
        if (entry.state === 'running') ctl.abort();
        this._remove(cpKey, entry);
      },
      // Restart a stopped/errored sequence in place: drop this entry and
      // call activateSequence again with the same record. A fresh
      // AbortController + a new run from step 0.
      restart: () => {
        if (entry.state === 'running') return;
        this._remove(cpKey, entry);
        this.activateSequence(cpKey, sequence);
      },
    };
    this._add(cpKey, entry);

    runSequence(sequence, cpKey, {
      signal: ctl.signal,
      onProgress: (e) => {
        if (e.type === 'waiting') {
          this._patch(entry, {
            waiting: {
              stepIndex: e.stepIndex,
              step: e.step,
              ms: e.ms,
              startedAt: Date.now(),
            },
            skipDelay: e.skip,
          });
          return;
        }
        if (e.type === 'start' || e.type === 'success' || e.type === 'skipped' || e.type === 'error') {
          // Any actual step transition ends the prior wait.
          if (entry.waiting || entry.skipDelay) {
            this._patch(entry, { waiting: null, skipDelay: null });
          }
          this._tick(cpKey, 'sequence');
        }
        if (e.type === 'error') {
          this._patch(entry, { lastError: e.error?.description || String(e.error) });
        }
        if (e.type === 'done') {
          if (entry.state === 'running') this._remove(cpKey, entry);
        }
      },
    }).catch((err) => {
      this._patch(entry, { state: 'errored', lastError: String(err) });
    });

    return entry;
  }

  // -------------------------------------------------------------------------
  // Scripts
  // -------------------------------------------------------------------------

  activateScript(cpKey, script) {
    const cp = connections.get().list.find((c) => c.key === cpKey);
    if (!cp) return null;

    const worker = new Worker(SCRIPT_WORKER_URL, { type: 'module' });
    const entry = {
      id: `r${nextRunId++}`,
      cpKey,
      kind: 'script',
      refId: script.id,
      name: script.label || 'Script',
      state: 'running',
      lastError: null,
      worker,
      stop: () => {
        if (entry.state !== 'running') return;
        worker.postMessage({ type: 'stop' });
        // Unregister now so dispatch stops invoking even before the worker
        // actually halts.
        this._unregisterAllForEntry(entry);
        this._patch(entry, { state: 'stopped' });
      },
      remove: () => {
        try { worker.terminate(); } catch {}
        this._unregisterAllForEntry(entry);
        stateForwarder?.();
        this._remove(cpKey, entry);
      },
      // Restart a stopped/errored script in place: the existing worker has
      // an aborted lifecycle (stopped=true, abort signal fired) and can't
      // be reused. Terminate it, tear down all bridges, and call
      // activateScript again with the same record — fresh worker, fresh
      // state, fresh chain registration.
      restart: () => {
        if (entry.state === 'running') return;
        try { worker.terminate(); } catch {}
        this._unregisterAllForEntry(entry);
        stateForwarder?.();
        this._remove(cpKey, entry);
        this.activateScript(cpKey, script);
      },
    };

    // Forward host CP state transitions to the worker. The worker tracks
    // them in `cpState` and fans out to onConnect/onDisconnect listeners.
    let lastForwardedState = cp.state;
    const stateForwarder = connections.subscribe((s) => {
      const c = s.list.find((x) => x.key === cpKey);
      if (!c) return;
      if (c.state !== lastForwardedState) {
        lastForwardedState = c.state;
        try { worker.postMessage({ type: 'cp-state', state: c.state, error: c.error }); } catch {}
      }
    });

    worker.addEventListener('message', (ev) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'send':
          this._tick(cpKey, 'script');
          connections.send(cpKey, msg.action, msg.payload).then(
            (response) => worker.postMessage({ type: 'send-result', id: msg.id, ok: true, response }),
            (error) => worker.postMessage({ type: 'send-result', id: msg.id, ok: false, error: serialize(error) }),
          );
          break;
        case 'connect':
          connections.connect(cpKey);
          break;
        case 'disconnect':
          connections.disconnect(cpKey);
          break;
        case 'register-handler':
          this._registerHandler(entry, msg.handlerId, msg.filterAction);
          break;
        case 'unregister-handler':
          this._unregisterHandler(entry, msg.handlerId);
          break;
        case 'invoke-result': {
          const pending = this._pendingInvocations.get(msg.invocationId);
          if (!pending) return;
          this._pendingInvocations.delete(msg.invocationId);
          if (msg.ok) pending.resolve(msg.response);
          else pending.reject(msg.error);
          break;
        }
        case 'log':
          // script.info / .warn / .error output. Land in the raw log under
          // this CP with a `script` direction marker. The script body's own
          // console.* (if used) continues to print to the worker's own
          // console — `script.*` are the user-facing path.
          connections.pushLog({
            connId: cpKey,
            dir: 'script',
            data: `${script.label}: ${msg.args.map(stringifyArg).join(' ')}`,
            parsed: null,
            level: msg.level || 'info',
          });
          break;
        case 'stop':
          // script.stop() inside user code — tear down the worker so a
          // user-initiated halt is symmetric with clicking ■.
          if (entry.state === 'running') {
            this._unregisterAllForEntry(entry);
            this._patch(entry, { state: 'stopped' });
          }
          break;
        case 'error':
          this._unregisterAllForEntry(entry);
          this._patch(entry, { lastError: msg.message, state: 'errored' });
          console.error(`[script ${script.label}]`, msg.message, msg.stack);
          break;
        case 'done':
          // Script body returned. Worker stays alive — its registered
          // handlers are still active and will fire on incoming CALLs. The
          // entry stays 'running' until the user (or script.stop()/error)
          // explicitly stops it.
          break;
      }
    });

    this._add(cpKey, entry);

    worker.postMessage({
      type: 'init',
      code: script.code || '',
      params: paramsToMap(script.params),
      cp: { ...cpScope(cp), state: cp.state || 'idle' },
    });

    return entry;
  }
}

function serialize(err) {
  if (!err) return { description: 'unknown' };
  if (typeof err === 'string') return { description: err };
  return { code: err.code, description: err.description || err.message, details: err.details };
}

// Format one script.log arg for the app log. Objects/arrays → JSON.
function stringifyArg(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function paramsToMap(params) {
  const out = {};
  for (const p of params || []) out[p.name] = p.default ?? '';
  return out;
}

export const activeRuns = new ActiveRuns();
