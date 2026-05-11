import { LitElement, html, css } from './lit.js';
import { connections } from '../state/connections.js';
import { composer } from '../state/composer.js';
import { VERSIONS, VERSION_LABEL } from '../ocpp/versions.js';
import { ACTION_INDEX, FUNCTION_BLOCKS } from '../ocpp/function-blocks.js';
import { prefs } from '../state/persistence.js';
import './function-block-nav.js';
import './action-list.js';
import './message-form.js';
import './workbench-panel.js';
import './raw-log.js';

class OcppApp extends LitElement {
  static styles = css`
    /* Grid layout
       ┌───────────────────────────────────┬──────────┐
       │ topbar  topbar  topbar            │  bench   │   row 1: 36px
       ├──────────┬──────────┬─────────────┤          │
       │ blocks   │ actions  │ message     │  bench   │   row 2: 1fr
       ├──────────┴──────────┴─────────────┤          │
       │ log                               │  bench   │   row 3: auto
       └───────────────────────────────────┴──────────┘
        220       300        minmax(360,1fr) 640
    */
    :host {
      display: grid;
      grid-template-columns: 220px 300px minmax(360px, 1fr) 640px;
      grid-template-rows: 36px minmax(0, 1fr) 220px;
      grid-template-areas:
        "topbar  topbar  topbar  bench"
        "blocks  actions message bench"
        "log     log     log     bench";
      height: 100vh;
      overflow: hidden;
      color: var(--text);
    }

    .messages-topbar {
      grid-area: topbar;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      box-sizing: border-box;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      border-right: 1px solid var(--border);
      font-family: var(--mono);
      overflow: hidden;
    }
    .messages-topbar h2 {
      margin: 0;
      font-size: 11px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }
    .messages-topbar .crumb {
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .messages-topbar .version-pill {
      display: inline-block;
      background: var(--bg);
      color: var(--muted);
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 9px;
      margin-left: 4px;
    }
    .messages-topbar .spacer { flex: 1; }
    .messages-topbar button.icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
      line-height: 1;
    }
    .messages-topbar button.icon-btn:hover { background: var(--surface-3); color: var(--text); border-color: var(--border); }
    .messages-topbar button.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .chip {
      display: inline-flex;
      align-items: center;
      padding: 1px 8px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      font-size: 10px;
      transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }
    .chip:hover { border-color: var(--border-strong); color: var(--text); }
    .chip.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }

    .blocks-pane,
    .action-pane,
    .message-pane {
      overflow-y: auto;
      min-width: 0;
      min-height: 0;
      background: var(--surface);
      padding: 10px;
      box-sizing: border-box;
    }
    .blocks-pane { grid-area: blocks; border-right: 1px solid var(--border); }
    .action-pane { grid-area: actions; border-right: 1px solid var(--border); }
    .message-pane { grid-area: message; padding: 16px; background: var(--bg); }

    .workbench-pane {
      grid-area: bench;
      border-left: 1px solid var(--border);
      overflow: hidden;
      min-height: 0;
    }

    raw-log {
      grid-area: log;
      border-right: 1px solid var(--border);
      min-height: 0;
    }
  `;

  static properties = {
    _list: { state: true },
    _block: { state: true },
    _action: { state: true },
    _filterVersions: { state: true },
    _initialPayload: { state: true },
  };

  constructor() {
    super();
    this._list = connections.get().list;
    this._block = 'B';
    this._action = null;
    this._filterVersions = new Set(prefs.get('version-filter', VERSIONS));
    if (this._filterVersions.size === 0) this._filterVersions = new Set(VERSIONS);
    this._unsubConn = connections.subscribe((s) => { this._list = s.list; });
    this._onBlockChange = this._onBlockChange.bind(this);
    this._onActionEdit = this._onActionEdit.bind(this);
    this._onComposerLoad = this._onComposerLoad.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('block-change', this._onBlockChange);
    this.addEventListener('edit-action', this._onActionEdit);
    this.addEventListener('composer-load', this._onComposerLoad);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('block-change', this._onBlockChange);
    this.removeEventListener('edit-action', this._onActionEdit);
    this.removeEventListener('composer-load', this._onComposerLoad);
    this._unsubConn?.();
  }

  _toggleVersion(v) {
    const next = new Set(this._filterVersions);
    if (next.has(v)) { if (next.size > 1) next.delete(v); }
    else next.add(v);
    this._filterVersions = next;
    prefs.set('version-filter', [...next]);
    if (this._action) {
      const meta = ACTION_INDEX[this._action];
      if (!meta || !meta.versions.some((v2) => next.has(v2))) this._action = null;
    }
  }

  _composeVersion() {
    if (!this._action) {
      for (const v of [...VERSIONS].reverse()) if (this._filterVersions.has(v)) return v;
      return 'ocpp2.1';
    }
    const meta = ACTION_INDEX[this._action];
    if (!meta) return 'ocpp2.1';
    for (const v of [...meta.versions].reverse()) if (this._filterVersions.has(v)) return v;
    return meta.versions.at(-1);
  }

  _onBlockChange(e) {
    this._block = e.detail.block;
    this._action = null;
    this._initialPayload = null;
    composer.set({ action: null, version: this._composeVersion(), payload: {}, valid: null });
  }

  _onActionEdit(e) {
    this._initialPayload = null;
    this._action = e.detail.action;
  }

  // Load a sequence step's content into the composer. Coming from
  // workbench-panel via a bubbled custom event so the composer's state
  // can be entirely managed here.
  _onComposerLoad(e) {
    const { action, version, payload } = e.detail;
    const meta = ACTION_INDEX[action];
    if (meta) this._block = meta.block;
    if (version && !this._filterVersions.has(version)) {
      this._filterVersions = new Set([...this._filterVersions, version]);
      prefs.set('version-filter', [...this._filterVersions]);
    }
    this._initialPayload = payload || {};
    this._action = action;
  }

  _composerRandomize() { this.renderRoot.querySelector('message-form')?.randomize(); }

  // Copy the composer's current payload as formatted JSON. Reads from the
  // composer store (the message-form keeps it up to date as the user edits)
  // and falls back to the legacy clipboard API when the modern one isn't
  // available (older browsers / insecure contexts). The clicked button
  // flashes "Copied" briefly as confirmation.
  async _composerCopy(ev) {
    const payload = composer.get().payload || {};
    const text = JSON.stringify(payload, null, 2);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch { ok = false; }
    const btn = ev?.currentTarget;
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = ok ? '✓' : '✕';
      setTimeout(() => { btn.textContent = orig; }, 900);
    }
  }

  render() {
    const block = FUNCTION_BLOCKS.find((b) => b.letter === this._block);
    const crumbBits = [];
    if (block) crumbBits.push(`${block.letter} ${block.name}`);
    if (this._action) crumbBits.push(this._action);
    return html`
      <div class="messages-topbar">
        <h2>Messages</h2>
        ${VERSIONS.map((v) => html`
          <span
            class="chip ${this._filterVersions.has(v) ? 'on' : ''}"
            title="Toggle ${VERSION_LABEL[v]} filter"
            @click=${() => this._toggleVersion(v)}
          >${VERSION_LABEL[v]}</span>
        `)}
        <span class="spacer"></span>
        ${crumbBits.length ? html`
          <span class="crumb">${crumbBits.join(' · ')}
            ${this._action ? html`<span class="version-pill">${this._composeVersion().replace('ocpp', '')}</span>` : ''}
          </span>
        ` : ''}
        <button
          class="icon-btn"
          title="Randomize composer payload"
          ?disabled=${!this._action}
          @click=${this._composerRandomize}
        >🎲</button>
        <button
          class="icon-btn"
          title="Copy the composer payload as JSON (formatted)"
          ?disabled=${!this._action}
          @click=${this._composerCopy}
        >📋</button>
      </div>

      <div class="blocks-pane">
        <function-block-nav
          .selected=${this._block}
          .filterVersions=${this._filterVersions}
        ></function-block-nav>
      </div>

      <div class="action-pane">
        <action-list
          .block=${this._block}
          .selected=${this._action}
          .filterVersions=${this._filterVersions}
        ></action-list>
      </div>

      <div class="message-pane">
        <message-form
          .action=${this._action}
          .version=${this._composeVersion()}
          .initialPayload=${this._initialPayload}
        ></message-form>
      </div>

      <div class="workbench-pane">
        <workbench-panel
          .cps=${this._list}
          .filterVersions=${this._filterVersions}
        ></workbench-panel>
      </div>

      <raw-log></raw-log>
    `;
  }
}

customElements.define('ocpp-app', OcppApp);
