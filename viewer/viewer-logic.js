// Viewer page logic: message tree and hash state. Classic script, no imports.
// Messages use the compact shape { id, parent, sender, at, ... }.

function byAtThenIndex(a, b) {
  const x = a.m.at || '', y = b.m.at || '';
  if (x < y) return -1;
  if (x > y) return 1;
  return a.i - b.i;
}

// Children of a parent id (null for roots), ordered by `at` then array order.
function childrenOf(messages, parentId) {
  const ids = {};
  messages.forEach(m => { ids[m.id] = true; });
  return messages
    .map((m, i) => ({ m, i }))
    .filter(e => parentId === null
      ? (e.m.parent == null || !ids[e.m.parent])
      : e.m.parent === parentId)
    .sort(byAtThenIndex)
    .map(e => e.m);
}

// Root to leaf. An unknown leaf falls back to the message with the latest `at`.
function chainFrom(messages, leafId) {
  if (!messages || !messages.length) return [];
  const byId = {};
  messages.forEach(m => { byId[m.id] = m; });
  let cur = byId[leafId];
  if (!cur) {
    const latest = messages.map((m, i) => ({ m, i })).sort(byAtThenIndex).pop();
    cur = latest.m;
  }
  const chain = [];
  const seen = {};
  while (cur && !seen[cur.id]) {
    seen[cur.id] = true;
    chain.push(cur);
    cur = cur.parent != null ? byId[cur.parent] : null;
  }
  return chain.reverse();
}

function siblingsOf(messages, id) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return { ids: [], index: -1 };
  const ids = childrenOf(messages, msg.parent == null ? null : msg.parent)
    .filter(m => msg.parent == null || m.parent === msg.parent)
    .map(m => m.id);
  return { ids, index: ids.indexOf(id) };
}

// Follows the latest child at each step down to a leaf.
function leafUnder(messages, id) {
  const seen = {};
  let cur = id;
  while (!seen[cur]) {
    seen[cur] = true;
    const kids = childrenOf(messages, cur);
    if (!kids.length) break;
    cur = kids[kids.length - 1].id;
  }
  return cur;
}

// New leaf after moving delta siblings over, or null when there is no such sibling.
function switchBranch(messages, id, delta) {
  const s = siblingsOf(messages, id);
  const next = s.ids[s.index + delta];
  if (s.index < 0 || next === undefined) return null;
  return leafUnder(messages, next);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return null; }
}

function parseHash(hash) {
  const out = { chat: null, leaf: null, file: null, version: null };
  const text = String(hash || '').replace(/^#/, '');
  text.split('&').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq);
    if (!Object.prototype.hasOwnProperty.call(out, key)) return;
    const value = safeDecode(part.slice(eq + 1));
    if (value === null || value === '') return;
    if (key === 'version') {
      const n = parseInt(value, 10);
      out.version = isNaN(n) ? null : n;
    } else {
      out[key] = value;
    }
  });
  return out;
}

function formatHash(state) {
  const parts = [];
  ['chat', 'leaf', 'file', 'version'].forEach(key => {
    const v = state && state[key];
    if (v !== null && v !== undefined && v !== '') parts.push(key + '=' + encodeURIComponent(v));
  });
  return parts.length ? '#' + parts.join('&') : '';
}

if (typeof module === 'object' && module.exports) {
  module.exports = { chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash };
}
