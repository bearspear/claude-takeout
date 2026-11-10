// Shared extractors: pure functions of the conversation JSON, used by popup.js and the Node tools.
// A classic script (plain top-level declarations, no modules), so popup.js sees the same global names.

// ============================================================================
// Mojibake Fix: Repair UTF-8 text corrupted via CP1252 misinterpretation
// ============================================================================

// Build comprehensive mojibake repair map (UTF-8 -> CP1252 corruption patterns)
function buildMojibakeMap() {
  const map = {};

  // Unicode ranges to cover
  const ranges = [
    [0x0080, 0x00FF],  // Latin-1 Supplement (ä ö ü ß etc.)
    [0x0100, 0x017F],  // Latin Extended-A
    [0x0180, 0x024F],  // Latin Extended-B
    [0x0250, 0x02AF],  // IPA Extensions
    [0x0370, 0x03FF],  // Greek and Coptic (α β γ ζ etc.)
    [0x0400, 0x04FF],  // Cyrillic
    [0x1E00, 0x1EFF],  // Latin Extended Additional
    [0x2000, 0x206F],  // General Punctuation (" " ' ' – —)
    [0x2070, 0x209F],  // Superscripts and Subscripts (⁰ ¹ ² ³ ₀ ₁ ₂ etc.)
    [0x20A0, 0x20CF],  // Currency Symbols (€)
    [0x2100, 0x214F],  // Letter-like Symbols (ℕ ℤ ℚ ℝ etc.)
    [0x2150, 0x218F],  // Number Forms (fractions, Roman numerals)
    [0x2190, 0x21FF],  // Arrows (→ ← ↔ etc.)
    [0x2200, 0x22FF],  // Mathematical Operators (∀ ∃ ∈ ∅ etc.)
    [0x2300, 0x23FF],  // Miscellaneous Technical
    [0x2500, 0x257F],  // Box Drawing (┌ ─ │ ├ └ etc.)
    [0x2580, 0x259F],  // Block Elements (▀ ▄ █ etc.)
    [0x25A0, 0x25FF],  // Geometric Shapes (□ ◇ ○ ◆ ● etc.)
    [0x2600, 0x26FF],  // Miscellaneous Symbols (☀ ★ etc.)
    [0x2700, 0x27BF],  // Dingbats (✓ ✗ etc.)
    [0x1F300, 0x1F5FF],  // Miscellaneous Symbols and Pictographs (🔥 🎉 etc.)
    [0x1F600, 0x1F64F],  // Emoticons (😀 😂 etc.)
    [0x1F680, 0x1F6FF],  // Transport and Map Symbols (🚀 etc.)
    [0x1F900, 0x1F9FF],  // Supplemental Symbols and Pictographs (🤔 etc.)
  ];

  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp++) {
      try {
        const char = String.fromCodePoint(cp);
        // Encode as UTF-8, then decode those bytes as CP1252
        const utf8Bytes = new TextEncoder().encode(char);
        const broken = new TextDecoder('windows-1252').decode(utf8Bytes);
        if (broken !== char && broken.length > 0) {
          map[broken] = char;
        }
      } catch (e) {
        // Skip characters that can't be processed
      }
    }
  }

  return map;
}

// Lazy-loaded mojibake map
let mojibakeMap = null;
let mojibakeKeys = null;

// Fix mojibake in text
function fixMojibake(text) {
  if (!text) return text;

  // Build map on first use
  if (!mojibakeMap) {
    mojibakeMap = buildMojibakeMap();
    // Sort by length (longest first) to handle multi-char sequences properly, once
    mojibakeKeys = Object.keys(mojibakeMap).sort((a, b) => b.length - a.length);
  }

  for (const broken of mojibakeKeys) {
    text = text.split(broken).join(mojibakeMap[broken]);
  }

  return text;
}

// Extensions that are safe to decode as text. Anything else stays as raw bytes,
// because decoding a PDF, ODT or ZIP as UTF-8 destroys it.
const TEXT_FILE_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'jsx', 'ts', 'tsx',
  'json', 'jsonl', 'csv', 'tsv', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini', 'py', 'sh', 'bash', 'zsh',
  'sql', 'r', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'tex', 'rst'
]);

function isTextFile(filename) {
  const name = filename || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && TEXT_FILE_EXTENSIONS.has(name.substring(dot + 1).toLowerCase());
}

// Trace message chain from current_leaf_message_uuid through parent_message_uuid
// This handles branched conversations where user may have regenerated responses
// ---- Warning badges ----
// The warnings that mean a generated file may not match what Claude made, as the viewer's flags:
// 'script' (a bash command changed it), 'edit' (an edit couldn't be replayed), 'doc' (a Claude Docs
// edit couldn't be rebuilt). The first warning for a file wins.
const FLAG_FOR_WARNING = { artifact_opaque_mutation: 'script', str_replace_failed: 'edit', claude_doc_unreplayed: 'doc' };

function viewerFlags(warnings) {
  const flags = {};
  for (const w of warnings || []) {
    const flag = w && Object.prototype.hasOwnProperty.call(FLAG_FOR_WARNING, w.type) ? FLAG_FOR_WARNING[w.type] : null;
    if (flag && w.filename && !Object.prototype.hasOwnProperty.call(flags, w.filename)) flags[w.filename] = flag;
  }
  return flags;
}

// The warnings in an errors.txt (generateErrorReport's format), for archives exported before the viewer
// carried them: [{ type, filename }].
function warningsFromReport(text) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  const at = t.search(/^## Warnings\s*$/m);
  if (at < 0) return [];
  const section = t.slice(at).split(/^## (?!Warnings)/m)[0];
  const out = [];
  for (const m of section.matchAll(/^### (.+)\n(?:[^\n]*\n)*?- \*\*Type:\*\* ([a-z ]+)$/gm)) {
    out.push({ type: m[2].trim().replace(/ /g, '_'), filename: m[1].trim() });
  }
  return out;
}

// ---- Export health ----
// claude.ai's REST API is undocumented. When its shape changes, an export can come out thin with nothing
// saying so. These checks look for what such a change leaves behind. Each problem: { check, message }.
// Calibrated on real chats: a chat that was opened and never used has no messages and an unchanged
// updated_at, and is healthy.
const KNOWN_BLOCK_TYPES = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image']);

function chatHealth(data) {
  const problems = [];
  const d = data && typeof data === 'object' ? data : {};
  const messages = Array.isArray(d.chat_messages) ? d.chat_messages : null;
  const changed = Date.parse(d.updated_at) - Date.parse(d.created_at) > 5000;
  if (!messages || (!messages.length && changed)) {
    problems.push({ check: 'no_messages', message: messages
      ? 'claude.ai returned no messages for this chat, although it was changed after it was created.'
      : 'claude.ai returned this chat without its messages.' });
    return problems;
  }
  const hollow = messages.filter((m) => !m || !Array.isArray(m.content) || (!m.content.length && !m.text)).length;
  if (hollow) problems.push({ check: 'empty_messages', message: `${hollow} of ${messages.length} messages came back with no content.` });
  const ids = new Set(messages.map((m) => m && m.uuid));
  const children = new Map();
  for (const m of messages) if (m) children.set(m.parent_message_uuid, (children.get(m.parent_message_uuid) || 0) + 1);
  const branched = [...children.values()].some((n) => n > 1);
  if (branched && !ids.has(d.current_leaf_message_uuid)) {
    problems.push({ check: 'unknown_branch', message: "claude.ai didn't say which branch of this chat is current, so messages from every branch are exported in one sequence." });
  }
  const unknown = new Map();
  for (const m of messages) for (const b of (m && Array.isArray(m.content) ? m.content : [])) {
    const type = b && typeof b === 'object' ? String(b.type) : typeof b;
    if (!KNOWN_BLOCK_TYPES.has(type)) unknown.set(type, (unknown.get(type) || 0) + 1);
  }
  if (unknown.size) {
    problems.push({ check: 'unknown_blocks', message: `Content the export doesn't show yet: ${[...unknown].map(([t, n]) => `${t} (${n})`).join(', ')}. It is kept in original.json.` });
  }
  return problems;
}

function getMessageChain(data) {
  const messages = data.chat_messages || [];
  const currentLeaf = data.current_leaf_message_uuid;

  // Build lookup by uuid
  const byUuid = {};
  for (const msg of messages) {
    byUuid[msg.uuid] = msg;
  }

  // If no leaf specified, fall back to all messages in order
  if (!currentLeaf || !byUuid[currentLeaf]) {
    return messages;
  }

  // Trace back from leaf to root. A parent loop (a damaged or crafted file) ends the walk.
  const chain = [];
  const seen = new Set();
  let uuid = currentLeaf;
  while (uuid && byUuid[uuid] && !seen.has(uuid)) {
    seen.add(uuid);
    chain.push(byUuid[uuid]);
    uuid = byUuid[uuid].parent_message_uuid;
  }

  // Reverse to get chronological order
  chain.reverse();
  return chain;
}

// Extract artifacts from create_file tool calls
// Extract artifacts with per-turn versioning. Walks the message chain in
// chronological order maintaining per-artifact state, replays str_replace
// edits against the running content, and snapshots each artifact at the end
// of every assistant turn in which it changed.
//
// For artifacts that were never edited (single create_file / artifacts create
// / heredoc with no follow-up): only the unversioned filename is emitted.
//
// For artifacts that were edited (any combination of create_file, str_replace,
// rewrite, artifacts update): each post-turn snapshot is emitted as
// <base>_vN<ext>, and the final state is additionally emitted under the
// unversioned <base><ext> so downstream lookups (present_files embedding,
// external tooling) still resolve to the latest content.
//
// Failed or ambiguous str_replace operations (no match, or multiple matches)
// are skipped and recorded in errorCollector when one is supplied.
// Newer conversations use Bash, Write, Edit and Read where older ones used
// bash_tool, create_file, str_replace and view.
function isBashTool(name) {
  return name === 'bash_tool' || name === 'Bash';
}

// `cat > path << DELIM ... DELIM` or `cat << DELIM > path ...`, with any delimiter, quoted or not.
// heredocMatches returns them in command order, each shaped like a match of the first form:
// [0] the whole heredoc, [1] path, [2] the quote (empty when bash expands the body), [4] body
// (undefined when empty), and index. Use heredocPath and heredocBody on them.
const HEREDOC_RE = /cat\s*>\s*(\S+?)\s*<<-?\s*(['"]?)(\w+)\2[^\n]*\n(?:([\s\S]*?)\n)??[ \t]*\3[ \t]*(?=\n|$)/g;
const HEREDOC_TARGET_LAST_RE = /cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*>\s*(\S+)[^\n]*\n(?:([\s\S]*?)\n)??[ \t]*\2[ \t]*(?=\n|$)/g;

function heredocMatches(command) {
  const text = String(command || '');
  const found = Array.from(text.matchAll(HEREDOC_RE));
  for (const m of text.matchAll(HEREDOC_TARGET_LAST_RE)) {
    const shaped = [m[0], m[3], m[1], m[2], m[4]];
    shaped.index = m.index;
    found.push(shaped);
  }
  return found.sort((a, b) => a.index - b.index);
}

function heredocPath(match) {
  return match[1].replace(/^['"]|['"]$/g, '');
}

// The text bash writes for a heredoc match: with <<-, leading tabs are removed from every line.
function heredocBody(match) {
  const body = match[4] || '';
  return /^[^\n]*<<-/.test(match[0]) ? body.replace(/^\t+/gm, '') : body;
}

// The files a Bash command writes with a heredoc, for the viewer's cards.
function heredocFiles(command) {
  return heredocMatches(command).map((match) => ({ path: heredocPath(match), text: heredocBody(match) }));
}

// A title made safe as a file name: letters, digits and marks from any script, _ and -, with spaces
// as _, at most 60 characters. '' when nothing is left. extract_artifacts.py's safe_file_title matches.
function safeFileTitle(label) {
  return Array.from(String(label || '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s+/g, '_')).slice(0, 60).join('');
}

// ---- Claude Docs documents ----
// claude.ai's Docs tools (named <connector>Claude_Docs__<action>) write a document in steps: batch
// creates it from Markdown with <?claude block k?> placeholders, some of them pending sections; update
// replaces a pending section, by the id its batch result gave it, with Markdown, or replaces found
// text; a later batch on the document can do the same beside creating a diagram it embeds; create adds
// a comment. The document lives on claude.ai, so it is rebuilt from these calls. extract_artifacts.py
// does the same; keep them in step.
const CLAUDE_DOCS_RE = /Claude_Docs__(\w+)$/;
function claudeDocsAction(name) {
  const m = CLAUDE_DOCS_RE.exec(String(name || ''));
  return m ? m[1] : null;
}

// The JSON value at the start of text, which may go on with plain words after it. null if none.
function leadingJson(text) {
  const t = String(text || '').trimStart();
  if (!/^[{[]/.test(t)) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) { try { return JSON.parse(t.slice(0, i + 1)); } catch (e) { return null; } }
    }
  }
  return null;
}

function resultText(result) {
  const content = result && result.content;
  if (typeof content === 'string') return content;
  const first = Array.isArray(content) ? content.find((c) => c && c.type === 'text') : null;
  return first ? String(first.text || '') : '';
}

function docPayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  try { return JSON.parse(payload); } catch (e) { return null; }
}

const DOC_PLACEHOLDER_RE = /<\?claude block ([A-Za-z0-9_]+)\?>/g;

// From a batch call that creates a document, and its result: { key, title, markdown, blocks, url, idmap,
// unconfirmed }, idmap taking each pending section's node id to its placeholder name. Without a usable
// result (the chat stopped, or the reply changed shape) the document is still returned, keyed by the
// tool call, with no section ids and unconfirmed set. null when the call doesn't create a document.
function claudeDocCreated(input, result, toolUseId = '') {
  const create = input && input.container && input.container.create;
  const doc = create && create.doc;
  if (!doc || typeof doc !== 'object' || typeof doc.markdown !== 'string') return null;
  const blocks = doc.blocks && typeof doc.blocks === 'object' ? doc.blocks : {};
  const title = String(create.name || ((/^#\s+(.+)$/m.exec(doc.markdown) || [])[1]) || 'Document');
  const text = resultText(result);
  const parsed = leadingJson(text) || {};
  const ack = (Array.isArray(parsed.acks) ? parsed.acks : []).find((a) => a && typeof a === 'object' && a.id && typeof a.xml === 'string');
  if (!ack) return { key: `doc:pending:${toolUseId}`, title, markdown: doc.markdown, blocks, url: '', idmap: {}, unconfirmed: true };
  const session = ack.session || ((/id='([^'.]+)\./.exec(ack.xml) || [])[1]) || '';
  const pendingIds = Array.from(ack.xml.matchAll(/<pending id='([^']+)'/g), (m) => (m[1].startsWith('.') ? session + m[1] : m[1]));
  const pendingKeys = Array.from(doc.markdown.matchAll(DOC_PLACEHOLDER_RE), (m) => m[1])
    .filter((k) => blocks[k] && typeof blocks[k] === 'object' && blocks[k].type === 'pending');
  const idmap = {};
  pendingIds.forEach((id, i) => { if (pendingKeys[i]) idmap[id] = pendingKeys[i]; });
  const url = (parsed.frame && typeof parsed.frame === 'object' && parsed.frame.url) || ((/https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/.exec(text) || [])[0]) || '';
  return { key: `doc:${ack.id}`, title, markdown: doc.markdown, blocks, url: String(url), idmap, unconfirmed: false };
}

// ---- Companion HTML for Claude Docs documents ----
// claude.ai draws a document's diagrams only on the document's own page, so the rebuild shows each by
// caption. When the owner wants them, they ask Claude for a self-contained HTML copy, which arrives as an
// ordinary file. docCompanions finds those copies: an HTML file sent (SendUserFile, present_files) in the
// message that exported the document (Claude_Docs__export, whose result names the document's live link),
// or else a whole HTML page whose <title> or first <h1> is the document's title. pathNames maps a sandbox path
// to its name in artefacts/. Returns { <doc key>: [names] }.
const DOC_CAPTION_RE = /^\[embedded content(?:: .*)?\]$/gm;
function docTitleKey(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };
  return String(text || '').replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(\w+));/gi, (m, dec, hex, name) => {
      if (name) return Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : m;
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}
function docCompanions(data, artifacts, index, pathNames = {}) {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const docs = [];
  const docNames = new Set();
  for (const [key, entry] of Object.entries(index || {})) {
    if (!key.startsWith('doc:') || !entry || typeof artifacts[entry.filename] !== 'string') continue;
    const md = artifacts[entry.filename];
    const title = docTitleKey((/^#\s+(.+)$/m.exec(md) || [])[1] || '');
    const url = (/^\*Live document on claude\.ai: (\S+)\*$/m.exec(md) || [])[1] || '';
    docs.push({ key, title, url });
    docNames.add(entry.filename);
    for (const v of entry.versions || []) docNames.add(v);
  }
  const html = (name) => typeof name === 'string' && /\.html?$/i.test(name) && has(artifacts, name) && typeof artifacts[name] === 'string' && !docNames.has(name);
  const out = {};
  const add = (key, name) => { out[key] = out[key] || []; if (!out[key].includes(name)) out[key].push(name); };

  for (const msg of getMessageChain(data)) {
    if (msg.sender !== 'assistant') continue;
    const results = {};
    for (const c of msg.content || []) if (c && c.type === 'tool_result' && c.tool_use_id) results[c.tool_use_id] = c;
    const exported = [];
    for (const c of msg.content || []) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use' && claudeDocsAction(c.name) === 'export') {
        const parsed = leadingJson(resultText(results[c.id])) || {};
        const url = parsed.frame && typeof parsed.frame === 'object' ? parsed.frame.url : '';
        const doc = url ? docs.find((d) => d.url === url) : null;
        if (doc && !exported.includes(doc)) exported.push(doc);
        continue;
      }
      if (!exported.length) continue;
      const paths = [];
      if (c.type === 'tool_use' && /(^|__)(SendUserFile|present_files)$/.test(String(c.name || '')) && c.input) {
        for (const list of [c.input.files, c.input.filepaths]) if (Array.isArray(list)) paths.push(...list);
      }
      for (const d of Array.isArray(c.file_deliveries) ? c.file_deliveries : []) if (d && d.path) paths.push(d.path);
      for (const p of paths) {
        const name = typeof p === 'string' && has(pathNames, p) ? pathNames[p] : null;
        if (html(name)) for (const doc of exported) add(doc.key, name);
      }
    }
  }

  // Versioned snapshots (<base>_vN beside <base>) stand for the same file.
  const names = Object.keys(artifacts).filter((n) => html(n) && !(/_v\d+(\.html?)$/i.test(n) && has(artifacts, n.replace(/_v\d+(\.html?)$/i, '$1')))).sort();
  const headings = {};
  for (const n of names) {
    const text = artifacts[n].slice(0, 200000);
    // Only a whole page: a piece Claude assembles one from (a body.html) is not a copy.
    if (!/<!doctype html|<html[\s>]/i.test(text)) { headings[n] = []; continue; }
    headings[n] = [(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1], (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text) || [])[1]]
      .filter((h) => h !== undefined).map(docTitleKey);
  }
  for (const doc of docs) {
    if (out[doc.key] || !doc.title) continue;
    for (const n of names) {
      if (!headings[n].includes(doc.title)) continue;
      if ((out[doc.key] || []).some((m) => artifacts[m] === artifacts[n])) continue;  // a delivered copy of the same file
      add(doc.key, n);
    }
  }
  return out;
}

// The note at the top of a Claude Docs document about its diagrams and its self-contained copies.
// Returns { markdown, captions }: the text with the note under its title, and how many diagrams show by
// caption.
function docCompanionNote(markdown, names = []) {
  const md = String(markdown);
  const captions = (md.match(DOC_CAPTION_RE) || []).length;
  const link = (n) => `[${n.replace(/([\\[\]])/g, '\\$1')}](${encodeURI(n).replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
  const links = names.map(link).join(', ');
  const one = captions === 1;
  const live = /^\*Live document on claude\.ai: \S+\*$/m.test(md);
  let note = '';
  if (captions && names.length) {
    note = `> **Diagram${one ? '' : 's'}:** claude.ai draws ${one ? "this document's diagram" : `this document's ${captions} diagrams`} only on the document's own page, so here ${one ? 'it shows' : 'they show'} by caption. For the ${one ? 'diagram' : 'diagrams'}, see the self-contained copy Claude made in this chat: ${links}.`;
  } else if (captions) {
    note = `> **⚠️ Diagram${one ? '' : 's'} not included.** claude.ai draws ${one ? "this document's diagram" : `this document's ${captions} diagrams`} only on the document's own page, so here ${one ? 'it shows' : 'they show'} by caption, and this chat has no self-contained copy of the document. To keep ${one ? 'it' : 'them'}, ask Claude in the chat to export the document as a self-contained HTML file, then export the chat again.${live ? ' The live document is linked at the end.' : ''}`;
  } else if (names.length) {
    note = `> **Self-contained copy:** Claude made one of this document in this chat: ${links}.`;
  }
  if (!note) return { markdown: md, captions };
  const heading = /^#\s+.+$/m.exec(md);
  if (!heading || heading.index !== 0) return { markdown: `${note}\n\n${md}`, captions };
  const end = heading[0].length;
  return { markdown: `${md.slice(0, end)}\n\n${note}${md.slice(end)}`, captions };
}

// The key a Docs call writes to, for the viewer's cards: 'doc:<node id>' (or 'doc:pending:<call id>'
// for a document whose batch result is missing), or null.
function claudeDocKey(block, result) {
  const action = claudeDocsAction(block && block.name);
  const input = (block && block.input) || {};
  if (action === 'batch') {
    const made = claudeDocCreated(input, result, block.id);
    if (made) return made.key;
    // A batch on an existing document: the document its first prose update edits.
    const edit = (Array.isArray(input.batch) ? input.batch : []).find((m) => m && typeof m === 'object' && m.verb === 'update' && m.ref && typeof m.ref === 'object' && m.ref.id);
    return edit ? `doc:${edit.ref.id}` : null;
  }
  if (action === 'update' && input.ref && input.ref.id) return `doc:${input.ref.id}`;
  return null;
}

// One placeholder's text: a date as written, a mention left out, an embedded diagram or chart by its
// caption (as claude.ai's own Markdown export shows it), other kinds noted.
function renderDocBlock(b) {
  if (!b || typeof b !== 'object' || typeof b.type !== 'string') return "*(An unsupported block isn't included in this export.)*";
  if (b.type === 'date') return String(b.value || '');
  if (b.type === 'mention') return '';
  if (b.type === 'embed') {
    const caption = typeof b.caption === 'string' ? b.caption.replace(/\s+/g, ' ').trim() : '';
    return caption ? `[embedded content: ${caption}]` : '[embedded content]';
  }
  return `*(A ${b.type} block isn't included in this export.)*`;
}

// The Markdown for a document as rebuilt so far: placeholders filled (a section's own chips first),
// then Claude's comments and the link to the live document.
function renderClaudeDoc(d) {
  const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const isPending = (b) => !!b && typeof b === 'object' && b.type === 'pending';
  // A section's text, its own chips filled first; a placeholder planted inside it is a section of its
  // own, named <section>/<key>.
  const section = (name, depth) => {
    if (!own(d.contents, name)) return "*(This section wasn't written.)*";
    const local = own(d.sectionBlocks, name) ? d.sectionBlocks[name] : null;
    return d.contents[name].replace(DOC_PLACEHOLDER_RE, (m2, k2) => {
      if (!own(local, k2)) return own(d.blocks, k2) ? renderDocBlock(d.blocks[k2]) : '';
      return isPending(local[k2]) && depth < 8 ? section(`${name}/${k2}`, depth + 1) : renderDocBlock(local[k2]);
    });
  };
  let out = d.markdown.replace(DOC_PLACEHOLDER_RE, (m, k) => {
    if (!own(d.blocks, k)) return '';
    return isPending(d.blocks[k]) ? section(k, 0) : renderDocBlock(d.blocks[k]);
  });
  out = out.replace(/ · (?=\n|$)/g, '').replace(/(^|\n) · /g, '$1').replace(/\s+$/, '');
  // A comment's later lines are indented, so a comment of several paragraphs stays one list item.
  const item = (body) => body.split('\n').map((line, i) => (i === 0 || !line ? line : `  ${line}`)).join('\n');
  const tail = [];
  if (d.comments.length) tail.push('## Comments\n\n' + d.comments.map((c) => `- ${c.anchor ? `On “${c.anchor}”: ` : ''}${item(c.body)}`).join('\n'));
  if (d.url) tail.push(`*Live document on claude.ai: ${d.url}*`);
  return out + (tail.length ? '\n\n---\n\n' + tail.join('\n\n') : '') + '\n';
}

// Where text occurs in a document's source, in reading order: the Markdown around the placeholders
// (outside them), and each written section at its placeholder. [{ section: null | name, at }]
function docFindAll(d, text) {
  const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const hits = [];
  const walk = (source, name, order, depth) => {
    const spans = Array.from(source.matchAll(DOC_PLACEHOLDER_RE));
    for (let i = source.indexOf(text); i !== -1; i = source.indexOf(text, i + text.length)) {
      if (!spans.some((s) => i < s.index + s[0].length && i + text.length > s.index)) hits.push({ order: [...order, i], at: i, section: name });
    }
    for (const s of spans) {
      const child = name === null ? s[1] : `${name}/${s[1]}`;
      if (own(d.contents, child) && depth < 8) walk(d.contents[child], child, [...order, s.index], depth + 1);
    }
  };
  walk(d.markdown, null, [], 0);
  const before = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  return hits.sort((a, b) => before(a.order, b.order));
}

// The pending block ids a Docs write's reply gives, in order, in full (a reply prints later ids short:
// '.25' is '<session>.25'). ack: { session, xml }; op: the operation's index, when the reply has one
// <doc op='N'> part per operation.
function docPendingIds(ack, op) {
  if (!ack || typeof ack !== 'object' || typeof ack.xml !== 'string') return [];
  const parts = ack.xml.split(/(?=<doc op=')/);
  const mine = parts.find((p) => p.startsWith(`<doc op='${op}'`)) || (parts.length <= 2 ? ack.xml : '');
  const session = typeof ack.session === 'string' ? ack.session : ((/id='([^'.]+)\./.exec(ack.xml) || [])[1]) || '';
  return Array.from(mine.matchAll(/<pending id='([^']+)'/g), (m) => (m[1].startsWith('.') ? session + m[1] : m[1]));
}

// Applies a Docs update's operations to a rebuilt document: a pending section filled with Markdown, or
// a find-and-replace of text (the nth match, the first by default). Anything else is left alone.
// { changed, unreplayed }
function applyDocOps(d, ops, ack) {
  const list = Array.isArray(ops) ? ops : [];
  let changed = false, unreplayed = list.length === 0;  // an update with no operations changed something else
  for (const [index, op] of list.entries()) {
    const ok = op && typeof op === 'object' && op.op === 'replace' && op.target && typeof op.target === 'object';
    const w = ok && op.with && typeof op.with === 'object' ? op.with : {};
    const content = w.from && typeof w.from === 'object' ? w.from.content : undefined;
    const ids = ok && Array.isArray(op.target.ids) ? op.target.ids : [];
    if (ok && op.target.kind !== 'find' && ids.length === 1 && Object.prototype.hasOwnProperty.call(d.idmap, ids[0]) && typeof content === 'string') {
      const section = d.idmap[ids[0]];
      const local = w.blocks && typeof w.blocks === 'object' ? w.blocks : null;
      d.contents[section] = content;
      d.sectionBlocks[section] = local;
      // Placeholders the fill plants for later, matched in order to the ids its reply gives.
      const planted = Array.from(content.matchAll(DOC_PLACEHOLDER_RE), (m) => m[1])
        .filter((k) => local && Object.prototype.hasOwnProperty.call(local, k) && local[k] && typeof local[k] === 'object' && local[k].type === 'pending');
      docPendingIds(ack, index).forEach((id, i) => { if (planted[i]) d.idmap[id] = `${section}/${planted[i]}`; });
      changed = true;
    } else if (ok && op.target.kind === 'find' && typeof op.target.text === 'string' && op.target.text && !op.target.within
      && (w.as === 'text' || w.as === 'markdown') && typeof content === 'string') {
      const nth = Number.isInteger(op.target.nth) && op.target.nth > 0 ? op.target.nth : 1;
      const hit = docFindAll(d, op.target.text)[nth - 1];
      if (!hit) { unreplayed = true; continue; }
      const swap = (s) => s.slice(0, hit.at) + content + s.slice(hit.at + op.target.text.length);
      if (hit.section === null) d.markdown = swap(d.markdown);
      else d.contents[hit.section] = swap(d.contents[hit.section]);
      changed = true;
    } else unreplayed = true;
  }
  return { changed, unreplayed };
}

// tool_use ids whose tool_result reported an error. A failed file tool changed
// nothing, so replaying it would invent an edit that never happened.
function failedToolUseIds(messages) {
  const ids = new Set();
  for (const msg of messages) {
    for (const block of (msg.content || [])) {
      if (block.type === 'tool_result' && block.is_error && block.tool_use_id) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

// index, when given, is filled as index[key] = { path, filename, versions: [filename...],
// messages: [msg uuid that made each version] } for the viewer; the return value is unchanged.
function extractArtifacts(data, errorCollector = null, index = null) {
  const artifacts = {};
  const messages = getMessageChain(data);
  const failedIds = failedToolUseIds(messages);

  // Map content types to file extensions
  const typeToExt = {
    'text/markdown': '.md',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/css': '.css',
    'text/csv': '.csv',
    'application/javascript': '.js',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/x-python': '.py',
    'text/x-java': '.java',
    'text/x-c': '.c',
    'text/x-cpp': '.cpp',
    'text/x-csharp': '.cs',
    'text/x-ruby': '.rb',
    'text/x-go': '.go',
    'text/x-rust': '.rs',
    'text/x-swift': '.swift',
    'text/x-kotlin': '.kt',
    'text/x-typescript': '.ts',
    'text/x-sql': '.sql',
    'text/x-shell': '.sh',
    'text/x-yaml': '.yaml',
    'image/svg+xml': '.svg'
  };

  // Per-artifact state. Keyed by full path (for create_file / str_replace /
  // rewrite / bash heredoc) or `artifact:<id-or-title>` (for the artifacts
  // tool). Each entry tracks current content, the basename to write under,
  // a list of post-turn snapshots, and whether the current turn edited it.
  const state = Object.create(null);  // any key, __proto__ included
  const docs = Object.create(null);  // Claude Docs: 'doc:<node id>' -> { title, markdown, blocks, contents, comments, url, idmap, filename }
  const resultsById = new Map();
  for (const m of messages) for (const b of (m.content || [])) if (b && b.type === 'tool_result' && b.tool_use_id) resultsById.set(b.tool_use_id, b);

  const basenameOf = (p) => zipSafeName((p || '').split('/').pop());
  const splitExt = (name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? { base: name.substring(0, dot), ext: name.substring(dot) }
      : { base: name, ext: '' };
  };

  function setContent(key, content, basename) {
    if (!state[key]) {
      state[key] = { current: content, basename, versions: [], versionMsgs: [], editedThisTurn: true };
    } else {
      state[key].current = content;
      state[key].editedThisTurn = true;
    }
  }

  function applyStrReplace(path, oldStr, newStr, replaceAll = false) {
    const s = state[path];
    if (!s) return { ok: false, reason: 'no prior create_file for this path' };
    if (!oldStr) return { ok: false, reason: 'empty old_str' };

    if (replaceAll) {
      if (!s.current.includes(oldStr)) return { ok: false, reason: 'old_str not found in current state' };
      s.current = s.current.split(oldStr).join(newStr);
      s.editedThisTurn = true;
      return { ok: true };
    }

    // Count occurrences of oldStr in current content. The real str_replace
    // tool requires uniqueness; mirror that here.
    let count = 0;
    let idx = s.current.indexOf(oldStr);
    const firstIdx = idx;
    while (idx !== -1) {
      count++;
      if (count > 1) break;
      idx = s.current.indexOf(oldStr, idx + 1);
    }

    if (count === 0) return { ok: false, reason: 'old_str not found in current state' };
    if (count > 1) return { ok: false, reason: 'old_str matches multiple times (ambiguous)' };

    s.current = s.current.slice(0, firstIdx) + newStr + s.current.slice(firstIdx + oldStr.length);
    s.editedThisTurn = true;
    return { ok: true };
  }

  for (const msg of messages) {
    for (const block of (msg.content || [])) {
      if (block.type !== 'tool_use') continue;
      // A failed bash command can still have written its heredoc, so only file
      // tools are skipped.
      if (failedIds.has(block.id) && !isBashTool(block.name)) continue;
      const input = block.input || {};

      if (block.name === 'create_file') {
        const path = input.path || '';
        const fileText = input.file_text || '';
        if (path && fileText) {
          setContent(path, fileText, basenameOf(path));
        }
      } else if (block.name === 'Write') {
        const path = input.file_path || '';
        const fileText = input.content || '';
        if (path && fileText) {
          setContent(path, fileText, basenameOf(path));
        }
      } else if (block.name === 'str_replace' || block.name === 'Edit') {
        const isEdit = block.name === 'Edit';
        const path = (isEdit ? input.file_path : input.path) || '';
        const oldStr = (isEdit ? input.old_string : input.old_str) || '';
        const rawNewStr = isEdit ? input.new_string : input.new_str;
        const newStr = rawNewStr != null ? rawNewStr : '';
        if (path) {
          const result = applyStrReplace(path, oldStr, newStr, isEdit && input.replace_all === true);
          if (!result.ok && errorCollector) {
            errorCollector.addWarning(
              'str_replace_failed',
              basenameOf(path),
              `str_replace skipped: ${result.reason}`,
              { path, note: 'The replacement could not be applied; the exported artifact may be missing this edit.' }
            );
          }
        }
      } else if (block.name === 'rewrite' || block.name === 'create_or_overwrite') {
        const path = input.path || '';
        const fileText = input.file_text || input.content || '';
        if (path && fileText) {
          setContent(path, fileText, basenameOf(path));
        }
      } else if (block.name === 'artifacts' && ['create', 'update', 'rewrite'].includes(input.command)) {
        // create and rewrite carry the whole text. update carries either the whole text or,
        // as claude.ai's artifacts tool usually sent it, an old_str/new_str edit.
        const content = input.content || '';
        const id = input.id || '';
        const title = input.title || '';
        const type = input.type || 'text/plain';
        const key = `artifact:${id || title}`;

        if (content && (id || title)) {
          const ext = typeToExt[type] || '.txt';
          const baseName = safeFileTitle(title || id) || safeFileTitle(id) || 'artifact';
          const filename = baseName.endsWith(ext) ? baseName : baseName + ext;
          setContent(key, content, filename);
        } else if (input.command === 'update' && (id || title) && typeof input.old_str === 'string') {
          const result = applyStrReplace(key, input.old_str, input.new_str || '');
          if (!result.ok && errorCollector) {
            const name = state[key] ? state[key].basename : String(title || id);
            errorCollector.addWarning(
              'str_replace_failed',
              name,
              `artifact update skipped: ${result.reason}`,
              { path: key, note: 'The update could not be applied; the exported artifact may be missing this edit.' }
            );
          }
        }
      } else if (claudeDocsAction(block.name)) {
        const action = claudeDocsAction(block.name);
        // Once per document: an edit the chat can't rebuild.
        const warnDoc = (d, key, message) => {
          if (d.warned || !errorCollector) return;
          d.warned = true;
          errorCollector.addWarning('claude_doc_unreplayed', d.filename, message,
            { path: key, note: d.url ? `Open the live document: ${d.url}` : 'Open the document on claude.ai.' });
        };
        const made = action === 'batch' ? claudeDocCreated(input, resultsById.get(block.id), block.id) : null;
        if (made) {
          docs[made.key] = { ...made, contents: {}, sectionBlocks: {}, comments: [], filename: `${safeFileTitle(made.title) || 'Document'}.md`, warned: false, project: '' };
          setContent(made.key, renderClaudeDoc(docs[made.key]), docs[made.key].filename);
          if (made.unconfirmed) warnDoc(docs[made.key], made.key, "This Claude Docs document's sections couldn't be matched to its edits, because the tool's reply is missing from the chat; they are shown as not written.");
        } else if (action === 'batch') {
          // A batch on an existing document: its prose updates are replayed like update calls, and a
          // widget it creates (a diagram or chart) shows through the section that embeds it. Any other
          // member can't be replayed.
          const target = input.container && input.container.id;
          const members = Array.isArray(input.batch) ? input.batch : [];
          const touched = new Map();  // key -> whether some edit to it couldn't be replayed
          let unknown = members.length === 0;
          const reply = leadingJson(resultText(resultsById.get(block.id))) || {};
          const acks = Array.isArray(reply.acks) ? reply.acks : [];  // one per member, in order
          for (const [i, m] of members.entries()) {
            const docKey = m && typeof m === 'object' && m.ref && typeof m.ref === 'object' && m.ref.id ? `doc:${m.ref.id}` : null;
            if (docKey && docs[docKey] && m.verb === 'update' && m.engine === 'prose') {
              const d = docs[docKey];
              if (target) d.project = String(target);
              const r = applyDocOps(d, (docPayload(m.payload) || {}).ops, acks[i]);
              if (r.changed) setContent(docKey, renderClaudeDoc(d), d.filename);
              touched.set(docKey, touched.get(docKey) || r.unreplayed);
            } else if (!(m && typeof m === 'object' && m.verb === 'create' && m.engine === 'widget')) unknown = true;
          }
          const fallback = target && Object.keys(docs).find((k) => k === `doc:${target}` || docs[k].project === target);
          if (unknown && fallback && !touched.has(fallback)) touched.set(fallback, true);
          for (const [key, bad] of touched) {
            if (bad || unknown) warnDoc(docs[key], key, 'A batch of edits to this Claude Docs document could not be rebuilt from the chat; the exported copy may differ from the document on claude.ai.');
          }
        } else if (action === 'update' || action === 'create') {
          const payload = docPayload(input.payload) || {};
          const ref = action === 'update' ? input.ref : (payload.value && payload.value.parent);
          const key = ref && ref.id ? `doc:${ref.id}` : null;
          const d = key ? docs[key] : null;
          if (d && input.container && input.container.id) d.project = String(input.container.id);
          if (d && action === 'create' && payload.value && typeof payload.value.body === 'string') {
            const anchor = payload.value.parent && payload.value.parent.anchor;
            d.comments.push({ anchor: anchor && anchor.text ? String(anchor.text) : '', body: payload.value.body });
            setContent(key, renderClaudeDoc(d), d.filename);
          } else if (d && action === 'update') {
            const { changed, unreplayed } = applyDocOps(d, payload.ops, leadingJson(resultText(resultsById.get(block.id))));
            if (changed) setContent(key, renderClaudeDoc(d), d.filename);
            if (unreplayed) warnDoc(d, key, 'An edit to this Claude Docs document could not be rebuilt from the chat; the exported copy may differ from the document on claude.ai.');
          }
        }
      } else if (isBashTool(block.name)) {
        const command = input.command || '';
        for (const match of heredocMatches(command)) {
          const filepath = heredocPath(match);
          const content = heredocBody(match);
          const filename = basenameOf(filepath);
          if (filename && content) {
            setContent(filepath, content, filename);
          }
        }
      }
    }

    // End-of-turn snapshot: any artifact edited during this assistant message
    // gets a new version. We also snapshot on human turns (no-op normally,
    // but defensive in case tool_use appears under a non-assistant sender).
    if (msg.sender === 'assistant' || msg.sender === 'human') {
      for (const key of Object.keys(state)) {
        const s = state[key];
        if (s.editedThisTurn) {
          s.versions.push(s.current);
          s.versionMsgs.push(msg.uuid);
          s.editedThisTurn = false;
        }
      }
    }
  }

  // Safety net: if the very last operation wasn't followed by an end-of-turn
  // sweep (shouldn't happen with a normal message chain, but be defensive),
  // capture the final state.
  for (const key of Object.keys(state)) {
    const s = state[key];
    if (s.editedThisTurn) {
      s.versions.push(s.current);
      s.versionMsgs.push(messages.length ? messages[messages.length - 1].uuid : null);
      s.editedThisTurn = false;
    }
  }

  // Final emission. Each artifact claims every name it writes: <base><ext>, plus
  // <base>_v1<ext> ... when it has versions. If another artifact already holds any
  // of them (two paths with one basename, or a file Claude itself named
  // report_v1.html), this one becomes <base>_2<ext> and so on, so nothing is
  // silently overwritten.
  const usedNames = new Set();

  for (const key of Object.keys(state)) {
    const s = state[key];
    let { base, ext } = splitExt(s.basename);
    const namesFor = (b) => s.versions.length <= 1
      ? [`${b}${ext}`]
      : [`${b}${ext}`, ...s.versions.map((_, i) => `${b}_v${i + 1}${ext}`)];

    let outBase = base;
    let collision = 0;
    while (namesFor(outBase).some((n) => usedNames.has(n))) {
      collision++;
      outBase = `${base}_${collision + 1}`;
    }
    for (const n of namesFor(outBase)) usedNames.add(n);
    if (collision > 0 && errorCollector) {
      errorCollector.addWarning(
        'artifact_basename_collision',
        `${outBase}${ext}`,
        `Another artifact already uses a file name that "${base}${ext}" needs. This artifact was renamed to "${outBase}${ext}" to avoid overwriting.`,
        { path: key, note: 'Check that both artifacts are intended; the renamed copy still preserves all versions.' }
      );
    }

    if (index) {
      const names = s.versions.length <= 1
        ? [`${outBase}${ext}`]
        : s.versions.map((_, i) => `${outBase}_v${i + 1}${ext}`);
      index[key] = { path: key, filename: `${outBase}${ext}`, versions: names, messages: s.versionMsgs.slice() };
    }

    // defineProperty, so a file named __proto__ is a file, not the object's prototype.
    const put = (name, content) => Object.defineProperty(artifacts, name, { value: content, enumerable: true, writable: true, configurable: true });
    if (s.versions.length <= 1) {
      // No edits — just emit the single content under the unversioned name.
      put(`${outBase}${ext}`, s.versions[0] != null ? s.versions[0] : s.current);
    } else {
      // Emit each per-turn version and the unversioned final.
      for (let i = 0; i < s.versions.length; i++) {
        put(`${outBase}_v${i + 1}${ext}`, s.versions[i]);
      }
      put(`${outBase}${ext}`, s.versions[s.versions.length - 1]);
    }
  }

  return artifacts;
}

// Extract uploaded file metadata from messages (PDFs, images, CSVs, etc. in files_v2)
// A name from chat data, made safe as one ZIP entry name: no folder separators or
// control characters, and never "." or "..". An empty name stays empty.
function zipSafeName(name) {
  const safe = String(name || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_');
  return safe === '.' || safe === '..' ? '_' : safe;
}

// The viewer's key for one upload: its file UUID, or, when it has none, its message and name, so two
// same-named uploads in different prompts stay apart. takeout-viewer.js's buildUploads uses the same rule.
function viewerUploadKey(file) {
  return file.uuid || `${file.messageUuid}\n${file.originalFilename}`;
}

function extractUploadedFiles(data, organizationId = null) {
  const files = [];
  const messages = getMessageChain(data);  // Use ordered message chain
  let promptNum = 0;

  for (const msg of messages) {
    // Track prompt number (only increment for human messages)
    if (msg.sender === 'human') {
      promptNum++;
    }

    // Process files_v2 array (newer format)
    for (const file of (msg.files_v2 || [])) {
      if (file.success && file.file_name) {
        // Prefix filename with prompt number for grouping (p01_, p02_, etc.)
        const promptPrefix = `p${String(promptNum).padStart(2, '0')}_`;
        const prefixedFilename = (promptPrefix + zipSafeName(file.file_name)).normalize('NFC');

        const fileInfo = {
          filename: prefixedFilename,
          originalFilename: file.file_name,  // Keep original for API calls
          promptNum: promptNum,
          messageUuid: msg.uuid || '',
          uuid: file.file_uuid || '',
          kind: file.file_kind || 'unknown',
          createdAt: file.created_at || '',
          path: file.path || ''  // Always capture path for wiggle endpoint
        };

        // Get URL for documents (PDFs)
        if (file.document_asset?.url) {
          fileInfo.url = file.document_asset.url;
          fileInfo.pageCount = file.document_asset.page_count;
        }

        // Get URL for images
        if (file.image_asset?.url) {
          fileInfo.url = file.image_asset.url;
        }

        // Mark blob files for potential JSON fallback extraction
        if (file.file_kind === 'blob') {
          fileInfo.isBlob = true;
        }

        files.push(fileInfo);
      }
    }

    // Process files array (older format)
    for (const file of (msg.files || [])) {
      if (!file.success) continue;

      // Get filename: from path (blob) or file_name (document)
      let originalFilename = '';
      if (file.path) {
        originalFilename = file.path.split('/').pop();
      } else if (file.file_name) {
        originalFilename = file.file_name;
      } else {
        continue; // No filename available
      }

      const promptPrefix = `p${String(promptNum).padStart(2, '0')}_`;
      const prefixedFilename = (promptPrefix + zipSafeName(originalFilename)).normalize('NFC');

      const fileInfo = {
        filename: prefixedFilename,
        originalFilename: originalFilename,
        promptNum: promptNum,
        messageUuid: msg.uuid || '',
        uuid: file.file_uuid || '',
        kind: file.file_kind || 'unknown',
        createdAt: file.created_at || '',
        path: file.path || ''
      };

      // Mark blob files for potential JSON fallback extraction
      if (file.file_kind === 'blob') {
        fileInfo.isBlob = true;
      }

      // Get URL for documents (PDFs)
      if (file.document_asset?.url) {
        fileInfo.url = file.document_asset.url;
        fileInfo.pageCount = file.document_asset.page_count;
      }

      // Get URL for images
      if (file.image_asset?.url) {
        fileInfo.url = file.image_asset.url;
      }

      files.push(fileInfo);
    }
  }

  return files;
}

// Extract presented files from present_files tool results
// These are files created by Claude (via bash/Python) and presented to the user
function extractPresentedFiles(data) {
  const files = [];
  const seen = new Set();  // Deduplicate by path
  const messages = data.chat_messages || [];

  for (const msg of messages) {
    for (const item of (msg.content || [])) {
      // Look for tool_result from present_files
      if (item.type === 'tool_result' && item.name === 'present_files') {
        for (const content of (item.content || [])) {
          if (content.type === 'local_resource' && content.file_path) {
            const path = content.file_path;
            if (seen.has(path)) continue;
            seen.add(path);

            const filename = zipSafeName(path.split('/').pop());
            files.push({
              filename: filename,
              path: path,
              uuid: content.uuid || '',
              mimeType: content.mime_type || '',
              name: content.name || ''
            });
          }
        }
      }
    }
  }

  return files;
}

// Extract files Claude sent to the user with SendUserFile. Each delivery has its
// own file UUID, so a path delivered more than once keeps every copy, as
// <base>_v1<ext> ... <base>_vN<ext> plus the latest under <base><ext>.
// takenNames holds filenames already used in artefacts/. Returns
// [{ filename, uuid, path }].
function extractDeliveredFiles(data, takenNames = []) {
  const byPath = new Map();
  for (const msg of getMessageChain(data)) {
    for (const item of (msg.content || [])) {
      for (const delivery of (item.file_deliveries || [])) {
        if (!delivery.file_uuid || !delivery.path) continue;
        if (!byPath.has(delivery.path)) byPath.set(delivery.path, []);
        byPath.get(delivery.path).push(delivery.file_uuid);
      }
    }
  }

  const taken = new Set(takenNames);
  const files = [];
  for (const [path, uuids] of byPath) {
    const name = zipSafeName(path.split('/').pop()).normalize('NFC');
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.substring(0, dot) : name;
    const ext = dot > 0 ? name.substring(dot) : '';

    // Keep the delivered copy apart from an artifact replayed under this name.
    let outBase = base;
    let attempt = 1;
    while (taken.has(outBase + ext)) {
      outBase = attempt === 1 ? `${base}_delivered` : `${base}_delivered_${attempt}`;
      attempt++;
    }
    taken.add(outBase + ext);

    if (uuids.length > 1) {
      uuids.forEach((uuid, i) => {
        files.push({ filename: `${outBase}_v${i + 1}${ext}`, uuid, path });
        taken.add(`${outBase}_v${i + 1}${ext}`);
      });
    }
    files.push({ filename: outBase + ext, uuid: uuids[uuids.length - 1], path });
  }
  return files;
}

// Get model name from conversation data
function getModelName(data) {
  // Direct model field (newer conversations)
  if (data.model) {
    // Parse model string like "claude-sonnet-4-5-20250929"
    const model = data.model.toLowerCase();
    let variant = '';
    let version = '';

    if (model.includes('opus')) variant = 'Opus';
    else if (model.includes('sonnet')) variant = 'Sonnet';
    else if (model.includes('haiku')) variant = 'Haiku';

    // Extract version numbers (e.g., "4-5" or "3-5")
    const versionMatch = model.match(/(\d+)-(\d+)/);
    if (versionMatch) {
      version = ` ${versionMatch[1]}.${versionMatch[2]}`;
    }

    if (variant) {
      return `Claude${version} ${variant}`;
    }
    return data.model; // Return raw if can't parse
  }

  // Check paprika_mode in settings (indicates thinking mode)
  const paprika = data.settings?.paprika_mode;
  if (paprika === 'extended') return 'Claude (extended thinking)';
  if (paprika === 'normal') return 'Claude (thinking)';

  // Check for thinking blocks in messages to infer model
  const messages = data.chat_messages || [];
  for (const msg of messages) {
    if (msg.sender === 'assistant') {
      for (const item of (msg.content || [])) {
        if (item.type === 'thinking') {
          return 'Claude (with thinking)';
        }
      }
    }
  }

  return 'Claude';
}

// File UUID -> { filename, path } for the delivered files that were saved. The
// latest copy is listed twice with one UUID, so the first name wins: that's its _vN file.
function buildViewerDeliveries(deliveredFiles) {
  const deliveries = {};
  for (const file of deliveredFiles) {
    deliveries[file.uuid] = deliveries[file.uuid] || { filename: file.filename, path: file.path };
  }
  return deliveries;
}

// One chat's project for the viewer, or null outside a project. A document too
// long to embed (or instructions too long) is cut here and stays whole on disk.
// limit: CTViewer.TEXT_EMBED_LIMIT.
function viewerProject(data, projectFiles, projectFileMapping, fileDir, fileNames, instructions = '', limit = 2 * 1024 * 1024) {
  if (!data.project_uuid && !data.project?.uuid) return null;
  const docs = Object.entries(projectFiles).map(([filename, content]) => {
    const name = projectFileMapping[filename];
    const text = String(content == null ? '' : content);
    return { name, text: text.length > limit ? `${text.slice(0, limit)}\n[... truncated: the whole text is in project/${name}]` : text };
  });
  const text = String(instructions == null ? '' : instructions);
  const cut = text.length > limit ? `${text.slice(0, limit)}\n[... truncated: the whole text is in project/prompt_template.md]` : text;
  return { name: data.project?.name || '', fileDir, fileNames, docs, instructions: cut };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fixMojibake, isTextFile, zipSafeName, viewerUploadKey, claudeDocsAction, claudeDocKey, renderClaudeDoc, getMessageChain, failedToolUseIds, isBashTool, heredocPath, heredocBody, heredocMatches, HEREDOC_RE, heredocFiles, safeFileTitle, claudeDocCreated, docCompanions, docCompanionNote,
    extractArtifacts, extractUploadedFiles, extractPresentedFiles, extractDeliveredFiles, getModelName, buildViewerDeliveries, viewerProject, chatHealth, KNOWN_BLOCK_TYPES, viewerFlags, warningsFromReport,
  };
}
