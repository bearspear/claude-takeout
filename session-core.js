// session-core.js: the pure filter for Claude Code and Cowork sessions. A classic script (content.js,
// popup.html and sidepanel.html load it before their own code); module.exports under Node only.
// It keeps the listed fields, strips system reminders from user text, masks known token shapes and
// stubs oversized events. Nothing it drops reaches the panel or the archive.

(function () {
const EVENT_STUB_BYTES = 2 * 1024 * 1024;
const SESSION_PAGE_LIMIT = 200;

const REMINDER_TAG_RE = /<(\/?)system-reminder>/g;

// Depth-aware: nested reminders go whole, an unclosed one drops the rest, a stray closing tag is removed.
function stripSystemReminders(text) {
  text = String(text);
  let out = '';
  let depth = 0;
  let pos = 0;
  REMINDER_TAG_RE.lastIndex = 0;
  let m;
  while ((m = REMINDER_TAG_RE.exec(text))) {
    if (depth === 0) out += text.slice(pos, m.index);
    if (m[1]) { if (depth > 0) depth--; } else depth++;
    pos = m.index + m[0].length;
  }
  if (depth === 0) out += text.slice(pos);
  return out.trim() === '' ? '' : out;
}

const KEY_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/g;
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/g;

// Linear: a BEGIN with no END anywhere after it is masked to the next blank line (or the end), and once
// no END exists no later BEGIN looks for one.
function maskKeys(text) {
  let out = '';
  let pos = 0;
  let noEnd = false;
  KEY_BEGIN_RE.lastIndex = 0;
  for (;;) {
    const m = KEY_BEGIN_RE.exec(text);
    if (!m) break;
    let end = -1;
    if (!noEnd) {
      KEY_END_RE.lastIndex = m.index + m[0].length;
      const e = KEY_END_RE.exec(text);
      if (e) end = e.index + e[0].length; else noEnd = true;
    }
    if (end < 0) {
      BLANK_LINE_RE.lastIndex = m.index + m[0].length;
      const b = BLANK_LINE_RE.exec(text);
      end = b ? b.index : text.length;
    }
    out += text.slice(pos, m.index) + '[masked]';
    pos = end;
    KEY_BEGIN_RE.lastIndex = end;
  }
  return out + text.slice(pos);
}

const SECRET_RES = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9]+/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /xox[bp]-[A-Za-z0-9-]+/g,
  /Bearer [A-Za-z0-9._~+\/=-]{20,}/gi,
];

function maskSecrets(text) {
  let out = maskKeys(String(text));
  for (const re of SECRET_RES) out = out.replace(re, '[masked]');
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function keepSession(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.startsWith('cse_')) return null;
  const out = pick(raw, ['id', 'title', 'status_bucket', 'environment_kind']);
  if (typeof out.title === 'string') out.title = maskSecrets(out.title);
  if (raw.config && typeof raw.config === 'object') out.config = pick(raw.config, ['origin', 'model']);
  Object.assign(out, pick(raw, ['created_at', 'updated_at', 'last_event_at']));
  const arts = raw.external_metadata && raw.external_metadata.artifacts;
  if (Array.isArray(arts)) {
    out.external_metadata = { artifacts: arts.filter((a) => a && typeof a === 'object').map((a) => {
      const o = pick(a, ['artifact_id', 'title', 'updated_at']);
      if (typeof o.title === 'string') o.title = maskSecrets(o.title);
      return o;
    }) };
  }
  return out;
}

// Mask every string in a value, recursively.
function maskDeep(v) {
  if (typeof v === 'string') return maskSecrets(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = maskDeep(v[k]);
    return o;
  }
  return v;
}

function utf8Bytes(s) {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length;
}

function keepSessionEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let out;
  if (raw.type === 'user' || raw.type === 'assistant') {
    const m = raw.message || {};
    let content = m.content;
    if (typeof content === 'string') content = [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return null;
    if (raw.type === 'user') {
      content = content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: stripSystemReminders(b.text) } : b))
        .filter((b) => !(b && b.type === 'text' && b.text === ''));
      if (!content.length) return null;
    }
    out = { type: raw.type, ...pick(raw, ['uuid', 'created_at', 'parent_tool_use_id']),
      message: { ...pick(m, ['role', 'model']), content: maskDeep(content) } };
  } else if (raw.type === 'result') {
    out = { type: 'result', ...pick(raw, ['uuid', 'created_at', 'is_error', 'num_turns', 'duration_ms', 'total_cost_usd', 'subtype']) };
  } else if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
    out = { type: 'system', ...pick(raw, ['uuid', 'created_at', 'subtype']) };
  } else {
    return null;
  }
  const size = utf8Bytes(JSON.stringify(out));
  if (size > EVENT_STUB_BYTES) {
    return { uuid: out.uuid, created_at: out.created_at, type: out.type, stub: 'too large (' + (size / 1048576).toFixed(1) + ' MB)' };
  }
  return out;
}

function sessionPage(raw) {
  const data = raw && Array.isArray(raw.data) ? raw.data : [];
  const events = [];
  for (const item of data) {
    const k = keepSessionEvent(item);
    if (k) events.push(k);
  }
  return { events, lastId: raw && typeof raw.last_id === 'string' ? raw.last_id : null, hasMore: !!(raw && raw.has_more) };
}

globalThis.CTSession = { stripSystemReminders, maskSecrets, keepSession, keepSessionEvent, sessionPage, EVENT_STUB_BYTES, SESSION_PAGE_LIMIT };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.CTSession;
}
