// User-written JavaScript snippets that can be activated on a ChargePoint.
//
// Persisted shape:
//   {
//     id,                       // IDB auto-increment
//     label,                    // user-facing label
//     description,              // free-text
//     params: [{ name, default, description? }],
//     code,                     // string; AsyncFunction body run inside a Worker
//     order,
//     createdAt, updatedAt,
//   }
//
// Execution is delegated to src/workers/script-runner.js — one Worker per
// activation. The runtime exposes two top-level objects to user code:
//   `cp`     — host ChargePoint (sendMessage / onMessage / state / connect / …)
//   `script` — script-local helpers (params / log / sleep / stop / merge / signal)
// See AGENTS.md for the full surface.

import { openDB } from './idb.js';

const STORE = 'scripts';

const DEFAULT_CODE = `// cp — the host ChargePoint
//   cp.id, cp.label, cp.ocppVersion
//   cp.state                       'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error'
//   cp.connect() / cp.disconnect() trigger the host CP's WebSocket lifecycle
//   cp.onConnect(handler)          fires on every transition into 'open'
//   cp.onDisconnect(handler)       fires on every transition out of 'open'
//
//   cp.params.NAME
//       The CP's own params, mirroring what {{ cp.params.NAME }} resolves
//       to in the composer. Values are JSON-parsed where possible
//       (numbers, booleans, objects) — otherwise strings.
//
//   await cp.sendMessage(action, payload)
//       Sends a CALL to the CSMS. Resolves with the CALLRESULT *payload*
//       (just the response object — not the full RPC frame). Rejects with
//       a CALLERROR { code, description, details } or Error('stopped').
//       Example: const r = await cp.sendMessage('BootNotification', {...});
//                r.status   // 'Accepted' | 'Pending' | 'Rejected'
//                r.interval // heartbeat seconds suggested by CSMS
//
//   cp.onMessage((payload, response) => { ... })
//       Global handler. Runs for every CSMS-initiated CALL on this CP.
//
//   cp.onMessage('Action', (payload, response) => { ... })
//       Filtered handler. Same shape, runs only when the action matches.
//
//       Handlers from every active script on a CP form ONE ordered chain
//       (managed centrally — the CP, not the script, owns it). The chain
//       is walked on each incoming CALL, threading a plain 'response'
//       object that starts at {}. Mutate fields directly:
//         response.status = 'Accepted';
//         response.setVariableResult = [...];
//         Object.assign(response, partial);
//       Returning a new object from the handler replaces it. Throwing
//       turns into a CALLERROR. The CSMS gets exactly ONE response per
//       CALL — the result after every handler has run.
//
//   const payload = await cp.waitForMessage(action, { timeout = 30000 })
//       One-shot await for the next matching incoming CALL. Resolves with
//       the request payload (the CALL's body), rejects on timeout/stop.
//
// script — this run
//   script.params.NAME              resolved script param (always a string)
//   script.info(...args)            log an INFO line into the app log
//   script.warn(...args)            log a WARN line (yellow)
//   script.error(...args)           log an ERROR line (red)
//   await script.sleep(ms)          honors stop()
//   script.stop()                   halt execution (entry stays as "stopped")
//   script.signal                   AbortSignal for fetch, etc.
//   script.merge(target, source)    recursive object-into-object merge —
//                                   handy for nested response fields:
//                                     script.merge(response, { a: { b: 1 } });

const bootResponse = await cp.sendMessage('BootNotification', {
  reason: 'PowerUp',
  chargingStation: { model: 'X1', vendorName: 'Acme' },
});
script.info('CSMS interval:', bootResponse.interval, 'status:', bootResponse.status);

cp.onMessage('TriggerMessage', (payload, response) => {
  script.info('CSMS triggered:', payload.requestedMessage);
  response.status = 'Accepted';
});

await script.sleep((bootResponse.interval || 30) * 1000);
await cp.sendMessage('Heartbeat', {});
`;

// Cached seeder promise — every listScripts() awaits this, so on a fresh
// DB the built-ins are guaranteed to exist before the UI's first render.
// Single source of truth; nothing else kicks the seeder.
let _builtinsReady;
function ensureBuiltinsOnce() {
  if (!_builtinsReady) _builtinsReady = ensureBuiltinScripts();
  return _builtinsReady;
}

export async function listScripts() {
  await ensureBuiltinsOnce();
  const db = await openDB();
  const all = await db.getAll(STORE);
  return all.sort((a, b) => a.order - b.order);
}

export async function reorderScripts(orderedIds) {
  const db = await openDB();
  for (let i = 0; i < orderedIds.length; i++) {
    const rec = await db.get(STORE, orderedIds[i]);
    if (!rec) continue;
    if (rec.order !== i) await db.put(STORE, { ...rec, order: i });
  }
}

export async function getScript(id) {
  const db = await openDB();
  return db.get(STORE, id);
}

export async function saveScript(script) {
  const db = await openDB();
  const now = Date.now();
  const record = { createdAt: now, ...script, updatedAt: now };
  if (record.id == null) delete record.id;
  return db.put(STORE, record);
}

// Restore a built-in script's `label`, `description`, `params`, and `code`
// from its canonical BUILTINS definition. Keeps the IDB-internal fields
// (id, order, createdAt) so the entry stays in place in the list. No-op
// for scripts that aren't built-ins.
export async function resetBuiltinScript(id) {
  const db = await openDB();
  const current = await db.get(STORE, id);
  if (!current || !current.builtinId) return false;
  const def = BUILTINS.find((b) => b.builtinId === current.builtinId);
  if (!def) return false;
  await saveScript({
    ...current,
    label: def.label,
    description: def.description || '',
    params: JSON.parse(JSON.stringify(def.params || [])),
    code: def.code,
    builtin: true,
  });
  return true;
}

export async function deleteScript(id) {
  const db = await openDB();
  return db.delete(STORE, id);
}

export function emptyScript() {
  return {
    label: 'Untitled script',
    description: '',
    params: [],
    code: DEFAULT_CODE,
    order: Date.now(),
  };
}

// -----------------------------------------------------------------------------
// Built-in scripts
// -----------------------------------------------------------------------------
//
// A built-in is identified by its `builtinId`. ensureBuiltinScripts() seeds
// any missing builtin once per session; existing copies are never touched
// so user edits (label, params, code) survive reloads. Use the script
// detail's "Reset to built-in" button to restore the canonical version.

const BUILTIN_SET_VARIABLES_CODE = `// Respond to CSMS-initiated SetVariables CALLs.
//
// Drop this script onto a ChargePoint to activate it. While active, the
// SharedWorker stops auto-acking SetVariables with empty {} and the script
// builds a schema-valid SetVariablesResponse instead.
//
// To override per-variable status, fill any of the buckets below with a JSON
// array of variable names ("Component.Variable" or just "Variable"). Anything
// not listed falls back to "Rejected" — so no explicit rejected bucket is
// needed.
//
//   accepted                ["TxStartPoint", "TxStopPoint"]
//   unknownComponent        []
//   unknownVariable         []
//   notSupportedAttrType    []
//   rebootRequired          ["MaxChargingProfilesInstalled"]

function parseList(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

const BUCKETS = {
  Accepted:                  parseList(script.params.accepted),
  UnknownComponent:          parseList(script.params.unknownComponent),
  UnknownVariable:           parseList(script.params.unknownVariable),
  NotSupportedAttributeType: parseList(script.params.notSupportedAttrType),
  RebootRequired:            parseList(script.params.rebootRequired),
};

function statusFor(component, variable) {
  const qualified = \`\${component?.name || ''}.\${variable?.name || ''}\`;
  const bare = variable?.name || '';
  for (const [status, names] of Object.entries(BUCKETS)) {
    if (names.includes(qualified) || names.includes(bare)) return status;
  }
  return 'Rejected';
}

cp.onMessage('SetVariables', (payload, response) => {
  const items = payload.setVariableData || [];
  response.setVariableResult = items.map((d) => ({
    attributeStatus: statusFor(d.component, d.variable),
    component: d.component,
    variable: d.variable,
    ...(d.attributeType ? { attributeType: d.attributeType } : {}),
  }));
});

script.info('SetVariables handler armed on', cp.label);
`;

const BUILTIN_AUTO_BOOT_HEARTBEAT_CODE = `// Auto Boot + Heartbeat.
//
// On every transition into 'open' state:
//   1. BootNotification (shape depends on cp.ocppVersion — 1.6 uses flat
//      chargePoint* fields; 2.x nests them under chargingStation).
//   2. On Accepted, an initial Available StatusNotification.
//   3. A periodic Heartbeat using the CSMS-suggested interval (or
//      heartbeatInterval as a fallback).
//
// Params resolve in this order, first hit wins:
//   1. cp.params[name]      — per-CP override on the ChargePoint record
//   2. script.params[name]  — script-level default below
//   3. hard-coded fallback inside the script
//
// On disconnect: stops the heartbeat. If activated while already connected,
// boots immediately so you don't have to bounce the socket.

function pick(name, fallback) {
  const cpVal = cp.params?.[name];
  if (cpVal !== undefined && cpVal !== '') return cpVal;
  const scriptVal = script.params?.[name];
  if (scriptVal !== undefined && scriptVal !== '') return scriptVal;
  return fallback;
}

const model    = pick('model', 'X1');
const vendor   = pick('vendor', 'Acme');
const serial   = pick('serial', 'ACME123');
const reason   = pick('reason', 'PowerUp');
const fallbackInterval = Number(pick('heartbeatInterval', 30)) || 30;
const is16 = cp.ocppVersion === 'ocpp1.6';

let heartbeatTimer = null;
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function bootPayload() {
  if (is16) {
    const out = { chargePointVendor: vendor, chargePointModel: model };
    if (serial) out.chargePointSerialNumber = serial;
    return out;
  }
  // OCPP 2.x
  const station = { model, vendorName: vendor };
  if (serial) station.serialNumber = serial;
  return { reason, chargingStation: station };
}

function statusPayload() {
  if (is16) {
    return {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: new Date().toISOString(),
    };
  }
  return {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  };
}

async function bootSequence() {
  let boot;
  try {
    boot = await cp.sendMessage('BootNotification', bootPayload());
  } catch (e) {
    script.info('BootNotification failed:', e?.description || e);
    return;
  }
  script.info('Boot status:', boot.status, '— interval:', boot.interval);
  // 1.6 uses 'Accepted'/'Pending'/'Rejected' just like 2.x.
  if (boot.status !== 'Accepted') return;

  try {
    await cp.sendMessage('StatusNotification', statusPayload());
  } catch (e) {
    script.info('StatusNotification failed:', e?.description || e);
  }

  const intervalMs = (boot.interval || fallbackInterval) * 1000;
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    cp.sendMessage('Heartbeat', {}).catch(() => { /* socket may be gone */ });
  }, intervalMs);
}

cp.onConnect(bootSequence);
cp.onDisconnect(() => {
  stopHeartbeat();
  script.info('Disconnected — heartbeat stopped.');
});

if (cp.state === 'open') bootSequence();
`;

const BUILTIN_CHARGING_SIMULATION_CODE = `// Charging Simulation — runs a complete mock charging session against the
// CSMS the moment the script is activated (or, if not yet connected, on the
// next 'open' transition). Branches on cp.ocppVersion:
//
//   OCPP 1.6:
//     StartTransaction → MeterValues × steps → StopTransaction
//   OCPP 2.x (2.0.1 / 2.1):
//     TransactionEvent(Started) → TransactionEvent(Updated) × steps
//                              → TransactionEvent(Ended)
//
// Params resolve cp.params → script.params → default.
//   startMeter      starting meter value in Wh (default: random 0–1000)
//   stepSize        Wh added per update (default: random 500–2000 each step)
//   intervalSec     seconds between updates (default: 30)
//   steps           how many Updated/MeterValues frames (default: 3)
//   idTag           1.6 idTag / 2.x idToken (default: 'TEST_TAG')
//   skipAuthorize   if truthy ('1', 'true', 'yes'), skip the Authorize step
//                   and go straight to StartTransaction. Default: false.

function pick(name, fallback) {
  const cpVal = cp.params?.[name];
  if (cpVal !== undefined && cpVal !== '') return cpVal;
  const scriptVal = script.params?.[name];
  if (scriptVal !== undefined && scriptVal !== '') return scriptVal;
  return fallback;
}

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function truthy(v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}
function randomBetween(min, max) { return Math.round(min + Math.random() * (max - min)); }
function newUuid() {
  // Crypto.randomUUID is available in modern Worker contexts.
  return (self.crypto?.randomUUID && self.crypto.randomUUID())
    || \`tx-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 8)}\`;
}

const startMeterParam  = pick('startMeter', '');
const stepSizeParam    = pick('stepSize', '');
const intervalSec      = num(pick('intervalSec', 30), 30);
const steps            = num(pick('steps', 3), 3);
const idTag            = String(pick('idTag', 'TEST_TAG'));
const skipAuthorize    = truthy(pick('skipAuthorize', ''));
const is16             = cp.ocppVersion === 'ocpp1.6';

let running = false;

function nextStep(current) {
  // If stepSize is configured, use it verbatim. Otherwise random per call.
  const explicit = num(stepSizeParam, null);
  const inc = explicit !== null ? explicit : randomBetween(500, 2000);
  return current + inc;
}

async function runSession() {
  if (running) return;
  running = true;
  try {
    const startBase = num(startMeterParam, null);
    let meter = startBase !== null ? startBase : randomBetween(0, 1000);

    // Authorize first — most CSMSes won't accept a StartTransaction /
    // TransactionEvent(Started) for an idTag that hasn't been authorized.
    // Skip via skipAuthorize=true. Branch by OCPP version: 1.6 uses idTag
    // and idTagInfo.status; 2.x uses idToken object and idTokenInfo.status.
    if (!skipAuthorize) {
      let auth;
      try {
        auth = is16
          ? await cp.sendMessage('Authorize', { idTag })
          : await cp.sendMessage('Authorize', { idToken: { idToken: idTag, type: 'Central' } });
      } catch (e) {
        script.error('Authorize failed:', e?.description || e);
        return;
      }
      const status = is16 ? auth?.idTagInfo?.status : auth?.idTokenInfo?.status;
      script.info('Authorize →', status);
      if (status !== 'Accepted') {
        script.warn(\`Token "\${idTag}" not Accepted (status: \${status || 'unknown'}). Skipping StartTransaction.\`);
        return;
      }
    }

    script.info('Charging session — start meter:', meter, 'Wh');

    let transactionId;

    if (is16) {
      const startRes = await cp.sendMessage('StartTransaction', {
        connectorId: 1,
        idTag,
        meterStart: meter,
        timestamp: new Date().toISOString(),
      });
      transactionId = startRes?.transactionId;
      script.info('1.6 StartTransaction →', startRes?.idTagInfo?.status, 'txId:', transactionId);
      if (transactionId == null) return;

      for (let i = 0; i < steps; i++) {
        await script.sleep(intervalSec * 1000);
        if (script.signal.aborted) return;
        meter = nextStep(meter);
        await cp.sendMessage('MeterValues', {
          connectorId: 1,
          transactionId,
          meterValue: [{
            timestamp: new Date().toISOString(),
            sampledValue: [{
              value: String(meter),
              context: 'Sample.Periodic',
              measurand: 'Energy.Active.Import.Register',
              unit: 'Wh',
            }],
          }],
        });
        script.info(\`MeterValues #\${i + 1}: \${meter} Wh\`);
      }

      await cp.sendMessage('StopTransaction', {
        transactionId,
        idTag,
        meterStop: meter,
        timestamp: new Date().toISOString(),
        reason: 'Local',
      });
      script.info('1.6 StopTransaction — final meter:', meter, 'Wh');
      return;
    }

    // OCPP 2.x
    transactionId = newUuid();
    let seqNo = 0;
    const startedAt = new Date().toISOString();

    await cp.sendMessage('TransactionEvent', {
      eventType: 'Started',
      timestamp: startedAt,
      triggerReason: 'Authorized',
      seqNo: seqNo++,
      transactionInfo: { transactionId, chargingState: 'Charging' },
      idToken: { idToken: idTag, type: 'Central' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [{
        timestamp: startedAt,
        sampledValue: [{
          value: meter,
          context: 'Transaction.Begin',
          measurand: 'Energy.Active.Import.Register',
          unitOfMeasure: { unit: 'Wh' },
        }],
      }],
    });
    script.info('2.x TransactionEvent(Started) txId:', transactionId);

    for (let i = 0; i < steps; i++) {
      await script.sleep(intervalSec * 1000);
      if (script.signal.aborted) return;
      meter = nextStep(meter);
      const now = new Date().toISOString();
      await cp.sendMessage('TransactionEvent', {
        eventType: 'Updated',
        timestamp: now,
        triggerReason: 'MeterValuePeriodic',
        seqNo: seqNo++,
        transactionInfo: { transactionId, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue: [{
          timestamp: now,
          sampledValue: [{
            value: meter,
            context: 'Sample.Periodic',
            measurand: 'Energy.Active.Import.Register',
            unitOfMeasure: { unit: 'Wh' },
          }],
        }],
      });
      script.info(\`TransactionEvent(Updated) #\${i + 1}: \${meter} Wh\`);
    }

    const endedAt = new Date().toISOString();
    await cp.sendMessage('TransactionEvent', {
      eventType: 'Ended',
      timestamp: endedAt,
      triggerReason: 'StopAuthorized',
      seqNo: seqNo++,
      transactionInfo: { transactionId, chargingState: 'Idle', stoppedReason: 'Local' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [{
        timestamp: endedAt,
        sampledValue: [{
          value: meter,
          context: 'Transaction.End',
          measurand: 'Energy.Active.Import.Register',
          unitOfMeasure: { unit: 'Wh' },
        }],
      }],
    });
    script.info('2.x TransactionEvent(Ended) — final meter:', meter, 'Wh');
  } finally {
    running = false;
  }
}

cp.onConnect(runSession);
if (cp.state === 'open') runSession();
`;

const BUILTINS = [
  {
    builtinId: 'handle-set-variables',
    label: 'Handle SetVariables (built-in)',
    description: 'Replies to CSMS-initiated SetVariables CALLs with a schema-valid SetVariablesResponse. Customize per-variable status via the six list params.',
    params: [
      { name: 'accepted', default: '[]', description: 'Variable names that respond Accepted' },
      { name: 'unknownComponent', default: '[]', description: 'Variable names that respond UnknownComponent' },
      { name: 'unknownVariable', default: '[]', description: 'Variable names that respond UnknownVariable' },
      { name: 'notSupportedAttrType', default: '[]', description: 'Variable names that respond NotSupportedAttributeType' },
      { name: 'rebootRequired', default: '[]', description: 'Variable names that respond RebootRequired' },
    ],
    code: BUILTIN_SET_VARIABLES_CODE,
  },
  {
    builtinId: 'default-cp-behavior',
    label: 'Auto Boot + Heartbeat (built-in)',
    description: 'BootNotification on connect, an initial Available StatusNotification, and a periodic Heartbeat (using the CSMS-suggested interval, falling back to heartbeatInterval). Stops on disconnect. Works on OCPP 1.6 and 2.x — each param resolves cp.params → script.params → default.',
    params: [
      { name: 'model', default: 'X1', description: 'Model — chargePointModel (1.6) / chargingStation.model (2.x)' },
      { name: 'vendor', default: 'Acme', description: 'Vendor — chargePointVendor (1.6) / chargingStation.vendorName (2.x)' },
      { name: 'serial', default: 'ACME123', description: 'Optional serial number. Empty = omit from BootNotification.' },
      { name: 'reason', default: 'PowerUp', description: '2.x BootNotification.reason (ignored on 1.6)' },
      { name: 'heartbeatInterval', default: '30', description: 'Fallback heartbeat seconds when the CSMS does not suggest one' },
    ],
    code: BUILTIN_AUTO_BOOT_HEARTBEAT_CODE,
  },
  {
    builtinId: 'charging-simulation',
    label: 'Charging Simulation (built-in)',
    description: 'Simulates one charging session against the CSMS: Start → 3 metering frames at 30s → Stop. Branches by cp.ocppVersion (StartTransaction/MeterValues/StopTransaction on 1.6; TransactionEvent on 2.x). Meter starts at a random offset; each step adds a random delta unless overridden.',
    params: [
      { name: 'startMeter', default: '', description: 'Starting meter value (Wh). Empty = random 0–1000.' },
      { name: 'stepSize', default: '', description: 'Wh added per metering frame. Empty = random 500–2000 each step.' },
      { name: 'intervalSec', default: '30', description: 'Seconds between metering frames' },
      { name: 'steps', default: '3', description: 'Number of metering frames between start and stop' },
      { name: 'idTag', default: 'TEST_TAG', description: '1.6 idTag / 2.x idToken value' },
      { name: 'skipAuthorize', default: '', description: 'Truthy ("1", "true", "yes") = skip the Authorize call and go straight to StartTransaction.' },
    ],
    code: BUILTIN_CHARGING_SIMULATION_CODE,
  },
];

export async function ensureBuiltinScripts() {
  // Direct DB query rather than listScripts() — listScripts awaits THIS, so
  // calling it would recurse. Idempotent: creates any built-in whose
  // builtinId isn't already in the store, leaves existing ones alone (user
  // edits to label/params/code are preserved; click "Reset to built-in" in
  // the script detail view to restore the canonical version).
  const db = await openDB();
  const existing = await db.getAll(STORE);
  const have = new Set(existing.filter((s) => s.builtinId).map((s) => s.builtinId));
  for (const def of BUILTINS) {
    if (have.has(def.builtinId)) continue;
    await saveScript({ ...emptyScript(), ...def, builtin: true });
  }
}
