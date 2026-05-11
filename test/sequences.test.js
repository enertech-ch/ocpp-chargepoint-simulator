import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// Stub the connections module before importing sequences.js — the runner
// imports it and we want a fake `connections.send` plus a fake list lookup.
vi.mock('../src/state/connections.js', () => {
  const sent = [];
  const state = { ocppVersion: 'ocpp2.1', params: [] };
  return {
    connections: {
      get: () => ({
        list: [{
          key: 'c1', id: 'CP_001', label: 'Test',
          ocppVersion: state.ocppVersion, params: state.params,
        }],
      }),
      send: vi.fn(async (key, action, payload) => {
        sent.push({ key, action, payload });
        if (action === 'WillFail') throw { code: 'NotImplemented', description: 'boom' };
        return { ok: true };
      }),
      _sent: sent,
      _setVersion: (v) => { state.ocppVersion = v; },
      _setParams: (p) => { state.params = p; },
    },
  };
});

const {
  saveSequence, listSequences, getSequence, deleteSequence,
  emptySequence, runSequence,
} = await import('../src/lib/sequences.js');
const { connections } = await import('../src/state/connections.js');

describe('Sequence CRUD', () => {
  beforeEach(async () => {
    const all = await listSequences();
    for (const s of all) await deleteSequence(s.id);
  });

  it('round-trips a sequence', async () => {
    const id = await saveSequence({
      ...emptySequence(),
      label: 'Boot + Heartbeat',
      steps: [
        { kind: 'send', action: 'BootNotification', payload: {} },
        { kind: 'pause', seconds: 1 },
        { kind: 'send', action: 'Heartbeat', payload: {} },
      ],
    });
    const got = await getSequence(id);
    expect(got.label).toBe('Boot + Heartbeat');
    expect(got.steps).toHaveLength(3);
    expect(got.createdAt).toBeTruthy();
    expect(got.updatedAt).toBeTruthy();
  });

  it('lists sequences in insertion order (oldest first; new ones append)', async () => {
    await saveSequence({ ...emptySequence(), label: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    await saveSequence({ ...emptySequence(), label: 'B' });
    const all = await listSequences();
    expect(all.map((s) => s.label)).toEqual(['A', 'B']);
  });
});

describe('runSequence', () => {
  beforeEach(() => {
    connections._sent.length = 0;
    connections.send.mockClear();
  });

  it('runs steps in order and reports progress', async () => {
    const events = [];
    await runSequence(
      {
        stopOnError: true,
        steps: [
          { kind: 'send', action: 'BootNotification', payload: { reason: 'PowerUp' } },
          { kind: 'pause', seconds: 0 },
          { kind: 'send', action: 'Heartbeat', payload: {} },
        ],
      },
      'c1',
      { onProgress: (e) => events.push(e) },
    );
    expect(connections._sent.map((s) => s.action)).toEqual(['BootNotification', 'Heartbeat']);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.filter((e) => e.type === 'success')).toHaveLength(3);
  });

  it('halts on error when stopOnError is true', async () => {
    const events = [];
    await runSequence(
      {
        stopOnError: true,
        steps: [
          { kind: 'send', action: 'WillFail', payload: {} },
          { kind: 'send', action: 'NeverReached', payload: {} },
        ],
      },
      'c1',
      { onProgress: (e) => events.push(e) },
    );
    expect(connections._sent.map((s) => s.action)).toEqual(['WillFail']);
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.error.code).toBe('NotImplemented');
  });

  it('continues on error when stopOnError is false', async () => {
    const events = [];
    await runSequence(
      {
        stopOnError: false,
        steps: [
          { kind: 'send', action: 'WillFail', payload: {} },
          { kind: 'send', action: 'Heartbeat', payload: {} },
        ],
      },
      'c1',
      { onProgress: (e) => events.push(e) },
    );
    expect(connections._sent.map((s) => s.action)).toEqual(['WillFail', 'Heartbeat']);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'success')).toHaveLength(1);
  });

  it('skips steps whose action is not supported on the target version', async () => {
    connections._setVersion('ocpp1.6');
    const events = [];
    await runSequence(
      {
        stopOnError: true,
        steps: [
          { kind: 'send', action: 'TransactionEvent', payload: {} },  // 2.x only
          { kind: 'send', action: 'BootNotification', payload: {} },  // all versions
        ],
      },
      'c1',
      { onProgress: (e) => events.push(e) },
    );
    expect(connections._sent.map((s) => s.action)).toEqual(['BootNotification']);
    const skipped = events.find((e) => e.type === 'skipped');
    expect(skipped).toBeTruthy();
    expect(skipped.stepIndex).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'done' });
    connections._setVersion('ocpp2.1');
  });

  it('emits "waiting" with a skip handle that fast-forwards the current wait', async () => {
    const events = [];
    const t0 = Date.now();
    let skipsFired = 0;
    await runSequence(
      {
        stopOnError: true,
        steps: [
          { kind: 'pause', seconds: 5 },          // long pause we'll skip
          { kind: 'send', action: 'Heartbeat', payload: {}, delaySeconds: 5 }, // long delay we'll skip
        ],
      },
      'c1',
      {
        onProgress: (e) => {
          events.push(e);
          if (e.type === 'waiting') {
            skipsFired++;
            e.skip();
          }
        },
      },
    );
    const elapsed = Date.now() - t0;
    expect(skipsFired).toBe(2);
    // Skip should drop the per-step waits to ~0, so the whole thing finishes
    // well under any one of the 5s timeouts.
    expect(elapsed).toBeLessThan(500);
    const waitingEvents = events.filter((e) => e.type === 'waiting');
    expect(waitingEvents).toHaveLength(2);
    expect(waitingEvents[0].step.kind).toBe('pause');
    expect(waitingEvents[1].step.action).toBe('Heartbeat');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('honors per-step delaySeconds for send steps', async () => {
    const events = [];
    const t0 = Date.now();
    await runSequence(
      {
        stopOnError: true,
        steps: [
          { kind: 'send', action: 'Heartbeat', payload: {}, delaySeconds: 0.05 },
          { kind: 'send', action: 'Heartbeat', payload: {}, delaySeconds: 0.05 },
        ],
      },
      'c1',
      { onProgress: (e) => events.push(e) },
    );
    const elapsed = Date.now() - t0;
    expect(connections._sent).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(80);  // both 50ms delays should have run
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('resolves {{ cp.params.X }} templates against the target CP', async () => {
    connections._setParams([
      { name: 'model', value: 'X1' },
      { name: 'chargingStation', value: { model: 'X1', vendorName: 'Acme' } },
    ]);
    await runSequence(
      {
        stopOnError: true,
        steps: [
          {
            kind: 'send',
            action: 'BootNotification',
            payload: {
              reason: 'PowerUp',
              chargingStation: '{{ cp.params.chargingStation }}',
              label: 'cp-{{ cp.params.model }}',
              fallback: "{{ cp.params.missing ?? 'def' }}",
            },
          },
        ],
      },
      'c1',
      { onProgress: () => {} },
    );
    const last = connections._sent.at(-1);
    expect(last.action).toBe('BootNotification');
    expect(last.payload.chargingStation).toEqual({ model: 'X1', vendorName: 'Acme' });
    expect(last.payload.label).toBe('cp-X1');
    expect(last.payload.fallback).toBe('def');
    connections._setParams([]);
  });

  it('respects an abort signal mid-pause', async () => {
    const ctrl = new AbortController();
    const events = [];
    setTimeout(() => ctrl.abort(), 30);
    await runSequence(
      {
        stopOnError: true,
        steps: [
          { kind: 'pause', seconds: 5 },
          { kind: 'send', action: 'Heartbeat', payload: {} },
        ],
      },
      'c1',
      { onProgress: (e) => events.push(e), signal: ctrl.signal },
    );
    expect(connections._sent).toHaveLength(0);
    expect(events.at(-1).type).toBe('done');
  });
});
