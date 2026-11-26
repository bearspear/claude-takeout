// session-core.js: the pure filter for Claude Code and Cowork sessions. A classic script (content.js,
// popup.html and sidepanel.html load it before their own code); module.exports under Node only.
// It keeps the listed fields, strips system reminders from user text, masks known token shapes and
// stubs oversized events. Nothing it drops reaches the panel or the archive.

const EVENT_STUB_BYTES = 2 * 1024 * 1024;
const SESSION_PAGE_LIMIT = 200;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripSystemReminders(text) {
  const out = String(text).replace(SYSTEM_REMINDER_RE, '');
  return out.trim() === '' ? '' : out;
}

const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[po]_[A-Za-z0-9]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[bp]-[A-Za-z0-9-]+/g,
  /Bearer [A-Za-z0-9._~+\/=-]{20,}/g,
];

function maskSecrets(text) {
  let out = String(text);
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
  if (raw.config) out.config = pick(raw.config, ['origin', 'model']);
  Object.assign(out, pick(raw, ['created_at', 'updated_at', 'last_event_at']));
  const arts = raw.external_metadata && raw.external_metadata.artifacts;
  if (Array.isArray(arts)) {
    out.external_metadata = { artifacts: arts.map((a) => pick(a, ['artifact_id', 'title', 'updated_at'])) };
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.CTSession;
}
