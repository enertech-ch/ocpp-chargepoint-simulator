// Sequences: ordered lists of OCPP actions (and pauses) that can be replayed
// against any connection. Stored globally in IndexedDB.
//
// Shape:
//   {
//     id,                       // IDB auto-incremented
//     label,                    // user-facing label
//     description,              // free-text notes
//     stopOnError,              // halt the run when a step returns CALLERROR
//     steps: [
//       { kind: 'send', action, payload, sourceVersion, delaySeconds, comment },
//       { kind: 'pause', seconds, comment },
//     ],
//     order,                    // position in the list
//     createdAt, updatedAt,
//   }

import { openDB } from './idb.js';
import { connections } from '../state/connections.js';
import { mapPayload } from '../ocpp/backmap.js';
import { ACTION_INDEX } from '../ocpp/function-blocks.js';
import { resolveTemplates, cpScope } from './templates.js';

const STORE = 'sequences';

export async function listSequences() {
  const db = await openDB();
  const all = await db.getAll(STORE);
  // Manual order: emptySequence() seeds `order = Date.now()` and reorder
  // rewrites it on drag, so we sort ascending. No updatedAt auto-sort —
  // recording a step shouldn't yank a sequence to the top.
  return all.sort((a, b) => a.order - b.order);
}

export async function getSequence(id) {
  const db = await openDB();
  return db.get(STORE, id);
}

export async function saveSequence(seq) {
  const db = await openDB();
  const now = Date.now();
  const record = { createdAt: now, ...seq, updatedAt: now };
  if (record.id == null) delete record.id; // let IDB autoIncrement
  return db.put(STORE, record);
}

export async function deleteSequence(id) {
  const db = await openDB();
  return db.delete(STORE, id);
}

export function emptySequence() {
  return {
    label: 'Untitled sequence',
    description: '',
    stopOnError: true,
    steps: [],
    order: Date.now(),
  };
}

// Reassign the `order` field across the supplied list so it matches array
// order, then persist any record whose order changed. Cheap (under ~100
// items) and avoids fractional bookkeeping.
export async function reorderSequences(orderedIds) {
  const db = await openDB();
  for (let i = 0; i < orderedIds.length; i++) {
    const rec = await db.get(STORE, orderedIds[i]);
    if (!rec) continue;
    if (rec.order !== i) await db.put(STORE, { ...rec, order: i });
  }
}

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------

const SEND_TIMEOUT_MS = 30_000;

// Skip-able sleep. The returned promise exposes a `.skip()` method that
// resolves it immediately without rejecting — used by the UI's per-step
// "Skip" button so the user can step through a sequence manually instead
// of waiting out every delay.
function sleepWithSkip(ms, signal) {
  let timer;
  let resolveSelf;
  const promise = new Promise((resolve, reject) => {
    resolveSelf = resolve;
    if (signal?.aborted) return reject(new Error('aborted'));
    timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
  promise.skip = () => {
    if (timer) clearTimeout(timer);
    resolveSelf();
  };
  return promise;
}

function timed(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject({ code: 'Timeout', description: `no response in ${ms}ms` }), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Run a sequence against a connection. `onProgress` is called with one of:
//   { type: 'start',   stepIndex }
//   { type: 'waiting', stepIndex, step, ms, skip }  — about to wait `ms`
//                                                     before running this step;
//                                                     call `skip()` to fast-
//                                                     forward through the wait.
//   { type: 'success', stepIndex, response }
//   { type: 'skipped', stepIndex, reason }   // action not in target version
//   { type: 'error',   stepIndex, error }
//   { type: 'done',    error? }
// `signal` is an AbortSignal that stops the whole run between steps and
// during waits.
//
// Version mismatch is NOT an error — when a step's action isn't supported on
// the target CP's OCPP version, the step is silently skipped (a 'skipped'
// event is emitted so the UI can show it).
export async function runSequence(sequence, cpKey, { onProgress, signal } = {}) {
  const conn = connections.get().list.find((c) => c.key === cpKey);
  if (!conn) throw new Error(`Connection ${cpKey} not found`);

  // Inline helper — wait `ms` while telling the host UI we're waiting and
  // exposing a skip handle for "Skip" buttons.
  const waitForStep = async (stepIndex, step, ms) => {
    if (ms <= 0) return;
    const sleeper = sleepWithSkip(ms, signal);
    onProgress?.({ type: 'waiting', stepIndex, step, ms, skip: () => sleeper.skip() });
    await sleeper;
  };

  for (let i = 0; i < sequence.steps.length; i++) {
    if (signal?.aborted) {
      onProgress?.({ type: 'done', error: { code: 'Aborted', description: 'stopped by user' } });
      return;
    }
    const step = sequence.steps[i];
    onProgress?.({ type: 'start', stepIndex: i });

    try {
      if (step.kind === 'pause') {
        await waitForStep(i, step, (step.seconds || 0) * 1000);
        onProgress?.({ type: 'success', stepIndex: i, response: null });
        continue;
      }
      if (step.kind === 'send') {
        // Skip if the action isn't part of the target version.
        const meta = ACTION_INDEX[step.action];
        if (meta && !meta.versions.includes(conn.ocppVersion)) {
          onProgress?.({ type: 'skipped', stepIndex: i, reason: `${step.action} not in ${conn.ocppVersion}` });
          continue;
        }
        const resolved = resolveTemplates(step.payload || {}, cpScope(conn));
        const mapped = mapPayload({
          action: step.action,
          payload: resolved,
          fromVersion: step.sourceVersion || conn.ocppVersion,
          toVersion: conn.ocppVersion,
        });
        if (mapped.unsupported) {
          onProgress?.({ type: 'skipped', stepIndex: i, reason: `${step.action} not in ${conn.ocppVersion}` });
          continue;
        }
        await waitForStep(i, step, (step.delaySeconds || 0) * 1000);
        const response = await timed(
          connections.send(cpKey, mapped.action, mapped.payload),
          SEND_TIMEOUT_MS,
        );
        onProgress?.({ type: 'success', stepIndex: i, response });
        continue;
      }
      throw { code: 'InvalidStep', description: `unknown step kind ${step.kind}` };
    } catch (err) {
      onProgress?.({ type: 'error', stepIndex: i, error: err });
      if (sequence.stopOnError) {
        onProgress?.({ type: 'done', error: err });
        return;
      }
    }
  }
  onProgress?.({ type: 'done' });
}
