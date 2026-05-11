// Regression test: for every *Request.json (and 1.6's *.json non-response
// files) we ship under schemas/, the random generator must produce a value
// that validates against the schema. Catches regressions in random.js or in
// our Ajv normalization layer when real OCPP schemas change.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomFromSchema } from '../src/lib/random.js';
import { compile } from '../src/lib/ajv.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.resolve(ROOT, '../schemas');

function listRequests(version) {
  const dir = path.join(SCHEMAS, version);
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (version === 'ocpp1.6') {
    // 1.6 uses <Action>.json + <Action>Response.json. Take only the request side.
    const set = new Set(all);
    return all.filter((f) => !f.endsWith('Response.json') && set.has(f));
  }
  return all.filter((f) => f.endsWith('Request.json'));
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

for (const version of ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']) {
  const files = listRequests(version);
  if (files.length === 0) continue;

  describe(`${version} request schemas (${files.length} files)`, () => {
    for (const file of files) {
      it(`generates a valid payload for ${file}`, () => {
        const schema = loadJson(path.join(SCHEMAS, version, file));
        const validate = compile(schema);
        // Generate several samples — the generator is random.
        for (let i = 0; i < 5; i++) {
          const payload = randomFromSchema(schema);
          const ok = validate(payload);
          if (!ok) {
            const errs = (validate.errors || []).slice(0, 4).map(
              (e) => `${e.instancePath || '/'} ${e.message}`,
            ).join('; ');
            throw new Error(`${file} sample ${i} did not validate: ${errs}\nPayload: ${JSON.stringify(payload).slice(0, 400)}`);
          }
          expect(ok).toBe(true);
        }
      });
    }
  });
}
