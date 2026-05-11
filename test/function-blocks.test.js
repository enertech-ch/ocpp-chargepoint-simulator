import { describe, it, expect } from 'vitest';
import { FUNCTION_BLOCKS, ACTION_INDEX } from '../src/ocpp/function-blocks.js';
import { FREQUENT_ACTIONS } from '../src/ocpp/frequent-actions.js';

describe('Function block registry', () => {
  it('covers letters A through S', () => {
    const letters = FUNCTION_BLOCKS.map((b) => b.letter);
    const expected = 'ABCDEFGHIJKLMNOPQRS'.split('');
    expect(letters).toEqual(expected);
  });

  it('indexes every action with its block', () => {
    for (const block of FUNCTION_BLOCKS) {
      for (const a of block.actions) {
        expect(ACTION_INDEX[a.action]).toBeDefined();
      }
    }
  });

  it('frequent actions all live in their block', () => {
    for (const [letter, actions] of Object.entries(FREQUENT_ACTIONS)) {
      const block = FUNCTION_BLOCKS.find((b) => b.letter === letter);
      expect(block, `block ${letter} missing`).toBeDefined();
      const blockActions = new Set(block.actions.map((a) => a.action));
      for (const a of actions) {
        expect(blockActions.has(a), `frequent action ${a} not in block ${letter}`).toBe(true);
      }
    }
  });
});
