import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const {
  saveScript, listScripts, getScript, deleteScript, emptyScript,
  ensureBuiltinScripts,
} = await import('../src/lib/scripts.js');

describe('Script CRUD', () => {
  beforeEach(async () => {
    const all = await listScripts();
    for (const s of all) await deleteScript(s.id);
  });

  it('round-trips a script', async () => {
    const id = await saveScript({
      ...emptyScript(),
      label: 'ping',
      description: 'sends a heartbeat',
      params: [{ name: 'count', default: '3' }],
      code: 'await cp.sendMessage("Heartbeat", {});',
    });
    const got = await getScript(id);
    expect(got.label).toBe('ping');
    expect(got.description).toBe('sends a heartbeat');
    expect(got.params).toHaveLength(1);
    expect(got.params[0].name).toBe('count');
    expect(got.code).toContain('Heartbeat');
    expect(got.createdAt).toBeTruthy();
    expect(got.updatedAt).toBeTruthy();
  });

  it('lists scripts in insertion order (oldest first; new ones append)', async () => {
    await saveScript({ ...emptyScript(), label: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    await saveScript({ ...emptyScript(), label: 'B' });
    const all = await listScripts();
    expect(all.map((s) => s.label)).toEqual(['A', 'B']);
  });

  it('ensureBuiltinScripts seeds each built-in once', async () => {
    await ensureBuiltinScripts();
    let all = await listScripts();

    const sv = all.filter((s) => s.builtinId === 'handle-set-variables');
    expect(sv).toHaveLength(1);
    expect(sv[0].builtin).toBe(true);
    expect(sv[0].code).toMatch(/cp\.onMessage\('SetVariables'/);
    expect(sv[0].params.map((p) => p.name)).toEqual([
      'accepted', 'unknownComponent', 'unknownVariable',
      'notSupportedAttrType', 'rebootRequired',
    ]);

    const boot = all.filter((s) => s.builtinId === 'default-cp-behavior');
    expect(boot).toHaveLength(1);
    expect(boot[0].builtin).toBe(true);
    expect(boot[0].label).toMatch(/Auto Boot \+ Heartbeat/);
    expect(boot[0].code).toMatch(/cp\.onConnect\(/);
    expect(boot[0].code).toMatch(/BootNotification/);
    expect(boot[0].code).toMatch(/Heartbeat/);
    // Per-CP override path is present (cp.params -> script.params -> default).
    expect(boot[0].code).toMatch(/cp\.params\?\.\[name\]/);
    // OCPP-version branching is wired up.
    expect(boot[0].code).toMatch(/ocpp1\.6/);
    expect(boot[0].params.map((p) => p.name)).toEqual([
      'model', 'vendor', 'serial', 'reason', 'heartbeatInterval',
    ]);

    const charge = all.filter((s) => s.builtinId === 'charging-simulation');
    expect(charge).toHaveLength(1);
    expect(charge[0].builtin).toBe(true);
    expect(charge[0].label).toMatch(/Charging Simulation/);
    // Both protocol branches present.
    expect(charge[0].code).toMatch(/StartTransaction/);
    expect(charge[0].code).toMatch(/StopTransaction/);
    expect(charge[0].code).toMatch(/TransactionEvent/);
    expect(charge[0].params.map((p) => p.name)).toEqual([
      'startMeter', 'stepSize', 'intervalSec', 'steps', 'idTag', 'skipAuthorize',
    ]);

    // Idempotent: a second call is a no-op (doesn't duplicate).
    await ensureBuiltinScripts();
    all = await listScripts();
    expect(all.filter((s) => s.builtinId === 'handle-set-variables')).toHaveLength(1);
    expect(all.filter((s) => s.builtinId === 'default-cp-behavior')).toHaveLength(1);
    expect(all.filter((s) => s.builtinId === 'charging-simulation')).toHaveLength(1);
  });

  it('emptyScript exposes the runtime hints in its default code', () => {
    const code = emptyScript().code;
    expect(code).toMatch(/cp\.sendMessage/);
    expect(code).toMatch(/cp\.onMessage/);
    expect(code).toMatch(/response\.status/);
    expect(code).toMatch(/cp\.waitForMessage/);
    expect(code).toMatch(/script\.sleep/);
    expect(code).toMatch(/script\.stop/);
    expect(code).toMatch(/script\.params/);
  });
});
