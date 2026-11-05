// Loads the real unpacked extension in Chromium against a mock of claude.ai as seen live on
// 2026-11-05: chats load over a StreamTimeline RPC, never REST. sidepanel.html opens in its
// own window with chrome.tabs.query pointed at the claude tab; everything else is real.
const { chromium } = require(process.env.PW);
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.resolve(__dirname, '..', '..');
const ORG = '11111111-1111-4111-8111-111111111111';
const ID = { A: 'aaaaaaaa-0000-4000-8000-000000000001', B: 'bbbbbbbb-0000-4000-8000-000000000002' };
const msg = (uuid, parent, sender, text) => ({
  uuid, parent_message_uuid: parent, sender, created_at: '2026-11-05T10:00:00Z',
  content: [{ type: 'text', text }], attachments: [], files: [], files_v2: [],
});
const conv = (id, name, turns) => {
  const chat_messages = [];
  let parent = null;
  for (let i = 0; i < turns; i++) {
    const u = `${id.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
    chat_messages.push(msg(u, parent, i % 2 ? 'assistant' : 'human', `turn ${i}`));
    parent = u;
  }
  return { uuid: id, name, model: 'claude-x', created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z', settings: {}, chat_messages, current_leaf_message_uuid: parent };
};

const PAGE = `<!doctype html><title>mock</title><body>mock claude<script>
  const rpc = () => fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', { method: 'POST', body: '{}' });
  window.selectChat = async (id) => { history.pushState({}, '', '/chat/' + id); await rpc(); };
  rpc();
</script></body>`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-ext-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false, executablePath: process.env.CHROME_EXE, acceptDownloads: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let failed = 0;
  const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`); };
  const server = { [ID.A]: conv(ID.A, 'Chat A', 2), [ID.B]: conv(ID.B, 'Chat B', 2) };
  const restHits = [];

  try {
    await ctx.addCookies([{ name: 'lastActiveOrg', value: ORG, url: 'https://claude.ai' }]);
    await ctx.route('https://claude.ai/**', (route) => {
      const url = route.request().url();
      const m = url.match(/\/organizations\/([0-9a-f-]+)\/chat_conversations\/([0-9a-f-]{36})/);
      if (m) {
        restHits.push(m[2]);
        if (m[1] !== ORG || !server[m[2]]) return route.fulfill({ status: 404, json: {} });
        return route.fulfill({ json: server[m[2]] });
      }
      if (url.includes('/claudeai-rpc/')) return route.fulfill({ contentType: 'application/connect+proto', body: 'x' });
      return route.fulfill({ contentType: 'text/html', body: PAGE });
    });

    const claude = await ctx.newPage();
    await claude.goto(`https://claude.ai/chat/${ID.A}`);
    await claude.waitForTimeout(800);

    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    const panelPromise = ctx.waitForEvent('page', (p) => p.url().includes('sidepanel.html'));
    await sw.evaluate((u) => chrome.windows.create({ url: u, focused: false }), `chrome-extension://${extId}/sidepanel.html`);
    const panel = await panelPromise;
    const logs = [];
    panel.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
    await panel.waitForLoadState('load');
    await panel.waitForTimeout(300);

    await panel.evaluate(() => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async () => (await real({ url: 'https://claude.ai/*' })).slice(0, 1);
      return requestData();
    });
    await panel.waitForTimeout(500);

    const read = () => panel.evaluate(() => ({
      status: document.getElementById('status').textContent,
      info: document.getElementById('info').textContent,
      disabled: document.getElementById('exportJson').disabled,
      uuid: conversationData ? conversationData.uuid : null,
      msgs: conversationData ? conversationData.chat_messages.length : null,
    }));

    let s = await read();
    check('startup with no capture and no captured org shows Chat A', s.uuid === ID.A && !s.disabled, JSON.stringify(s));

    await claude.evaluate((id) => window.selectChat(id), ID.B);
    await panel.waitForTimeout(800);
    s = await read();
    check('select chat over RPC -> Chat B', s.uuid === ID.B && /Chat B/.test(s.info), JSON.stringify(s));

    server[ID.A] = conv(ID.A, 'Chat A', 6);
    await claude.evaluate((id) => window.selectChat(id), ID.A);
    await panel.waitForTimeout(800);
    s = await read();
    check('back to Chat A shows newer messages', s.uuid === ID.A && s.msgs === 6, JSON.stringify(s));

    server[ID.A] = conv(ID.A, 'Chat A', 8);
    let [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#exportJson')]);
    const json = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    check('JSON export has latest messages', json.chat_messages.length === 8, String(json.chat_messages.length));

    server[ID.A] = conv(ID.A, 'Chat A', 10);
    [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#exportMd')]);
    const md = fs.readFileSync(await dl.path(), 'utf8');
    check('Markdown export has latest messages', md.includes('turn 9'));

    server[ID.A] = conv(ID.A, 'Chat A', 12);
    [dl] = await Promise.all([panel.waitForEvent('download', { timeout: 15000 }), panel.click('#exportZip')]);
    const zipPath = await dl.path();
    await panel.waitForTimeout(300);
    const original = await panel.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const zip = await JSZip.loadAsync(bytes);
      const f = Object.keys(zip.files).find((n) => n.endsWith('original.json'));
      return JSON.parse(await zip.files[f].async('string')).chat_messages.length;
    }, fs.readFileSync(zipPath).toString('base64'));
    s = await read();
    check('ZIP export has latest messages', original === 12, String(original));
    check('ZIP result status survives', /Exported zip/.test(s.status), JSON.stringify(s));

    await claude.evaluate(() => { history.pushState({}, '', '/new'); });
    await panel.waitForTimeout(800);
    s = await read();
    check('non-chat page disables export', s.disabled && s.uuid === null, JSON.stringify(s));

    check('no page errors in panel', logs.length === 0, JSON.stringify(logs));
  } catch (e) {
    failed++;
    console.log('HARNESS ERROR', e.message);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
