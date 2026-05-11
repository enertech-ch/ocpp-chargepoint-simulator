// Schema-driven random value generators. Hand-rolled, algorithmic — no value
// pools or lookup tables (per user request). Outputs validate against the
// supplied schema when the schema is well-formed.

const ALPHA_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALPHA_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';
const ALPHA = ALPHA_LOWER + ALPHA_UPPER;
const ALNUM = ALPHA + DIGIT;

function pick(s) { return s[Math.floor(Math.random() * s.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }

export function randomString(length = 8, charset = ALNUM) {
  let out = '';
  for (let i = 0; i < length; i++) out += pick(charset);
  return out;
}

// Format generators. Each returns a value that satisfies the JSON schema
// `format` keyword. Defaults are RFC3339-shaped.
const FORMATS = {
  'date-time': () => new Date(Date.now() - randInt(0, 3600_000)).toISOString(),
  'date': () => new Date(Date.now() - randInt(0, 90 * 86400_000)).toISOString().slice(0, 10),
  'time': () => new Date().toISOString().slice(11, 19) + 'Z',
  'uuid': () => uuidv4(),
  'uri': () => `https://${randomString(randInt(4, 8), ALPHA_LOWER)}.example.com/${randomString(randInt(3, 8), ALNUM)}`,
  'uri-reference': () => `/${randomString(randInt(3, 8), ALNUM)}`,
  'email': () => `${randomString(randInt(4, 8), ALPHA_LOWER)}@${randomString(randInt(3, 6), ALPHA_LOWER)}.example`,
  'hostname': () => `${randomString(randInt(3, 8), ALPHA_LOWER)}.example.com`,
  'ipv4': () => `${randInt(1, 254)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
  'ipv6': () => Array.from({ length: 8 }, () => randInt(0, 0xffff).toString(16)).join(':'),
};

function uuidv4() {
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = randInt(0, 255);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// -----------------------------------------------------------------------------
// Regex pattern generator. Walks a small AST of the pattern and emits a string.
// Supports: literal, escapes (\d \w \s \D \W \S \\), character classes [a-z0-9],
// negated classes [^...], groups (...), alternation |, quantifiers ? * + {n} {n,m}.
// Anchors ^ $ are accepted and ignored (we always emit a full match).
// Lookarounds, backrefs and named groups are not supported (rare in OCPP).
// -----------------------------------------------------------------------------

class PatternParser {
  constructor(src) { this.src = src; this.i = 0; }
  peek() { return this.src[this.i]; }
  eat() { return this.src[this.i++]; }
  eof() { return this.i >= this.src.length; }

  parse() { return this.parseAlt(); }

  parseAlt() {
    const branches = [this.parseSeq()];
    while (!this.eof() && this.peek() === '|') {
      this.eat();
      branches.push(this.parseSeq());
    }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  }

  parseSeq() {
    const items = [];
    while (!this.eof() && this.peek() !== ')' && this.peek() !== '|') {
      items.push(this.parseQuant());
    }
    return { type: 'seq', items };
  }

  parseQuant() {
    const atom = this.parseAtom();
    if (this.eof()) return atom;
    const c = this.peek();
    if (c === '?' || c === '*' || c === '+') {
      this.eat();
      const [min, max] = c === '?' ? [0, 1] : c === '*' ? [0, 5] : [1, 6];
      return { type: 'quant', atom, min, max };
    }
    if (c === '{') {
      const save = this.i;
      this.eat();
      let num = '';
      while (!this.eof() && /\d/.test(this.peek())) num += this.eat();
      if (num === '') { this.i = save; return atom; }
      let min = parseInt(num, 10), max = min;
      if (this.peek() === ',') {
        this.eat();
        let num2 = '';
        while (!this.eof() && /\d/.test(this.peek())) num2 += this.eat();
        max = num2 === '' ? min + 5 : parseInt(num2, 10);
      }
      if (this.peek() !== '}') { this.i = save; return atom; }
      this.eat();
      return { type: 'quant', atom, min, max };
    }
    return atom;
  }

  parseAtom() {
    const c = this.eat();
    if (c === '^' || c === '$') return { type: 'empty' };
    if (c === '.') return { type: 'class', chars: ALNUM + ' _-' };
    if (c === '(') {
      // non-capturing semantics; skip ?: ?= ?! if present
      if (this.peek() === '?') {
        this.eat();
        const k = this.eat();
        if (k === ':') { /* fine */ }
        else { /* lookaround — skip until ) */
          let depth = 1;
          while (!this.eof() && depth > 0) {
            const ch = this.eat();
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === '\\') this.eat();
          }
          return { type: 'empty' };
        }
      }
      const inner = this.parseAlt();
      if (this.peek() === ')') this.eat();
      return { type: 'group', inner };
    }
    if (c === '[') return this.parseClass();
    if (c === '\\') return this.parseEscape();
    return { type: 'lit', ch: c };
  }

  parseClass() {
    let neg = false;
    if (this.peek() === '^') { neg = true; this.eat(); }
    let chars = '';
    while (!this.eof() && this.peek() !== ']') {
      let c = this.eat();
      if (c === '\\') {
        const esc = this.eat();
        chars += escSet(esc);
        continue;
      }
      if (this.peek() === '-' && this.src[this.i + 1] !== ']') {
        this.eat(); // -
        const end = this.eat();
        const a = c.charCodeAt(0), b = (end === '\\' ? this.eat() : end).charCodeAt(0);
        for (let k = Math.min(a, b); k <= Math.max(a, b); k++) chars += String.fromCharCode(k);
        continue;
      }
      chars += c;
    }
    if (this.peek() === ']') this.eat();
    if (neg) {
      const set = new Set(chars);
      let inv = '';
      for (const ch of ALNUM + ' -_./:') if (!set.has(ch)) inv += ch;
      chars = inv;
    }
    return { type: 'class', chars };
  }

  parseEscape() {
    const c = this.eat();
    return { type: 'class', chars: escSet(c) };
  }
}

function escSet(c) {
  switch (c) {
    case 'd': return DIGIT;
    case 'D': return ALPHA + ' _-';
    case 'w': return ALNUM + '_';
    case 'W': return ' -.:/';
    case 's': return ' ';
    case 'S': return ALNUM;
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '.': case '\\': case '/': case '(': case ')':
    case '[': case ']': case '{': case '}': case '+':
    case '*': case '?': case '|': case '^': case '$':
      return c;
    default: return c;
  }
}

function emit(node) {
  switch (node.type) {
    case 'empty': return '';
    case 'lit': return node.ch;
    case 'class': return node.chars.length ? pick(node.chars) : '';
    case 'seq': return node.items.map(emit).join('');
    case 'alt': return emit(node.branches[Math.floor(Math.random() * node.branches.length)]);
    case 'group': return emit(node.inner);
    case 'quant': {
      const n = randInt(node.min, node.max);
      let out = '';
      for (let i = 0; i < n; i++) out += emit(node.atom);
      return out;
    }
  }
  return '';
}

export function randomFromPattern(pattern, { minLength = 0, maxLength = 64 } = {}) {
  const ast = new PatternParser(pattern).parse();
  let attempt = 0;
  while (attempt++ < 20) {
    const out = emit(ast);
    if (out.length >= minLength && out.length <= maxLength) return out;
  }
  return emit(ast).slice(0, maxLength);
}

// -----------------------------------------------------------------------------
// Top-level generator. Walks a JSON schema and emits a random value.
// -----------------------------------------------------------------------------

export function randomFromSchema(schema, root = schema) {
  if (!schema || typeof schema !== 'object') return null;
  // $ref — resolve only same-document refs like "#/definitions/Foo"
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    return resolved ? randomFromSchema(resolved, root) : null;
  }
  if (schema.enum) return schema.enum[Math.floor(Math.random() * schema.enum.length)];
  if (schema.const !== undefined) return schema.const;
  // Always take the first branch so the generated payload matches what
  // message-form's _renderOneOf draws (it also picks branches[0]). Random
  // branch choice produced shape mismatches (e.g. an array branch payload
  // landing in an object-branch renderer).
  if (schema.oneOf) return randomFromSchema(schema.oneOf[0], root);
  if (schema.anyOf) return randomFromSchema(schema.anyOf[0], root);
  if (schema.allOf) {
    let merged = {};
    for (const part of schema.allOf) merged = { ...merged, ...part };
    return randomFromSchema(merged, root);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string': return randomString_(schema);
    case 'integer': return randomInt_(schema);
    case 'number': return randomNumber_(schema);
    case 'boolean': return Math.random() < 0.5;
    case 'array': return randomArray_(schema, root);
    case 'object':
    default: return randomObject_(schema, root);
  }
}

function randomString_(schema) {
  if (schema.format && FORMATS[schema.format]) return FORMATS[schema.format]();
  if (schema.pattern) {
    return randomFromPattern(schema.pattern, {
      minLength: schema.minLength || 0,
      maxLength: schema.maxLength || 64,
    });
  }
  // Respect schema.maxLength as the hard cap; only default the min when neither
  // bound is provided. OCPP schemas often set tight upper bounds (e.g. ISO 4217
  // currency codes have maxLength: 3) that would otherwise collide with the
  // default min.
  let min = schema.minLength;
  let max = schema.maxLength;
  if (min == null && max == null) { min = 4; max = 12; }
  else if (min == null) { min = Math.min(1, max); }
  else if (max == null) { max = Math.max(min + 4, min + 16, 12); }
  if (max < min) max = min;
  return randomString(randInt(min, max));
}

function randomInt_(schema) {
  const min = schema.minimum ?? -1000;
  const max = schema.maximum ?? 1000;
  const step = schema.multipleOf || 1;
  const k = randInt(Math.ceil(min / step), Math.floor(max / step));
  return k * step;
}

function randomNumber_(schema) {
  const min = schema.minimum ?? -100;
  const max = schema.maximum ?? 100;
  const step = schema.multipleOf || 0.01;
  const k = randInt(Math.ceil(min / step), Math.floor(max / step));
  // Round to the precision implied by `step` to dodge floating-point fuzz.
  const decimals = (String(step).split('.')[1] || '').length;
  return Number((k * step).toFixed(decimals));
}

function randomArray_(schema, root) {
  const minItems = schema.minItems || 1;
  const maxItems = schema.maxItems || Math.max(minItems, 2);
  const n = randInt(minItems, Math.min(maxItems, minItems + 2));
  const out = [];
  for (let i = 0; i < n; i++) out.push(randomFromSchema(schema.items || {}, root));
  return out;
}

function randomObject_(schema, root) {
  const out = {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  for (const [k, sub] of Object.entries(props)) {
    // OCPP 2.x `customData` is an extension slot — skip unless required.
    if (k === 'customData' && !required.has(k)) continue;
    if (required.has(k) || Math.random() < 0.6) {
      out[k] = randomFromSchema(sub, root);
    }
  }
  return out;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) return null;
  const path = ref.slice(2).split('/');
  let node = root;
  for (const p of path) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return null;
  }
  return node;
}
