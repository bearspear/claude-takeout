// Viewer page logic: message tree and hash state.
const { test } = require('node:test');
const assert = require('node:assert');
const { chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash } = require('../viewer/viewer-logic.js');

const msgs = [
  { id: 'r', parent: null, sender: 'human', at: '2026-01-01T00:00:00Z' },
  { id: 'a1', parent: 'r', sender: 'assistant', at: '2026-01-01T00:00:01Z' },
  { id: 'a2', parent: 'r', sender: 'assistant', at: '2026-01-01T00:00:02Z' },
  { id: 'h3', parent: 'a2', sender: 'human', at: '2026-01-01T00:00:03Z' },
  { id: 'a4', parent: 'h3', sender: 'assistant', at: '2026-01-01T00:00:04Z' },
];

test('chainFrom walks root to leaf', () => {
  assert.deepStrictEqual(chainFrom(msgs, 'a4').map(m => m.id), ['r', 'a2', 'h3', 'a4']);
});

test('chainFrom edge cases', () => {
  assert.deepStrictEqual(chainFrom([], null), []);
  assert.deepStrictEqual(chainFrom(msgs, 'nope').map(m => m.id), ['r', 'a2', 'h3', 'a4']);
  assert.deepStrictEqual(chainFrom([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }], 'x').length, 2);
  assert.deepStrictEqual(chainFrom([{ id: 'z', parent: 'gone' }], 'z').map(m => m.id), ['z']);
});

test('siblings, leafUnder and switchBranch', () => {
  assert.deepStrictEqual(siblingsOf(msgs, 'a2'), { ids: ['a1', 'a2'], index: 1 });
  assert.strictEqual(leafUnder(msgs, 'a2'), 'a4');
  assert.strictEqual(switchBranch(msgs, 'a2', -1), 'a1');
  assert.strictEqual(switchBranch(msgs, 'a2', 1), null);
});

test('hash round trip and bad input', () => {
  const s = { chat: 'c 1', leaf: 'm', file: null, version: 2 };
  assert.deepStrictEqual(parseHash(formatHash(s)), s);
  assert.deepStrictEqual(parseHash('#junk=%E0%A4'), { chat: null, leaf: null, file: null, version: null });
});
