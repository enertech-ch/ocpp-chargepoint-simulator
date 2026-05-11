// SharedWorker: owns every WebSocket and a rolling raw-frame log. Tabs attach
// via the `connect` event, send commands over their MessagePort, and receive
// state/log events. A BroadcastChannel mirrors every log entry so a
// pop-out log tab (log.html) sees the stream even if its origin tab closes.
//
// Loaded as `new SharedWorker(url, { type: 'module' })`.

import { C2W, W2C, LOG_CHANNEL, LOG_RING_SIZE, ConnState } from './protocol.js';

const clients = new Set(); // MessagePort
const connections = new Map(); // id -> { ws, url, subprotocol, state, pending }
const logRing = []; // { ts, connId, dir, data }
const broadcast = new BroadcastChannel(LOG_CHANNEL);

function broadcastToClients(msg) {
  for (const port of clients) {
    try { port.postMessage(msg); } catch { /* port dead */ }
  }
}

function pushLog(entry) {
  logRing.push(entry);
  if (logRing.length > LOG_RING_SIZE) logRing.shift();
  broadcastToClients({ type: W2C.Log, entry });
  broadcast.postMessage(entry);
}

function setState(id, state, error) {
  const c = connections.get(id);
  if (!c) return;
  c.state = state;
  c.lastError = error || null;
  broadcastToClients({ type: W2C.ConnectionState, id, state, error: c.lastError });
}

// Human-readable hint for a close code. Browsers strip almost every useful
// detail from the underlying handshake/transport failure (for security), so
// the close code is often all we have. We surface what it means.
function closeCodeHint(code) {
  switch (code) {
    case 1000: return 'normal closure';
    case 1001: return 'going away (server or client unloaded)';
    case 1002: return 'protocol error';
    case 1003: return 'unsupported data';
    case 1005: return 'no status received';
    case 1006: return 'abnormal — handshake never completed (server unreachable, rejected the upgrade, wrong path, or TLS / mixed-content failed)';
    case 1007: return 'invalid frame payload data';
    case 1008: return 'policy violation';
    case 1009: return 'message too big';
    case 1010: return 'mandatory extension missing';
    case 1011: return 'internal server error';
    case 1015: return 'TLS handshake failed';
    default:   return `code ${code}`;
  }
}

function logSys(connId, message, level) {
  const entry = { ts: Date.now(), connId, dir: 'sys', data: message, parsed: null };
  if (level) entry.level = level; // 'warn' / 'error' — surfaces via console on the tab too
  pushLog(entry);
}

function doConnect(id, url, subprotocols) {
  const existing = connections.get(id);
  if (existing && existing.ws) {
    try { existing.ws.close(); } catch {}
  }
  // Accept either a single string or an array. We offer multiple subprotocols
  // for some OCPP versions (see SUBPROTOCOL_ALTERNATES) so the handshake
  // tolerates servers that advertise a non-canonical name.
  const offered = Array.isArray(subprotocols)
    ? subprotocols.filter(Boolean)
    : (subprotocols ? [subprotocols] : []);
  const preferred = offered[0] || null;
  const entry = {
    url, subprotocols: offered,
    ws: null,
    state: ConnState.Connecting,
    lastError: null,
    pending: new Map(),         // messageId -> { resolveTo: portRef, requestId } — CP-initiated CALLs awaiting CALLRESULT
  };
  connections.set(id, entry);
  setState(id, ConnState.Connecting);
  logSys(id, `Connecting to ${url}${offered.length ? ` (offering subprotocols: ${offered.join(', ')})` : ''}…`);

  let ws;
  try {
    ws = offered.length ? new WebSocket(url, offered) : new WebSocket(url);
  } catch (e) {
    const msg = String(e?.message || e);
    setState(id, ConnState.Error, msg);
    logSys(id, `WebSocket constructor threw: ${msg}`);
    return;
  }
  entry.ws = ws;

  ws.addEventListener('open', () => {
    setState(id, ConnState.Open);
    const negotiated = ws.protocol || '';
    if (negotiated && preferred && negotiated !== preferred) {
      // The server picked a non-canonical alternate (e.g. `ocpp2.0` instead
      // of `ocpp2.0.1`). Frames will still flow but flag it both in the
      // in-app log AND in the SharedWorker's console so anyone debugging
      // sees it without having to scan the log.
      const warning = `OCPP subprotocol "${negotiated}" negotiated instead of canonical "${preferred}" for ${url}. Handshake succeeded via a compatibility alternate — the server's OCPP build is older than spec.`;
      // SharedWorker-side console.warn (visible in `chrome://inspect`'s
      // Shared workers DevTools). The `level: 'warn'` on the log entry
      // also makes the tab side console.warn it — see connections.js.
      // eslint-disable-next-line no-console
      console.warn(`[ocpp-sim] ${warning}`);
      logSys(id, `Open — ${warning}`, 'warn');
    } else {
      logSys(id, `Open${negotiated ? `, negotiated subprotocol: ${negotiated}` : ''}`);
    }
  });
  ws.addEventListener('close', (ev) => {
    const detail = `code ${ev.code} (${closeCodeHint(ev.code)})${ev.reason ? `, reason: "${ev.reason}"` : ''}, wasClean=${ev.wasClean}`;
    setState(id, ConnState.Closed, ev.wasClean ? null : detail);
    logSys(id, `Closed — ${detail}`);
  });
  ws.addEventListener('error', () => {
    // The WebSocket 'error' event carries no useful payload by spec — the
    // close event that follows has the code. Log a marker so the user sees
    // *something* happened at this moment. The HTTP-level upgrade response
    // (status code, headers) IS visible, but only from the SharedWorker's
    // own DevTools — the page-level Network tab can't see it because the
    // WS is opened from the worker, not the page.
    setState(id, ConnState.Error, 'websocket error (see close event for code)');
    logSys(id,
      'WebSocket error event (the close event below has the code). ' +
      'For HTTP-level handshake details, inspect this SharedWorker directly: ' +
      'Chromium → chrome://inspect → Shared workers → inspect; ' +
      'Firefox → about:debugging#/runtime/this-firefox → Shared Workers → Inspect.'
    );
  });
  ws.addEventListener('message', (ev) => {
    const ts = Date.now();
    let parsed;
    try { parsed = JSON.parse(ev.data); } catch { parsed = null; }
    pushLog({ ts, connId: id, dir: 'in', data: ev.data, parsed });
    // OCPP RPC frame: [messageTypeId, messageId, ...]
    if (Array.isArray(parsed) && (parsed[0] === 3 || parsed[0] === 4)) {
      const [type, messageId] = parsed;
      const pending = entry.pending.get(messageId);
      if (pending) {
        entry.pending.delete(messageId);
        try {
          pending.port.postMessage({
            type: W2C.SendResult,
            requestId: pending.requestId,
            ok: type === 3,
            response: type === 3 ? parsed[2] : null,
            error: type === 4 ? { code: parsed[2], description: parsed[3], details: parsed[4] } : null,
          });
        } catch {}
      }
    }
    // CSMS-initiated CALLs (type 2) are NOT auto-acked here. Every script's
    // handler chain seeds itself with `res.set({})` so it answers every
    // CALL on its host CP. If a CP has no active script, CSMS-initiated
    // CALLs will go unanswered — that's by design.
  });
}

function doDisconnect(id) {
  const c = connections.get(id);
  if (!c) return;
  setState(id, ConnState.Closing);
  logSys(id, 'Disconnect requested…');
  try { c.ws && c.ws.close(); } catch {}
}

let messageCounter = 0;
function nextMessageId() {
  // 24-char hex-ish id — collision-resistant within a session.
  return `${Date.now().toString(36)}-${(messageCounter++).toString(36)}`;
}

function doSend(port, msg) {
  const { id, action, payload, requestId } = msg;
  const c = connections.get(id);
  if (!c || !c.ws || c.ws.readyState !== 1) {
    port.postMessage({ type: W2C.SendResult, requestId, ok: false, error: { code: 'NotConnected', description: 'Connection not open' } });
    return;
  }
  const messageId = nextMessageId();
  const frame = [2, messageId, action, payload || {}];
  const data = JSON.stringify(frame);
  c.pending.set(messageId, { port, requestId });
  try {
    c.ws.send(data);
    pushLog({ ts: Date.now(), connId: id, dir: 'out', data, parsed: frame });
  } catch (e) {
    c.pending.delete(messageId);
    port.postMessage({ type: W2C.SendResult, requestId, ok: false, error: { code: 'SendFailed', description: String(e) } });
  }
}

function doRespond(id, messageId, ok, payload, error) {
  const c = connections.get(id);
  if (!c || !c.ws || c.ws.readyState !== 1) return;
  const frame = ok
    ? [3, messageId, payload || {}]
    : [4, messageId, error?.code || 'InternalError', error?.description || '', error?.details || {}];
  const data = JSON.stringify(frame);
  try {
    c.ws.send(data);
    pushLog({ ts: Date.now(), connId: id, dir: 'out', data, parsed: frame });
  } catch { /* socket gone */ }
}

function handle(port, msg) {
  switch (msg.type) {
    case C2W.Hello:
      port.postMessage({ type: W2C.Hello, connections: snapshotConnections() });
      break;
    case C2W.Connect:
      doConnect(msg.id, msg.url, msg.subprotocols);
      break;
    case C2W.Disconnect:
      doDisconnect(msg.id);
      break;
    case C2W.Send:
      doSend(port, msg);
      break;
    case C2W.Hydrate:
      port.postMessage({ type: W2C.Hydrate, log: logRing.slice(-LOG_RING_SIZE) });
      break;
    case C2W.Respond:
      doRespond(msg.id, msg.messageId, msg.ok, msg.payload, msg.error);
      break;
    case C2W.PushLog:
      // Main-thread origin (e.g. script.log) — entry already shaped.
      pushLog({ ts: Date.now(), ...msg.entry });
      break;
  }
}

function snapshotConnections() {
  const out = [];
  for (const [id, c] of connections) {
    out.push({ id, url: c.url, subprotocol: c.subprotocol, state: c.state, error: c.lastError });
  }
  return out;
}

self.addEventListener('connect', (e) => {
  const port = e.ports[0];
  clients.add(port);
  port.addEventListener('message', (ev) => handle(port, ev.data));
  port.start();
});
