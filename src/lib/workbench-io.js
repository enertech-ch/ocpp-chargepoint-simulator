// Export / Import for workbench items (ChargePoints, Sequences, Scripts).
//
// File shape — one JSON object with three arrays, any of which may be empty:
//
//   {
//     "version": 1,
//     "exportedAt": "2026-05-…",
//     "chargePoints": [{ label, id, csmUrl, ocppVersion, description, params, hue }],
//     "sequences":    [{ label, description, stopOnError, steps }],
//     "scripts":      [{ label, description, params, code, builtinId? }]
//   }
//
// On export, items are sorted by label so the file's order is stable and
// readable regardless of how items were arranged in the UI.
//
// On import we strip transient fields (key/state/error for CPs; id/order/
// createdAt/updatedAt for sequences/scripts) and let the regular add/save
// paths assign fresh ones. Conflicting labels are accepted as-is — the
// user can rename after.

export const EXPORT_VERSION = 1;
const FILENAME_PREFIX = 'workbench';

const TRANSIENT_CP = new Set(['key', 'state', 'error']);
const TRANSIENT_SEQ_SCRIPT = new Set(['id', 'order', 'createdAt', 'updatedAt']);

function pickFields(obj, drop) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function byLabel(a, b) {
  return (a.label || '').localeCompare(b.label || '');
}

// Build the export payload from any subset of items. `items` is an object
// `{ cps, sequences, scripts }`; any missing array is treated as empty.
export function buildExport({ cps = [], sequences = [], scripts = [] } = {}) {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    chargePoints: cps.map((c) => pickFields(c, TRANSIENT_CP)).sort(byLabel),
    sequences: sequences.map((s) => pickFields(s, TRANSIENT_SEQ_SCRIPT)).sort(byLabel),
    scripts: scripts.map((s) => pickFields(s, TRANSIENT_SEQ_SCRIPT)).sort(byLabel),
  };
}

export function exportFilename(date = new Date()) {
  const iso = date.toISOString().slice(0, 10);
  return `${FILENAME_PREFIX}-${iso}.json`;
}

// Trigger a browser download of the JSON payload. Pure side-effect helper.
export function downloadJson(payload, filename = exportFilename()) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari/Firefox don't drop the download mid-stream.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Parse + validate a string previously produced by buildExport. Returns
// `{ chargePoints, sequences, scripts }` with arrays guaranteed to exist
// (never undefined). Throws an Error if the file is malformed.
export function parseImport(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Import file must be a JSON object');
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    chargePoints: arr(parsed.chargePoints),
    sequences: arr(parsed.sequences),
    scripts: arr(parsed.scripts),
  };
}
