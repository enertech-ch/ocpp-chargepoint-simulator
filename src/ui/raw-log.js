import { LitElement, html, css, repeat } from './lit.js';
import { connections } from '../state/connections.js';
import { bgFor, fgFor } from './connection-hue.js';
import { formStyles } from './shared-styles.js';

const MAX_DISPLAY = 1000;

// In standalone (pop-out) mode, accept ?cp=<key> to solo-filter the log to
// that single ChargePoint. Triggered by the per-CP "pop out log" button.
function soloKeyFromUrl() {
  if (typeof location === 'undefined') return null;
  try {
    return new URLSearchParams(location.search).get('cp');
  } catch { return null; }
}

class RawLog extends LitElement {
  static styles = [formStyles, css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--surface);
      border-top: 1px solid var(--border);
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    :host([standalone]) { height: 100vh; border-top: none; }

    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 11px;
      user-select: none;
      min-height: 32px;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .title { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; flex-shrink: 0; }
    .spacer { flex: 1; }
    .bar button { font-size: 11px; padding: 4px 10px; }

    /* Per-CP filter chips. Click toggles visibility; off-state is dimmed
       with a strike-through and grayed text. */
    .filters {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 10px;
      font-family: var(--mono);
      cursor: pointer;
      user-select: none;
      transition: opacity 0.12s ease, background 0.12s ease;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .filter-chip .swatch {
      width: 8px; height: 8px; border-radius: 50%;
      flex-shrink: 0;
    }
    .filter-chip.off { opacity: 0.35; text-decoration: line-through; }
    .filter-chip:hover { background: var(--surface-2); }

    .log {
      flex: 1;
      overflow-y: scroll;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.5;
    }
    .row {
      padding: 2px 12px;
      display: flex;
      gap: 8px;
      align-items: flex-start;
      background-color: var(--cp-tint, transparent);
    }
    /* Alternating row stripe — overlay a darker layer on every second row
       so it's easier to follow long frames that wrap to multiple lines.
       Composes over the per-CP tint set inline. */
    .row:nth-child(even) {
      box-shadow: inset 0 0 0 999px rgba(0, 0, 0, 0.18);
    }
    .row .ts { color: var(--muted); flex-shrink: 0; }
    .row .dir {
      width: 16px;
      flex-shrink: 0;
      font-weight: 900;
      font-size: 13px;
      line-height: 1;
      text-align: center;
    }
    .row .dir.in { color: var(--ok); }
    .row .dir.out { color: var(--accent); }
    .row .dir.sys, .row .dir.script { color: var(--muted); }
    /* System lines (connection lifecycle) and script.info lines render
       dimmer + italic so they read as "out-of-band" notes vs. OCPP frames. */
    .row.sys, .row.script { color: var(--muted); font-style: italic; }
    /* Level-driven overrides — warn (yellow) and error (red) win over the
       default muted styling for sys/script rows AND apply equally to
       elevated-level entries on any kind of row. */
    .row.level-warn, .row.level-warn .dir { color: var(--warn); font-style: normal; }
    .row.level-error, .row.level-error .dir { color: var(--err); font-style: normal; font-weight: 600; }
    .row .conn { min-width: 80px; max-width: 160px; font-weight: 600; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .data {
      flex: 1;
      min-width: 0;
      /* pre-wrap keeps embedded whitespace but lets long frames wrap so
         nothing gets clipped or hidden behind the right edge. */
      white-space: pre-wrap;
      word-break: break-all;
    }
    /* "{ }" button on the right edge of frames that look like JSON; opens
       a Blob URL with type application/json in a new tab so the browser
       renders it with its built-in JSON viewer. */
    .row .pretty {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 0 6px;
      border-radius: 3px;
      font-size: 11px;
      line-height: 1.5;
      font-family: var(--mono);
    }
    .row .pretty:hover { background: var(--surface-2); border-color: var(--border); color: var(--accent); }
  `];

  static properties = {
    standalone: { type: Boolean, reflect: true },
    _entries: { state: true },
    _hidden: { state: true },
    _cps: { state: true },
    _soloKey: { state: true },     // standalone: locked solo CP from ?cp= URL param
  };

  constructor() {
    super();
    // NOTE: `standalone` is intentionally NOT initialised here — assigning it
    // in the constructor can race the attribute-driven init (Lit reads the
    // `standalone` HTML attribute into the property as part of element setup
    // and an explicit assignment in the constructor body can clobber it).
    this._entries = [];
    this._hidden = new Set();
    this._cps = [];
    this._soloKey = null;
    this._userTouchedFilter = false;
  }

  // Re-derive _hidden from the current _cps + _soloKey. Called whenever the
  // CP list changes so a freshly-arrived CP can't slip past the solo filter.
  _applySoloFilter() {
    if (!this._soloKey) return;
    this._hidden = new Set(
      this._cps.filter((c) => c.key !== this._soloKey).map((c) => c.key),
    );
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.standalone) {
      this._soloKey = soloKeyFromUrl();
      if (!connections.port) connections.init();
    }
    this._unsubLog = connections.onLog((entry) => {
      if (entry.__hydrate) this._entries = entry.log.slice(-MAX_DISPLAY);
      else this._append(entry);
    });
    this._unsubConn = connections.subscribe((s) => {
      // Standalone: the filter is LOCAL to this window. We keep re-deriving
      // it from _soloKey on every cps update (so cross-tab CP additions still
      // get hidden), UNTIL the user manually toggles a chip — after that
      // they're driving and we leave their selection alone.
      this._cps = s.list;
      if (!this.standalone) {
        this._hidden = s.hiddenLogIds;
      } else if (!this._userTouchedFilter) {
        this._applySoloFilter();
      }
      this._updateWindowTitle();
    });
    const snap = connections.get();
    this._cps = snap.list;
    if (this.standalone) {
      this._applySoloFilter();
    } else {
      this._hidden = snap.hiddenLogIds;
    }
    this._updateWindowTitle();
    connections.requestHydrate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubLog?.();
    this._unsubConn?.();
  }

  _updateWindowTitle() {
    if (!this.standalone) return;
    try {
      const visible = this._cps.filter((c) => !this._hidden.has(c.key));
      if (visible.length === 1) document.title = `Log · ${visible[0].label}`;
      else document.title = 'OCPP Log';
    } catch { /* ignore */ }
  }

  // Toggle visibility for a CP. Standalone: local state — once the user has
  // touched a chip we stop auto-re-deriving from _soloKey so we don't undo
  // their choice on the next cps update. Embedded: writes through to
  // connections so the change persists & syncs across tabs.
  _toggleVisible(key) {
    if (this.standalone) {
      const next = new Set(this._hidden);
      if (next.has(key)) next.delete(key); else next.add(key);
      this._hidden = next;
      this._userTouchedFilter = true;
      this._updateWindowTitle();
    } else {
      connections.toggleLogVisible(key);
    }
  }

  _showAllLocal() {
    if (this.standalone) {
      this._hidden = new Set();
      this._userTouchedFilter = true;
      this._updateWindowTitle();
    } else {
      for (const key of [...this._hidden]) connections.toggleLogVisible(key);
    }
  }

  _append(entry) {
    const next = this._entries.length >= MAX_DISPLAY
      ? this._entries.slice(-MAX_DISPLAY + 1)
      : this._entries.slice();
    next.push(entry);
    this._entries = next;
    queueMicrotask(() => {
      const el = this.renderRoot?.querySelector('.log');
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  _clear() { this._entries = []; }
  _detach() { window.open('log.html', 'ocpp-log', 'width=900,height=600'); }

  // Open a single log entry's parsed payload in a new tab as a Blob URL
  // tagged application/json. Chromium/Firefox render with their built-in
  // JSON viewer (collapse/expand, syntax-highlighted). Safari falls back
  // to a plain-text view, which is still readable.
  _openPretty(entry) {
    if (!entry?.parsed) return;
    const text = JSON.stringify(entry.parsed, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // Revoke a minute later — long enough for the viewer to finish loading
    // even on slow tabs, short enough to avoid leaking forever.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  _cpByKey(key) { return this._cps.find((c) => c.key === key); }

  _filtered() {
    if (!this._hidden || this._hidden.size === 0) return this._entries;
    return this._entries.filter((e) => !this._hidden.has(e.connId));
  }

  _renderFilters() {
    // In a solo pop-out the filter is intentional & locked to one CP — the
    // chips would just be noise. Skip them; the title still says which CP
    // this window is following.
    if (this._soloKey) return '';
    if (this._cps.length === 0) return '';
    return html`
      <span class="filters">
        ${this._cps.map((cp) => {
          const off = this._hidden.has(cp.key);
          return html`
            <span
              class="filter-chip ${off ? 'off' : ''}"
              title="${off ? 'Show' : 'Hide'} ${cp.label} in the log"
              @click=${() => this._toggleVisible(cp.key)}
            >
              <span class="swatch" style="background: ${fgFor(cp)}"></span>
              ${cp.label}
            </span>
          `;
        })}
      </span>
    `;
  }

  render() {
    const filtered = this._filtered();
    const hiddenCount = this._entries.length - filtered.length;
    return html`
      <div class="bar">
        <span class="title">
          Log · ${filtered.length}${hiddenCount ? html`<span style="color: var(--muted); font-weight: normal;"> (+${hiddenCount} hidden)</span>` : ''}
        </span>
        ${this._renderFilters()}
        <span class="spacer"></span>
        ${this._hidden.size > 0 && !this._soloKey
          ? html`<button class="ghost" @click=${this._showAllLocal}>Show all</button>`
          : ''}
        <button class="ghost" @click=${this._clear}>Clear</button>
        ${!this.standalone
          ? html`<button class="ghost" @click=${this._detach}>⇗ Pop out</button>`
          : ''}
      </div>
      <div class="log">
        ${repeat(filtered, (e, i) => i, (e) => {
          const cp = this._cpByKey(e.connId);
          const glyph = e.dir === 'in' ? '←'
            : e.dir === 'out' ? '→'
            : e.dir === 'script' ? '»'
            : '·';
          const dirCls = e.dir === 'sys' || e.dir === 'script' ? e.dir : '';
          const levelCls = e.level && e.level !== 'info' ? `level-${e.level}` : '';
          const cls = [dirCls, levelCls].filter(Boolean).join(' ');
          // Only OCPP frames have a parseable JSON payload.
          const canPretty = !!e.parsed;
          return html`
            <div class="row ${cls}" style="--cp-tint: ${bgFor(cp, 0.08)};">
              <span class="ts">${new Date(e.ts).toISOString().slice(11, 23)}</span>
              <span class="conn" style="color: ${fgFor(cp)}">${cp ? cp.label : e.connId.slice(-4)}</span>
              <span class="dir ${e.dir}">${glyph}</span>
              <span class="data">${e.data}</span>
              ${canPretty
                ? html`<button class="pretty" title="Open this frame as formatted JSON in a new tab" @click=${() => this._openPretty(e)}>{ }</button>`
                : ''}
            </div>
          `;
        })}
      </div>
    `;
  }
}

customElements.define('raw-log', RawLog);
