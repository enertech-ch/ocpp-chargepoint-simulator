// Tab-side registry of OCPP connections. Talks to the SharedWorker which
// actually owns the WebSockets.
//
// CP record shape (the persisted + observed object):
//   {
//     key,             // stable internal handle (`c<random>`) — used for routing
//     id,              // user-facing OCPP identifier (serial, e.g. "CP_001")
//     label,           // display label
//     csmUrl,          // CentralSystem URL — may contain {{ cp.id }} templates
//     ocppVersion,     // 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1'
//     description,
//     params: [{name, value}],
//     state, error,    // runtime
//   }
//
// `key` is what gets passed over the wire to the worker (as `id`, since the
// worker doesn't care about user-facing identity). All connect/disconnect/
// send calls take the key.

import { C2W, W2C, ConnState } from '../workers/protocol.js';
import { createStore } from './store.js';
import { prefs } from './persistence.js';
import { nextNumber } from '../lib/labels.js';
import { resolveTemplates, cpScope } from '../lib/templates.js';
import { pickHue } from '../ui/connection-hue.js';
import { subprotocolsFor } from '../ocpp/versions.js';

const WORKER_URL = new URL('../workers/connection-worker.js', import.meta.url);

function makePort() {
  if (typeof SharedWorker !== 'undefined') {
    const sw = new SharedWorker(WORKER_URL, { type: 'module', name: 'ocpp-sim' });
    return sw.port;
  }
  const w = new Worker(WORKER_URL, { type: 'module' });
  return {
    postMessage: (m) => w.postMessage(m),
    addEventListener: (ev, fn) => w.addEventListener(ev, fn),
    start() {},
  };
}

class ConnectionRegistry {
  constructor() {
    this.port = null;
    this.store = createStore({
      list: prefs.get('connections', []),
      hiddenLogIds: new Set(prefs.get('log-hidden', [])),
    });
    this._logListeners = new Set();
    this._sendInbox = new Map();
    this._reqCounter = 0;
    // Cross-tab sync: when another tab/window writes to one of our
    // localStorage keys, refresh the relevant store slice. Used by the
    // pop-out log window so it stays in step with the main tab.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === 'ocpp-sim:connections') {
          this.store.set((s) => ({ ...s, list: prefs.get('connections', []) }));
        } else if (e.key === 'ocpp-sim:log-hidden') {
          try {
            const next = new Set(JSON.parse(e.newValue || '[]'));
            this.store.set((s) => ({ ...s, hiddenLogIds: next }));
          } catch { /* ignore */ }
        }
      });
    }
  }

  toggleLogVisible(key) {
    const s = this.store.get();
    const next = new Set(s.hiddenLogIds);
    if (next.has(key)) next.delete(key); else next.add(key);
    this.store.set({ ...s, hiddenLogIds: next });
    prefs.set('log-hidden', [...next]);
  }

  isLogVisible(key) {
    return !this.store.get().hiddenLogIds.has(key);
  }

  init() {
    if (this.port) return;
    this.port = makePort();
    this.port.addEventListener('message', (ev) => this._onMessage(ev.data));
    this.port.start();
    this.port.postMessage({ type: C2W.Hello });
    this.port.postMessage({ type: C2W.Hydrate });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case W2C.Hello:
        for (const c of msg.connections) this._applyState(c.id, c.state, c.error);
        break;
      case W2C.ConnectionState:
        this._applyState(msg.id, msg.state, msg.error);
        break;
      case W2C.Log:
        // Mirror flagged system messages (subprotocol fallback, etc.) to
        // the page console so users with DevTools open in the main tab
        // don't have to hunt them down in the SharedWorker inspector.
        if (msg.entry?.level === 'warn') console.warn('[ocpp-sim]', msg.entry.data);
        else if (msg.entry?.level === 'error') console.error('[ocpp-sim]', msg.entry.data);
        for (const fn of this._logListeners) fn(msg.entry);
        break;
      case W2C.Hydrate:
        for (const fn of this._logListeners) fn({ __hydrate: true, log: msg.log });
        break;
      case W2C.SendResult: {
        const cb = this._sendInbox.get(msg.requestId);
        if (cb) {
          this._sendInbox.delete(msg.requestId);
          if (msg.ok) cb.resolve(msg.response);
          else cb.reject(msg.error || { code: 'Unknown', description: 'send failed' });
        }
        break;
      }
    }
  }

  _applyState(key, state, error) {
    this.store.set((s) => ({
      ...s,
      list: s.list.map((c) => (c.key === key ? { ...c, state, error } : c)),
    }));
  }

  _persist() {
    prefs.set('connections', this.store.get().list);
  }

  add({ csmUrl = 'wss://ocpp.domain.example/{{ cp.id }}', ocppVersion = 'ocpp2.1', label = '', id = '' } = {}) {
    const key = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.store.set((s) => {
      // Share a number across the auto-generated label and id, so
      //   "ChargePoint #3"  pairs with  "CP000003".
      const n = nextNumber('ChargePoint', s.list, 'label');
      // Stable, visually-distinct hue per CP. Persisted on the record so
      // duplicates, reorders, and reloads keep the same color.
      const hue = pickHue(s.list.map((c) => c.hue).filter((h) => typeof h === 'number'));
      return {
        ...s,
        list: [...s.list, {
          key,
          id: id || `CP${String(n).padStart(6, '0')}`,
          label: label || `ChargePoint #${n}`,
          csmUrl,
          ocppVersion,
          description: '',
          params: [],
          hue,
          state: ConnState.Idle,
          error: null,
        }],
      };
    });
    this._persist();
    return key;
  }

  remove(key) {
    this.disconnect(key);
    this.store.set((s) => ({ ...s, list: s.list.filter((c) => c.key !== key) }));
    this._persist();
  }

  // Reposition `key` inside the list. `beforeKey === null` appends.
  reorder(key, beforeKey) {
    this.store.set((s) => {
      const fromIdx = s.list.findIndex((c) => c.key === key);
      if (fromIdx < 0) return s;
      const moved = s.list[fromIdx];
      const without = s.list.filter((c) => c.key !== key);
      const toIdx = beforeKey == null ? without.length : without.findIndex((c) => c.key === beforeKey);
      const insertAt = toIdx < 0 ? without.length : toIdx;
      const list = [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
      return { ...s, list };
    });
    this._persist();
  }

  update(key, patch) {
    this.store.set((s) => ({
      ...s,
      list: s.list.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    }));
    this._persist();
  }

  connect(key) {
    const c = this.store.get().list.find((x) => x.key === key);
    if (!c) return;
    const url = resolveTemplates(c.csmUrl || '', cpScope(c));
    this.port.postMessage({
      type: C2W.Connect, id: key, url,
      subprotocols: subprotocolsFor(c.ocppVersion),
    });
  }

  disconnect(key) {
    this.port.postMessage({ type: C2W.Disconnect, id: key });
  }

  // Inject a log entry into the SharedWorker's ring buffer. Used by
  // active-runs to surface script.log() output alongside actual frames.
  // Entry shape: { connId, dir, data, parsed?, level? } — ts is filled in
  // by the SharedWorker so timestamps stay monotonic with frame events.
  pushLog(entry) {
    this.port.postMessage({ type: C2W.PushLog, entry });
  }

  respond(key, messageId, payload) {
    this.port.postMessage({ type: C2W.Respond, id: key, messageId, ok: true, payload: payload || {} });
  }

  respondError(key, messageId, error) {
    this.port.postMessage({ type: C2W.Respond, id: key, messageId, ok: false, error: error || {} });
  }

  send(key, action, payload) {
    const requestId = `r${++this._reqCounter}`;
    return new Promise((resolve, reject) => {
      this._sendInbox.set(requestId, { resolve, reject });
      this.port.postMessage({ type: C2W.Send, id: key, action, payload, requestId });
    });
  }

  onLog(fn) {
    this._logListeners.add(fn);
    return () => this._logListeners.delete(fn);
  }

  requestHydrate() {
    this.port.postMessage({ type: C2W.Hydrate });
  }

  subscribe(fn) { return this.store.subscribe(fn); }
  get() { return this.store.get(); }
}

export const connections = new ConnectionRegistry();
