import { LitElement, html, css } from './lit.js';
import { loadSchema } from '../ocpp/schema-loader.js';
import { randomFromSchema, randomFromPattern } from '../lib/random.js';
import { composer } from '../state/composer.js';
import { formStyles } from './shared-styles.js';

function resolveRef(ref, root) {
  if (!ref || !ref.startsWith('#/')) return null;
  const path = ref.slice(2).split('/');
  let node = root;
  for (const p of path) if (node && p in node) node = node[p]; else return null;
  return node;
}

function deref(schema, root) {
  if (!schema) return schema;
  if (schema.$ref) return deref(resolveRef(schema.$ref, root) || {}, root);
  return schema;
}

function getAt(obj, path) {
  let node = obj;
  for (const p of path) {
    if (node == null) return undefined;
    node = node[p];
  }
  return node;
}

function setAt(obj, path, value) {
  if (path.length === 0) return value;
  const head = path[0];
  const next = path.length === 1 ? value : setAt(
    (obj && obj[head] != null) ? obj[head] : (typeof path[1] === 'number' ? [] : {}),
    path.slice(1),
    value,
  );
  if (Array.isArray(obj)) {
    const copy = obj.slice();
    copy[head] = next;
    return copy;
  }
  return { ...obj, [head]: next };
}

function removeAt(obj, path) {
  if (path.length === 1) {
    if (Array.isArray(obj)) {
      const copy = obj.slice();
      copy.splice(path[0], 1);
      return copy;
    }
    const { [path[0]]: _, ...rest } = obj;
    return rest;
  }
  const head = path[0];
  return { ...obj, [head]: removeAt(obj[head], path.slice(1)) };
}

class MessageForm extends LitElement {
  static styles = [formStyles, css`
    :host { display: block; font-family: var(--mono); font-size: 12px; }
    .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      min-height: 200px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      border: 1px dashed var(--border);
      border-radius: var(--radius-sm);
      padding: 24px;
      text-align: center;
    }
    .body {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
    }
    fieldset {
      border: 1px solid var(--border);
      border-radius: 4px;
      margin: 6px 0;
      padding: 8px;
    }
    legend { color: var(--muted); padding: 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .field {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 6px;
      align-items: center;
      margin: 4px 0;
    }
    .field > label { color: var(--muted); }
    .field input:not([type="checkbox"]), .field select, .field textarea { width: 100%; }

    /* A horizontally-attached row of controls: [leadr] [input] [dice].
       First child gets rounded left corners, last gets rounded right,
       inner borders collapse so the trio reads as one welded affordance. */
    .input-group {
      display: flex;
      width: 100%;
      border-radius: var(--radius-sm);
      transition: box-shadow 0.12s ease;
    }
    .input-group:focus-within { box-shadow: 0 0 0 2px var(--accent-ring); }
    .input-group > * { border-radius: 0; }
    .input-group > *:not(:last-child) { border-right: none; }
    .input-group > *:first-child {
      border-top-left-radius: var(--radius-sm);
      border-bottom-left-radius: var(--radius-sm);
    }
    .input-group > *:last-child {
      border-top-right-radius: var(--radius-sm);
      border-bottom-right-radius: var(--radius-sm);
    }
    .input-group > input, .input-group > select { flex: 1; min-width: 0; }
    .input-group:focus-within > input,
    .input-group:focus-within > select {
      border-color: var(--accent);
      box-shadow: none;
    }
    .input-group > .dice {
      border-left: 1px solid var(--border);
      padding: 6px 10px;
      font-size: 13px;
      background: var(--surface-2);
      color: var(--muted);
      flex-shrink: 0;
      cursor: pointer;
    }
    .input-group:focus-within > .dice { border-color: var(--accent); }
    .input-group > .dice:hover { background: var(--surface-3); color: var(--accent); border-color: var(--border-strong); }

    /* Lead indicator on the left of an input-group: * required (gray),
       ✕ optional+present (red), + optional+absent (green). Same metric
       as .dice so [leadr | input | dice] is symmetric. */
    .input-group > .leadr {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      padding: 0;
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--muted);
      flex-shrink: 0;
      transition: filter 0.12s ease;
    }
    .input-group > span.leadr { cursor: default; }
    .input-group > button.leadr { cursor: pointer; }
    .input-group > button.leadr-remove { background: var(--err); color: #fff; border-color: var(--err); }
    .input-group > button.leadr-add { background: var(--ok); color: #fff; border-color: var(--ok); }
    .input-group > button.leadr:hover { filter: brightness(1.15); }
    .input-group:focus-within > .leadr { border-color: var(--accent); }

    /* Standalone (+) for an optional-and-absent field: no input-group, so
       it carries its own full radius + border. Sits in the value column
       next to "(optional)" text. */
    .stub {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
    }
    .stub .leadr-add {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      padding: 6px 8px;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      border: 1px solid var(--ok);
      border-radius: var(--radius-sm);
      background: var(--ok);
      color: #fff;
      cursor: pointer;
      transition: filter 0.12s ease;
    }
    .stub .leadr-add:hover { filter: brightness(1.15); }

    /* Compact leadr inside a fieldset legend (for nested object/array
       sub-fields). Inline pill, not part of an input-group. */
    legend .leadr {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 16px;
      padding: 0 4px;
      margin-right: 6px;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: var(--surface-2);
      color: var(--muted);
      vertical-align: middle;
    }
    legend button.leadr-remove { background: var(--err); color: #fff; border-color: var(--err); cursor: pointer; }
    legend button.leadr-add { background: var(--ok); color: #fff; border-color: var(--ok); cursor: pointer; }
    legend button.leadr:hover { filter: brightness(1.15); }

    /* Boolean field: native checkbox at native size, left-anchored, with
       the leadr (if any) beside it. The earlier full-width rule used to
       stretch the checkbox into a hideous strip. */
    .bool-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .bool-row input[type="checkbox"] {
      width: 16px;
      height: 16px;
      margin: 0;
      cursor: pointer;
    }
    .bool-row .leadr {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--muted);
    }
    .bool-row button.leadr-remove { background: var(--err); color: #fff; border-color: var(--err); cursor: pointer; }
    .bool-row button.leadr-add { background: var(--ok); color: #fff; border-color: var(--ok); cursor: pointer; }
    .bool-row button.leadr:hover { filter: brightness(1.15); }

    .array-row { display: flex; gap: 6px; align-items: flex-start; margin: 4px 0; }
    .array-row > *:first-child { flex: 1; }
    .warning { color: var(--warn); font-size: 11px; margin-top: 4px; }

    /* Whole-array buttons: "Add item" and "Remove [i]". Same square
       footprint as the leadr glyphs. */
    .btn-add, .btn-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 4px;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      vertical-align: middle;
      transition: filter 0.12s ease;
    }
    .btn-add { background: var(--ok); }
    .btn-remove { background: var(--err); }
    .btn-add:hover, .btn-remove:hover { filter: brightness(1.15); }
    .fallback textarea { width: 100%; height: 220px; font-family: var(--mono); }
  `];

  static properties = {
    action: { type: String },
    version: { type: String },           // OCPP version of the schema we're editing
    initialPayload: { type: Object },    // when set, used as the payload after a schema load (e.g. "insert step into composer")
    _schema: { state: true },
    _present: { state: true },
    _payload: { state: true },
    _raw: { state: true },
  };

  constructor() {
    super();
    this._schema = null;
    this._present = false;
    this._payload = {};
    this._raw = '';
  }

  willUpdate(changed) {
    if (changed.has('action') || changed.has('version') || changed.has('initialPayload')) {
      this._load();
    }
  }

  async _load() {
    if (!this.action || !this.version) {
      this._schema = null; this._present = false; this._payload = {}; this._raw = '';
      this._publish();
      return;
    }
    const { schema, present } = await loadSchema(this.version, this.action);
    this._schema = schema;
    this._present = present;
    // initialPayload (e.g. coming from a sequence step "Insert into composer")
    // wins over randomization on load.
    if (this.initialPayload != null) {
      this._payload = JSON.parse(JSON.stringify(this.initialPayload));
    } else if (present) {
      this._payload = randomFromSchema(schema);
    } else {
      this._payload = {};
    }
    this._raw = JSON.stringify(this._payload, null, 2);
    this._publish();
  }

  // Mirror our current state into the composer store so other panes
  // (destinations + Add step) can read it.
  _publish() {
    composer.set({
      action: this.action || null,
      version: this.version || 'ocpp2.1',
      payload: this._payload,
      valid: this._present ? null : true, // null means "unknown, depends on schema"
    });
  }

  _set(path, value) {
    this._payload = setAt(this._payload, path, value);
    this._publish();
  }

  _remove(path) {
    this._payload = removeAt(this._payload, path);
    this._publish();
  }

  _randomize() {
    if (!this._schema) return;
    this._payload = randomFromSchema(this._schema);
    this._raw = JSON.stringify(this._payload, null, 2);
    this._publish();
  }

  // Public entry point so the composer topbar (in ocpp-app) can drive the form.
  randomize() { this._randomize(); }

  render() {
    if (!this.action) {
      return html`<div class="placeholder">
        Pick a message from the list to compose its parameters.<br>
        Then use the destinations panel on the right to send it to a ChargePoint or add it to a sequence.
      </div>`;
    }
    return html`
      <div class="body">
        ${this._present
          ? this._renderField(this._schema, [], this.action)
          : html`
              <div class="warning">
                Schema for <code>${this.action}</code> not found in
                <code>schemas/${this.version}/</code> — free-text mode.
              </div>
              <div class="fallback">
                <textarea
                  .value=${this._raw}
                  @input=${(e) => { this._raw = e.target.value; try { this._payload = JSON.parse(e.target.value); this._publish(); } catch {} }}
                ></textarea>
              </div>
            `}
      </div>
    `;
  }

  _renderField(schema, path, label, leadr) {
    schema = deref(schema, this._schema);
    if (!schema) return html``;

    if (schema.enum) return this._renderEnum(schema, path, label, leadr);
    if (schema.oneOf || schema.anyOf) return this._renderOneOf(schema, path, label, leadr);

    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    switch (type) {
      case 'object': return this._renderObject(schema, path, label, leadr);
      case 'array': return this._renderArray(schema, path, label, leadr);
      case 'string': return this._renderString(schema, path, label, leadr);
      case 'integer':
      case 'number': return this._renderNumber(schema, path, label, leadr);
      case 'boolean': return this._renderBoolean(schema, path, label, leadr);
      default: return this._renderUnknown(schema, path, label, leadr);
    }
  }

  // Build the lead-indicator that prefixes every field's input control:
  //   required        → gray [*]  (non-clickable)
  //   optional+present→ red  [✕] (click removes the property)
  //   optional+absent → handled by caller via _renderStub below
  _makeLeadr(isReq, path) {
    if (isReq) {
      return html`<span class="leadr leadr-required" title="Required">*</span>`;
    }
    return html`<button
      class="leadr leadr-remove"
      title="Remove (won't be sent)"
      @click=${(e) => { e.stopPropagation(); this._remove(path); }}
    >✕</button>`;
  }

  _renderObject(schema, path, label, leadr) {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const value = getAt(this._payload, path) || {};
    const showLegend = path.length > 0;
    const fields = html`${Object.entries(props).map(([k, sub]) => {
      if (k === 'customData') return ''; // OCPP 2.x extension slot — noise in the form
      const isReq = required.has(k);
      const has = k in value;
      if (!isReq && !has) {
        // Optional, not currently set: show an "add" affordance in the
        // same left-of-value slot as the [*] and [✕] indicators.
        return html`
          <div class="field">
            <label>${k}</label>
            <span class="stub">
              <button
                class="leadr-add"
                title="Add ${k}"
                @click=${() => this._set([...path, k], randomFromSchema(deref(sub, this._schema)))}
              >+</button>
              <span>(optional)</span>
            </span>
          </div>
        `;
      }
      const subLeadr = this._makeLeadr(isReq, [...path, k]);
      return html`<div>${this._renderField(sub, [...path, k], k, subLeadr)}</div>`;
    })}`;
    return showLegend
      ? html`<fieldset><legend>${leadr ?? ''}${label}</legend>${fields}</fieldset>`
      : fields;
  }

  _renderArray(schema, path, label, leadr) {
    const raw = getAt(this._payload, path);
    const items = Array.isArray(raw) ? raw : [];
    return html`
      <fieldset>
        <legend>${leadr ?? ''}${label} (${items.length})</legend>
        ${items.map((_, i) => html`
          <div class="array-row">
            ${this._renderField(schema.items, [...path, i], `[${i}]`)}
            <button class="btn-remove" title="Remove [${i}]" @click=${() => this._remove([...path, i])}>✕</button>
          </div>
        `)}
        <button
          class="btn-add"
          title="Add item"
          @click=${() => this._set([...path, items.length], randomFromSchema(deref(schema.items, this._schema)))}
        >+</button>
      </fieldset>
    `;
  }

  _renderEnum(schema, path, label, leadr) {
    const value = getAt(this._payload, path) ?? schema.enum[0];
    return html`
      <div class="field">
        <label>${label}</label>
        <div class="input-group">
          ${leadr ?? ''}
          <select @change=${(e) => this._set(path, e.target.value)}>
            ${schema.enum.map((v) => html`<option ?selected=${v === value} value=${v}>${v}</option>`)}
          </select>
        </div>
      </div>
    `;
  }

  _renderString(schema, path, label, leadr) {
    const value = getAt(this._payload, path) ?? '';
    const onInput = (e) => this._set(path, e.target.value);
    const dice = () => {
      let v;
      if (schema.format) v = randomFromSchema(schema);
      else if (schema.pattern) v = randomFromPattern(schema.pattern, { minLength: schema.minLength || 0, maxLength: schema.maxLength || 64 });
      else v = randomFromSchema(schema);
      this._set(path, v);
    };
    return html`
      <div class="field">
        <label title="${schema.description || ''}">${label}</label>
        <div class="input-group">
          ${leadr ?? ''}
          <input type="text"
            .value=${value}
            maxlength=${schema.maxLength || ''}
            placeholder=${schema.format || schema.pattern || ''}
            @input=${onInput}
          />
          <button class="dice" title="Generate random value" @click=${dice}>🎲</button>
        </div>
      </div>
    `;
  }

  _renderNumber(schema, path, label, leadr) {
    const value = getAt(this._payload, path) ?? '';
    return html`
      <div class="field">
        <label>${label}</label>
        <div class="input-group">
          ${leadr ?? ''}
          <input type="number"
            .value=${value}
            min=${schema.minimum ?? ''}
            max=${schema.maximum ?? ''}
            @input=${(e) => this._set(path, e.target.value === '' ? undefined : Number(e.target.value))}
          />
          <button class="dice" title="Generate random value" @click=${() => this._set(path, randomFromSchema(schema))}>🎲</button>
        </div>
      </div>
    `;
  }

  _renderBoolean(schema, path, label, leadr) {
    const value = !!getAt(this._payload, path);
    return html`
      <div class="field">
        <label>${label}</label>
        <div class="bool-row">
          ${leadr ?? ''}
          <input type="checkbox"
            .checked=${value}
            @change=${(e) => this._set(path, e.target.checked)}
          />
        </div>
      </div>
    `;
  }

  _renderOneOf(schema, path, label, leadr) {
    const branches = schema.oneOf || schema.anyOf;
    // Simple: pick the first branch — extension point for tabbed switcher.
    return this._renderField(branches[0], path, label, leadr);
  }

  _renderUnknown(schema, path, label, leadr) {
    const value = getAt(this._payload, path);
    return html`
      <div class="field">
        <label>${label}</label>
        <div class="input-group">
          ${leadr ?? ''}
          <input type="text"
            .value=${value == null ? '' : (typeof value === 'string' ? value : JSON.stringify(value))}
            @change=${(e) => this._set(path, e.target.value)}
          />
        </div>
      </div>
    `;
  }
}

customElements.define('message-form', MessageForm);
