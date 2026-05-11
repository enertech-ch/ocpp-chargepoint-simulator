// `{{ expr }}` templating for composer payloads and the CentralSystem URL.
//
// Anywhere a string contains `{{ ... }}`, the contents are a JavaScript
// expression evaluated with one argument in scope: `cp`, a snapshot of the
// host ChargePoint exposing at least `id`, `label`, `ocppVersion`, and
// `params` (a `{name: value}` map of the CP's named parameters).
//
// Two shapes:
//   "{{ cp.params.x }}"           — WHOLE-STRING form. Replaced with the raw
//                                    expression result, preserving its type
//                                    (so an object param splats in as an
//                                    object, not a stringified blob).
//   "prefix-{{ cp.params.x }}!"   — INLINE form. The result is coerced to a
//                                    string and concatenated.
//
// Three consumers:
//   resolveTemplates(value, cp) — runtime replacement (composer ▶ send, the
//                                 sequence runner, and connect-time URL).
//   toScriptSource(value)       — emit JS source where templates become bare
//                                 expressions / template literals.
//   cpScope(cp)                 — build the canonical `cp` scope from a CP
//                                 record. Shared by every resolveTemplates
//                                 caller.

const TEMPLATE_RE = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const WHOLE_RE = /^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/;

function evalExpr(expr, cp) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('cp', `"use strict"; return (${expr});`);
    return fn(cp);
  } catch {
    return undefined;
  }
}

function resolveString(s, cp) {
  const whole = s.match(WHOLE_RE);
  if (whole) return evalExpr(whole[1], cp);
  return s.replace(TEMPLATE_RE, (_, expr) => {
    const v = evalExpr(expr, cp);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function hasTemplate(s) {
  if (typeof s !== 'string') return false;
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(s);
}

export function resolveTemplates(value, cp) {
  const scope = cp || {};
  return walk(value);
  function walk(v) {
    if (typeof v === 'string') return resolveString(v, scope);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  }
}

// Convert a CP's `params: [{name, value}]` array into a `{name: value}` map
// keyed by name.
export function cpParamsMap(params) {
  const out = {};
  for (const p of params || []) {
    if (p && p.name) out[p.name] = p.value;
  }
  return out;
}

// The canonical `cp` scope used everywhere templates resolve. Pass a CP
// record (or anything with the same field names); get back the read-only
// snapshot exposed inside `{{ ... }}` expressions.
export function cpScope(cp) {
  if (!cp) return { id: '', label: '', ocppVersion: '', params: {} };
  return {
    id: cp.id || '',
    label: cp.label || '',
    ocppVersion: cp.ocppVersion || '',
    params: cpParamsMap(cp.params),
  };
}

// -----------------------------------------------------------------------------
// Recording: emit JS source. A whole-string template becomes a bare expression;
// an inline template becomes a template literal. Plain values use JSON.
// -----------------------------------------------------------------------------

export function toScriptSource(value, indent = 0) {
  return emit(value, indent);
}

function emit(value, indent) {
  if (typeof value === 'string') return emitString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return emitArray(value, indent);
  if (value && typeof value === 'object') return emitObject(value, indent);
  return JSON.stringify(value);
}

function emitString(s) {
  const whole = s.match(WHOLE_RE);
  if (whole) return `(${whole[1]})`;
  if (!hasTemplate(s)) return JSON.stringify(s);
  // Inline template → template literal.
  TEMPLATE_RE.lastIndex = 0;
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(TEMPLATE_RE, (_, expr) => `\${${expr.trim()}}`);
  return '`' + escaped + '`';
}

function emitArray(arr, indent) {
  if (arr.length === 0) return '[]';
  const pad = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);
  return '[\n' + arr.map((v) => pad + emit(v, indent + 2)).join(',\n') + '\n' + close + ']';
}

function emitObject(obj, indent) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  const pad = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);
  return '{\n' + entries.map(([k, v]) => `${pad}${keyOf(k)}: ${emit(v, indent + 2)}`).join(',\n') + '\n' + close + '}';
}

function keyOf(k) {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}
