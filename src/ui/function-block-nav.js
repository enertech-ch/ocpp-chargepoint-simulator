import { LitElement, html, css } from './lit.js';
import { FUNCTION_BLOCKS } from '../ocpp/function-blocks.js';

class FunctionBlockNav extends LitElement {
  static styles = css`
    :host { display: block; font-family: var(--mono); font-size: 12px; }
    .item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid transparent;
      margin-bottom: 1px;
    }
    .item:hover { background: var(--surface-2); }
    .item.selected {
      background: var(--surface-2);
      border-color: var(--accent);
      color: var(--accent);
    }
    .item.empty { opacity: 0.35; cursor: default; }
    .item.empty:hover { background: transparent; }
    .letter { width: 18px; text-align: center; color: var(--muted); font-weight: 600; }
    .item.selected .letter { color: var(--accent); }
    .name { flex: 1; }
    .count { color: var(--muted); font-size: 10px; }
  `;

  static properties = {
    selected: { type: String },
    filterVersions: { type: Object },
  };

  _visibleCount(block) {
    if (!this.filterVersions || this.filterVersions.size === 0) return block.actions.length;
    return block.actions.filter((a) => a.versions.some((v) => this.filterVersions.has(v))).length;
  }

  _pick(letter, visibleCount) {
    if (visibleCount === 0) return;
    this.dispatchEvent(new CustomEvent('block-change', {
      detail: { block: letter }, bubbles: true, composed: true,
    }));
  }

  render() {
    return html`
      ${FUNCTION_BLOCKS.map((b) => {
        const count = this._visibleCount(b);
        const empty = count === 0;
        return html`
          <div
            class="item ${b.letter === this.selected ? 'selected' : ''} ${empty ? 'empty' : ''}"
            @click=${() => this._pick(b.letter, count)}
          >
            <span class="letter">${b.letter}</span>
            <span class="name">${b.name}</span>
            <span class="count">${count}</span>
          </div>
        `;
      })}
    `;
  }
}

customElements.define('function-block-nav', FunctionBlockNav);
