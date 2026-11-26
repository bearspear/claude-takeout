const test = require('node:test');
const assert = require('node:assert');
const S = require('../session-core.js');

const ev = (type, message, extra) => ({ type, uuid: 'u1', created_at: '2026-01-01T00:00:00Z', message, ...extra });
const user = (content) => ev('user', { role: 'user', content });

test('keepSession keeps only the listed fields', () => {
  const raw = {
    id: 'cse_abc', title: 'T', status_bucket: 'idle', environment_kind: 'bridge',
    config: { origin: 'cli', model: 'm', mcp_connector_ids: ['x'] },
    created_at: 'c', updated_at: 'u', last_event_at: 'l',
    tags: ['a'], session_context: { secret: 1 }, url: 'https://x', session_url: 'https://y',
    external_metadata: { artifacts: [{ artifact_id: 'a1', title: 'A', updated_at: 'z', url: 'https://u' }], other: 1 },
  };
  assert.deepStrictEqual(S.keepSession(raw), {
    id: 'cse_abc', title: 'T', status_bucket: 'idle', environment_kind: 'bridge',
    config: { origin: 'cli', model: 'm' }, created_at: 'c', updated_at: 'u', last_event_at: 'l',
    external_metadata: { artifacts: [{ artifact_id: 'a1', title: 'A', updated_at: 'z' }] },
  });
  assert.strictEqual(S.keepSession({ id: 'x_1' }), null);
  assert.strictEqual(S.keepSession({ id: 5 }), null);
});

test('keepSessionEvent drops machinery', () => {
  for (const e of [
    { type: 'env_manager_log' }, { type: 'control_request', uuid: 'u' }, { type: 'rate_limit_event', uuid: 'u' },
    { type: 'system', subtype: 'init', uuid: 'u' }, { type: 'autocompact_state', uuid: 'u' },
  ]) assert.strictEqual(S.keepSessionEvent(e), null);
  assert.deepStrictEqual(
    S.keepSessionEvent({ type: 'system', subtype: 'compact_boundary', uuid: 'u', created_at: 'c', extra: 1 }),
    { uuid: 'u', created_at: 'c', subtype: 'compact_boundary', type: 'system' });
  assert.deepStrictEqual(
    S.keepSessionEvent({ type: 'result', uuid: 'u', created_at: 'c', is_error: false, num_turns: 2, duration_ms: 5, total_cost_usd: 0.1, subtype: 'success', usage: {}, result: 'x' }),
    { type: 'result', uuid: 'u', created_at: 'c', is_error: false, num_turns: 2, duration_ms: 5, total_cost_usd: 0.1, subtype: 'success' });
});

test('stripSystemReminders drops reminder-only messages', () => {
  assert.strictEqual(S.stripSystemReminders('<system-reminder>cwd /x</system-reminder>'), '');
  assert.strictEqual(S.stripSystemReminders('hi <system-reminder>a\nb</system-reminder> there'), 'hi  there');
  assert.strictEqual(S.keepSessionEvent(user('<system-reminder>cwd /x</system-reminder>')), null);
  assert.strictEqual(S.keepSessionEvent(user([{ type: 'text', text: '<system-reminder>x</system-reminder>' }])), null);
  const kept = S.keepSessionEvent(user('hi <system-reminder>a</system-reminder>'));
  assert.deepStrictEqual(kept.message.content, [{ type: 'text', text: 'hi ' }]);
  const out = '<system-reminder>tool output</system-reminder>';
  const r = S.keepSessionEvent(user([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: out }] }]));
  assert.strictEqual(r.message.content[0].content[0].text, out);
});

test('maskSecrets masks tokens inside larger text', () => {
  const cases = [
    ['sk-ant-' + 'a1_-'.repeat(10), 'k=[masked] z'],
    ['ghp_' + 'a'.repeat(36), 'k=[masked] z'],
    ['gho_' + 'b'.repeat(36), 'k=[masked] z'],
    ['github_pat_' + 'A1_'.repeat(20), 'k=[masked] z'],
    ['AKIA' + 'ABCDEFGH12345678', 'k=[masked] z'],
    ['xoxb-123-abc-DEF', 'k=[masked] z'],
    ['xoxp-123-abc-DEF', 'k=[masked] z'],
    ['Bearer ' + 'a'.repeat(30), 'k=[masked] z'],
  ];
  for (const [tok] of cases) assert.strictEqual(S.maskSecrets('k=' + tok + ' z'), 'k=[masked] z', tok);
  assert.strictEqual(S.maskSecrets('GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + '\nPATH=/bin'), 'GITHUB_TOKEN=[masked]\nPATH=/bin');
  assert.strictEqual(S.maskSecrets('Bearer short'), 'Bearer short');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  assert.strictEqual(S.maskSecrets(pem), '[masked]');
  assert.strictEqual(S.maskSecrets('a\n' + pem + '\nb'), 'a\n[masked]\nb');
});

test('keepSessionEvent masks tool results and inputs', () => {
  const tok = 'sk-ant-' + 'x'.repeat(30);
  const e = ev('assistant', { role: 'assistant', model: 'm', content: [
    { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo ' + tok, n: 3 } },
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'got ' + tok }] },
    { type: 'tool_result', tool_use_id: 't', content: 'plain ' + tok },
  ] }, { parent_tool_use_id: null, junk: 1 });
  const k = S.keepSessionEvent(e);
  assert.strictEqual(k.message.content[0].input.command, 'echo [masked]');
  assert.strictEqual(k.message.content[0].input.n, 3);
  assert.strictEqual(k.message.content[1].content[0].text, 'got [masked]');
  assert.strictEqual(k.message.content[2].content, 'plain [masked]');
  assert.strictEqual(k.junk, undefined);
  assert.strictEqual(k.message.model, 'm');
});

test('keepSessionEvent stubs an event over 2 MB', () => {
  const k = S.keepSessionEvent(ev('assistant', { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(2.1 * 1024 * 1024) }] }));
  assert.deepStrictEqual(k, { uuid: 'u1', created_at: '2026-01-01T00:00:00Z', type: 'assistant', stub: 'too large (2.1 MB)' });
});

test('sessionPage takes lastId and hasMore from the raw page', () => {
  const p = S.sessionPage({ data: [user('hello'), { type: 'env_manager_log' }], has_more: true, last_id: 'e9' });
  assert.strictEqual(p.lastId, 'e9');
  assert.strictEqual(p.hasMore, true);
  assert.strictEqual(p.events.length, 1);
  assert.deepStrictEqual(S.sessionPage({ data: [] }), { events: [], lastId: null, hasMore: false });
  assert.strictEqual(S.EVENT_STUB_BYTES, 2 * 1024 * 1024);
  assert.strictEqual(S.SESSION_PAGE_LIMIT, 200);
});
