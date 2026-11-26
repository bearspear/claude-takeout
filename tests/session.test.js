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
    ['ghs_' + 'c'.repeat(36), 'k=[masked] z'],
    ['ghu_' + 'd'.repeat(36), 'k=[masked] z'],
    ['ghr_' + 'e'.repeat(36), 'k=[masked] z'],
    ['ASIA' + 'ABCDEFGH12345678', 'k=[masked] z'],
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

test('session-core.js can run twice in one context (re-injection)', () => {
  const vm = require('node:vm');
  const src = require('node:fs').readFileSync(require.resolve('../session-core.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  assert.doesNotThrow(() => vm.runInContext(src, ctx));
  assert.strictEqual(vm.runInContext("CTSession.maskSecrets('ghp_' + 'a'.repeat(36))", ctx), '[masked]');
});

test('maskSecrets masks a truncated private key', () => {
  assert.strictEqual(S.maskSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3abc\n...truncated'), '[masked]');
  assert.strictEqual(S.maskSecrets('x\n-----BEGIN PRIVATE KEY-----\nAAA\nBBB\n\nafter'), 'x\n[masked]\n\nafter');
  const big = '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(Math.ceil(1024 * 1024 / 32));
  assert.strictEqual(S.maskSecrets(big), '[masked]');
  assert.strictEqual(S.maskSecrets('-----BEGIN PRIVATE KEY-----\na\n-----END PRIVATE KEY----- -----BEGIN PRIVATE KEY-----\nb'), '[masked] [masked]');
});

test('stripSystemReminders handles unclosed and nested tags', () => {
  assert.strictEqual(S.stripSystemReminders('hi <system-reminder>secret cwd'), 'hi ');
  assert.strictEqual(S.stripSystemReminders('<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>x'), 'x');
  assert.strictEqual(S.stripSystemReminders('a</system-reminder>b'), 'ab');
});

test('maskSecrets matches Bearer case-insensitively and at string edges', () => {
  assert.strictEqual(S.maskSecrets('authorization: bearer ' + 'a'.repeat(40)), 'authorization: [masked]');
  assert.strictEqual(S.maskSecrets('ghp_' + 'a'.repeat(36)), '[masked]');
  assert.strictEqual(S.maskSecrets('x ' + 'AKIA' + 'ABCDEFGH12345678'), 'x [masked]');
});

test('keepSession masks titles and tolerates odd shapes', () => {
  const tok = 'ghp_' + 'a'.repeat(36);
  const k = S.keepSession({ id: 'cse_1', title: 'T ' + tok, config: 'oops',
    external_metadata: { artifacts: [{ artifact_id: 'a', title: tok }, 'bad', null, 5] } });
  assert.strictEqual(k.title, 'T [masked]');
  assert.strictEqual(k.config, undefined);
  assert.deepStrictEqual(k.external_metadata.artifacts, [{ artifact_id: 'a', title: '[masked]' }]);
});

// ---- Task 4: transcript, README, images ----
const C = require('../export-core.js');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

test('sessionImages saves PNG and JPEG by leading bytes and skips others', () => {
  const events = [
    user([img(PNG)]),
    user([{ type: 'tool_result', tool_use_id: 't', content: [img(JPG), img(Buffer.from('hello world!').toString('base64'))] }]),
  ];
  const before = JSON.stringify(events);
  const r = C.sessionImages(events);
  assert.strictEqual(JSON.stringify(events), before);
  assert.deepStrictEqual(r.images.map((i) => i.name), ['1.png', '2.jpg']);
  assert.deepStrictEqual(r.events[0].message.content[0], { type: 'image', file: 'images/1.png' });
  const c = r.events[1].message.content[0].content;
  assert.deepStrictEqual(c[0], { type: 'image', file: 'images/2.jpg' });
  assert.match(c[1].missing, /^not saved \(/);
  assert.strictEqual(r.skipped, 1);
});

test('sessionImages leaves out an image over 5 MB', () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5 * 1024 * 1024 + 10)]).toString('base64');
  const r = C.sessionImages([user([img(big)])]);
  assert.strictEqual(r.images.length, 0);
  assert.match(r.events[0].message.content[0].missing, /5 MB/);
});

test('promptKind labels compaction, commands and output', () => {
  assert.strictEqual(C.promptKind('This session is being continued from a previous conversation that ran out'), 'compaction');
  assert.strictEqual(C.promptKind('<command-name>/clear</command-name>'), 'command');
  assert.strictEqual(C.promptKind('<local-command-stdout>ok</local-command-stdout>'), 'command-output');
  assert.strictEqual(C.promptKind('hello'), 'prompt');
});

test('sessionTranscriptMd cuts a long tool result at 2 KB', () => {
  const events = [
    user([{ type: 'text', text: 'run it' }]),
    ev('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(3000) }]),
  ];
  const md = C.sessionTranscriptMd({ title: 'T', config: {} }, events);
  assert.ok(md.includes('x'.repeat(2048)) && !md.includes('x'.repeat(2049)));
  assert.match(md, /\[… 952 more characters in session\.json\]/);
  assert.match(md, /Bash/);
});

test('sessionTranscriptMd marks a compaction', () => {
  const md = C.sessionTranscriptMd({ title: 'T' }, [
    user([{ type: 'text', text: 'hi' }]),
    { type: 'system', subtype: 'compact_boundary', uuid: 'c' },
    user([{ type: 'text', text: 'This session is being continued from a previous conversation' }]),
    { uuid: 's', type: 'user', stub: 'too large (9 MB)' },
  ]);
  assert.match(md, /— Conversation compacted —/);
  assert.match(md, /Summary of the earlier conversation/);
  assert.match(md, /\[event too large to keep\]/);
});

test('sessionReadmeMd links artifacts in the export and on claude.ai', () => {
  const uuid = '12345678-1234-4234-8234-123456789abc';
  const md = C.sessionReadmeMd({ id: 'cse_abcdefghijklmnop', title: 'T', config: {} }, [
    user([{ type: 'text', text: 'hi' }]),
    ev('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] }),
    { type: 'result', uuid: 'r', total_cost_usd: 1.234 },
  ], [{ uuid, title: 'Local', href: '../../artifacts/Local_x/' }, { uuid, title: 'Remote', href: null }]);
  assert.match(md, /\(\.\.\/\.\.\/artifacts\/Local_x\/\)/);
  assert.ok(md.includes(`https://claude.ai/artifact/${C.uuidToBase58(uuid)}`));
  assert.match(md, /Turns: 1/);
  assert.match(md, /Tool calls: 1/);
  assert.match(md, /\$1\.23/);
  assert.strictEqual(C.sessionShortId('cse_abcdefghijklmnop'), 'efghijklmnop');
});

test('sessionReadmeMd escapes titles', () => {
  const t = '[x](javascript:alert(1)) <img onerror=1>';
  const md = C.sessionReadmeMd({ title: t }, [], [{ uuid: 'u', title: t, href: 'a/' }]);
  assert.ok(!md.includes('](javascript:'));
  assert.ok(!md.includes('<img'));
  assert.ok(md.includes('\\[x\\]'));
});

test('sessionTranscriptMd never cuts a result inside a surrogate pair', () => {
  const text = 'a' + '😀'.repeat(1100);
  const md = C.sessionTranscriptMd({ title: 'T' }, [
    ev('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
    user([{ type: 'tool_result', tool_use_id: 't1', content: text }]),
  ]);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(md));
  const kept = (md.match(/😀/g) || []).length;
  assert.strictEqual(kept, 1023);
  const m = /\[… (\d+) more characters/.exec(md);
  assert.strictEqual(Number(m[1]), text.length - (1 + 1023 * 2));
});

test('sessionTranscriptMd escapes a hostile tool name', () => {
  const md = C.sessionTranscriptMd({ title: 'T' }, [
    ev('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: '**x`[a](http://x)', input: {} }] }),
  ]);
  const line = md.split('\n').find((l) => l.startsWith('**Tool:'));
  assert.ok(!line.includes('](http'));
  assert.ok(line.endsWith('**') || / `/.test(line));
  assert.strictEqual((line.replace(/\\\*/g, '').match(/\*\*/g) || []).length, 2);
});
