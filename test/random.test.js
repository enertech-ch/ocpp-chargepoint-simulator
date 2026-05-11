import { describe, it, expect } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { randomFromSchema, randomFromPattern } from '../src/lib/random.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function check(schema, samples = 200) {
  const validate = ajv.compile(schema);
  for (let i = 0; i < samples; i++) {
    const v = randomFromSchema(schema);
    expect(validate(v), `sample ${i} ${JSON.stringify(v)} did not validate: ${JSON.stringify(validate.errors)}`).toBe(true);
  }
}

describe('randomFromSchema', () => {
  it('generates valid date-time strings', () => {
    check({ type: 'string', format: 'date-time' });
  });

  it('generates valid uuid strings', () => {
    check({ type: 'string', format: 'uuid' });
  });

  it('respects string minLength/maxLength', () => {
    check({ type: 'string', minLength: 5, maxLength: 10 });
  });

  it('respects integer minimum/maximum', () => {
    check({ type: 'integer', minimum: -10, maximum: 10 });
  });

  it('picks from enum', () => {
    check({ enum: ['A', 'B', 'C'] });
  });

  it('handles objects with required fields', () => {
    check({
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'integer', minimum: 0 },
        name: { type: 'string', minLength: 1, maxLength: 8 },
        active: { type: 'boolean' },
      },
    });
  });

  it('handles arrays', () => {
    check({
      type: 'array',
      minItems: 1, maxItems: 3,
      items: { type: 'integer', minimum: 0, maximum: 100 },
    });
  });

  it('resolves internal $ref', () => {
    const schema = {
      definitions: { Id: { type: 'integer', minimum: 1, maximum: 9999 } },
      type: 'object',
      required: ['id'],
      properties: { id: { $ref: '#/definitions/Id' } },
    };
    check(schema);
  });
});

describe('randomFromPattern', () => {
  it('handles digit shorthand', () => {
    for (let i = 0; i < 50; i++) {
      const s = randomFromPattern('\\d{4}');
      expect(s).toMatch(/^\d{4}$/);
    }
  });

  it('handles character classes', () => {
    for (let i = 0; i < 50; i++) {
      const s = randomFromPattern('[a-z]{3,5}');
      expect(s).toMatch(/^[a-z]{3,5}$/);
    }
  });

  it('handles alternation', () => {
    for (let i = 0; i < 50; i++) {
      const s = randomFromPattern('foo|bar');
      expect(s).toMatch(/^(foo|bar)$/);
    }
  });

  it('handles groups and quantifiers', () => {
    for (let i = 0; i < 50; i++) {
      const s = randomFromPattern('(ab){2}');
      expect(s).toMatch(/^(ab){2}$/);
    }
  });
});
