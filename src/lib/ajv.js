// Shared Ajv instance. OCPP 1.6/2.0.1 schemas use draft-04, 2.1 uses draft-06,
// and Ajv 8 ships draft-07/2019/2020 metas. The differences for the keywords
// OCPP actually uses (type, properties, required, enum, $ref, definitions,
// items, format, pattern, min/maxLength, min/maximum) are nil — so we strip
// the `$schema` declaration and compile under Ajv's default semantics. A
// quick grep confirms no OCPP schema uses the draft-04-incompatible
// `exclusiveMinimum`/`exclusiveMaximum` boolean form.

let AjvCtor, addFormatsFn;
if (typeof window !== 'undefined') {
  AjvCtor = (await import('https://esm.sh/ajv@8')).default;
  addFormatsFn = (await import('https://esm.sh/ajv-formats@3')).default;
} else {
  AjvCtor = (await import('ajv')).default;
  addFormatsFn = (await import('ajv-formats')).default;
}

function makeAjv() {
  const a = new AjvCtor({
    allErrors: true,
    strict: false,
    // OCPP smart-charging schemas use `multipleOf: 0.1` and similar, which
    // collide with IEEE-754 representation (82.3 / 0.1 ≠ 823 exactly). This
    // option lets Ajv round the division before the integer check.
    multipleOfPrecision: 6,
  });
  addFormatsFn(a);
  return a;
}

export const ajv = makeAjv();

// Strip `$schema` from a (possibly nested) schema so Ajv 8 doesn't try to
// fetch an unknown meta-schema URI. Non-destructive — returns a shallow clone.
export function normalize(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  // Drop `$schema` (unknown meta-schema URIs in OCPP 1.6/2.0.1/2.1) and
  // promote the draft-04 `id` to `$id` so Ajv 8 doesn't trip on it.
  const { $schema, id, ...rest } = schema;
  if (id !== undefined && rest.$id === undefined) rest.$id = id;
  return rest;
}

export function compile(schema) {
  return ajv.compile(normalize(schema));
}
