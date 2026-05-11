import { describe, it, expect } from 'vitest';
import { resolveTemplates, toScriptSource, cpParamsMap, hasTemplate } from '../src/lib/templates.js';

describe('resolveTemplates', () => {
  const cp = {
    id: 'CP_001',
    label: 'Test',
    ocppVersion: 'ocpp2.1',
    params: {
      model: 'X1',
      count: 7,
      bootNotification: { reason: 'PowerUp', chargingStation: { model: 'X1', vendorName: 'Acme' } },
    },
  };

  it('replaces whole-string templates with raw expression result', () => {
    const out = resolveTemplates(
      { chargingStation: '{{ cp.params.bootNotification.chargingStation }}' },
      cp,
    );
    expect(out.chargingStation).toEqual({ model: 'X1', vendorName: 'Acme' });
  });

  it('coerces inline templates to strings', () => {
    expect(resolveTemplates({ x: 'model-{{ cp.params.model }}' }, cp)).toEqual({ x: 'model-X1' });
    expect(resolveTemplates({ x: 'count:{{ cp.params.count }}' }, cp)).toEqual({ x: 'count:7' });
  });

  it('exposes cp.id / cp.label / cp.ocppVersion alongside cp.params', () => {
    expect(resolveTemplates('ws://csms/{{ cp.id }}', cp)).toBe('ws://csms/CP_001');
    expect(resolveTemplates('{{ cp.ocppVersion }}', cp)).toBe('ocpp2.1');
  });

  it('honors ?? fallbacks', () => {
    expect(resolveTemplates({ x: "{{ cp.params.missing ?? 'fallback' }}" }, cp)).toEqual({ x: 'fallback' });
  });

  it('walks nested objects and arrays', () => {
    const out = resolveTemplates(
      { a: { b: ['{{ cp.params.model }}', '{{ cp.params.count }}'] } },
      cp,
    );
    expect(out).toEqual({ a: { b: ['X1', 7] } });
  });

  it('leaves non-template strings alone', () => {
    expect(resolveTemplates({ a: 'plain' }, cp)).toEqual({ a: 'plain' });
  });

  it('returns undefined for whole-string templates whose expression errors out', () => {
    expect(resolveTemplates({ a: '{{ throw new Error("x") }}' }, cp)).toEqual({ a: undefined });
  });
});

describe('cpParamsMap', () => {
  it('flattens [{name,value}] into a map', () => {
    expect(cpParamsMap([{ name: 'a', value: 1 }, { name: 'b', value: 'x' }])).toEqual({ a: 1, b: 'x' });
  });
  it('skips entries without a name', () => {
    expect(cpParamsMap([{ value: 1 }, { name: '', value: 2 }, { name: 'ok', value: 3 }])).toEqual({ ok: 3 });
  });
});

describe('hasTemplate', () => {
  it('detects templates and ignores plain strings', () => {
    expect(hasTemplate('plain')).toBe(false);
    expect(hasTemplate('{{ x }}')).toBe(true);
    expect(hasTemplate('mid-{{ x }}-end')).toBe(true);
    expect(hasTemplate(42)).toBe(false);
  });
});

describe('toScriptSource', () => {
  it('emits JSON for plain values', () => {
    expect(toScriptSource({ a: 'b', n: 1, t: true, z: null })).toBe(
      '{\n  a: "b",\n  n: 1,\n  t: true,\n  z: null\n}',
    );
  });

  it('whole-string template becomes a bare expression', () => {
    expect(toScriptSource({ x: '{{ cp.params.model }}' })).toBe('{\n  x: (cp.params.model)\n}');
  });

  it('inline template becomes a template literal', () => {
    expect(toScriptSource({ x: 'model-{{ cp.params.model }}-end' })).toBe(
      '{\n  x: `model-${cp.params.model}-end`\n}',
    );
  });

  it('quotes keys that are not valid identifiers', () => {
    expect(toScriptSource({ 'with-dash': 1 })).toBe('{\n  "with-dash": 1\n}');
  });

  it('walks arrays', () => {
    expect(toScriptSource(['a', '{{ x }}', 1])).toBe('[\n  "a",\n  (x),\n  1\n]');
  });

  it('escapes backticks and ${ in inline templates', () => {
    expect(toScriptSource({ x: '`back-{{ y }}-${z}' })).toBe('{\n  x: `\\`back-${y}-\\${z}`\n}');
  });
});
