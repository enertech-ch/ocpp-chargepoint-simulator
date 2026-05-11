import { describe, it, expect } from 'vitest';
import { C2W, W2C, ConnState, LOG_RING_SIZE } from '../src/workers/protocol.js';

describe('worker protocol envelope', () => {
  it('exposes a stable C2W vocabulary', () => {
    expect(C2W).toMatchObject({
      Hello: 'hello',
      Connect: 'connect',
      Disconnect: 'disconnect',
      Send: 'send',
      Hydrate: 'hydrate',
    });
  });

  it('exposes a stable W2C vocabulary', () => {
    expect(W2C).toMatchObject({
      Hello: 'hello',
      ConnectionState: 'connection-state',
      Log: 'log',
      Hydrate: 'hydrate',
      SendResult: 'send-result',
    });
  });

  it('defines a complete set of connection states', () => {
    expect(Object.values(ConnState)).toEqual(
      expect.arrayContaining(['idle', 'connecting', 'open', 'closing', 'closed', 'error']),
    );
  });

  it('caps the log ring buffer at a sane size', () => {
    expect(LOG_RING_SIZE).toBeGreaterThan(100);
    expect(LOG_RING_SIZE).toBeLessThanOrEqual(50000);
  });
});
