// Lazy loader for OCPP request schemas. Schemas live under
// /schemas/<version>/<filename>.json; user drops them in from the official
// spec download. Until then we report `present: false` so the UI can fall
// back to a free-text JSON editor.

import { schemaFilename } from './versions.js';

const cache = new Map(); // key = `${version}:${action}` -> { present, schema, error? }

export async function loadSchema(version, action) {
  const key = `${version}:${action}`;
  if (cache.has(key)) return cache.get(key);
  const url = new URL(`../../schemas/${version}/${schemaFilename(version, action)}`, import.meta.url);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const result = { present: false, schema: null, error: `HTTP ${res.status}` };
      cache.set(key, result);
      return result;
    }
    const schema = await res.json();
    const result = { present: true, schema, error: null };
    cache.set(key, result);
    return result;
  } catch (e) {
    const result = { present: false, schema: null, error: String(e) };
    cache.set(key, result);
    return result;
  }
}

export function clearSchemaCache() { cache.clear(); }
