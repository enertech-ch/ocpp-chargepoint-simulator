import { describe, it, expect } from 'vitest';
import { mapPayload } from '../src/ocpp/backmap.js';

describe('mapPayload', () => {
  it('is a no-op for same-version', () => {
    const r = mapPayload({ action: 'BootNotification', payload: { foo: 1 }, fromVersion: 'ocpp2.1', toVersion: 'ocpp2.1' });
    expect(r.action).toBe('BootNotification');
    expect(r.payload).toEqual({ foo: 1 });
    expect(r.warnings).toHaveLength(0);
  });

  it('strips 2.1-only fields when targeting 2.0.1', () => {
    const r = mapPayload({
      action: 'TransactionEvent',
      payload: { eventType: 'Started', tariffId: 'T1', other: 42 },
      fromVersion: 'ocpp2.1', toVersion: 'ocpp2.0.1',
    });
    expect(r.payload.tariffId).toBeUndefined();
    expect(r.payload.other).toBe(42);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('reports unsupported when an action has no 1.6 equivalent', () => {
    const r = mapPayload({
      action: 'TransactionEvent', payload: {}, fromVersion: 'ocpp2.1', toVersion: 'ocpp1.6',
    });
    expect(r.unsupported).toBe(true);
  });

  it('strips 2.x-only fields when targeting 1.6', () => {
    const r = mapPayload({
      action: 'StatusNotification',
      payload: { connectorId: 1, status: 'Available', evse: { id: 1 } },
      fromVersion: 'ocpp2.1', toVersion: 'ocpp1.6',
    });
    expect(r.payload.evse).toBeUndefined();
    expect(r.payload.connectorId).toBe(1);
  });
});
