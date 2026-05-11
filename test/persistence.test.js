import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from '../src/lib/idb.js';

describe('IndexedDB facade', () => {
  it('round-trips sequence records', async () => {
    const db = await openDB();
    await db.clear('sequences');
    const id = await db.add('sequences', {
      name: 'boot-default',
      description: 'sanity',
      stopOnError: true,
      steps: [{ kind: 'send', action: 'BootNotification', payload: { reason: 'PowerUp' } }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const got = await db.get('sequences', id);
    expect(got.name).toBe('boot-default');
    expect(got.steps[0].action).toBe('BootNotification');
    const all = await db.getAll('sequences');
    expect(all).toHaveLength(1);
  });
});
