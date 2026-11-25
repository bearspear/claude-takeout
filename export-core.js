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

// Notes give the softer flags 'draft' and 'helper'; a warning's flag wins over a note's.
const FLAG_FOR_NOTE = { draft_superseded: 'draft', helper_script: 'helper' };

function viewerFlags(warnings, notes = []) {
  const flags = {};
  for (const w of warnings || []) {
    const flag = w && Object.prototype.hasOwnProperty.call(FLAG_FOR_WARNING, w.type) ? FLAG_FOR_WARNING[w.type] : null;
    if (flag && w.filename && !Object.prototype.hasOwnProperty.call(flags, w.filename)) flags[w.filename] = flag;
  }
  for (const n of notes || []) {
    const flag = n && Object.prototype.hasOwnProperty.call(FLAG_FOR_NOTE, n.type) ? FLAG_FOR_NOTE[n.type] : null;
    if (flag && n.filename && !Object.prototype.hasOwnProperty.call(flags, n.filename)) flags[n.filename] = flag;
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

// `cat > path << DELIM ... DELIM` or `cat << DELIM > path ...`, with any delimiter, quoted or not
// (`cat >> path` appends; see literalSwapCommand).
// heredocMatches returns them in command order, each shaped like a match of the first form:
// [0] the whole heredoc, [1] path, [2] the quote (empty when bash expands the body), [4] body
// (undefined when empty), and index. Use heredocPath and heredocBody on them.
const HEREDOC_RE = /cat\s*>(?!>)\s*(\S+?)\s*<<-?\s*(['"]?)(\w+)\2[^\n]*\n(?:([\s\S]*?)\n)??[ \t]*\3[ \t]*(?=\n|$)/g;
const HEREDOC_TARGET_LAST_RE = /cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*>(?!>)\s*(\S+)[^\n]*\n(?:([\s\S]*?)\n)??[ \t]*\2[ \t]*(?=\n|$)/g;

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

// A sandbox path with . and .. segments and repeated or trailing slashes removed. '..' above the root stays at the root.
function normalizeSandboxPath(p) {
  const text = String(p || '');
  const absolute = text.startsWith('/');
  const parts = [];
  for (const seg of text.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!absolute) parts.push(seg); continue; }
    parts.push(seg);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

// Any heredoc's body, with the rest of its first line kept: a body is input, not shell.
const CWD_HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n(?:[\s\S]*?\n)??[ \t]*\2[ \t]*(?=\n|$)/g;
// A cd at the start of a simple command (the command's start, or after ;, &&, ||, | or a newline),
// with its directory quoted or bare; no directory, or ~ or -, is a cd the export can't follow.
const CD_RE = /(^|[;&|\n])[ \t]*cd(?:[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s;&|()]+)))?[ \t]*(?=$|[;&|\n)])/g;

// Every cd, wherever it is (a subshell included); pushd and popd; a chdir() call in a script.
const ANY_CD_RE = /(?:^|[;&|\n(`])[ \t]*cd(?=[ \t;&|\n)]|$)/g;
const PUSHD_RE = /(?:^|[;&|\n(`])[ \t]*(?:pushd|popd)(?=[ \t;&|\n)]|$)/;
const CHDIR_RE = /\bchdir\s*\(/;
// A cd that may or may not run: after then, do, else, elif, { or !.
const COND_CD_RE = /(?:[{!]|\b(?:then|do|else|elif))[ \t]*cd(?=[ \t;&|\n)]|$)/;

// Each bash tool_use's working directory, by its id: its own leading cd (followed by && or ;) when it
// is the command's only change of directory, else null when it changes directory any other way, else
// the directory the last cd of an earlier bash command in the chain left (the sandbox shell keeps it
// between calls), else null. A relative cd resolves against the directory before it; a cd that can't
// be followed (none, ~, -, or relative to an unknown one) leaves it unknown (null). A cd in a
// heredoc body is text; one in a subshell ( ... ) makes the command's own directory unknown but
// doesn't carry. pushd, popd, chdir() or a cd that may not run (after then, do, else, elif, { or !)
// leave it unknown for later commands too.
function commandCwds(messages) {
  const cwds = new Map();
  let carried = null;
  const target = (m, base) => {
    const dir = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (dir === undefined || dir === '' || dir === '-' || dir.startsWith('~')) return null;
    if (dir.startsWith('/')) return normalizeSandboxPath(dir);
    return base ? normalizeSandboxPath(base + '/' + dir) : null;
  };
  for (const msg of messages || []) {
    for (const block of (msg && msg.content) || []) {
      if (!block || block.type !== 'tool_use' || !isBashTool(block.name)) continue;
      const raw = String((block.input && block.input.command) || '');
      const command = raw.replace(CWD_HEREDOC_RE, '$3');
      // Any other change of directory (a second cd, cd ||, a cd in a subshell, pushd/popd, or a
      // chdir() in any script, heredoc bodies included) leaves this command's directory unknown,
      // and the one after it too.
      const cds = (command.match(ANY_CD_RE) || []).length;
      const lead = /^\s*cd[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s;&|()]+))[ \t]*(?:&&|;|\n)/.exec(command);
      const other = CHDIR_RE.test(raw) || PUSHD_RE.test(command) || COND_CD_RE.test(command);
      let own = carried;
      if (other || cds > 1 || (cds === 1 && !lead)) own = null;
      else if (lead) own = target([null, null, lead[1], lead[2], lead[3]], carried);
      cwds.set(block.id, own);
      if (other) carried = null;
      else for (const m of command.matchAll(CD_RE)) carried = target(m, carried);
    }
  }
  return cwds;
}

// What file a word in a command names. Absolute: itself. Relative with a working directory: the
// directory joined with it (or the word itself when that is a known path and the join is not, for a
// file Claude wrote by a relative path). With no directory: the one known path ending in the word
// (its basename, or its last segments), else path null and every such known path as candidates.
function resolveSandboxPath(word, cwd, knownPaths) {
  const text = String(word || '');
  const known = Array.from(knownPaths || []);
  if (text.startsWith('/')) { const path = normalizeSandboxPath(text); return { path, candidates: [path] }; }
  const rel = normalizeSandboxPath(text);
  if (cwd) {
    let path = normalizeSandboxPath(cwd + '/' + text);
    if (!known.includes(path) && known.includes(rel)) path = rel;
    return { path, candidates: [path] };
  }
  if (!rel || rel.startsWith('..')) return { path: null, candidates: [] };
  const candidates = known.filter((p) => p === rel || normalizeSandboxPath(p).endsWith('/' + rel));
  return candidates.length === 1 ? { path: candidates[0], candidates } : { path: null, candidates };
}

// Whether a file lies in a folder or below it, by whole path segments: /a/de-luce/x is not under /a/de.
function isUnderFolder(file, folder) {
  const dir = normalizeSandboxPath(folder);
  const path = normalizeSandboxPath(file);
  return path.startsWith(dir === '/' ? '/' : dir + '/') && path !== dir;
}

// ---- Literal text swaps a bash command makes (spec "Replay of literal text swaps") ----
// extract_artifacts.py has a twin of each of these; keep them in step.

// `cat >> path << 'D'` (or `cat << 'D' >> path`) with nothing else on its first line. Groups: the
// path word, - (tabs stripped), the quote, the delimiter, the body (undefined when empty), and the
// tabs before the closing delimiter.
const APPEND_WORD = `([^\\s'"<>;&|$\`]+|'[^'\\n]*'|"[^"$\`\\\\\\n]*")`;
const APPEND_RE = new RegExp(`cat[ \\t]*>>[ \\t]*${APPEND_WORD}[ \\t]*<<(-?)[ \\t]*(['"]?)([A-Za-z0-9_]+)\\3[ \\t]*\\n(?:([\\s\\S]*?)\\n)??(\\t*)\\4(?=\\n|$)`, 'g');
const APPEND_TARGET_LAST_RE = new RegExp(`cat[ \\t]+<<(-?)[ \\t]*(['"]?)([A-Za-z0-9_]+)\\2[ \\t]*>>[ \\t]*${APPEND_WORD}[ \\t]*\\n(?:([\\s\\S]*?)\\n)??(\\t*)\\3(?=\\n|$)`, 'g');
const APPEND_MARK = '\u0001';

// A command's simple commands as lists of words, split at ;, && and newlines, when every word is
// literal text. null when anything would be expanded, redirected, piped, grouped or run in the
// background: $, a backtick, an unquoted glob, ~, #, !, (, ), {, }, <, >, | or a single &.
// [ and ] are allowed only as whole words (test's [ ... ]).
function literalCommands(text) {
  const commands = [];
  let words = [], word = '', started = false, quote = null;
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const wordEnd = (c) => c === undefined || c === ' ' || c === '\t' || c === '\n' || c === ';';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`') return null;
      else if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined || next === '\n') return null;
        if ('"\\$`'.includes(next)) { word += next; i++; } else word += ch;
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return null;
      i++;
      if (next !== '\n') { word += next; started = true; }
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '\n' || ch === ';') { endCommand(); continue; }
    if (ch === '&' && text[i + 1] === '&') { endCommand(); i++; continue; }
    if ((ch === '[' || ch === ']') && !started && wordEnd(text[i + 1])) { word = ch; started = true; continue; }
    if ('|&<>()$`*?[]{}~#!'.includes(ch)) return null;
    word += ch; started = true;
  }
  if (quote) return null;
  endCommand();
  return commands;
}

// One sed script `s<d>A<d>B<d>` or `...g`, both sides literal: { from, to, global }, else null. A may
// escape only the delimiter and . / * [ ] $ ^; B only the delimiter, /, \ and &. Neither side holds
// a newline, A no other regex character, B no & (the match) and no \1.
const SED_PATTERN_META = '.*[]^$';
const SED_PATTERN_ESCAPES = './*[]$^';
const SED_REPLACEMENT_ESCAPES = '/\\&';
function sedSubstitution(script) {
  const text = String(script);
  if (text[0] !== 's' || text.length < 4) return null;
  const d = text[1];
  if (/[\sA-Za-z0-9\\]/.test(d) || SED_PATTERN_META.includes(d)) return null;
  let i = 2;
  const part = (pattern) => {
    let out = '';
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === d) { i++; return out; }
      if (c === '\n') return null;
      if (c === '\\') {
        const n = text[i + 1];
        if (n === undefined) return null;
        if (n !== d && !(pattern ? SED_PATTERN_ESCAPES : SED_REPLACEMENT_ESCAPES).includes(n)) return null;
        out += n; i++;
        continue;
      }
      if (pattern ? SED_PATTERN_META.includes(c) : c === '&') return null;
      out += c;
    }
    return null;
  };
  const from = part(true);
  if (!from) return null;
  const to = part(false);
  if (to === null) return null;
  const flags = text.slice(i);
  if (flags !== '' && flags !== 'g') return null;
  return { from, to, global: flags === 'g' };
}

// sed's per-line replay of literal substitutions: the first match on each line, or every one with g.
function applySedSubstitutions(text, subs) {
  return String(text).split('\n').map((line) => {
    for (const { from, to, global } of subs) {
      if (global) line = line.split(from).join(to);
      else {
        const at = line.indexOf(from);
        if (at !== -1) line = line.slice(0, at) + to + line.slice(at + from.length);
      }
    }
    return line;
  }).join('\n');
}

const READ_ONLY_TOOLS = new Set(['grep', 'head', 'tail', 'wc', 'cat', 'ls', 'echo', 'printf', 'test', '[']);
const SED_PRINT_RE = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;

// The steps of a command made only of cd, read-only tools, sed -i with literal substitutions,
// cat >> appends and (copies: true) cp: { steps: [{ kind: 'sed', files, subs } | { kind: 'append',
// file, text } | { kind: 'copy', sources, dest }] }, the file words as written. null for anything else.
function literalSteps(command, { copies = false } = {}) {
  const raw = String(command || '');
  if (raw.includes(APPEND_MARK)) return null;
  const found = [];
  for (const m of raw.matchAll(APPEND_RE)) found.push({ index: m.index, length: m[0].length, word: m[1], dash: m[2], quote: m[3], body: m[5], tabs: m[6] });
  for (const m of raw.matchAll(APPEND_TARGET_LAST_RE)) found.push({ index: m.index, length: m[0].length, word: m[4], dash: m[1], quote: m[2], body: m[5], tabs: m[6] });
  found.sort((a, b) => a.index - b.index);
  const appends = [];
  let text = '', at = 0;
  for (const f of found) {
    if (f.index < at) return null;
    if (f.tabs && !f.dash) return null;
    let body = f.body;
    if (!f.quote && body !== undefined && /[$`\\]/.test(body)) return null;
    if (f.dash && body !== undefined) body = body.replace(/^\t+/gm, '');
    text += raw.slice(at, f.index) + APPEND_MARK + appends.length + APPEND_MARK;
    at = f.index + f.length;
    const words = literalCommands(f.word);
    if (!words || words.length !== 1 || words[0].length !== 1) return null;
    appends.push({ kind: 'append', file: words[0][0], text: body === undefined ? '' : body + '\n' });
  }
  text += raw.slice(at);
  const commands = literalCommands(text);
  if (!commands) return null;
  const steps = [];
  const markRe = new RegExp(`^${APPEND_MARK}(\\d+)${APPEND_MARK}$`);
  for (const words of commands) {
    const mark = markRe.exec(words[0]);
    if (mark) { if (words.length !== 1) return null; steps.push(appends[Number(mark[1])]); continue; }
    if (words.some((w) => w.includes(APPEND_MARK))) return null;
    const [tool, ...args] = words;
    if (tool === 'cd') { if (args.length !== 1) return null; continue; }
    if (tool === 'sed') {
      if (args[0] === '-n' && args.length >= 2 && SED_PRINT_RE.test(args[1]) && args.slice(2).every((w) => !w.startsWith('-'))) continue;
      let inPlace = false;
      const scripts = [], positional = [];
      for (let i = 0; i < args.length; i++) {
        const w = args[i];
        if (/^-i/.test(w) || w === '--in-place' || w.startsWith('--in-place=')) inPlace = true;
        else if (w === '-e') { if (i + 1 >= args.length) return null; scripts.push(args[++i]); }
        else if (w.startsWith('-')) return null;
        else positional.push(w);
      }
      if (!scripts.length && positional.length) scripts.push(positional.shift());
      if (!inPlace || !scripts.length || !positional.length) return null;
      const subs = scripts.map(sedSubstitution);
      if (subs.some((s) => !s)) return null;
      steps.push({ kind: 'sed', files: positional, subs });
      continue;
    }
    if (copies && tool === 'cp') {
      if (args.length < 2 || args.some((w) => w.startsWith('-'))) return null;
      steps.push({ kind: 'copy', sources: args.slice(0, -1), dest: args[args.length - 1] });
      continue;
    }
    if (READ_ONLY_TOOLS.has(tool)) continue;
    return null;
  }
  return { steps };
}

// A bash command extractArtifacts can replay: only cd, read-only tools, sed -i with literal
// substitutions and cat >> appends. { edits: [{ path, kind: 'sed', subs } | { path, kind: 'append',
// text }] } in command order, each path absolute (a relative name joined to cwd); null for any other
// command, or a relative name with no known directory.
function literalSwapCommand(command, cwd) {
  const parsed = literalSteps(command);
  if (!parsed) return null;
  const resolve = (word) => word.startsWith('/') ? normalizeSandboxPath(word) : cwd ? normalizeSandboxPath(cwd + '/' + word) : null;
  const edits = [];
  for (const step of parsed.steps) {
    const files = step.kind === 'sed' ? step.files : [step.file];
    for (const file of files) {
      const path = resolve(file);
      if (!path) return null;
      edits.push(step.kind === 'sed' ? { path, kind: 'sed', subs: step.subs } : { path, kind: 'append', text: step.text });
    }
  }
  return { edits };
}

// The known files a bash command may have changed, when it was not replayed. Its cat > heredocs
// were replayed as creates, except that a body bash expanded leaves that file unknown. The rest:
// when it is only cd, read-only tools, cp, literal sed -i and cat >>, the files those write (for cp
// into a folder, the copy's name there); otherwise every known file whose name appears in it.
function commandTouches(command, cwd, known) {
  const raw = String(command || '');
  const knownSet = new Set(known);
  const touched = new Set();
  let rest = raw;
  for (const m of heredocMatches(raw).reverse()) {
    if (m[2] === '' && /[$`\\]/.test(m[4] || '')) {
      const { path } = resolveSandboxPath(heredocPath(m), cwd, known);
      if (path && knownSet.has(path)) touched.add(path);
    }
    const header = m[0].split('\n')[0];
    const tail = /<<-?\s*(['"]?)\w+\1[ \t]*>(?!>)\s*\S+(.*)$/.exec(header) || /<<-?\s*(['"]?)\w+\1(.*)$/.exec(header);
    rest = rest.slice(0, m.index) + (tail ? tail[2] : '') + rest.slice(m.index + m[0].length);
  }
  const parsed = literalSteps(rest, { copies: true });
  if (!parsed) {
    for (const k of known) { const name = k.split('/').pop(); if (name && rest.includes(name)) touched.add(k); }
    return touched;
  }
  const mark = (word) => {
    const { path, candidates } = resolveSandboxPath(word, cwd, known);
    for (const p of path ? [path] : candidates) if (knownSet.has(p)) touched.add(p);
  };
  for (const step of parsed.steps) {
    if (step.kind === 'sed') step.files.forEach(mark);
    else if (step.kind === 'append') mark(step.file);
    else {
      mark(step.dest);
      for (const src of step.sources) mark(step.dest.replace(/\/+$/, '') + '/' + src.split('/').pop());
    }
  }
  return touched;
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

// Pages Claude published with publish_files. Names may carry a connector prefix.
const isPublishTool = (name) => /(^|__|:)publish_files$/.test(String(name || ''));

// claude.ai's Artifact tool publishes one file (input.file_path) or, with input.action ('open'), opens an
// artifact without publishing anything. Only a call with a file_path and no other action is a publish.
// Function declarations, so takeout-viewer.js can reach them on window.
function isArtifactTool(name) { return /(^|__|:)Artifact$/.test(String(name || '')); }
function isArtifactPublish(name, input) {
  return isArtifactTool(name) && !!input && typeof input === 'object'
    && typeof input.file_path === 'string' && input.file_path !== '' && (input.action == null || input.action === 'publish');
}

// The reply to an Artifact publish, "Published <path> at https://claude.ai/artifact/<short id> (Version N,
// version id <ver>) ...", as { url, uuid, shortId, ver }, or null. The url may also be
// https://claude.ai/code/artifact/<uuid>. ver is '' when the reply names none (then the live version).
function artifactPublishReply(text) {
  const m = /^Published \S[^\n]*? at (https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+))(?=[\s)]|$)/.exec(String(text || '').trim());
  if (!m) return null;
  const id = m[2];
  const uuid = base58ToUuid(id) || (PUBLISH_UUID_RE.test(id.toLowerCase()) ? id.toLowerCase() : '');
  if (!uuid) return null;
  const v = /\(Version \d+, version id ([^)\s]+)\)/.exec(text);
  const ver = v && PUBLISH_VER_RE.test(v[1]) ? v[1] : '';
  return { url: m[1], uuid, shortId: uuidToBase58(uuid), ver };
}

// The page a publish call's result names, { title, url }, for publish_files (its leading JSON) and the Artifact
// tool (its reply text); null when the result names no claude.ai page.
function publishedReply(name, result) {
  const text = resultText(result);
  if (isPublishTool(name)) {
    const info = leadingJson(text);
    return info && typeof info === 'object' && typeof info.url === 'string' && info.url ? { title: String(info.title || ''), url: info.url } : null;
  }
  if (isArtifactTool(name)) {
    const reply = artifactPublishReply(text);
    return reply ? { title: '', url: reply.url } : null;
  }
  return null;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// A claude.ai/artifact short id (base58 of the 16 bytes of a UUID) as the UUID it stands for, or ''
// unless it is 21-22 alphabet characters that decode to under 2^128 and encode back to the same text.
function base58ToUuid(shortId) {
  const id = String(shortId || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{21,22}$/.test(id)) return '';
  let n = 0n;
  for (const c of id) n = n * 58n + BigInt(BASE58.indexOf(c));
  if (n >= (1n << 128n)) return '';
  const hex = n.toString(16).padStart(32, '0');
  let again = '';
  for (let v = n; v > 0n; v /= 58n) again = BASE58[Number(v % 58n)] + again;
  if (again !== id) return '';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The short id for a UUID: base58 of its 128 bits, no leading-zero padding. Ids under 21 characters (uuids
// below ~2^117) aren't accepted by base58ToUuid; they are used only for naming. '' for anything but a UUID.
function uuidToBase58(uuid) {
  const u = String(uuid || '');
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(u)) return '';
  let n = BigInt('0x' + u.replace(/-/g, ''));
  let out = '';
  for (; n > 0n; n /= 58n) out = BASE58[Number(n % 58n)] + out;
  return out;
}

const PUBLISH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLISH_VER_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

// The frames claude.ai listed, reduced to the fields an export may keep (public: a boolean). Anything else (owner, audience, thumbnail,
// URLs) is dropped, a slug that is not a UUID is dropped, and a uuid appears once; paged (only when true) marks one
// found only by paging claude.ai's full list. listed: how many frames claude.ai sent, before any was dropped.
// paging: how the full list was paged (artifactPaging), or null.
function artifactsFromList(reply) {
  const frames = reply && Array.isArray(reply.frames) ? reply.frames : [];
  const str = (v) => (typeof v === 'string' ? v : '');
  const seen = new Set();
  const artifacts = [];
  for (const f of frames) {
    if (!f || typeof f.slug !== 'string' || !PUBLISH_UUID_RE.test(f.slug)) continue;
    const uuid = f.slug.toLowerCase();
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    artifacts.push({
      slug: f.slug, title: str(f.title), typeSlug: str(f.typeSlug), typeTitle: str(f.typeTitle),
      sourceSurface: str(f.sourceSurface), rel: str(f.rel),
      live: typeof f.live === 'string' && PUBLISH_VER_RE.test(f.live) ? f.live : '',
      updatedAt: str(f.updatedAt), createdAt: str(f.createdAt), public: f.public === true,
      // Found only by paging claude.ai's full list: its live version is resolved when it is fetched.
      ...(f.paged === true ? { paged: true } : {}),
    });
  }
  return { artifacts, listed: frames.length, paging: artifactPaging(reply && reply.paging) };
}

// How content.js paged claude.ai's full artifact list, as plain values: { status: 'ok' | 'capped', added } (artifacts
// the quick list missed) or { status: 'failed', code } (a short code; anything else becomes 'unknown'); null when
// the reply has none.
function artifactPaging(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.status === 'ok' || p.status === 'capped') {
    return { status: p.status, added: Number.isInteger(p.added) && p.added > 0 ? p.added : 0 };
  }
  if (p.status === 'failed') {
    const code = typeof p.code === 'string' && /^[A-Za-z0-9 ]{1,40}$/.test(p.code) ? p.code : 'unknown';
    return { status: 'failed', code };
  }
  return null;
}

// The pages a chat published, one entry per uuid + version, in chat order over every message (also
// branches that are no longer current). A result with no slug and version but an artifact url stands for
// the live version: ver '' and current true.
// An Artifact tool publish (isArtifactPublish) gives one entry from its reply text, titled by its file's name
// (claude.ai's page info gives the real title later) and with one source whose published name is unknown.
function publishedPagesOf(data) {
  const pages = [];
  const byKey = new Map();
  const messages = (data && data.chat_messages) || [];
  const results = new Map();
  for (const msg of messages) {
    for (const b of Array.isArray(msg.content) ? msg.content : []) if (b && b.type === 'tool_result') results.set(b.tool_use_id, b);
  }
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      if (isArtifactPublish(b.name, b.input)) {
        const r = results.get(b.id);
        const reply = r && !r.is_error ? artifactPublishReply(resultText(r)) : null;
        if (!reply) continue;
        const key = `${reply.uuid} ${reply.ver}`;
        let page = byKey.get(key);
        if (!page) {
          // The reply has no title: the file's name stands in until claude.ai's page info gives one.
          const file = b.input.file_path.split('/').pop();
          page = {
            uuid: reply.uuid, shortId: reply.shortId, ver: reply.ver, title: file.replace(/\.[^.]+$/, '') || file, titleFromFile: true,
            url: reply.url, current: !reply.ver, publishes: [], sources: [{ as: '', path: b.input.file_path }],
          };
          byKey.set(key, page);
          pages.push(page);
        }
        page.publishes.push({ messageUuid: msg.uuid, toolUseId: b.id });
        continue;
      }
      if (!isPublishTool(b.name)) continue;
      const r = results.get(b.id);
      if (!r || r.is_error) continue;
      const info = leadingJson(resultText(r));
      if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
      let uuid = '', ver = '', current = false;
      const url = typeof info.url === 'string' ? info.url : '';
      if (info.slug != null || info.version != null) {
        uuid = String(info.slug == null ? '' : info.slug).toLowerCase();
        ver = String(info.version == null ? '' : info.version);
        if (!PUBLISH_UUID_RE.test(uuid) || !PUBLISH_VER_RE.test(ver)) continue;
      } else {
        const m = /^https:\/\/claude\.ai\/artifact\/([^/?#]+)/.exec(url);
        uuid = m ? base58ToUuid(m[1]) : '';
        if (!uuid) continue;
        current = true;
      }
      const shortId = (/\/artifact\/([^/?#]+)/.exec(url) || [])[1] || '';
      const key = `${uuid} ${ver}`;
      let page = byKey.get(key);
      if (!page) {
        const files = b.input && Array.isArray(b.input.files) ? b.input.files : [];
        page = {
          uuid, shortId, ver, title: String(info.title || (b.input && b.input.title) || ''), url, current,
          publishes: [],
          sources: files.filter((f) => f && typeof f.path === 'string').map((f) => ({ as: String(f.as || ''), path: f.path })),
        };
        byKey.set(key, page);
        pages.push(page);
      }
      page.publishes.push({ messageUuid: msg.uuid, toolUseId: b.id });
    }
  }
  return pages;
}

// Which claude.ai artifacts a chat made, published or edited, as [{ uuid, messageUuid, how, docKey }] in chat
// order over every message (any branch), one entry per (uuid, how, message). 'published': each publish in
// publishedPagesOf. 'made': a Claude_Docs__batch whose result names the new artifact (created.minted, else
// frame.url); docKey is its extractArtifacts key. 'edited': a Claude_Docs__* call on a project container id, or
// an edit_version call with a slug. Mentions, opens and lists link nothing. A function declaration, so
// takeout-viewer.js can reach it on window.
function artifactLinksOf(data) {
  const messages = (data && data.chat_messages) || [];
  const failed = failedToolUseIds(messages);
  const results = new Map();
  for (const msg of messages) {
    for (const b of Array.isArray(msg.content) ? msg.content : []) if (b && b.type === 'tool_result') results.set(b.tool_use_id, b);
  }
  const published = new Map();
  for (const page of publishedPagesOf(data)) for (const p of page.publishes) published.set(p.toolUseId, page.uuid);
  const out = [];
  const seen = new Set();
  const add = (uuid, messageUuid, how, docKey) => {
    uuid = String(uuid || '').toLowerCase();
    if (!PUBLISH_UUID_RE.test(uuid)) return;
    const k = `${uuid} ${how} ${messageUuid}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ uuid, messageUuid, how, docKey: docKey || null });
  };
  for (const msg of messages) {
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!b || b.type !== 'tool_use') continue;
      if (published.has(b.id)) { add(published.get(b.id), msg.uuid, 'published', null); continue; }
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      const action = claudeDocsAction(b.name);
      if (action) {
        if (failed.has(b.id)) continue;
        if (action === 'batch') {
          const r = results.get(b.id);
          const info = r ? leadingJson(resultText(r)) : null;
          if (info && typeof info === 'object') {
            let uuid = info.created && typeof info.created === 'object' ? String(info.created.minted || '').toLowerCase() : '';
            if (!PUBLISH_UUID_RE.test(uuid)) {
              const url = info.frame && typeof info.frame === 'object' && typeof info.frame.url === 'string' ? info.frame.url : '';
              const m = /^https:\/\/claude\.ai\/artifact\/([A-Za-z0-9]+)/.exec(url);
              uuid = m ? base58ToUuid(m[1]) : '';
            }
            if (uuid) add(uuid, msg.uuid, 'made', claudeDocKey(b, r));
          }
        }
        const c = input.container;
        if (c && typeof c === 'object' && c.kind === 'project' && typeof c.id === 'string') add(c.id, msg.uuid, 'edited', null);
        continue;
      }
      if (/(^|__|:)edit_version$/.test(String(b.name || '')) && typeof input.slug === 'string') {
        const r = results.get(b.id);
        if (r && !r.is_error) add(input.slug, msg.uuid, 'edited', null);
      }
    }
  }
  return out;
}

// The index in entry.versions (extractArtifacts' index entry) of the version an artifact had as of a message:
// the last of entry.messages at or before it on chain. messageUuid null or undefined: the last version made on
// chain. -1 when there is none yet, or when the message is not on chain.
const chainPositions = new WeakMap();
function versionAsOf(entry, chain, messageUuid) {
  let pos = chainPositions.get(chain);
  if (!pos) {
    pos = new Map(Array.from(chain || [], (m, i) => [m && m.uuid, i]));
    if (chain && typeof chain === 'object') chainPositions.set(chain, pos);
  }
  let at = null;
  if (messageUuid != null) {
    if (!pos.has(messageUuid)) return -1;
    at = pos.get(messageUuid);
  }
  let v = -1;
  Array.from((entry && entry.messages) || []).forEach((id, i) => { if (pos.has(id) && (at == null || pos.get(id) <= at)) v = i; });
  return v;
}

// One segment of a published page's file path as a name that is safe on every system: zipSafeName, then
// <>:"|?* as _, trailing dots and spaces trimmed, and a Windows device name (CON, PRN, AUX, NUL, COM1-9,
// LPT1-9, any case, with or without an extension) prefixed with _. Never empty.
function publishedSegment(name) {
  let safe = zipSafeName(name).replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = '_' + safe;
  return safe || '_';
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

// claude.ai's visualize tool (show_widget) draws an SVG or HTML fragment in the chat, styled by claude.ai's
// own widget stylesheet. widgetFile makes it a file that stands alone: an SVG gets xmlns and WIDGET_CSS
// (the classes and colors the tool's guide documents, light and dark), and HTML gets a page around it.
// extract_artifacts.py has the same stylesheet, byte for byte.
const WIDGET_CSS = ':root{--text-primary:#1F1E1D;--text-secondary:#5F5E5A;--text-muted:#888780;--text-accent:#185FA5;--text-danger:#A32D2D;--text-success:#3B6D11;--text-warning:#854F0B;--surface-0:#FAF9F5;--surface-1:#F5F4EF;--surface-2:#FFFFFF;--bg-accent:#E6F1FB;--bg-danger:#FCEBEB;--bg-success:#EAF3DE;--bg-warning:#FAEEDA;--border:rgba(31,30,29,0.15);--border-strong:rgba(31,30,29,0.3);--border-stronger:rgba(31,30,29,0.45);--border-accent:#378ADD;--border-danger:#E24B4A;--border-success:#639922;--border-warning:#BA7517;}:root{--p:var(--text-primary);--s:var(--text-secondary);--t:var(--text-muted);--bg2:var(--surface-1);--b:var(--border);--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--font-voice:Georgia,"Times New Roman",serif;--font-mono:ui-monospace,Menlo,Consolas,monospace;--radius:8px;--pad-sm:8px;--pad-md:12px;--pad-lg:16px;--pad-xl:24px;--gap-xs:4px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;--gap-xl:24px;background:var(--surface-0);color:var(--text-primary)}.t,.ts,.th{font-family:var(--font-sans);fill:var(--text-primary)}.t{font-size:14px}.th{font-size:14px;font-weight:500}.ts{font-size:12px;fill:var(--text-secondary)}.box{fill:var(--surface-1);stroke:var(--border-strong)}.arr{fill:none;stroke:var(--text-secondary);stroke-width:1.5}.leader{fill:none;stroke:var(--text-muted);stroke-width:0.5;stroke-dasharray:4 3}.node{cursor:pointer}.c-purple>rect,.c-purple>circle,.c-purple>ellipse,rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#EEEDFE;stroke:#534AB7}.c-purple>.t,.c-purple>.th{fill:#3C3489}.c-purple>.ts{fill:#534AB7}.c-teal>rect,.c-teal>circle,.c-teal>ellipse,rect.c-teal,circle.c-teal,ellipse.c-teal{fill:#E1F5EE;stroke:#0F6E56}.c-teal>.t,.c-teal>.th{fill:#085041}.c-teal>.ts{fill:#0F6E56}.c-coral>rect,.c-coral>circle,.c-coral>ellipse,rect.c-coral,circle.c-coral,ellipse.c-coral{fill:#FAECE7;stroke:#993C1D}.c-coral>.t,.c-coral>.th{fill:#712B13}.c-coral>.ts{fill:#993C1D}.c-pink>rect,.c-pink>circle,.c-pink>ellipse,rect.c-pink,circle.c-pink,ellipse.c-pink{fill:#FBEAF0;stroke:#993556}.c-pink>.t,.c-pink>.th{fill:#72243E}.c-pink>.ts{fill:#993556}.c-gray>rect,.c-gray>circle,.c-gray>ellipse,rect.c-gray,circle.c-gray,ellipse.c-gray{fill:#F1EFE8;stroke:#5F5E5A}.c-gray>.t,.c-gray>.th{fill:#444441}.c-gray>.ts{fill:#5F5E5A}.c-blue>rect,.c-blue>circle,.c-blue>ellipse,rect.c-blue,circle.c-blue,ellipse.c-blue{fill:#E6F1FB;stroke:#185FA5}.c-blue>.t,.c-blue>.th{fill:#0C447C}.c-blue>.ts{fill:#185FA5}.c-green>rect,.c-green>circle,.c-green>ellipse,rect.c-green,circle.c-green,ellipse.c-green{fill:#EAF3DE;stroke:#3B6D11}.c-green>.t,.c-green>.th{fill:#27500A}.c-green>.ts{fill:#3B6D11}.c-amber>rect,.c-amber>circle,.c-amber>ellipse,rect.c-amber,circle.c-amber,ellipse.c-amber{fill:#FAEEDA;stroke:#854F0B}.c-amber>.t,.c-amber>.th{fill:#633806}.c-amber>.ts{fill:#854F0B}.c-red>rect,.c-red>circle,.c-red>ellipse,rect.c-red,circle.c-red,ellipse.c-red{fill:#FCEBEB;stroke:#A32D2D}.c-red>.t,.c-red>.th{fill:#791F1F}.c-red>.ts{fill:#A32D2D}@media (prefers-color-scheme:dark){:root{--text-primary:#F5F4EF;--text-secondary:#B4B2A9;--text-muted:#888780;--text-accent:#85B7EB;--text-danger:#F09595;--text-success:#97C459;--text-warning:#EF9F27;--surface-0:#262624;--surface-1:#30302E;--surface-2:#3A3A37;--bg-accent:#0C447C;--bg-danger:#791F1F;--bg-success:#27500A;--bg-warning:#633806;--border:rgba(245,244,239,0.15);--border-strong:rgba(245,244,239,0.3);--border-stronger:rgba(245,244,239,0.45);}.c-purple>rect,.c-purple>circle,.c-purple>ellipse,rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#3C3489;stroke:#AFA9EC}.c-purple>.t,.c-purple>.th{fill:#CECBF6}.c-purple>.ts{fill:#AFA9EC}.c-teal>rect,.c-teal>circle,.c-teal>ellipse,rect.c-teal,circle.c-teal,ellipse.c-teal{fill:#085041;stroke:#5DCAA5}.c-teal>.t,.c-teal>.th{fill:#9FE1CB}.c-teal>.ts{fill:#5DCAA5}.c-coral>rect,.c-coral>circle,.c-coral>ellipse,rect.c-coral,circle.c-coral,ellipse.c-coral{fill:#712B13;stroke:#F0997B}.c-coral>.t,.c-coral>.th{fill:#F5C4B3}.c-coral>.ts{fill:#F0997B}.c-pink>rect,.c-pink>circle,.c-pink>ellipse,rect.c-pink,circle.c-pink,ellipse.c-pink{fill:#72243E;stroke:#ED93B1}.c-pink>.t,.c-pink>.th{fill:#F4C0D1}.c-pink>.ts{fill:#ED93B1}.c-gray>rect,.c-gray>circle,.c-gray>ellipse,rect.c-gray,circle.c-gray,ellipse.c-gray{fill:#444441;stroke:#B4B2A9}.c-gray>.t,.c-gray>.th{fill:#D3D1C7}.c-gray>.ts{fill:#B4B2A9}.c-blue>rect,.c-blue>circle,.c-blue>ellipse,rect.c-blue,circle.c-blue,ellipse.c-blue{fill:#0C447C;stroke:#85B7EB}.c-blue>.t,.c-blue>.th{fill:#B5D4F4}.c-blue>.ts{fill:#85B7EB}.c-green>rect,.c-green>circle,.c-green>ellipse,rect.c-green,circle.c-green,ellipse.c-green{fill:#27500A;stroke:#97C459}.c-green>.t,.c-green>.th{fill:#C0DD97}.c-green>.ts{fill:#97C459}.c-amber>rect,.c-amber>circle,.c-amber>ellipse,rect.c-amber,circle.c-amber,ellipse.c-amber{fill:#633806;stroke:#EF9F27}.c-amber>.t,.c-amber>.th{fill:#FAC775}.c-amber>.ts{fill:#EF9F27}.c-red>rect,.c-red>circle,.c-red>ellipse,rect.c-red,circle.c-red,ellipse.c-red{fill:#791F1F;stroke:#F09595}.c-red>.t,.c-red>.th{fill:#F7C1C1}.c-red>.ts{fill:#F09595}}';

function isWidgetTool(name) {
  return /(^|__|:)show_widget$/.test(String(name || ''));
}

// The state key a show_widget call writes to: one file per title, versioned like any artifact.
function widgetKey(input, toolUseId = '') {
  const title = input && typeof input.title === 'string' ? input.title : '';
  return `widget:${title || toolUseId}`;
}

// { name, text } for one show_widget call, or null when it drew nothing.
function widgetFile(input) {
  const code = input && typeof input.widget_code === 'string' ? input.widget_code : '';
  if (!code.trim()) return null;
  const title = typeof input.title === 'string' ? input.title : '';
  const base = safeFileTitle(title) || 'diagram';
  const svg = /^\s*<svg\b[^>]*>/i.exec(code);
  if (svg) {
    let open = svg[0];
    if (!/\sxmlns\s*=/.test(open)) open = open.replace(/^(\s*<svg)/i, '$1 xmlns="http://www.w3.org/2000/svg"');
    return { name: `${base}.svg`, text: `${open}<style>${WIDGET_CSS}</style>${code.slice(svg[0].length)}` };
  }
  const head = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return {
    name: `${base}.html`,
    text: `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${head}</title>\n<style>${WIDGET_CSS}body{margin:0;padding:16px;font:16px/1.7 var(--font-sans)}</style>\n<script>function sendPrompt() {}</script>\n</head>\n<body>\n${code}\n</body>\n</html>\n`,
  };
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
// replayed, when given (a Set), gets toolUseId + '|' + path for each bash edit replayed: a literal
// sed -i or cat >> (literalSwapCommand) on a file whose text is known, that is, created in the chat
// with every change since replayed. From a file's first bash command that isn't replayed
// (commandTouches), none is replayed for it again.
function extractArtifacts(data, errorCollector = null, index = null, replayed = null) {
  const artifacts = {};
  const messages = getMessageChain(data);
  const failedIds = failedToolUseIds(messages);
  const cwds = commandCwds(messages);
  const opaque = new Set();  // state keys a bash command changed in a way not replayed

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

  // missingNewline: the text is a heredoc's body, which in the file ends with a newline the
  // export leaves out. An append puts it back first.
  function setContent(key, content, basename, missingNewline = false) {
    if (!state[key]) {
      state[key] = { current: content, basename, versions: [], versionMsgs: [], editedThisTurn: true, missingNewline };
    } else {
      state[key].current = content;
      state[key].editedThisTurn = true;
      state[key].missingNewline = missingNewline;
    }
  }

  // The state key of a sandbox path, when its file is known.
  const pathKeys = () => Object.keys(state).filter((k) => k.startsWith('/') || !/^(artifact|doc|widget):/.test(k));
  function knownKey(path) {
    const key = state[path] ? path : Object.keys(state).find((k) => k.startsWith('/') && normalizeSandboxPath(k) === path);
    return key && !opaque.has(key) ? key : null;
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
      } else if (isWidgetTool(block.name)) {
        const file = widgetFile(input);
        if (file) setContent(widgetKey(input, block.id), file.text, file.name);
      } else if (isBashTool(block.name)) {
        const command = input.command || '';
        const creates = heredocMatches(command);
        for (const match of creates) {
          const filepath = heredocPath(match);
          const content = heredocBody(match);
          const filename = basenameOf(filepath);
          if (filename && content) {
            setContent(filepath, content, filename, true);
          }
        }
        // A literal sed -i or cat >> on known files is replayed in place; a failed command may
        // have stopped before or after its edit, so it isn't.
        const cwd = cwds.has(block.id) ? cwds.get(block.id) : null;
        const swap = creates.length || failedIds.has(block.id) ? null : literalSwapCommand(command, cwd);
        const keys = swap ? swap.edits.map((e) => knownKey(e.path)) : [];
        if (swap && keys.every(Boolean)) {
          swap.edits.forEach((edit, i) => {
            const s = state[keys[i]];
            const before = s.current;
            if (edit.kind === 'sed') s.current = applySedSubstitutions(s.current, edit.subs);
            else {
              s.current = (s.missingNewline ? s.current + '\n' : s.current) + edit.text;
              s.missingNewline = false;
            }
            if (s.current !== before) s.editedThisTurn = true;
            if (replayed) replayed.add(block.id + '|' + keys[i]);
          });
        } else {
          for (const key of commandTouches(command, cwd, pathKeys())) opaque.add(key);
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
    // A file on Claude's own message is its output, not an upload (extractAttachedFiles).
    if (msg.sender === 'assistant') continue;

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

// Files claude.ai attached to Claude's own messages, such as a page Claude published. They are Claude's
// output, so they go to artefacts/, not uploads/. One whose name a replayed artifact already has is that
// file (existing: true) and isn't saved again. takenNames: names already in artefacts/. Returns
// [{ filename, uuid, path, existing, messageUuid }], messageUuid the message the file is on.
function extractAttachedFiles(data, takenNames = []) {
  const taken = new Set(takenNames);
  const seen = new Set();
  const files = [];
  for (const msg of getMessageChain(data)) {
    if (msg.sender !== 'assistant') continue;
    const list = [
      ...(msg.files_v2 || []).map((f) => [f, f && f.file_name]),
      ...(msg.files || []).map((f) => [f, f && (f.path ? f.path.split('/').pop() : f.file_name)]),
    ];
    for (const [file, raw] of list) {
      if (!file || !file.success || !raw || !file.file_uuid || seen.has(file.file_uuid)) continue;
      seen.add(file.file_uuid);
      const name = zipSafeName(raw).normalize('NFC');
      if (taken.has(name)) {
        files.push({ filename: name, uuid: file.file_uuid, path: file.path || '', existing: true, messageUuid: msg.uuid });
        continue;
      }
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.substring(0, dot) : name;
      const ext = dot > 0 ? name.substring(dot) : '';
      let out = name;
      for (let n = 2; taken.has(out); n++) out = `${base}_${n}${ext}`;
      taken.add(out);
      files.push({ filename: out, uuid: file.file_uuid, path: file.path || '', existing: false, messageUuid: msg.uuid });
    }
  }
  return files;
}

// Images claude.ai's image_search showed, from every message, once per URL, https only (they are fetched
// from their own sites). Each: { url, thumb, title, page, source, key }, key a short hash of the URL that
// names the saved file, so the old-archive tool finds it again (webImageName).
function webImagesOf(data) {
  const seen = new Set();
  const out = [];
  const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
  for (const msg of (data.chat_messages || [])) {
    for (const block of (msg && msg.content) || []) {
      if (!block || block.type !== 'tool_result' || !isImageResultTool(block.name)) continue;
      for (const part of Array.isArray(block.content) ? block.content : []) {
        for (const img of (part && Array.isArray(part.images) ? part.images : [])) {
          const url = https(img && img.url);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          out.push({ url, thumb: https(img.thumbnail_url), title: String(img.title || ''), page: https(img.page_url), source: String(img.source || ''), key: webImageKey(url) });
        }
      }
    }
  }
  return out;
}

// Images in tool results that claude.ai only links (file_uuid and preview_url), such as a photo Claude
// opened with Read: from every message, once per file. Each: { uuid, url, base }, url claude.ai's preview
// path, base the name of the file the tool read (its sandbox path's last part, without extension) or ''.
function toolImagesOf(data) {
  const pathOf = new Map();
  for (const msg of (data.chat_messages || [])) {
    for (const b of (msg && msg.content) || []) {
      if (b && b.type === 'tool_use' && b.id && b.input && typeof b.input === 'object') pathOf.set(b.id, String(b.input.file_path || b.input.path || ''));
    }
  }
  const seen = new Set();
  const out = [];
  for (const msg of (data.chat_messages || [])) {
    for (const b of (msg && msg.content) || []) {
      if (!b || b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      for (const item of b.content) {
        if (!item || item.type !== 'image' || typeof item.file_uuid !== 'string' || seen.has(item.file_uuid)) continue;
        const url = String(item.preview_url || '');
        if (!/^\/api\/[\w-]+\/files\/[\w-]+\/preview$/.test(url) || !/^[0-9a-f-]{8,}$/i.test(item.file_uuid)) continue;
        seen.add(item.file_uuid);
        const name = (pathOf.get(b.tool_use_id) || '').split('/').pop();
        out.push({ uuid: item.file_uuid, url, base: name.replace(/\.[^.]*$/, '') });
      }
    }
  }
  return out;
}

// images/<first 8 of the uuid>_<name><ext>, found again by that prefix.
function toolImageName(img, ext) {
  const base = safeFileTitle(img.base).slice(0, 40);
  return `${img.uuid.slice(0, 8)}${base ? `_${base}` : ''}${ext}`;
}

// Tools whose results carry web images: image_search, and claude.ai's product cards
// (product_carousel_display_v0, featured_card_display_v0), whose images are product_<n>_<m>.
function isImageResultTool(name) {
  return /(^|__|:)(image_search|\w+_display_v\d+)$/.test(String(name || ''));
}

// FNV-1a over the URL's UTF-16 code units, as 8 hex digits.
function webImageKey(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The image types saved, by the Content-Type the site sends, and the extension each gets.
const WEB_IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

// images/<key>_<title><ext>: the key first, so a file is found by it whatever its title.
function webImageName(img, ext) {
  const title = safeFileTitle(img.title).slice(0, 40);
  return `${img.key}${title ? `_${title}` : ''}${ext}`;
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

// The file types a link may open from disk: documents, images, audio, video, archives and plain data. A copy of
// OPENABLE_EXTENSIONS in viewer/viewer-logic.js (the viewer pages don't load this file); a test keeps them identical.
const OPENABLE_EXTENSIONS = new Set(('pdf doc docx xls xlsx ppt pptx odt ods odp rtf pages numbers key epub zip gz tar 7z rar ' +
  'csv tsv txt log md markdown json png jpg jpeg gif webp heic tif tiff bmp mp3 m4a wav ogg flac aac mp4 mov webm m4v mkv avi').split(' '));
function openableName(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || '').split('/').pop());
  return !!ext && OPENABLE_EXTENSIONS.has(ext[1].toLowerCase());
}

// ============================================================================
// Artifacts: published pages and the Artifacts viewer's records (popup.js and tools/archive-lib.js)
// ============================================================================

// The file a version opens with: index.html, else the first .html, else the first file.
function publishedStart(files) {
  return files.find((f) => f.path === 'index.html') || files.find((f) => /\.html?$/i.test(f.path)) || files[0] || null;
}

const isPublishedText = (f) => isTextFile(f.path) || /^text\//i.test(f.contentType || '');
// claude.ai's frame preamble: a copy served from /_f/<ver>/ starts with <!-- frame-runtime --> and two scripts
// claude.ai adds (window.__FRAME_PREAMBLE = {...}, then its runtime, whose text names /_f/). They are left out of the
// test, so a page that runs offline isn't labelled for claude.ai's own code; the page's own scripts still count.
function withoutFramePreamble(text) {
  if (text.indexOf('<!-- frame-runtime -->') === -1) return text;
  const scripts = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let out = '';
  let at = 0;
  let dropNext = false;
  let m;
  while ((m = scripts.exec(text))) {
    const preamble = /^\s*window\.__FRAME_PREAMBLE\b/.test(m[1]);
    if (preamble || dropNext) {
      out += text.slice(at, m.index);
      at = m.index + m[0].length;
      dropNext = preamble;
    } else dropNext = false;
  }
  return out + text.slice(at);
}
const publishedNeedsRuntime = (text) => typeof text === 'string' && /artifact-type\/|\/_f\//.test(withoutFramePreamble(text));

// Preview files for Export Artifacts' viewer: 'text' for pages, styles, scripts, SVG and Markdown, an image's MIME
// type for PNG, JPEG, GIF, WebP, AVIF, BMP and ICO (by extension), null for anything else. Agrees with
// artifactFileKind: every 'image' kind is collected.
const PREVIEW_ITEM_MAX = 2 * 1024 * 1024;   // one text or image (TEXT_EMBED_LIMIT)
const PREVIEW_TOTAL_MAX = 8 * 1024 * 1024;  // texts in all, and images in all, of one artifact
const PREVIEW_IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};
// A Design artifact's layout: its boards' places and titles, and its notes.
const DESIGN_CANVAS_PATH = 'project/canvas.json';

// The order an artifact's files go into its preview data, which has a budget: the start file, a Design canvas's
// layout, its boards (project/<name>.dc.html), then everything else, each group in file order (the sort is stable).
function previewRank(path, start) {
  if (path === start) return 0;
  if (path === DESIGN_CANVAS_PATH) return 1;
  return /^project\/[^/]+\.dc\.html$/.test(String(path)) ? 2 : 3;
}

function previewKind(p) {
  const ext = (/\.([a-z0-9]+)$/i.exec(String(p)) || [])[1];
  if (!ext) return null;
  const e = ext.toLowerCase();
  if (['html', 'htm', 'css', 'js', 'mjs', 'svg', 'md', 'markdown', 'json'].includes(e)) return 'text';
  return Object.prototype.hasOwnProperty.call(PREVIEW_IMAGE_TYPES, e) ? PREVIEW_IMAGE_TYPES[e] : null;
}

// Claude Docs artifacts: listed, never fetched (their text is in no file).
const CLAUDE_DOCS_TYPE = 'c8f0b311-af6a-4d22-a07b-61eb818fc35d';
const isClaudeDocsArtifact = (a) => a.typeSlug === CLAUDE_DOCS_TYPE || (!a.typeSlug && a.typeTitle === 'Docs');
// Shared with you: claude.ai says so with a rel other than 'mine'; an empty rel says nothing.
const isSharedArtifact = (rel) => typeof rel === 'string' && rel !== '' && rel !== 'mine';
// Whether local links treat an artifact as someone else's (no HTML or SVG opened from disk): shared, or one claude.ai
// listed without saying it is the owner's (rel 'mine'). Its note and label still follow isSharedArtifact.
const artifactForeign = (rel, listed) => isSharedArtifact(rel) || (listed === true && rel !== 'mine');

// A file's kind for the artifacts viewer, from its name.
function artifactFileKind(p) {
  const ext = ((/\.([a-z0-9]+)$/i.exec(String(p || '')) || [])[1] || '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (previewKind(p) && /^image\//.test(previewKind(p))) return 'image';
  if (ext === 'jsx' || ext === 'tsx') return 'react';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  return 'other';
}
const artifactStartKind = (p) => {
  if (p == null) return null;
  const kind = artifactFileKind(p);
  return kind === 'css' || kind === 'js' ? 'other' : kind;
};

// An artifact's record for the artifacts viewer (ArtifactView, without part and key). o: { uuid, shortId, url,
// title, typeSlug, typeTitle, shared, foreign (no local HTML/SVG links: artifactForeign; shared when absent), public, docs, createdAt, updatedAt, folder, files (artifact.json's), missing,
// start, startSaved, startSize, needsRuntime, notExported, note, inPayload (the start's text or image is in the
// preview payload) }. Files lists those saved; missingCount counts the listed ones not saved. A start file a preview
// could show but whose text or image is not in the payload is tooLarge when over PREVIEW_ITEM_MAX, otherwise
// startMissing (the export loop sets startMissing too when the payload gets no part).
function artifactView(o) {
  const missing = new Set(o.missing || []);
  const startSize = Number.isFinite(o.startSize) ? o.startSize : null;
  const tooLarge = !!o.start && startSize != null && startSize > PREVIEW_ITEM_MAX;
  return {
    id: o.shortId || o.uuid, title: o.title, kind: o.typeTitle || 'Page', typed: o.typeSlug !== '', docs: !!o.docs,
    shared: !!o.shared, foreign: o.foreign === undefined ? !!o.shared : !!o.foreign, public: o.public === true, createdAt: o.createdAt, updatedAt: o.updatedAt, folder: o.folder,
    start: o.start || null, startSaved: o.start ? o.startSaved || null : null, startKind: artifactStartKind(o.start || null),
    startSize: o.start ? startSize : null, tooLarge,
    startMissing: !!o.start && !tooLarge && !!previewKind(o.start) && !o.inPayload, missingCount: missing.size,
    files: (o.files || []).filter((f) => !missing.has(f.path)).map((f) => ({ path: f.path, savedAs: f.savedAs, kind: artifactFileKind(f.path), verified: f.verified !== false })),
    needsRuntime: !!o.needsRuntime, notExported: !!o.notExported, note: o.note || '', url: o.url, thumb: null,
    // The current version's ZIP, root-relative (a plain link: the viewer offers it as Download ZIP), or null.
    zip: typeof o.zip === 'string' && o.zip ? o.zip : null,
    // Files the chats saved: startSaved and each file's savedAs are then root-relative paths, not folder-relative.
    ...(o.reused ? { reused: true } : {}),
  };
}

// ===================================================================
// Artifacts indexes (index.md, index.html) and the helpers they use; popup.js and tools/merge_archives.js write them
// ===================================================================

// Text for HTML: & < > " escaped.
const escapeHtmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Format timestamp
function formatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

// Text inside [...] of a Markdown link: brackets escaped, whitespace runs as one space.
const mdLinkText = (text) => String(text).replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ');

// A '/'-separated path with each segment URL-encoded.
const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

const artifactCount = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A record's versions as [ver, VersionRec], in claude.ai's order (its history, oldest first) when known; versions
// not in the history after those, as they were added, and the one with no id last.
function storeVersionList(rec) {
  const list = rec.versions && typeof rec.versions.entries === 'function' ? [...rec.versions.entries()] : Object.entries(rec.versions || {});
  const history = Array.isArray(rec.history) ? rec.history : [];
  const place = (ver) => (ver === '' ? history.length + 1 : history.indexOf(ver) >= 0 ? history.indexOf(ver) : history.length);
  return list.map((e, i) => ({ e, i })).sort((a, b) => place(a.e[0]) - place(b.e[0]) || a.i - b.i).map((x) => x.e);
}

// The name the version with no id goes by in artifact.json and the indexes: current, or current_2, ... when a
// version has that id. list: storeVersionList's.
function storeNoIdKey(list) {
  let key = 'current';
  for (let n = 2; list.some(([ver]) => ver === key); n++) key = `current_${n}`;
  return key;
}

// A store version not copied because a chat wrote its one file the same: sameAs names that chat's file.
const storeVersionSame = (v) => !!(v && !v.folder && v.sameAs && typeof v.sameAs === 'object' && Array.isArray(v.files) && v.files.length === 1
  && typeof v.sameAs[v.files[0].path] === 'string' && v.sameAs[v.files[0].path]);

// A store record's versions for the indexes, in claude.ai's order (storeVersionList): { label (the version id, or
// current), folder (relative to the store's prefix; null when no copy was saved), startSaved, current, reused (only
// for a version the same as a chat's file: startSaved is then that root-relative file) }.
function artifactRowVersions(rec) {
  const list = storeVersionList(rec);
  const noId = storeNoIdKey(list);
  return list.map(([ver, v]) => {
    const same = storeVersionSame(v) ? v.sameAs[v.start || v.files[0].path] || null : null;
    return {
      label: ver || noId, folder: v.folder ? `${rec.dir}/${v.folder}` : null, startSaved: v.folder ? v.startSaved || null : same,
      current: !!ver && ver === rec.current, ...(same ? { reused: true } : {}),
    };
  });
}

// An index row for a store record the artifact step didn't save (a page only chats published, or a listed artifact an
// Export Changes run left out): linked to its newest saved version (artifactRowVersions).
function storeRecordRow(rec) {
  const versions = artifactRowVersions(rec);
  const newest = versions.filter((v) => v.startSaved).pop() || null;
  const latest = storeVersionList(rec).filter(([, v]) => v.saved || storeVersionSame(v)).pop();
  const v = latest ? latest[1] : null;
  const missing = v && Array.isArray(v.missing) ? v.missing.length : 0;
  const notes = [rec.meta.note, ...(rec.incomplete ? ['some versions not saved (see the chats\' errors.txt)'] : [])].filter(Boolean);
  return {
    title: rec.title, typeTitle: rec.meta.typeTitle, sourceSurface: rec.meta.sourceSurface, rel: rec.meta.rel,
    folder: newest ? newest.folder || rec.dir : rec.dir, startSaved: newest ? newest.startSaved : null, url: rec.meta.url, note: notes.join('; '),
    needsRuntime: !!(v && v.needsRuntime), fileCount: v ? v.files.length - missing : 0, missingCount: missing,
    ...(newest && newest.reused ? { reused: true } : {}), listed: rec.listed === true, versions,
  };
}

const sortArtifactRows = (rows) => rows.slice().sort((a, b) => {
  const x = String(a.title || '').toLowerCase();
  const y = String(b.title || '').toLowerCase();
  return x < y ? -1 : x > y ? 1 : (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0);
});
const artifactRowNotes = (r) => [r.note, r.needsRuntime ? 'needs claude.ai to run' : ''].filter(Boolean).join('; ');
const artifactSource = (r) => [r.sourceSurface, isSharedArtifact(r.rel) ? 'shared with you' : ''].filter(Boolean).join(', ');
// The claude.ai link, rebuilt from the short id so nothing else from the reply can become a link.
const artifactUrl = (r) => {
  const m = /^https:\/\/claude\.ai\/artifact\/([1-9A-HJ-NP-Za-km-z]+|[0-9a-f-]{36})$/.exec(String(r.url || ''));
  return m ? `https://claude.ai/artifact/${m[1]}` : null;
};
// The local link of an artifact's start file. A shared artifact's only when the viewer would open its type
// (openableName, export-core.js): anything else, HTML, SVG or XML among them, opened from disk could run
// someone else's code with network access and the shared file:// storage.
// base: the folder the index lives in, relative to the export root ('' or 'artifacts/'); a start file the chats
// saved is a root-relative path, so it is reached from there.
const artifactLocal = (r, base = '') => {
  if (!r.startSaved) return null;
  if (artifactForeign(r.rel, r.listed) && !openableName(r.startSaved)) return null;
  if (r.reused) return encodePath(`${'../'.repeat(String(base).split('/').filter(Boolean).length)}${r.startSaved}`);
  return encodePath(`${r.folder}/${r.startSaved}`);
};
// A row's versions (rows from a store have them): [{ label, local (as artifactLocal), current }].
const artifactVersionLinks = (r, base = '') => (Array.isArray(r.versions) ? r.versions : []).map((v) => ({
  label: v.label, current: !!v.current,
  local: v.folder || v.reused ? artifactLocal({ rel: r.rel, listed: r.listed, folder: v.folder, startSaved: v.startSaved, reused: !!v.reused }, base) : null,
}));

// index.md: one table row per artifact, by title. opts: { listed, exportedAt, warnings, thumbs (card pictures saved) }.
// "Card pictures: N of M", with the note when they were skipped for want of the optional permission.
const ARTIFACT_THUMB_PERMISSION_STATUS = 'Card pictures need the web images permission (Settings).';
// An Export Changes run's header: "Changed since <date>: N of M listed".
const artifactsChangedLine = (since, included, listed) => `Changed since ${formatTimestamp(since)}: ${Number(included) || 0} of ${Number(listed) || 0} listed`;
function artifactThumbsLine(thumbs, listed, needPermission) {
  return `${Number(thumbs) || 0} of ${Number(listed) || 0}${needPermission ? ' (needs the web images permission: Settings, Save web images and artifact card pictures)' : ''}`;
}
// Rows not in claude.ai's list (listed: false, pages only chats published) go in their own table under this heading.
const ARTIFACTS_UNLISTED_HEADING = "Published from chats, not in claude.ai's list";
// What the indexes say for "Listed by claude.ai" when the export has no list (the setting off, or the list failed).
const ARTIFACTS_NO_LIST = "claude.ai's list isn't in this export";
const splitListedRows = (rows) => [sortArtifactRows(rows.filter((r) => r.listed !== false)), sortArtifactRows(rows.filter((r) => r.listed === false))];
// listed: claude.ai's count, or null when the export has no list.
function artifactsIndexMd(rows, { listed = rows.length, exportedAt = new Date().toISOString(), warnings = 0, thumbs = 0, thumbsNeedPermission = false, base = '', since = null } = {}) {
  const cell = (t) => mdLinkText(String(t || '')).replace(/[<>|*_`#]/g, '\\$&');
  const noList = listed == null;
  const lines = [
    '# Claude Takeout - Artifacts',
    '',
    ...(since && !noList ? [artifactsChangedLine(since, rows.filter((r) => r.listed !== false).length, listed), ''] : []),
    `**Exported:** ${formatTimestamp(exportedAt)}`,
    `**Listed by claude.ai:** ${noList ? ARTIFACTS_NO_LIST : listed}`,
    `**Saved with files:** ${rows.filter((r) => r.fileCount > 0).length}`,
    ...(noList ? [] : [`**Card pictures:** ${artifactThumbsLine(thumbs, since ? rows.filter((r) => r.listed !== false).length : listed, thumbsNeedPermission)}`]),
  ];
  if (warnings) lines.push(`**Issues:** ${artifactCount(warnings, 'warning')} (see errors.txt)`);
  // A Versions column when the rows come from a store (one folder per version).
  const withVersions = rows.some((r) => Array.isArray(r.versions));
  const target = (local) => local.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  const table = (list) => {
    lines.push('', `| # | Artifact | Kind | Source | Files |${withVersions ? ' Versions |' : ''} Notes |`, `|---|----------|------|--------|-------|${withVersions ? '----------|' : ''}-------|`);
    list.forEach((r, i) => {
      const local = artifactLocal(r, base);
      const remote = artifactUrl(r);
      const name = cell(r.title || 'Untitled');
      const link = local ? `[${name}](${target(local)})` : name;
      const versions = withVersions ? ` ${artifactVersionLinks(r, base).map((v) => `${v.local ? `[${cell(v.label)}](${target(v.local)})` : cell(v.label)}${v.current ? ' (current)' : ''}`).join(', ')} |` : '';
      lines.push(`| ${i + 1} | ${link}${remote ? ` · [claude.ai](${remote})` : ''} | ${cell(r.typeTitle || 'Page')} | ${cell(artifactSource(r))} | ${r.fileCount}${r.missingCount ? ` (${r.missingCount} missing)` : ''} |${versions} ${cell(artifactRowNotes(r))} |`);
    });
  };
  const [inList, unlisted] = splitListedRows(rows);
  if (inList.length || !unlisted.length) table(inList);
  if (unlisted.length) {
    lines.push('', `## ${ARTIFACTS_UNLISTED_HEADING}`);
    table(unlisted);
  }
  return lines.join('\n') + '\n';
}

// index.html: a static page, no scripts; every value is escaped and the only links are each artifact's start
// file in the export, its claude.ai page and, when it was built (opts.viewer), viewer.html. opts as artifactsIndexMd.
function artifactsIndexHtml(rows, { listed = rows.length, exportedAt = new Date().toISOString(), warnings = 0, thumbs = 0, viewer = false, thumbsNeedPermission = false, base = '', since = null } = {}) {
  const esc = (t) => escapeHtmlText(String(t == null ? '' : t)).replace(/'/g, '&#39;');
  const up = '../'.repeat(String(base).split('/').filter(Boolean).length);
  const withVersions = rows.some((r) => Array.isArray(r.versions));
  const noList = listed == null;
  const inList = rows.filter((r) => r.listed !== false);
  const row = (r) => {
    const local = artifactLocal(r, base);
    const remote = artifactUrl(r);
    const name = esc(r.title || 'Untitled');
    const versions = withVersions ? `<td>${artifactVersionLinks(r, base).map((v) => `${v.local ? `<a href="${esc(v.local)}">${esc(v.label)}</a>` : esc(v.label)}${v.current ? ' (current)' : ''}`).join(', ')}</td>` : '';
    return `<tr><td>${local ? `<a href="${esc(local)}">${name}</a>` : name}${remote ? ` <a class="remote" href="${esc(remote)}" rel="noopener noreferrer">claude.ai</a>` : ''}</td>`
      + `<td>${esc(r.typeTitle || 'Page')}</td><td>${esc(artifactSource(r))}</td>`
      + `<td>${r.fileCount}${r.missingCount ? ` (${r.missingCount} missing)` : ''}</td>${versions}<td>${esc(artifactRowNotes(r))}</td></tr>`;
  };
  const table = (list) => `<div class="wrap">
<table>
<thead><tr><th>Artifact</th><th>Kind</th><th>Source</th><th>Files</th>${withVersions ? '<th>Versions</th>' : ''}<th>Notes</th></tr></thead>
<tbody>
${list.map(row).join('\n')}
</tbody>
</table>
</div>`;
  const [listedRows, unlisted] = splitListedRows(rows);
  const tables = [
    ...(listedRows.length || !unlisted.length ? [table(listedRows)] : []),
    ...(unlisted.length ? [`<h2>${esc(ARTIFACTS_UNLISTED_HEADING)}</h2>\n${table(unlisted)}`] : []),
  ].join('\n');
  const listedLine = noList ? `Listed by claude.ai: ${esc(ARTIFACTS_NO_LIST)}`
    : `Listed by claude.ai: ${Number(listed) || 0} · Card pictures: ${esc(artifactThumbsLine(thumbs, since ? inList.length : listed, thumbsNeedPermission))}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Claude Artifacts</title>
<style>
:root { color-scheme: light dark; --bg: #faf9f5; --fg: #1f1e1d; --muted: #6b6a68; --line: #e3e1da; --link: #a14a2c; }
@media (prefers-color-scheme: dark) { :root { --bg: #1f1e1d; --fg: #eeece6; --muted: #a6a39b; --line: #3a3936; --link: #e08a6a; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 28px 0 8px; }
.meta { color: var(--muted); margin: 0 0 20px; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
a { color: var(--link); }
a.remote { font-size: 0.85em; margin-left: 6px; }
</style>
</head>
<body>
<main>
<h1>Claude Artifacts</h1>
${since && !noList ? `<p class="meta">${esc(artifactsChangedLine(since, inList.length, listed))}</p>\n` : ''}<p class="meta">Exported ${esc(formatTimestamp(exportedAt))} · ${listedLine}${warnings ? ` · ${artifactCount(warnings, 'warning')} (see errors.txt)` : ''}</p>
${viewer ? `<p class="viewer"><a href="${up}viewer.html">Open the artifacts viewer</a></p>\n` : ''}${tables}
</main>
</body>
</html>
`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtmlText, formatTimestamp, mdLinkText, encodePath, artifactCount, storeVersionList, storeNoIdKey, storeVersionSame, artifactRowVersions, storeRecordRow,
    sortArtifactRows, artifactRowNotes, artifactSource, artifactUrl, artifactLocal, artifactVersionLinks, ARTIFACT_THUMB_PERMISSION_STATUS, artifactsChangedLine,
    artifactThumbsLine, ARTIFACTS_UNLISTED_HEADING, ARTIFACTS_NO_LIST, splitListedRows, artifactsIndexMd, artifactsIndexHtml,
    fixMojibake, isTextFile, zipSafeName, viewerUploadKey, claudeDocsAction, isPublishTool, isArtifactTool, isArtifactPublish, artifactPublishReply, publishedReply, base58ToUuid, uuidToBase58, artifactsFromList, publishedPagesOf, artifactLinksOf, publishedSegment, versionAsOf, claudeDocKey, renderClaudeDoc, getMessageChain, failedToolUseIds, isBashTool, heredocPath, heredocBody, heredocMatches, HEREDOC_RE, heredocFiles, normalizeSandboxPath, commandCwds, resolveSandboxPath, isUnderFolder, literalCommands, sedSubstitution, applySedSubstitutions, literalSteps, literalSwapCommand, commandTouches, safeFileTitle, claudeDocCreated, docCompanions, docCompanionNote,
    WIDGET_CSS, isWidgetTool, widgetKey, widgetFile, webImagesOf, isImageResultTool, webImageKey, WEB_IMAGE_TYPES, webImageName, toolImagesOf, toolImageName,
    extractArtifacts, extractUploadedFiles, extractPresentedFiles, extractDeliveredFiles, extractAttachedFiles, getModelName, buildViewerDeliveries, viewerProject, chatHealth, KNOWN_BLOCK_TYPES, viewerFlags, warningsFromReport, OPENABLE_EXTENSIONS, openableName,
    publishedStart, isPublishedText, publishedNeedsRuntime, DESIGN_CANVAS_PATH, previewRank, PREVIEW_ITEM_MAX, PREVIEW_TOTAL_MAX, PREVIEW_IMAGE_TYPES, previewKind, CLAUDE_DOCS_TYPE, isClaudeDocsArtifact, isSharedArtifact, artifactForeign,
    artifactFileKind, artifactStartKind, artifactView,
  };
}
