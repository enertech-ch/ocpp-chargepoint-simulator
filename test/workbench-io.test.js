import { describe, it, expect } from 'vitest';
import { buildExport, parseImport, EXPORT_VERSION } from '../src/lib/workbench-io.js';

describe('workbench-io', () => {
  it('exports a CP without transient fields, sorted by label', () => {
    const out = buildExport({
      cps: [
        { key: 'cZZ', label: 'Zeta',  id: 'CP_002', csmUrl: 'ws://b', ocppVersion: 'ocpp2.1', params: [], state: 'open', error: null, hue: 240 },
        { key: 'cAA', label: 'Alpha', id: 'CP_001', csmUrl: 'ws://a', ocppVersion: 'ocpp2.1', params: [], state: 'idle', error: 'x',  hue: 200 },
      ],
    });
    expect(out.version).toBe(EXPORT_VERSION);
    expect(out.chargePoints.map((c) => c.label)).toEqual(['Alpha', 'Zeta']);
    // transient fields stripped
    for (const c of out.chargePoints) {
      expect(c.key).toBeUndefined();
      expect(c.state).toBeUndefined();
      expect(c.error).toBeUndefined();
    }
    // payload fields preserved
    expect(out.chargePoints[0].csmUrl).toBe('ws://a');
    expect(out.chargePoints[0].hue).toBe(200);
  });

  it('exports sequences and scripts without IDB-internal fields, sorted by label', () => {
    const out = buildExport({
      sequences: [
        { id: 9, label: 'Z',     order: 99, createdAt: 1, updatedAt: 2, steps: [{ kind: 'pause', seconds: 1 }] },
        { id: 1, label: 'A',     order: 1,  createdAt: 1, updatedAt: 2, steps: [] },
      ],
      scripts: [
        { id: 5, label: 'beta',  order: 5, createdAt: 1, updatedAt: 2, code: 'x' },
        { id: 2, label: 'alpha', order: 2, createdAt: 1, updatedAt: 2, code: 'y' },
      ],
    });
    expect(out.sequences.map((s) => s.label)).toEqual(['A', 'Z']);
    expect(out.scripts.map((s) => s.label)).toEqual(['alpha', 'beta']);
    for (const s of [...out.sequences, ...out.scripts]) {
      expect(s.id).toBeUndefined();
      expect(s.order).toBeUndefined();
      expect(s.createdAt).toBeUndefined();
      expect(s.updatedAt).toBeUndefined();
    }
  });

  it('empty sections become empty arrays in the export, never undefined', () => {
    const out = buildExport({ cps: [{ key: 'c1', label: 'one' }] });
    expect(out.chargePoints).toHaveLength(1);
    expect(out.sequences).toEqual([]);
    expect(out.scripts).toEqual([]);
  });

  it('parseImport accepts valid files and normalises missing sections to []', () => {
    const file = JSON.stringify({ version: 1, chargePoints: [{ label: 'x' }] });
    const parsed = parseImport(file);
    expect(parsed.chargePoints).toHaveLength(1);
    expect(parsed.sequences).toEqual([]);
    expect(parsed.scripts).toEqual([]);
  });

  it('parseImport throws on garbage', () => {
    expect(() => parseImport('not json')).toThrow(/Invalid JSON/);
    expect(() => parseImport('"a string"')).toThrow(/JSON object/);
  });

  it('parseImport ignores unexpected fields in arrays', () => {
    const file = JSON.stringify({ chargePoints: [{ label: 'x', random: 'y' }] });
    const parsed = parseImport(file);
    expect(parsed.chargePoints[0]).toEqual({ label: 'x', random: 'y' });
  });
});
