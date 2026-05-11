// Right pane: master/detail for ChargePoints, sequences, and scripts.
//
//   List view (default): three sections — CPs, Sequences, Scripts — with
//                        per-section filter inputs and "+ Add …" footers.
//   CP detail:           CP fields + an "Active" list of currently-attached
//                        sequences and scripts (each with stop / remove).
//   Sequence detail:     ordered list of steps; drag-handle reorder.
//   Script detail:       name, notes, params, code (textarea).
//
// Activation = drag a sequence or script's ⠿ handle onto a CP row. The
// active-runs registry tracks lifecycle and emits ticks for chip flashing.

import { LitElement, html, css, repeat } from './lit.js';
import { formStyles } from './shared-styles.js';
import { connections } from '../state/connections.js';
import { composer } from '../state/composer.js';
import { ConnState } from '../workers/protocol.js';
import { VERSIONS, VERSION_LABEL, highestVersion } from '../ocpp/versions.js';
import { bgFor, fgFor } from './connection-hue.js';
import {
  listSequences, getSequence, saveSequence, emptySequence, deleteSequence,
  reorderSequences,
} from '../lib/sequences.js';
import {
  listScripts, getScript, saveScript, emptyScript, deleteScript,
  reorderScripts, resetBuiltinScript,
} from '../lib/scripts.js';
import { activeRuns } from '../state/active-runs.js';
import { nextLabel, copyName } from '../lib/labels.js';
import { resolveTemplates, cpScope, toScriptSource } from '../lib/templates.js';
import { buildExport, downloadJson, parseImport } from '../lib/workbench-io.js';

// Param names follow the same gap-filling rule as ChargePoint/Sequence labels,
// but without the "Prefix #N" shape — they're plain `paramN` identifiers so
// they can be used as `script.params.paramN`.
function nextParamName(params) {
  const used = new Set();
  for (const p of params || []) {
    const m = (p.name || '').match(/^param(\d+)$/);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `param${n}`;
}

// Ergonomics for CP/script param values: typing `X1` keeps a plain string;
// typing `42`, `true`, `{"a":1}`, etc. parses as JSON. Round-trips cleanly —
// strings display without quotes; non-strings get JSON.stringified.
function parseInputValue(raw) {
  if (raw === '') return '';
  try { return JSON.parse(raw); } catch { return raw; }
}
function valueToInput(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const REORDER_MIME = {
  cp: 'application/x-ocpp-cp-reorder',
  sequence: 'application/x-ocpp-sequence-reorder',
  script: 'application/x-ocpp-script-reorder',
};

// AI providers offered by the "Prompt AI" dropdown on script detail views.
// Each entry's `url` takes an already-URL-encoded query string and returns
// the full URL to open.
const AI_PROVIDERS = [
  { id: 'chatgpt',    label: 'ChatGPT',    url: (q) => `https://chat.openai.com/?q=${q}` },
  { id: 'claude',     label: 'Claude',     url: (q) => `https://claude.ai/new?q=${q}` },
  { id: 'perplexity', label: 'Perplexity', url: (q) => `https://www.perplexity.ai/search/new?q=${q}` },
  { id: 'gemini',     label: 'Gemini',     url: (q) => `https://www.google.com/search?udm=50&aep=11&q=${q}` },
];

function filterBy(items, query, fields) {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((it) => fields.some((f) => (it[f] || '').toLowerCase().includes(q)));
}

const STATE_DOT = {
  [ConnState.Idle]: '○',
  [ConnState.Connecting]: '◔',
  [ConnState.Open]: '●',
  [ConnState.Closing]: '◑',
  [ConnState.Closed]: '○',
  [ConnState.Error]: '✕',
};

class WorkbenchPanel extends LitElement {
  static styles = [formStyles, css`
    :host {
      display: flex;
      flex-direction: column;
      font-family: var(--mono);
      font-size: 12px;
      height: 100%;
      overflow: hidden;
    }

    .topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      height: 36px;
      box-sizing: border-box;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .topbar h2 {
      margin: 0;
      font-size: 11px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }
    .topbar .back {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 4px 6px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
    }
    .topbar .back:hover { background: var(--surface-3); color: var(--text); }
    .topbar .spacer { flex: 1; }
    .crumb {
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .body { flex: 1; overflow-y: auto; padding: 12px; }

    section { margin-bottom: 18px; }
    .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0 8px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .section-head .line { flex: 1; height: 1px; background: var(--border); }
    .section-head .filter-input {
      width: 110px;
      height: 20px;
      padding: 0 8px;
      font-family: var(--mono);
      font-size: 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--text);
      text-transform: none;
      letter-spacing: 0;
    }
    .section-head .filter-input::placeholder { color: var(--muted); }
    .section-head .filter-input:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--surface);
      box-shadow: 0 0 0 2px var(--accent-ring);
    }

    /* Master-list row = a "grouped" button: a leading action on the left,
       glued to a clickable body that navigates into the detail view. */
    .row {
      display: flex;
      align-items: stretch;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg);
      margin-bottom: 4px;
      overflow: hidden;
      transition: border-color 0.12s ease;
    }
    .row:hover { border-color: var(--accent); }

    /* Leading control group on the left of every row. Shares a background
       and separates inner buttons with thin vertical borders so they read
       as one "grouped" control. */
    .row-leading {
      display: flex;
      align-items: stretch;
      flex-shrink: 0;
      background: var(--surface-2);
      border-right: 1px solid var(--border);
    }
    .row-leading > .row-action + .row-action,
    .row-leading > .drag-handle + .row-action,
    .row-leading > .row-action + .drag-handle {
      border-left: 1px solid var(--border);
    }
    .row-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      background: transparent;
      color: var(--ok);
      border: none;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.12s ease, color 0.12s ease;
      flex-shrink: 0;
    }
    .row-action:hover { background: var(--accent-soft); color: var(--accent); }
    .row-action:disabled { color: var(--border-strong); cursor: not-allowed; background: transparent; }
    .row-action:disabled:hover { background: transparent; color: var(--border-strong); }

    /* Connect/disconnect toggle next to the send button. */
    .row-action.toggle { color: var(--muted); }
    .row-action.toggle:hover { background: var(--accent-soft); color: var(--accent); }
    .row-action.toggle.open { color: var(--err); }
    .row-action.toggle.open:hover { background: rgba(248,113,113,0.12); color: var(--err); }
    .row-action.toggle.transit { color: var(--warn); }
    .drag-handle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      color: var(--muted);
      cursor: grab;
      user-select: none;
      font-size: 14px;
      line-height: 1;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .drag-handle:hover { background: var(--surface-3); color: var(--text); }
    .drag-handle:active { cursor: grabbing; }

    .row-action.record { color: var(--err); }
    .row-action.record:hover { background: rgba(248,113,113,0.12); color: var(--err); }
    .row-action.record:disabled { color: var(--border-strong); }

    .row.drag-source { opacity: 0.5; }
    .row.cp-row.drop-target {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-ring);
    }
    .row.drop-above { box-shadow: 0 -2px 0 0 var(--accent); }
    .row.drop-below { box-shadow: 0 2px 0 0 var(--accent); }

    /* ↕ reorder handle — right-side, always visible. Same look in master
       list rows and inside sequence step rows. */
    .reorder-handle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      color: var(--muted);
      cursor: grab;
      user-select: none;
      font-size: 13px;
      line-height: 1;
      border-radius: 3px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .reorder-handle:hover { background: var(--surface-3); color: var(--text); }
    .reorder-handle:active { cursor: grabbing; }

    .row-body {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .row-body:hover { background: var(--surface-2); }
    .row-body .dot { font-size: 13px; line-height: 1; flex-shrink: 0; }
    .row-body .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-body .badge {
      color: var(--muted);
      font-size: 10px;
      padding: 2px 8px;
      background: var(--surface-2);
      border-radius: 999px;
    }
    .row-body .dup,
    .row-body .del {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      line-height: 1;
      opacity: 0;
      transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
    }
    .row:hover .row-body .dup,
    .row:hover .row-body .del { opacity: 1; }
    .row-body .dup:hover { background: var(--accent-soft); color: var(--accent); }
    .row-body .del:hover { background: rgba(248,113,113,0.12); color: var(--err); }
    .row-body .chev { color: var(--muted); }

    .empty { color: var(--muted); font-style: italic; font-size: 11px; padding: 8px 4px; }

    .add-btn {
      width: 100%;
      margin-top: 6px;
      padding: 8px;
      background: var(--surface-2);
      color: var(--accent);
      border: 1px dashed var(--accent);
    }
    .add-btn:hover { background: var(--accent-soft); }

    /* ---------------- CP detail view ---------------- */

    .field-grid {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 10px 12px;
      align-items: center;
      margin-bottom: 16px;
    }
    .field-grid > textarea { align-self: stretch; }
    .field-grid > label:has(+ textarea) { align-self: flex-start; padding-top: 6px; }
    /* CentralSystem URL column: input + optional mixed-content warning. */
    .url-col { display: flex; flex-direction: column; gap: 4px; width: 100%; }
    .mixed-content-warn {
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.4;
      color: var(--warn);
      background: rgba(251,191,36,0.08);
      border: 1px solid rgba(251,191,36,0.4);
      border-radius: var(--radius-sm);
      padding: 4px 6px;
    }
    .mixed-content-warn code {
      background: var(--surface-2);
      padding: 0 4px;
      border-radius: 3px;
    }

    /* Label row in CP detail pairs the label input with a hue slider. The
       slider's gradient is the full hue spectrum at our normalized
       saturation/lightness, so what you see is always what you get. */
    .label-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: 100%;
    }
    .label-row .label-input { flex: 1; min-width: 0; }
    /* Hue slider. Track gradient lives on the track pseudo-elements (Webkit
       repaints the input background while the thumb moves, so a gradient
       set on the input itself disappears mid-drag). Firefox's
       ::-moz-range-progress is transparent — otherwise it draws its own
       fill on top of the track and we see TWO spectrums. */
    .hue-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100px;
      height: 18px;
      flex-shrink: 0;
      background: transparent;
      border: none;
      padding: 0;
      margin: 0;
      cursor: pointer;
    }
    .hue-slider:focus { outline: none; }
    .hue-slider::-webkit-slider-runnable-track {
      height: 18px;
      border-radius: 9px;
      background: linear-gradient(
        to right,
        hsl(0,   65%, 45%),
        hsl(60,  65%, 45%),
        hsl(120, 65%, 45%),
        hsl(180, 65%, 45%),
        hsl(240, 65%, 45%),
        hsl(300, 65%, 45%),
        hsl(360, 65%, 45%)
      );
    }
    .hue-slider::-moz-range-track {
      height: 18px;
      border-radius: 9px;
      background: linear-gradient(
        to right,
        hsl(0,   65%, 45%),
        hsl(60,  65%, 45%),
        hsl(120, 65%, 45%),
        hsl(180, 65%, 45%),
        hsl(240, 65%, 45%),
        hsl(300, 65%, 45%),
        hsl(360, 65%, 45%)
      );
    }
    .hue-slider::-moz-range-progress {
      background: transparent;
    }
    .hue-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      margin-top: 2px;
      border-radius: 50%;
      background: var(--thumb, white);
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px var(--border);
    }
    .hue-slider::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--thumb, white);
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px var(--border);
    }

    /* Export / Import modal — covers the workbench pane (its host has
       overflow:hidden so a fixed overlay scoped here keeps the dialog
       scoped to the right rail rather than the whole viewport). */
    .io-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      font-family: var(--mono);
    }
    .io-dialog {
      display: flex;
      flex-direction: column;
      width: min(560px, 92vw);
      max-height: 80vh;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      overflow: hidden;
    }
    .io-head, .io-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--surface-2);
    }
    .io-head { border-bottom: 1px solid var(--border); }
    .io-foot { border-top: 1px solid var(--border); }
    .io-head h3 { margin: 0; font-size: 13px; color: var(--accent); }
    .io-head .spacer, .io-foot .spacer { flex: 1; }
    .io-filename { color: var(--muted); font-size: 11px; }
    .io-body {
      overflow-y: auto;
      padding: 8px 14px;
      flex: 1;
    }
    .io-section { margin: 12px 0; }
    .io-section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      color: var(--text);
    }
    .io-section-head .io-empty { color: var(--muted); font-size: 10px; font-style: italic; }
    .io-count-inline { color: var(--muted); font-size: 10px; margin-left: auto; }
    .io-list { list-style: none; padding: 4px 0 0; margin: 0; }
    .io-list li { padding: 2px 0; }
    .io-check {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 12px;
      width: 100%;
    }
    .io-check input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      cursor: pointer;
    }
    .io-count { color: var(--muted); font-size: 11px; }

    /* "Prompt AI" dropdown in script-detail Code section header. */
    .ai-dropdown { position: relative; display: inline-block; }
    .ai-menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 50;
      min-width: 140px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      box-shadow: 0 8px 20px rgba(0,0,0,0.35);
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ai-option {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text);
      text-align: left;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 3px;
      font-family: var(--mono);
    }
    .ai-option:hover { background: var(--surface-2); border-color: var(--border); color: var(--accent); }

    .field-grid label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-pill.open { background: rgba(74,222,128,0.15); color: var(--ok); }
    .status-pill.connecting, .status-pill.closing { background: rgba(251,191,36,0.15); color: var(--warn); }
    .status-pill.error, .status-pill.closed { background: rgba(248,113,113,0.15); color: var(--err); }
    .status-pill.idle { background: var(--surface-2); color: var(--muted); }
    .cp-detail .actions { display: flex; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .cp-detail .actions .spacer { flex: 1; }
    .err { color: var(--err); font-family: var(--mono); font-size: 11px; }

    /* ---------------- Sequence detail view ---------------- */

    .seq-meta {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 8px 12px;
      margin-bottom: 16px;
      align-items: center;
    }
    .seq-meta label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding-top: 8px; }
    .seq-meta > textarea { align-self: stretch; }
    .seq-meta > label:has(+ textarea) { align-self: flex-start; }

    /* Compact 2-line description textareas, resizable vertically. */
    textarea.desc {
      width: 100%;
      min-height: 44px;
      box-sizing: border-box;
      font-family: var(--mono);
      font-size: 11px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      resize: vertical;
    }
    textarea.desc:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-ring); }

    .step-list { list-style: none; padding: 0; margin: 0; }
    .step-list li {
      display: grid;
      grid-template-columns: auto 28px 1fr auto auto auto;
      gap: 8px;
      align-items: center;
      padding: 4px 10px 4px 4px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg);
      margin-bottom: 4px;
      transition: box-shadow 0.06s ease;
    }
    .step-list li:hover { border-color: var(--border-strong); }
    .step-list li.drag-source { opacity: 0.45; }
    .step-list li.drop-above { box-shadow: 0 -2px 0 0 var(--accent); }
    .step-list li.drop-below { box-shadow: 0 2px 0 0 var(--accent); }

    /* Leading group: [⇤ export] [⇥ import] as one grouped control. */
    .step-leading {
      display: flex;
      align-items: stretch;
      height: 30px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .step-leading > * {
      width: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      color: var(--accent);
      transition: background 0.12s ease, color 0.12s ease;
    }
    .step-leading > button:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent-strong); }
    .step-leading > button:disabled {
      color: var(--border-strong);
      cursor: not-allowed;
    }
    /* Step rows also use a placeholder span when the row is a 'pause' step
       (no export/import buttons) so the grid column stays aligned. */
    .step-list .leading-placeholder { width: 0; }

    .step-list .idx { color: var(--muted); font-weight: 600; }
    .step-list .name {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }
    .step-list .name .action-name {
      flex-shrink: 0;
      white-space: nowrap;
    }
    .step-list .kind-pause .action-name { color: var(--warn); }
    .step-list .kind-send .action-name { color: var(--text); }
    .step-list .meta {
      color: var(--muted);
      font-size: 10px;
      flex-shrink: 0;
    }
    .step-list .name .comment {
      flex: 1;
      min-width: 60px;
      font-family: var(--mono);
      font-size: 10px;
      font-style: italic;
      color: var(--muted);
      background: transparent;
      border: none;
      padding: 0;
    }
    .step-list .name .comment::placeholder { color: var(--border-strong); font-style: italic; }
    .step-list .name .comment:focus { outline: none; color: var(--text); font-style: normal; }
    .step-list .delay {
      display: inline-flex;
      align-items: baseline;
      gap: 2px;
      color: var(--muted);
      font-size: 10px;
      font-style: italic;
    }
    .step-list .delay input {
      width: 36px;
      text-align: right;
      font-family: var(--mono);
      font-size: 10px;
      font-style: italic;
      background: transparent;
      border: none;
      padding: 0;
      color: var(--muted);
    }
    .step-list .delay input:hover { border: none; }
    .step-list .delay input:focus {
      outline: none;
      background: transparent;
      box-shadow: none;
      color: var(--text);
      font-style: normal;
    }
    .step-list .step-del {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 12px;
      line-height: 1;
    }
    .step-list .step-del:hover { background: rgba(248,113,113,0.12); color: var(--err); }

    /* Per-CP counter chips: sequence ▶N and script ⚙N. Flash on tick. */
    .count-chip {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 9px;
      font-family: var(--mono);
      letter-spacing: 0.04em;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--muted);
      transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
    }
    .count-chip.seq { color: var(--ok); border-color: rgba(74,222,128,0.4); }
    .count-chip.script { color: var(--accent); border-color: rgba(96,165,250,0.4); }
    .count-chip.flash { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .count-chip.seq.flash { background: var(--ok); }

    /* Active list under CP detail */
    .active-list { list-style: none; padding: 0; margin: 0; }
    .active-list li {
      display: block;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      margin-bottom: 4px;
    }
    .active-list .active-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    /* Sub-row shown beneath an active sequence while it's waiting before
       its next step. Shows the upcoming step + a live countdown, plus a
       "Skip" button to fast-forward the wait. */
    .active-list .waiting-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      padding: 4px 6px;
      background: var(--surface-2);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text);
    }
    .active-list .waiting-row .spacer { flex: 1; }
    .active-list .waiting-row .muted { color: var(--muted); }
    .active-list .waiting-row strong { color: var(--accent); font-weight: 600; }
    .active-list .waiting-row button {
      font-size: 10px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: var(--bg);
      color: var(--accent);
      cursor: pointer;
    }
    .active-list .waiting-row button:hover {
      background: var(--accent-soft);
      border-color: var(--accent);
    }
    .active-list li.state-stopped { opacity: 0.55; }
    .active-list li.state-errored { border-color: var(--err); }
    .active-list .kind-glyph {
      width: 18px;
      text-align: center;
    }
    .active-list .kind-sequence { color: var(--ok); }
    .active-list .kind-script { color: var(--accent); }
    .active-list .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .active-list .badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }
    .active-list button.danger-hover:hover { background: rgba(248,113,113,0.12); color: var(--err); }

    /* Script editor */
    .param-list { list-style: none; padding: 0; margin: 0 0 8px; }
    .param-list li {
      display: grid;
      grid-template-columns: 160px 1fr auto;
      gap: 6px;
      margin-bottom: 4px;
      align-items: center;
    }
    .param-list .pname, .param-list .pdefault {
      font-family: var(--mono);
      font-size: 11px;
    }
    textarea.code {
      width: 100%;
      min-height: 560px;
      font-family: var(--mono);
      font-size: 12px;
      tab-size: 2;
      box-sizing: border-box;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px;
      resize: vertical;
    }
    textarea.code:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-ring); }

  `];

  static properties = {
    cps: { type: Array },
    filterVersions: { type: Object },     // Set<string> from ocpp-app
    sequences: { state: true },
    scripts: { state: true },
    _view: { state: true },
    _selectedCpKey: { state: true },
    _selectedSequenceId: { state: true },
    _selectedScriptId: { state: true },
    _dragKind: { state: true },           // 'sequence' | 'script' | null
    _draggingRefId: { state: true },
    _stepDragIndex: { state: true },
    _stepDragOver: { state: true },
    _reorderKind: { state: true },        // 'cp' | 'sequence' | 'script' | null
    _reorderFromId: { state: true },
    _reorderOver: { state: true },        // { id, pos: 'above'|'below' }
    _cpFilter: { state: true },
    _sequenceFilter: { state: true },
    _scriptFilter: { state: true },
    _activeByCp: { state: true },         // Map<cpId, Entry[]>
    _flashing: { state: true },           // Map<`${cpId}:${kind}`, timeoutId>
    _exportDialog: { state: true },       // { sel: { cps: Set<key>, sequences: Set<id>, scripts: Set<id> } }
    _importDialog: { state: true },       // { filename, data: parsed, sel: same shape as above }
    _aiMenuOpen: { state: true },         // script detail: "Prompt AI" dropdown visibility
  };

  // Activate-on-CP drags (⠿ handle on sequence/script rows).
  static SEQ_MIME = 'application/x-ocpp-sequence';
  static SCRIPT_MIME = 'application/x-ocpp-script';
  // Reorder-within-section drags (↕ handle on every list row).
  static CP_REORDER_MIME = 'application/x-ocpp-cp-reorder';
  static SEQ_REORDER_MIME = 'application/x-ocpp-sequence-reorder';
  static SCRIPT_REORDER_MIME = 'application/x-ocpp-script-reorder';
  // Step reorder inside a sequence detail.
  static STEP_DRAG_MIME = 'application/x-ocpp-step';

  constructor() {
    super();
    this.cps = [];
    this.filterVersions = null;
    this.sequences = [];
    this.scripts = [];
    this._view = 'list';
    this._selectedCpKey = null;
    this._selectedSequenceId = null;
    this._selectedScriptId = null;
    this._composerState = composer.get();
    this._dragKind = null;
    this._draggingRefId = null;
    this._stepDragIndex = null;
    this._stepDragOver = null;
    this._reorderKind = null;
    this._reorderFromId = null;
    this._reorderOver = null;
    this._cpFilter = '';
    this._sequenceFilter = '';
    this._scriptFilter = '';
    this._activeByCp = new Map();
    this._flashing = new Map();
    this._exportDialog = null;
    this._importDialog = null;
    this._aiMenuOpen = false;
  }

  _filteredCps() { return filterBy(this.cps, this._cpFilter, ['label', 'url']); }
  _filteredSequences() { return filterBy(this.sequences, this._sequenceFilter, ['name', 'description']); }
  _filteredScripts() { return filterBy(this.scripts, this._scriptFilter, ['name', 'notes']); }
  _activeFor(cpId) { return this._activeByCp.get(cpId) || []; }
  _activeCount(cpId, kind) { return this._activeFor(cpId).filter((e) => e.kind === kind).length; }
  _isFlashing(cpId, kind) { return this._flashing.has(`${cpId}:${kind}`); }

  connectedCallback() {
    super.connectedCallback();
    this._reloadSequences();
    this._reloadScripts();
    this._unsubComposer = composer.subscribe((s) => {
      this._composerState = s;
      this.requestUpdate();
    });
    this._activeByCp = new Map(activeRuns._byCp); // initial snapshot
    this._unsubActive = activeRuns.subscribe((map) => {
      this._activeByCp = new Map(map);
    });
    this._unsubTick = activeRuns.onTick(({ cpId, kind }) => this._flash(cpId, kind));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubComposer?.();
    this._unsubActive?.();
    this._unsubTick?.();
    for (const t of this._flashing.values()) clearTimeout(t);
    if (this._waitTicker) { clearInterval(this._waitTicker); this._waitTicker = null; }
  }

  updated() {
    // After each render, decide whether the countdown ticker should be
    // running. Cheap — _activeByCp is small.
    this._ensureWaitTicker();
  }

  _flash(cpId, kind) {
    const key = `${cpId}:${kind}`;
    const prev = this._flashing.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this._flashing.delete(key);
      this.requestUpdate();
    }, 400);
    this._flashing.set(key, t);
    this.requestUpdate();
  }

  async _reloadSequences() { this.sequences = await listSequences(); }
  async _reloadScripts() { this.scripts = await listScripts(); }

  _back() {
    this._view = 'list';
    this._selectedCpKey = null;
    this._selectedSequenceId = null;
    this._selectedScriptId = null;
  }
  _openCp(id) { this._selectedCpKey = id; this._view = 'cp'; }
  _openSequence(id) { this._selectedSequenceId = id; this._view = 'sequence'; }
  _openScript(id) { this._selectedScriptId = id; this._view = 'script'; }

  _addCp() {
    const key = connections.add({ ocppVersion: highestVersion(this.filterVersions) });
    this._openCp(key);
  }

  _duplicateCp(cp, ev) {
    if (ev) ev.stopPropagation();
    connections.add({
      label: copyName(cp, this.cps, 'label'),
      csmUrl: cp.csmUrl,
      ocppVersion: cp.ocppVersion,
      id: cp.id || '',
    });
    // params + description aren't auto-copied — duplicating a CP is for spawning
    // a fresh peer that shares the URL/version, not a verbatim clone.
  }

  async _duplicateSequence(seq, ev) {
    if (ev) ev.stopPropagation();
    const fresh = await getSequence(seq.id);
    if (!fresh) return;
    await saveSequence({
      ...emptySequence(),
      label: copyName(seq, this.sequences, 'label'),
      description: fresh.description || '',
      stopOnError: !!fresh.stopOnError,
      steps: JSON.parse(JSON.stringify(fresh.steps || [])),
    });
    await this._reloadSequences();
  }

  async _addSequence() {
    const id = await saveSequence({
      ...emptySequence(),
      label: nextLabel('Sequence', this.sequences, 'label'),
    });
    await this._reloadSequences();
    this._openSequence(id);
  }

  async _addScript() {
    const id = await saveScript({
      ...emptyScript(),
      label: nextLabel('Script', this.scripts, 'label'),
    });
    await this._reloadScripts();
    this._openScript(id);
  }

  async _duplicateScript(script, ev) {
    if (ev) ev.stopPropagation();
    const fresh = await getScript(script.id);
    if (!fresh) return;
    await saveScript({
      ...emptyScript(),
      label: copyName(script, this.scripts, 'label'),
      description: fresh.description || '',
      params: JSON.parse(JSON.stringify(fresh.params || [])),
      code: fresh.code || '',
    });
    await this._reloadScripts();
  }

  async _deleteScript(script, ev) {
    if (ev) ev.stopPropagation();
    const skipConfirm = ev && (ev.ctrlKey || ev.metaKey);
    if (!skipConfirm && !confirm(`Delete script "${script.label}"?`)) return;
    if (this._view === 'script' && this._selectedScriptId === script.id) this._back();
    await deleteScript(script.id);
    await this._reloadScripts();
  }

  async _resetBuiltin(script) {
    if (!script.builtinId) return;
    if (!confirm(`Reset "${script.label}" to its built-in definition? Your edits will be lost.`)) return;
    await resetBuiltinScript(script.id);
    await this._reloadScripts();
  }

  // Build the prompt body once, then hand it to whichever provider the user
  // picked. The intro gives the AI enough runtime context to read a bare
  // `cp.onMessage` call without guessing what `cp` / `script` are. We send
  // the full code (no truncation) — URL length limits seem effectively
  // unbounded in practice, but if a provider/browser DOES chop it, the AI
  // is told the expected length and to ask the user to paste the rest.
  _aiPrompt(script) {
    const code = '```js\n' + (script.code || '') + '\n//Script complete\n```';
    const intro = [
      'Summarize what the following script does.\n\n\n',
      'Context: The script runs inside a developer-facing OCPP ChargePoint simulator (browser app, OCPP 1.6/2.0.1/2.1).',
      'Each script executes in its own Web Worker, attached to one ChargePoint, and talks to the CSMS via an exposed `cp` object.',
      '`cp.sendMessage(action, payload)` sends a CALL to the CSMS and resolves with the response; `cp.onMessage(handler)` or `cp.onMessage(\'Action\', handler)` registers handlers that produce CALLRESULTs (handlers receive `(payload, response)` where `response` is a plain object you mutate or replace).',
      'A second `script` object exposes script-local helpers: `script.params.NAME`, `script.log(...)`, `await script.sleep(ms)`, `script.stop()`, `script.signal`, and `script.merge(target, source)` for deep merges.',
      'HARD RULE: if the script in the initial prompt does not end with //Script complete, your entire response must be a request for the full code — do not summarize, explain, or analyze any part of it.',
    ].join(' ');
    return `${intro}\n\n\n\n${code}`;
  }

  _promptAi(provider, script) {
    const q = encodeURIComponent(this._aiPrompt(script));
    window.open(provider.url(q), '_blank', 'noopener');
    this._aiMenuOpen = false;
  }

  _toggleAiMenu(ev) {
    if (ev) ev.stopPropagation();
    this._aiMenuOpen = !this._aiMenuOpen;
    if (this._aiMenuOpen) {
      // Close on next outside click. queueMicrotask so the click that opened
      // the menu doesn't immediately close it.
      queueMicrotask(() => {
        const close = () => { this._aiMenuOpen = false; document.removeEventListener('click', close); };
        document.addEventListener('click', close);
      });
    }
  }

  async _patchScript(script, patch) {
    const fresh = await getScript(script.id);
    if (!fresh) return;
    await saveScript({ ...fresh, ...patch });
    await this._reloadScripts();
  }

  _updateCp(id, patch) { connections.update(id, patch); }
  _connect(id) { connections.connect(id); }
  _disconnect(id) { connections.disconnect(id); }
  _removeCp(cp, ev) {
    if (ev) ev.stopPropagation();
    const skipConfirm = ev && (ev.ctrlKey || ev.metaKey);
    if (!skipConfirm && !confirm(`Remove ${cp.label}?`)) return;
    // Navigate back BEFORE removal so the detail view doesn't try to render
    // a CP that's about to disappear from the cps list mid-update.
    if (this._view === 'cp' && this._selectedCpKey === cp.key) this._back();
    connections.remove(cp.key);
  }

  // Open a standalone log window solo-filtered to this CP. The window name
  // is namespaced by cp.key so repeat clicks focus the same window rather
  // than spawning duplicates. We also force-navigate (and add a cache-bust
  // param) — some browsers focus an existing named window without applying
  // the new URL, which would strip the ?cp= filter AND can leave the popup
  // running a stale module bundle.
  _popOutLog(cp, ev) {
    if (ev) ev.stopPropagation();
    const url = `log.html?cp=${encodeURIComponent(cp.key)}&t=${Date.now()}`;
    const win = window.open(url, `ocpp-log-${cp.key}`, 'width=900,height=600');
    if (win) {
      try { win.location.replace(url); } catch { /* cross-origin guard */ }
      win.focus();
    }
  }

  // ---- Action button on each row ----
  _sendToCp(cp, ev) {
    ev.stopPropagation();
    const cs = this._composerState;
    if (!cs.action) return;
    const resolved = resolveTemplates(cs.payload || {}, cpScope(cp));
    connections.send(cp.key, cs.action, resolved).catch((err) => console.error(err));
  }

  async _appendToScript(script, ev) {
    if (ev) ev.stopPropagation();
    const cs = this._composerState;
    if (!cs.action) return;
    const fresh = await getScript(script.id);
    if (!fresh) return;
    const payload = toScriptSource(cs.payload || {}, 0);
    const line = `await cp.sendMessage('${cs.action}', ${payload});\n`;
    const code = (fresh.code || '').replace(/\s*$/, '\n');
    await saveScript({ ...fresh, code: code + line });
    await this._reloadScripts();
  }

  async _addStepToSequence(seq, ev) {
    ev.stopPropagation();
    const cs = this._composerState;
    if (!cs.action) return;
    const fresh = await getSequence(seq.id);
    if (!fresh) return;
    fresh.steps = [
      ...(fresh.steps || []),
      {
        kind: 'send',
        action: cs.action,
        payload: cs.payload,
        sourceVersion: cs.version,
        delaySeconds: 1,
      },
    ];
    await saveSequence(fresh);
    await this._reloadSequences();
  }

  async _updateStep(seq, stepIndex, patch) {
    const fresh = await getSequence(seq.id);
    if (!fresh) return;
    const steps = fresh.steps.slice();
    steps[stepIndex] = { ...steps[stepIndex], ...patch };
    fresh.steps = steps;
    await saveSequence(fresh);
    this._reloadSequences();
  }

  async _deleteStep(seq, stepIndex, ev) {
    if (ev) ev.stopPropagation();
    const step = seq.steps[stepIndex];
    const label = step.kind === 'pause' ? `pause ${step.seconds}s` : step.action;
    const skipConfirm = ev && (ev.ctrlKey || ev.metaKey);
    if (!skipConfirm && !confirm(`Delete step ${stepIndex + 1} (${label})?`)) return;
    const fresh = await getSequence(seq.id);
    if (!fresh) return;
    const steps = fresh.steps.slice();
    steps.splice(stepIndex, 1);
    fresh.steps = steps;
    await saveSequence(fresh);
    this._reloadSequences();
  }

  // Load a step's content into the composer (round-trips through ocpp-app).
  _insertStepInComposer(step, ev) {
    if (ev) ev.stopPropagation();
    if (step.kind !== 'send') return;
    this.dispatchEvent(new CustomEvent('composer-load', {
      detail: {
        action: step.action,
        version: step.sourceVersion || 'ocpp2.1',
        payload: step.payload || {},
      },
      bubbles: true,
      composed: true,
    }));
  }

  // Overwrite this step's action+payload from the current composer state.
  async _updateStepFromComposer(seq, stepIndex, ev) {
    if (ev) ev.stopPropagation();
    const cs = this._composerState;
    if (!cs.action) return;
    await this._updateStep(seq, stepIndex, {
      kind: 'send',
      action: cs.action,
      payload: cs.payload,
      sourceVersion: cs.version,
    });
  }

  // ---- Step reorder via drag-and-drop ----
  _onStepDragStart(stepIndex, ev) {
    ev.stopPropagation();
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData(WorkbenchPanel.STEP_DRAG_MIME, String(stepIndex));
    this._stepDragIndex = stepIndex;
  }
  _onStepDragEnd() {
    this._stepDragIndex = null;
    this._stepDragOver = null;
  }
  _onStepDragOver(stepIndex, ev) {
    if (this._stepDragIndex == null) return;
    ev.preventDefault();
    const rect = ev.currentTarget.getBoundingClientRect();
    const pos = ev.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    if (this._stepDragOver?.index !== stepIndex || this._stepDragOver?.pos !== pos) {
      this._stepDragOver = { index: stepIndex, pos };
    }
  }
  async _onStepDrop(seq, targetIndex, ev) {
    if (this._stepDragIndex == null) return;
    ev.preventDefault();
    ev.stopPropagation();
    const source = this._stepDragIndex;
    const pos = this._stepDragOver?.pos === 'below' ? targetIndex + 1 : targetIndex;
    this._stepDragIndex = null;
    this._stepDragOver = null;
    if (source === pos || source + 1 === pos) return; // no-op
    const fresh = await getSequence(seq.id);
    if (!fresh) return;
    const steps = fresh.steps.slice();
    const [moved] = steps.splice(source, 1);
    const insertAt = pos > source ? pos - 1 : pos;
    steps.splice(insertAt, 0, moved);
    fresh.steps = steps;
    await saveSequence(fresh);
    this._reloadSequences();
  }

  // ---- Drag & drop: ↕ handle reorders within its own section ----
  _onReorderStart(kind, id, ev) {
    ev.stopPropagation();
    const mime = REORDER_MIME[kind];
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData(mime, String(id));
    this._reorderKind = kind;
    this._reorderFromId = id;
  }
  _onReorderEnd() {
    this._reorderKind = null;
    this._reorderFromId = null;
    this._reorderOver = null;
  }
  _onReorderOver(kind, id, ev) {
    if (this._reorderKind !== kind) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const rect = ev.currentTarget.getBoundingClientRect();
    const pos = ev.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    if (this._reorderOver?.id !== id || this._reorderOver?.pos !== pos) {
      this._reorderOver = { id, pos };
    }
  }
  async _onReorderDrop(kind, targetId, ev) {
    if (this._reorderKind !== kind) return;
    ev.preventDefault();
    ev.stopPropagation();
    const fromId = this._reorderFromId;
    const pos = this._reorderOver?.pos || 'above';
    this._reorderKind = null;
    this._reorderFromId = null;
    this._reorderOver = null;
    if (fromId == null || fromId === targetId) return;
    if (kind === 'cp') {
      // Append-after the target = insert before its successor.
      let beforeId = targetId;
      if (pos === 'below') {
        const idx = this.cps.findIndex((c) => c.key ===targetId);
        beforeId = idx >= 0 && idx + 1 < this.cps.length ? this.cps[idx + 1].id : null;
      }
      connections.reorder(fromId, beforeId);
    } else if (kind === 'sequence') {
      await this._reorderList(this.sequences, fromId, targetId, pos, reorderSequences);
      await this._reloadSequences();
    } else if (kind === 'script') {
      await this._reorderList(this.scripts, fromId, targetId, pos, reorderScripts);
      await this._reloadScripts();
    }
  }
  async _reorderList(items, fromId, targetId, pos, persist) {
    const fromIdx = items.findIndex((it) => it.id === fromId);
    let toIdx = items.findIndex((it) => it.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    if (pos === 'below') toIdx += 1;
    const next = items.slice();
    const [moved] = next.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    next.splice(insertAt, 0, moved);
    await persist(next.map((it) => it.id));
  }

  // ---- Drag & drop: drag a sequence or script onto a CP to activate it there ----
  _onDragStartSeq(seq, ev) {
    ev.dataTransfer.effectAllowed = 'copy';
    ev.dataTransfer.setData(WorkbenchPanel.SEQ_MIME, String(seq.id));
    this._dragKind = 'sequence';
    this._draggingRefId = seq.id;
  }
  _onDragStartScript(script, ev) {
    ev.dataTransfer.effectAllowed = 'copy';
    ev.dataTransfer.setData(WorkbenchPanel.SCRIPT_MIME, String(script.id));
    this._dragKind = 'script';
    this._draggingRefId = script.id;
  }
  _onDragEnd() { this._dragKind = null; this._draggingRefId = null; }

  _dragHasActivatable(ev) {
    return ev.dataTransfer?.types?.includes(WorkbenchPanel.SEQ_MIME)
        || ev.dataTransfer?.types?.includes(WorkbenchPanel.SCRIPT_MIME)
        || this._dragKind != null;
  }

  _onDragOverCp(ev) {
    if (!this._dragHasActivatable(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }

  async _onDropOnCp(cp, ev) {
    if (!this._dragHasActivatable(ev)) return;
    ev.preventDefault();
    const kind = this._dragKind
      || (ev.dataTransfer.types?.includes(WorkbenchPanel.SEQ_MIME) ? 'sequence' : 'script');
    const mime = kind === 'sequence' ? WorkbenchPanel.SEQ_MIME : WorkbenchPanel.SCRIPT_MIME;
    const refId = Number(ev.dataTransfer.getData(mime)) || this._draggingRefId;
    this._dragKind = null;
    this._draggingRefId = null;
    if (!refId) return;
    if (kind === 'sequence') {
      const seq = await getSequence(refId);
      if (!seq || (seq.steps || []).length === 0) return;
      activeRuns.activateSequence(cp.key, seq);
    } else {
      const script = await getScript(refId);
      if (!script || !(script.code || '').trim()) return;
      activeRuns.activateScript(cp.key, script);
    }
  }

  async _renameSequence(seq, label) {
    seq.label = label;
    await saveSequence(seq);
    this._reloadSequences();
  }
  async _setSequenceDescription(seq, description) {
    seq.description = description;
    await saveSequence(seq);
    this._reloadSequences();
  }
  async _deleteSequence(seq, ev) {
    if (ev) ev.stopPropagation();
    const skipConfirm = ev && (ev.ctrlKey || ev.metaKey);
    if (!skipConfirm && !confirm(`Delete sequence "${seq.label}"?`)) return;
    // Navigate back BEFORE the IDB delete + reload so the detail render
    // never sees the missing sequence and tries to mutate state mid-update.
    if (this._view === 'sequence' && this._selectedSequenceId === seq.id) this._back();
    await deleteSequence(seq.id);
    await this._reloadSequences();
  }

  // -----------------------------------------------------------------------
  // Renders
  // -----------------------------------------------------------------------

  render() {
    if (this._view === 'cp') return this._renderCpDetail();
    if (this._view === 'sequence') return this._renderSequenceDetail();
    if (this._view === 'script') return this._renderScriptDetail();
    return this._renderList();
  }

  _renderList() {
    return html`
      <div class="topbar">
        <h2>Workbench</h2>
        <span class="spacer"></span>
        <button class="ghost" title="Import items from a JSON file" @click=${this._startImport}>↙ Import</button>
        <button class="ghost" title="Export items to a JSON file" @click=${this._openExport}>↗ Export</button>
      </div>
      ${this._exportDialog ? this._renderExportDialog() : ''}
      ${this._importDialog ? this._renderImportDialog() : ''}
      <div class="body">
        ${this._renderSection({
          title: 'ChargePoints',
          all: this.cps,
          filtered: this._filteredCps(),
          filterValue: this._cpFilter,
          onFilterInput: (v) => { this._cpFilter = v; },
          renderRow: (c) => this._renderCpRow(c),
          rowKey: (c) => c.key,
          emptyAll: 'No ChargePoints yet.',
          addLabel: '+ Add ChargePoint',
          onAdd: () => this._addCp(),
        })}
        ${this._renderSection({
          title: 'Sequences',
          all: this.sequences,
          filtered: this._filteredSequences(),
          filterValue: this._sequenceFilter,
          onFilterInput: (v) => { this._sequenceFilter = v; },
          renderRow: (s) => this._renderSequenceRow(s),
          rowKey: (s) => s.id,
          emptyAll: 'No sequences yet.',
          addLabel: '+ Add sequence',
          onAdd: () => this._addSequence(),
        })}
        ${this._renderSection({
          title: 'Scripts',
          all: this.scripts,
          filtered: this._filteredScripts(),
          filterValue: this._scriptFilter,
          onFilterInput: (v) => { this._scriptFilter = v; },
          renderRow: (s) => this._renderScriptRow(s),
          rowKey: (s) => s.id,
          emptyAll: 'No scripts yet.',
          addLabel: '+ Add script',
          onAdd: () => this._addScript(),
        })}
      </div>
    `;
  }

  _renderSection({ title, all, filtered, filterValue, onFilterInput, renderRow, rowKey, emptyAll, addLabel, onAdd }) {
    return html`
      <section>
        <div class="section-head">
          <span>${title}</span>
          <span class="line"></span>
          <input
            class="filter-input"
            type="text"
            placeholder="filter…"
            .value=${filterValue}
            @input=${(e) => onFilterInput(e.target.value)}
          />
        </div>
        ${all.length === 0
          ? html`<div class="empty">${emptyAll}</div>`
          : filtered.length === 0
            ? html`<div class="empty">No matches for "${filterValue}".</div>`
            : repeat(filtered, rowKey, renderRow)}
        <button class="add-btn" @click=${onAdd}>${addLabel}</button>
      </section>
    `;
  }

  // -----------------------------------------------------------------------
  // Export / Import
  // -----------------------------------------------------------------------

  _openExport() {
    // Default: every item selected. User can deselect.
    this._exportDialog = {
      sel: {
        cps: new Set(this.cps.map((c) => c.key)),
        sequences: new Set(this.sequences.map((s) => s.id)),
        scripts: new Set(this.scripts.map((s) => s.id)),
      },
    };
  }
  _closeExport() { this._exportDialog = null; }

  _toggleExportSel(kind, key) {
    const sel = new Set(this._exportDialog.sel[kind]);
    if (sel.has(key)) sel.delete(key); else sel.add(key);
    this._exportDialog = { sel: { ...this._exportDialog.sel, [kind]: sel } };
  }
  _setExportAll(kind, ids) {
    const cur = this._exportDialog.sel[kind];
    const next = cur.size === ids.length ? new Set() : new Set(ids);
    this._exportDialog = { sel: { ...this._exportDialog.sel, [kind]: next } };
  }

  _doExport() {
    const sel = this._exportDialog.sel;
    const payload = buildExport({
      cps: this.cps.filter((c) => sel.cps.has(c.key)),
      sequences: this.sequences.filter((s) => sel.sequences.has(s.id)),
      scripts: this.scripts.filter((s) => sel.scripts.has(s.id)),
    });
    downloadJson(payload);
    this._closeExport();
  }

  // ---- Import ----

  _startImport() {
    // Trigger a hidden <input type="file"> click. We rebuild it each time so
    // the change handler always fires (browsers skip 'change' if the user
    // re-selects the same file).
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = parseImport(text);
        this._importDialog = {
          filename: file.name,
          data,
          sel: {
            cps: new Set(data.chargePoints.map((_, i) => i)),
            sequences: new Set(data.sequences.map((_, i) => i)),
            scripts: new Set(data.scripts.map((_, i) => i)),
          },
        };
      } catch (e) {
        alert(`Couldn't read import file: ${e.message}`);
      }
    });
    input.click();
  }
  _closeImport() { this._importDialog = null; }

  _toggleImportSel(kind, index) {
    const sel = new Set(this._importDialog.sel[kind]);
    if (sel.has(index)) sel.delete(index); else sel.add(index);
    this._importDialog = { ...this._importDialog, sel: { ...this._importDialog.sel, [kind]: sel } };
  }
  _setImportAll(kind, count) {
    const cur = this._importDialog.sel[kind];
    const next = cur.size === count ? new Set() : new Set(Array.from({ length: count }, (_, i) => i));
    this._importDialog = { ...this._importDialog, sel: { ...this._importDialog.sel, [kind]: next } };
  }

  async _doImport() {
    const { data, sel } = this._importDialog;
    for (const i of sel.cps) {
      const c = data.chargePoints[i];
      if (!c) continue;
      // Add returns a key; then patch the rest of the fields the bare add() doesn't take.
      const key = connections.add({
        label: c.label, id: c.id, csmUrl: c.csmUrl, ocppVersion: c.ocppVersion,
      });
      connections.update(key, {
        description: c.description || '',
        params: Array.isArray(c.params) ? c.params : [],
        ...(typeof c.hue === 'number' ? { hue: c.hue } : {}),
      });
    }
    for (const i of sel.sequences) {
      const s = data.sequences[i];
      if (!s) continue;
      await saveSequence({ ...emptySequence(), ...s });
    }
    for (const i of sel.scripts) {
      const s = data.scripts[i];
      if (!s) continue;
      await saveScript({ ...emptyScript(), ...s });
    }
    await this._reloadSequences();
    await this._reloadScripts();
    this._closeImport();
  }

  // ---- Shared render ----

  _renderExportDialog() {
    const sel = this._exportDialog.sel;
    const total =
      (sel.cps.size + sel.sequences.size + sel.scripts.size);
    return html`
      <div class="io-overlay" @click=${(e) => { if (e.target.classList.contains('io-overlay')) this._closeExport(); }}>
        <div class="io-dialog">
          <div class="io-head">
            <h3>Export</h3>
            <span class="spacer"></span>
            <button class="ghost" @click=${this._closeExport}>✕</button>
          </div>
          <div class="io-body">
            ${this._renderIoSection({
              title: 'ChargePoints',
              items: this.cps.slice().sort((a, b) => (a.label || '').localeCompare(b.label || '')),
              keyOf: (c) => c.key,
              labelOf: (c) => c.label,
              sel: sel.cps,
              onToggle: (key) => this._toggleExportSel('cps', key),
              onToggleAll: () => this._setExportAll('cps', this.cps.map((c) => c.key)),
            })}
            ${this._renderIoSection({
              title: 'Sequences',
              items: this.sequences.slice().sort((a, b) => (a.label || '').localeCompare(b.label || '')),
              keyOf: (s) => s.id,
              labelOf: (s) => s.label,
              sel: sel.sequences,
              onToggle: (id) => this._toggleExportSel('sequences', id),
              onToggleAll: () => this._setExportAll('sequences', this.sequences.map((s) => s.id)),
            })}
            ${this._renderIoSection({
              title: 'Scripts',
              items: this.scripts.slice().sort((a, b) => (a.label || '').localeCompare(b.label || '')),
              keyOf: (s) => s.id,
              labelOf: (s) => s.label,
              sel: sel.scripts,
              onToggle: (id) => this._toggleExportSel('scripts', id),
              onToggleAll: () => this._setExportAll('scripts', this.scripts.map((s) => s.id)),
            })}
          </div>
          <div class="io-foot">
            <span class="io-count">${total} item${total === 1 ? '' : 's'} selected</span>
            <span class="spacer"></span>
            <button class="ghost" @click=${this._closeExport}>Cancel</button>
            <button class="primary" ?disabled=${total === 0} @click=${this._doExport}>Download JSON</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderImportDialog() {
    const { data, sel, filename } = this._importDialog;
    const total = sel.cps.size + sel.sequences.size + sel.scripts.size;
    return html`
      <div class="io-overlay" @click=${(e) => { if (e.target.classList.contains('io-overlay')) this._closeImport(); }}>
        <div class="io-dialog">
          <div class="io-head">
            <h3>Import</h3>
            <span class="io-filename">${filename}</span>
            <span class="spacer"></span>
            <button class="ghost" @click=${this._closeImport}>✕</button>
          </div>
          <div class="io-body">
            ${this._renderIoSection({
              title: 'ChargePoints',
              items: data.chargePoints,
              keyOf: (_c, i) => i,
              labelOf: (c) => c.label || '(unnamed)',
              sel: sel.cps,
              onToggle: (i) => this._toggleImportSel('cps', i),
              onToggleAll: () => this._setImportAll('cps', data.chargePoints.length),
            })}
            ${this._renderIoSection({
              title: 'Sequences',
              items: data.sequences,
              keyOf: (_s, i) => i,
              labelOf: (s) => s.label || '(unnamed)',
              sel: sel.sequences,
              onToggle: (i) => this._toggleImportSel('sequences', i),
              onToggleAll: () => this._setImportAll('sequences', data.sequences.length),
            })}
            ${this._renderIoSection({
              title: 'Scripts',
              items: data.scripts,
              keyOf: (_s, i) => i,
              labelOf: (s) => s.label || '(unnamed)',
              sel: sel.scripts,
              onToggle: (i) => this._toggleImportSel('scripts', i),
              onToggleAll: () => this._setImportAll('scripts', data.scripts.length),
            })}
          </div>
          <div class="io-foot">
            <span class="io-count">${total} item${total === 1 ? '' : 's'} selected</span>
            <span class="spacer"></span>
            <button class="ghost" @click=${this._closeImport}>Cancel</button>
            <button class="primary" ?disabled=${total === 0} @click=${this._doImport}>Import selected</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderIoSection({ title, items, keyOf, labelOf, sel, onToggle, onToggleAll }) {
    if (!items || items.length === 0) {
      return html`
        <div class="io-section">
          <div class="io-section-head"><span>${title}</span><span class="io-empty">(none)</span></div>
        </div>
      `;
    }
    const allOn = sel.size === items.length;
    return html`
      <div class="io-section">
        <div class="io-section-head">
          <label class="io-check">
            <input type="checkbox" .checked=${allOn} @change=${onToggleAll} />
            <strong>${title}</strong>
            <span class="io-count-inline">${sel.size} / ${items.length}</span>
          </label>
        </div>
        <ul class="io-list">
          ${items.map((it, i) => {
            const k = keyOf(it, i);
            return html`
              <li>
                <label class="io-check">
                  <input
                    type="checkbox"
                    .checked=${sel.has(k)}
                    @change=${() => onToggle(k)}
                  />
                  ${labelOf(it)}
                </label>
              </li>
            `;
          })}
        </ul>
      </div>
    `;
  }

  _renderCpRow(cp) {
    const isOpen = cp.state === ConnState.Open;
    const inTransit = cp.state === ConnState.Connecting || cp.state === ConnState.Closing;
    const canSend = !!this._composerState.action && isOpen;
    const isDropTarget = this._dragKind != null;
    const seqN = this._activeCount(cp.key, 'sequence');
    const scriptN = this._activeCount(cp.key, 'script');
    const reorderOver = this._reorderKind === 'cp' && this._reorderOver?.id === cp.key
      ? this._reorderOver.pos : null;
    const isReorderSource = this._reorderKind === 'cp' && this._reorderFromId === cp.key;
    const sendTitle = !this._composerState.action
      ? 'Compose a message first'
      : !isOpen
        ? 'Connect this ChargePoint first'
        : `Send ${this._composerState.action} to ${cp.label}`;
    const toggleTitle = isOpen
      ? `Disconnect ${cp.label}`
      : `Connect ${cp.label}`;
    const toggleCls = isOpen ? 'open' : (inTransit ? 'transit' : '');
    return html`
      <div
        class="row cp-row ${isDropTarget ? 'drop-target' : ''} ${isReorderSource ? 'drag-source' : ''} ${reorderOver === 'above' ? 'drop-above' : ''} ${reorderOver === 'below' ? 'drop-below' : ''}"
        style="border-left: 3px solid ${bgFor(cp, 0.7)};"
        @dragover=${(e) => { this._onDragOverCp(e); this._onReorderOver('cp', cp.key, e); }}
        @drop=${(e) => {
          if (this._reorderKind === 'cp') this._onReorderDrop('cp', cp.key, e);
          else this._onDropOnCp(cp, e);
        }}
      >
        <div class="row-leading">
          <button
            class="row-action"
            title=${sendTitle}
            ?disabled=${!canSend}
            @click=${(e) => this._sendToCp(cp, e)}
          >▶</button>
          <button
            class="row-action toggle ${toggleCls}"
            title=${toggleTitle}
            ?disabled=${inTransit}
            @click=${(e) => { e.stopPropagation(); isOpen ? this._disconnect(cp.key) : this._connect(cp.key); }}
          >⏻</button>
        </div>
        <div class="row-body" @click=${() => this._openCp(cp.key)}>
          <span class="dot" style="color: ${isOpen ? 'var(--ok)' : fgFor(cp)};">
            ${STATE_DOT[cp.state] || '○'}
          </span>
          <span class="label" title=${cp.csmUrl || ''}>${cp.label}</span>
          <span class="badge">${cp.ocppVersion.replace('ocpp', '')}</span>
          ${seqN > 0 ? html`
            <span
              class="count-chip seq ${this._isFlashing(cp.key, 'sequence') ? 'flash' : ''}"
              title="${seqN} active sequence${seqN === 1 ? '' : 's'}"
            >▶${seqN}</span>` : ''}
          ${scriptN > 0 ? html`
            <span
              class="count-chip script ${this._isFlashing(cp.key, 'script') ? 'flash' : ''}"
              title="${scriptN} active script${scriptN === 1 ? '' : 's'}"
            >⚙${scriptN}</span>` : ''}
          <button
            class="dup"
            title="Pop out a log filtered to this ChargePoint"
            @click=${(e) => this._popOutLog(cp, e)}
          >⇗</button>
          <button
            class="dup"
            title="Duplicate ChargePoint"
            @click=${(e) => this._duplicateCp(cp, e)}
          >⧉</button>
          <button
            class="del"
            title="Delete (Ctrl-click to skip confirmation)"
            @click=${(e) => this._removeCp(cp, e)}
          >✕</button>
          <span
            class="reorder-handle"
            draggable="true"
            title="Drag to reorder ChargePoints"
            @dragstart=${(e) => this._onReorderStart('cp', cp.key, e)}
            @dragend=${() => this._onReorderEnd()}
            @click=${(e) => e.stopPropagation()}
          >↕</span>
          <span class="chev">›</span>
        </div>
      </div>
    `;
  }

  _renderSequenceRow(seq) {
    const stepCount = (seq.steps || []).length;
    const canRecord = !!this._composerState.action;
    const isDragging = this._dragKind === 'sequence' && this._draggingRefId === seq.id;
    const isReorderSource = this._reorderKind === 'sequence' && this._reorderFromId === seq.id;
    const reorderOver = this._reorderKind === 'sequence' && this._reorderOver?.id === seq.id
      ? this._reorderOver.pos : null;
    const recordTitle = canRecord
      ? `Append ${this._composerState.action} to ${seq.label}`
      : 'Compose a message first';
    return html`
      <div
        class="row seq-row ${isDragging || isReorderSource ? 'drag-source' : ''} ${reorderOver === 'above' ? 'drop-above' : ''} ${reorderOver === 'below' ? 'drop-below' : ''}"
        @dragover=${(e) => this._onReorderOver('sequence', seq.id, e)}
        @drop=${(e) => this._onReorderDrop('sequence', seq.id, e)}
      >
        <div class="row-leading">
          <span
            class="drag-handle"
            draggable="true"
            title="Drag onto a ChargePoint to run this sequence there"
            @dragstart=${(e) => this._onDragStartSeq(seq, e)}
            @dragend=${() => this._onDragEnd()}
          >⠿</span>
          <button
            class="row-action record"
            title=${recordTitle}
            ?disabled=${!canRecord}
            @click=${(e) => this._addStepToSequence(seq, e)}
          >⏺</button>
        </div>
        <div class="row-body" @click=${() => this._openSequence(seq.id)}>
          <span class="label" title=${seq.description || seq.label}>${seq.label}</span>
          <span class="badge">${stepCount} step${stepCount === 1 ? '' : 's'}</span>
          <button
            class="dup"
            title="Duplicate sequence"
            @click=${(e) => this._duplicateSequence(seq, e)}
          >⧉</button>
          <button
            class="del"
            title="Delete (Ctrl-click to skip confirmation)"
            @click=${(e) => this._deleteSequence(seq, e)}
          >✕</button>
          <span
            class="reorder-handle"
            draggable="true"
            title="Drag to reorder sequences"
            @dragstart=${(e) => this._onReorderStart('sequence', seq.id, e)}
            @dragend=${() => this._onReorderEnd()}
            @click=${(e) => e.stopPropagation()}
          >↕</span>
          <span class="chev">›</span>
        </div>
      </div>
    `;
  }

  _renderScriptRow(script) {
    const isDragging = this._dragKind === 'script' && this._draggingRefId === script.id;
    const isReorderSource = this._reorderKind === 'script' && this._reorderFromId === script.id;
    const reorderOver = this._reorderKind === 'script' && this._reorderOver?.id === script.id
      ? this._reorderOver.pos : null;
    const paramN = (script.params || []).length;
    const canRecord = !!this._composerState.action;
    const recordTitle = canRecord
      ? `Append cp.sendMessage('${this._composerState.action}', …) to ${script.label}`
      : 'Compose a message first';
    return html`
      <div
        class="row script-row ${isDragging || isReorderSource ? 'drag-source' : ''} ${reorderOver === 'above' ? 'drop-above' : ''} ${reorderOver === 'below' ? 'drop-below' : ''}"
        @dragover=${(e) => this._onReorderOver('script', script.id, e)}
        @drop=${(e) => this._onReorderDrop('script', script.id, e)}
      >
        <div class="row-leading">
          <span
            class="drag-handle"
            draggable="true"
            title="Drag onto a ChargePoint to activate this script there"
            @dragstart=${(e) => this._onDragStartScript(script, e)}
            @dragend=${() => this._onDragEnd()}
          >⠿</span>
          <button
            class="row-action record"
            title=${recordTitle}
            ?disabled=${!canRecord}
            @click=${(e) => this._appendToScript(script, e)}
          >⏺</button>
        </div>
        <div class="row-body" @click=${() => this._openScript(script.id)}>
          <span class="label" title=${script.description || script.label}>${script.label}</span>
          ${paramN > 0 ? html`<span class="badge">${paramN} param${paramN === 1 ? '' : 's'}</span>` : ''}
          <button
            class="dup"
            title="Duplicate script"
            @click=${(e) => this._duplicateScript(script, e)}
          >⧉</button>
          <button
            class="del"
            title="Delete (Ctrl-click to skip confirmation)"
            @click=${(e) => this._deleteScript(script, e)}
          >✕</button>
          <span
            class="reorder-handle"
            draggable="true"
            title="Drag to reorder scripts"
            @dragstart=${(e) => this._onReorderStart('script', script.id, e)}
            @dragend=${() => this._onReorderEnd()}
            @click=${(e) => e.stopPropagation()}
          >↕</span>
          <span class="chev">›</span>
        </div>
      </div>
    `;
  }

  // ---------------- CP detail ----------------

  _renderCpDetail() {
    const cp = this.cps.find((c) => c.key ===this._selectedCpKey);
    if (!cp) { queueMicrotask(() => this._back()); return html``; }
    const cls = (cp.state || 'idle').toLowerCase();
    return html`
      <div class="topbar">
        <button class="back" @click=${this._back} title="Back to list">‹</button>
        <h2>ChargePoint</h2>
        <span class="crumb">· ${cp.label}</span>
        <span class="spacer"></span>
        <span class="status-pill ${cls}">${cp.state}</span>
      </div>
      <div class="body cp-detail">
        <div class="field-grid">
          <label>Label</label>
          <span class="label-row">
            <input
              class="label-input"
              .value=${cp.label}
              @change=${(e) => this._updateCp(cp.key, { label: e.target.value })}
            />
            <input
              type="range"
              class="hue-slider"
              min="0" max="359"
              .value=${String(cp.hue ?? 0)}
              title="Pick a hue for this ChargePoint"
              @input=${(e) => this._updateCp(cp.key, { hue: Number(e.target.value) })}
              style="--thumb: ${fgFor(cp)};"
            />
          </span>
          <label>Identifier</label>
          <input
            placeholder="CP_001 (the OCPP-level identifier / serial)"
            .value=${cp.id || ''}
            @change=${(e) => this._updateCp(cp.key, { id: e.target.value })}
          />
          <label>CentralSystem URL</label>
          <span class="url-col">
            <input
              class="url"
              placeholder="ws://csms.example.com/{{ cp.id }}"
              .value=${cp.csmUrl || ''}
              @change=${(e) => this._updateCp(cp.key, { csmUrl: e.target.value })}
            />
            ${this._mixedContentWarning(cp)}
          </span>
          <label>OCPP Version</label>
          <select @change=${(e) => this._updateCp(cp.key, { ocppVersion: e.target.value })}>
            ${VERSIONS.map((v) => html`
              <option value=${v} ?selected=${cp.ocppVersion === v}>${VERSION_LABEL[v]}</option>
            `)}
          </select>
          <label>Description</label>
          <textarea
            class="desc"
            rows="2"
            placeholder="Notes about this ChargePoint"
            .value=${cp.description || ''}
            @change=${(e) => this._updateCp(cp.key, { description: e.target.value })}
          ></textarea>
        </div>
        ${cp.error ? html`<div class="err">${cp.error}</div>` : ''}
        <div class="actions">
          ${cp.state === ConnState.Open
            ? html`<button @click=${() => this._disconnect(cp.key)}>Disconnect</button>`
            : html`<button class="primary" @click=${() => this._connect(cp.key)}>Connect</button>`}
          <span class="spacer"></span>
          <button class="danger" @click=${(e) => this._removeCp(cp, e)}>Delete</button>
        </div>
        ${this._renderCpParams(cp)}
        ${this._renderActiveList(cp)}
      </div>
    `;
  }

  // Browsers block ws:// (insecure WebSocket) when the page itself is loaded
  // over https:. There's no JS-side workaround — the constructor either
  // throws SecurityError or the connection silently fails. When we detect
  // this, surface the cause + actionable options so the user isn't left
  // staring at an opaque "websocket error".
  _mixedContentWarning(cp) {
    const url = (cp.csmUrl || '').trim();
    if (!url) return '';
    const isInsecureWs = /^ws:\/\//i.test(url);
    const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';
    if (!(isInsecureWs && pageIsHttps)) return '';
    return html`
      <div class="mixed-content-warn" title="Browsers block ws:// connections from https: pages.">
        ⚠ Browsers won't open ws:// from this https: page (mixed content).
        Options: serve the simulator over http (e.g. <code>npx serve .</code>),
        use a wss:// URL, or allow "Insecure content" for this site in your
        browser's site settings.
      </div>
    `;
  }

  _renderCpParams(cp) {
    const params = cp.params || [];
    const setParams = (next) => this._updateCp(cp.key, { params: next });
    return html`
      <div class="section-head" style="margin-top: 16px;">
        <span>Parameters</span>
        <span class="line"></span>
        <button class="ghost" @click=${() => setParams([...params, { name: nextParamName(params), value: '' }])}>
          + Add param
        </button>
      </div>
      ${params.length === 0
        ? html`<div class="empty">Reference these from the composer with <code>{{ cp.params.NAME }}</code>.</div>`
        : html`<ul class="param-list">
            ${params.map((p, i) => html`
              <li>
                <input
                  class="pname"
                  placeholder="name"
                  .value=${p.name}
                  @change=${(e) => {
                    const next = params.slice();
                    next[i] = { ...next[i], name: e.target.value };
                    setParams(next);
                  }}
                />
                <input
                  class="pdefault"
                  placeholder="value (JSON or string)"
                  .value=${valueToInput(p.value)}
                  @change=${(e) => {
                    const next = params.slice();
                    next[i] = { ...next[i], value: parseInputValue(e.target.value) };
                    setParams(next);
                  }}
                />
                <button class="ghost danger-hover" title="Remove param" @click=${() => {
                  const next = params.slice();
                  next.splice(i, 1);
                  setParams(next);
                }}>✕</button>
              </li>
            `)}
          </ul>`}
    `;
  }

  _renderActiveList(cp) {
    const items = this._activeFor(cp.key);
    return html`
      <div class="section-head" style="margin-top: 16px;">Active</div>
      ${items.length === 0
        ? html`<div class="empty">Drag a sequence or script onto this ChargePoint to activate it.</div>`
        : html`<ul class="active-list">
            ${items.map((it) => html`
              <li class="state-${it.state}">
                <div class="active-row">
                  <span class="kind-glyph kind-${it.kind}" title=${it.kind}>${it.kind === 'sequence' ? '▶' : '⚙'}</span>
                  <span class="name" title=${it.lastError || ''}>${it.name}</span>
                  <span class="badge">${it.state}</span>
                  ${it.state === 'running'
                    ? html`<button class="ghost" title="Stop (keeps in list)" @click=${() => it.stop()}>■</button>`
                    : html`<button class="ghost" title="Restart from the top" @click=${() => it.restart?.()}>↻</button>`}
                  <button class="ghost danger-hover" title="Remove" @click=${() => it.remove()}>✕</button>
                </div>
                ${it.waiting ? this._renderWaitingRow(it) : ''}
              </li>
            `)}
          </ul>`}
    `;
  }

  _renderWaitingRow(it) {
    const w = it.waiting;
    const label = w.step?.kind === 'pause'
      ? 'pause'
      : (w.step?.action || 'step');
    const totalS = Math.round(w.ms / 100) / 10;
    const remainingS = this._waitingRemainingSeconds(w);
    return html`
      <div class="waiting-row">
        <span class="waiting-meta">
          Step ${w.stepIndex + 1} · ${label} —
          <strong>${remainingS}s</strong> <span class="muted">/ ${totalS}s</span>
        </span>
        <span class="spacer"></span>
        <button class="ghost" title="Skip the wait — run this step now" @click=${() => it.skipDelay?.()}>Skip Delay</button>
      </div>
    `;
  }

  // Show a countdown of the remaining wait. Called every render; the
  // periodic re-render is driven by _ensureWaitTicker below.
  _waitingRemainingSeconds(w) {
    const elapsed = Date.now() - (w.startedAt || Date.now());
    const remaining = Math.max(0, w.ms - elapsed);
    return Math.ceil(remaining / 1000);
  }

  // Whenever ANY active item is waiting, refresh the render every 250ms so
  // the countdown numbers actually count down. Stops itself when nothing is
  // waiting anymore.
  _ensureWaitTicker() {
    const anyWaiting = [...this._activeByCp.values()]
      .flat()
      .some((it) => it.waiting);
    if (anyWaiting && !this._waitTicker) {
      this._waitTicker = setInterval(() => this.requestUpdate(), 250);
    } else if (!anyWaiting && this._waitTicker) {
      clearInterval(this._waitTicker);
      this._waitTicker = null;
    }
  }

  // ---------------- Script detail ----------------

  _renderScriptDetail() {
    const script = this.scripts.find((s) => s.id === this._selectedScriptId);
    if (!script) { queueMicrotask(() => this._back()); return html``; }
    const params = script.params || [];
    return html`
      <div class="topbar">
        <button class="back" @click=${this._back} title="Back to list">‹</button>
        <h2>Script</h2>
        <span class="crumb">· ${script.label}</span>
        <span class="spacer"></span>
        ${script.builtinId ? html`
          <button
            class="ghost"
            title="Restore label, description, params, and code from the canonical definition (your edits will be lost)"
            @click=${() => this._resetBuiltin(script)}
          >Reset to built-in</button>` : ''}
        <button class="danger ghost" @click=${(e) => this._deleteScript(script, e)}>Delete</button>
      </div>
      <div class="body">
        <div class="seq-meta">
          <label>Label</label>
          <input .value=${script.label} @change=${(e) => this._patchScript(script, { label: e.target.value })} />
          <label>Description</label>
          <textarea
            class="desc"
            rows="2"
            placeholder="What this script does"
            .value=${script.description || ''}
            @change=${(e) => this._patchScript(script, { description: e.target.value })}
          ></textarea>
        </div>
        <div class="section-head">
          <span>Parameters</span>
          <span class="line"></span>
          <button class="ghost" @click=${() => this._patchScript(script, {
            params: [...params, { name: nextParamName(params), default: '', description: '' }],
          })}>+ Add param</button>
        </div>
        ${params.length === 0
          ? html`<div class="empty">No parameters. Use <code>script.params.X</code> inside the script body.</div>`
          : html`<ul class="param-list">
              ${params.map((p, i) => html`
                <li>
                  <input
                    class="pname"
                    placeholder="name"
                    .value=${p.name}
                    @change=${(e) => {
                      const next = params.slice();
                      next[i] = { ...next[i], name: e.target.value };
                      this._patchScript(script, { params: next });
                    }}
                  />
                  <input
                    class="pdefault"
                    placeholder="default value"
                    .value=${p.default || ''}
                    @change=${(e) => {
                      const next = params.slice();
                      next[i] = { ...next[i], default: e.target.value };
                      this._patchScript(script, { params: next });
                    }}
                  />
                  <button class="ghost danger-hover" title="Remove param" @click=${() => {
                    const next = params.slice();
                    next.splice(i, 1);
                    this._patchScript(script, { params: next });
                  }}>✕</button>
                </li>
              `)}
            </ul>`}
        <div class="section-head" style="margin-top: 12px;">
          <span>Code</span>
          <span class="line"></span>
          <span class="ai-dropdown">
            <button
              class="ghost"
              title="Open this script in an AI chat for review/explanation"
              @click=${(e) => this._toggleAiMenu(e)}
            >🤖 Prompt AI ▾</button>
            ${this._aiMenuOpen ? html`
              <div class="ai-menu" @click=${(e) => e.stopPropagation()}>
                ${AI_PROVIDERS.map((p) => html`
                  <button
                    class="ai-option"
                    @click=${() => this._promptAi(p, script)}
                  >${p.label}</button>
                `)}
              </div>
            ` : ''}
          </span>
        </div>
        <textarea
          class="code"
          spellcheck="false"
          .value=${script.code || ''}
          @change=${(e) => this._patchScript(script, { code: e.target.value })}
        ></textarea>
        <button
          class="add-btn"
          title=${this._composerState.action
            ? `Append cp.sendMessage('${this._composerState.action}', …) to the script`
            : 'Compose a message first'}
          ?disabled=${!this._composerState.action}
          @click=${async (e) => {
            await this._appendToScript(script, e);
            await this.updateComplete;
            const ta = this.renderRoot.querySelector('textarea.code');
            if (ta) ta.scrollTop = ta.scrollHeight;
          }}
        >⏺ Append cp.sendMessage(…) from composer</button>
      </div>
    `;
  }

  // ---------------- Sequence detail ----------------

  _renderSequenceDetail() {
    const seq = this.sequences.find((s) => s.id === this._selectedSequenceId);
    if (!seq) {
      // Safety net: never mutate state during render — schedule the navigation.
      queueMicrotask(() => this._back());
      return html``;
    }
    const steps = seq.steps || [];
    return html`
      <div class="topbar">
        <button class="back" @click=${this._back} title="Back to list">‹</button>
        <h2>Sequence</h2>
        <span class="crumb">· ${seq.label}</span>
        <span class="spacer"></span>
        <button class="danger ghost" @click=${(e) => this._deleteSequence(seq, e)}>Delete</button>
      </div>
      <div class="body">
        <div class="seq-meta">
          <label>Label</label>
          <input .value=${seq.label} @change=${(e) => this._renameSequence(seq, e.target.value)} />
          <label>Description</label>
          <textarea
            class="desc"
            rows="2"
            placeholder="What this sequence does"
            .value=${seq.description || ''}
            @change=${(e) => this._setSequenceDescription(seq, e.target.value)}
          ></textarea>
        </div>
        <div class="section-head">Steps</div>
        ${steps.length === 0
          ? html`<div class="empty">No steps yet.</div>`
          : html`
              <ul class="step-list">
                ${steps.map((s, i) => this._renderStep(s, i))}
              </ul>
            `}
        <button
          class="add-btn"
          title=${this._composerState.action
            ? `Append ${this._composerState.action} as a new step`
            : 'Compose a message first'}
          ?disabled=${!this._composerState.action}
          @click=${async (e) => {
            await this._addStepToSequence(seq, e);
            // Reveal the freshly-added step at the bottom.
            await this.updateComplete;
            const body = this.renderRoot.querySelector('.body');
            if (body) body.scrollTop = body.scrollHeight;
          }}
        >⇥ Add step from composer</button>
      </div>
    `;
  }

  _renderStep(step, i) {
    const seq = this.sequences.find((s) => s.id === this._selectedSequenceId);
    if (!seq) return html``;
    const isSend = step.kind === 'send';
    const isDragSource = this._stepDragIndex === i;
    const dragOver = this._stepDragOver?.index === i ? this._stepDragOver.pos : null;
    const classes = [
      `kind-${step.kind}`,
      isDragSource ? 'drag-source' : '',
      dragOver === 'above' ? 'drop-above' : '',
      dragOver === 'below' ? 'drop-below' : '',
    ].filter(Boolean).join(' ');

    // Import (⇥) is only enabled when the composer is editing the SAME action
    // as this step — protects against accidentally overwriting one message
    // type with the payload of a different one.
    const canImport = isSend
      && this._composerState.action
      && this._composerState.action === step.action;
    const importTitle = !isSend
      ? ''
      : !this._composerState.action
        ? 'Compose a message first'
        : this._composerState.action !== step.action
          ? `Composer is editing ${this._composerState.action}, not ${step.action}`
          : `Import composer → step (overwrite from the composer)`;

    return html`
      <li
        class=${classes}
        @dragover=${(e) => this._onStepDragOver(i, e)}
        @drop=${(e) => this._onStepDrop(seq, i, e)}
      >
        ${isSend ? html`
          <span class="step-leading">
            <button
              class="step-load"
              title="Export step → composer (load this step into the composer)"
              @click=${(e) => this._insertStepInComposer(step, e)}
            >⇤</button>
            <button
              class="step-save"
              title=${importTitle}
              ?disabled=${!canImport}
              @click=${(e) => this._updateStepFromComposer(seq, i, e)}
            >⇥</button>
          </span>
        ` : html`<span class="leading-placeholder"></span>`}
        <span class="idx">${i + 1}.</span>
        <span class="name">
          <span class="action-name">${isSend ? step.action : 'Pause'}</span>
          ${isSend ? html`<span class="meta">${(step.sourceVersion || '').replace('ocpp', '')}</span>` : ''}
          <input
            class="comment"
            type="text"
            placeholder="comment…"
            .value=${step.comment || ''}
            @change=${(e) => this._updateStep(seq, i, { comment: e.target.value })}
          />
        </span>
        <span class="delay" title=${isSend ? 'Wait this many seconds before sending' : 'Pause duration'}>
          <input
            type="number" min="0" step="0.1"
            .value=${String(isSend ? (step.delaySeconds ?? 1) : (step.seconds ?? 1))}
            @change=${(e) => this._updateStep(seq, i, isSend
              ? { delaySeconds: Number(e.target.value) }
              : { seconds: Number(e.target.value) })}
          />s
        </span>
        <button
          class="step-del"
          title="Delete (Ctrl-click skips confirm)"
          @click=${(e) => this._deleteStep(seq, i, e)}
        >✕</button>
        <span
          class="reorder-handle"
          draggable="true"
          title="Drag to reorder steps"
          @dragstart=${(e) => this._onStepDragStart(i, e)}
          @dragend=${() => this._onStepDragEnd()}
        >↕</span>
      </li>
    `;
  }
}

customElements.define('workbench-panel', WorkbenchPanel);
