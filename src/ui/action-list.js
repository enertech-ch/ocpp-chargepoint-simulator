import { LitElement, html, css } from './lit.js';
import { formStyles } from './shared-styles.js';
import { FREQUENT_ACTIONS } from '../ocpp/frequent-actions.js';
import { FUNCTION_BLOCKS, ACTION_INDEX } from '../ocpp/function-blocks.js';

class ActionList extends LitElement {
  static styles = [formStyles, css`
    :host { display: block; font-family: var(--mono); font-size: 12px; }
    .group-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 10px 0 4px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      margin-bottom: 1px;
    }
    .row:hover { background: var(--surface-2); border-color: var(--border); }
    .row.selected { background: var(--surface-2); border-color: var(--accent); color: var(--accent); }
    .row.disabled { opacity: 0.4; cursor: not-allowed; }
    .row.disabled:hover { background: transparent; border-color: transparent; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .versions { color: var(--muted); font-size: 10px; flex-shrink: 0; }
    .empty { color: var(--muted); font-style: italic; padding: 8px 0; }
  `];

  static properties = {
    block: { type: String },
    selected: { type: String },
    filterVersions: { type: Object },        // Set<string> of selected OCPP versions
  };

  _matchesFilter(action) {
    const meta = ACTION_INDEX[action];
    if (!meta) return false;
    if (!this.filterVersions || this.filterVersions.size === 0) return true;
    return meta.versions.some((v) => this.filterVersions.has(v));
  }

  _edit(action) {
    this.dispatchEvent(new CustomEvent('edit-action', {
      detail: { action }, bubbles: true, composed: true,
    }));
  }

  _renderRow(action, { disabled = false } = {}) {
    const meta = ACTION_INDEX[action];
    return html`
      <div
        class="row ${this.selected === action ? 'selected' : ''} ${disabled ? 'disabled' : ''}"
        @click=${() => !disabled && this._edit(action)}
        title=${disabled ? 'Not supported by any selected OCPP version' : ''}
      >
        <span class="name">${action}</span>
        <span class="versions">${meta?.versions.map((v) => v.replace('ocpp', '')).join(' ') || '?'}</span>
      </div>
    `;
  }

  render() {
    const block = FUNCTION_BLOCKS.find((b) => b.letter === this.block);
    if (!block) return html``;
    const all = block.actions.map((a) => a.action);
    const frequentRaw = FREQUENT_ACTIONS[this.block] || [];
    const frequent = frequentRaw.filter((a) => this._matchesFilter(a));
    const frequentSet = new Set(frequentRaw);
    const further = all.filter((a) => this._matchesFilter(a) && !frequentSet.has(a));
    const unsupported = all.filter((a) => !this._matchesFilter(a));

    if (all.length === 0) {
      return html`<div class="empty">No CP-originated messages in this block.</div>`;
    }

    return html`
      ${frequent.length ? html`<div class="group-label">Frequently used</div>` : ''}
      ${frequent.map((a) => this._renderRow(a))}
      ${further.length ? html`<div class="group-label">Further messages</div>` : ''}
      ${further.map((a) => this._renderRow(a))}
      ${unsupported.length ? html`<div class="group-label">Unsupported for selected protocols</div>` : ''}
      ${unsupported.map((a) => this._renderRow(a, { disabled: true }))}
    `;
  }
}

customElements.define('action-list', ActionList);
