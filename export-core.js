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

  // Trace back from leaf to root
  const chain = [];
  let uuid = currentLeaf;
  while (uuid && byUuid[uuid]) {
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

// `cat > path << DELIM ... DELIM`, with any delimiter, quoted or not. Groups:
// 1 path, 4 body.
const HEREDOC_RE = /cat\s+>\s+(\S+)\s+<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;

function heredocPath(match) {
  return match[1].replace(/^['"]|['"]$/g, '');
}

// The files a Bash command writes with a heredoc, for the viewer's cards.
function heredocFiles(command) {
  return Array.from(String(command || '').matchAll(HEREDOC_RE), (match) => ({ path: heredocPath(match), text: match[4] }));
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
  const state = {};

  const basenameOf = (p) => (p || '').split('/').pop();
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
          let baseName = (title || id).replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_').substring(0, 60);
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
      } else if (isBashTool(block.name)) {
        const command = input.command || '';
        for (const match of command.matchAll(HEREDOC_RE)) {
          const filepath = heredocPath(match);
          const content = match[4];
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

    if (s.versions.length <= 1) {
      // No edits — just emit the single content under the unversioned name.
      artifacts[`${outBase}${ext}`] = s.versions[0] != null ? s.versions[0] : s.current;
    } else {
      // Emit each per-turn version and the unversioned final.
      for (let i = 0; i < s.versions.length; i++) {
        artifacts[`${outBase}_v${i + 1}${ext}`] = s.versions[i];
      }
      artifacts[`${outBase}${ext}`] = s.versions[s.versions.length - 1];
    }
  }

  return artifacts;
}

// Extract uploaded file metadata from messages (PDFs, images, CSVs, etc. in files_v2)
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
        const prefixedFilename = (promptPrefix + file.file_name).normalize('NFC');

        const fileInfo = {
          filename: prefixedFilename,
          originalFilename: file.file_name,  // Keep original for API calls
          promptNum: promptNum,
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
      const prefixedFilename = (promptPrefix + originalFilename).normalize('NFC');

      const fileInfo = {
        filename: prefixedFilename,
        originalFilename: originalFilename,
        promptNum: promptNum,
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

            const filename = path.split('/').pop();
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
    const name = path.split('/').pop().normalize('NFC');
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
    fixMojibake, isTextFile, getMessageChain, failedToolUseIds, isBashTool, heredocPath, HEREDOC_RE, heredocFiles,
    extractArtifacts, extractUploadedFiles, extractPresentedFiles, extractDeliveredFiles, getModelName, buildViewerDeliveries, viewerProject,
  };
}
