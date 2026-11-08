// Popup script - handles export UI

let conversationData = null;
let orgId = null;

// ============================================================================
// Error Collector: Structured error tracking for comprehensive error reporting
// ============================================================================

class ExportErrorCollector {
  constructor(conversationName, conversationUuid) {
    this.conversationName = conversationName || 'Untitled';
    this.conversationUuid = conversationUuid || 'unknown';
    this.errors = [];
    this.warnings = [];
  }

  addError(type, filename, error, details = {}) {
    this.errors.push({
      type,
      severity: 'error',
      filename,
      error: error?.message || String(error),
      details: {
        uuid: details.uuid || null,
        path: details.path || null,
        urlsTried: details.urlsTried || [],
        httpStatus: details.httpStatus || null,
        fallbackAttempted: details.fallbackAttempted || false,
        fallbackResult: details.fallbackResult || null,
        rawError: details.rawError || null
      },
      recovery: this._getRecoveryHint(type, details)
    });
  }

  addWarning(type, filename, message, details = {}) {
    this.warnings.push({
      type,
      severity: 'warning',
      filename,
      error: message,
      details: {
        uuid: details.uuid || null,
        path: details.path || null,
        note: details.note || null
      },
      recovery: this._getRecoveryHint(type, details)
    });
  }

  _getRecoveryHint(type, details) {
    const httpStatus = details.httpStatus;

    switch (type) {
      case 'upload':
        if (httpStatus === 404) {
          return 'Every known download URL returned 404. Check whether the file still opens on claude.ai: if it does, the API may have changed, so report it. If it does not, it was deleted or expired. For blob files, check original.json for content in "view" or "Read" tool results.';
        } else if (httpStatus === 403) {
          return 'Session may have expired. Refresh claude.ai, ensure you are logged in, and retry the export.';
        } else if (details.fallbackAttempted && !details.fallbackResult) {
          return 'API download failed and content was not found in conversation JSON. The file may need to be re-uploaded to Claude.';
        }
        return 'Check original.json for file content in tool_result blocks. Re-upload the file if needed.';

      case 'presented_file':
        return 'This file was created by Claude (via bash/Python) but could not be downloaded. Check original.json for the file content in tool results.';

      case 'delivered_file':
        return 'Claude sent this file to you, but it could not be downloaded. Open the conversation on claude.ai and use the download button on the file card.';

      case 'project_doc':
        if (details.truncated) {
          return 'Full file could not be fetched from API. Partial content was saved from conversation (may be truncated by Claude\'s view tool).';
        }
        return 'Project document could not be fetched. Check if you have access to the project and try re-exporting.';

      case 'project_metadata':
        return 'Project metadata could not be fetched. The conversation may not be associated with an active project.';

      case 'str_replace_failed':
        return 'A str_replace edit could not be applied during artifact reconstruction. The earlier version of the artifact (and any other successful edits) is still preserved in artefacts/<name>_vN.<ext> snapshots. Inspect original.json to recover the missed edit if needed.';

      case 'artifact_basename_collision':
        return 'Two distinct paths in the conversation produced files with the same basename. The second was saved under a numbered suffix (e.g. foo_2.html) to avoid silent overwrite. Both artifacts and all their versions are preserved in artefacts/.';

      case 'artifact_opaque_mutation':
        return 'A bash command modified an artifact in a way the exporter cannot replay declaratively (it\'s not a create_file, str_replace, or heredoc). The exporter never attempts to interpret bash scripts; the companion CLI does. To reconstruct this artifact: run `python3 replay_bash.py <this-export-folder>` (ships alongside the extension). It replays each bash command in conversation order with per-command confirmation, in a tmpdir isolated by the OS on macOS, saves the originals, and writes the result into artefacts/. These commands come from the conversation, so review them first with --dry-run.';

      case 'viewer':
        return 'The chat data is all in this export. Only viewer.html is missing or incomplete; the Markdown files are unaffected.';

      default:
        return 'Check original.json for the raw conversation data that may contain this content.';
    }
  }

  // Drop warnings of one type for a file, once something has made them moot.
  clearWarnings(type, filename) {
    this.warnings = this.warnings.filter((w) => !(w.type === type && w.filename === filename));
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  hasWarnings() {
    return this.warnings.length > 0;
  }

  hasAny() {
    return this.hasErrors() || this.hasWarnings();
  }

  generateErrorReport() {
    if (!this.hasAny()) return null;

    const lines = [
      '# Export Errors Report',
      '',
      `**Export Date:** ${new Date().toISOString()}`,
      `**Conversation:** ${this.conversationName}`,
      `**UUID:** ${this.conversationUuid}`,
      '',
      '---',
      '',
      '## Summary',
      ''
    ];

    // Summary counts by type
    const errorsByType = {};
    const warningsByType = {};

    for (const err of this.errors) {
      errorsByType[err.type] = (errorsByType[err.type] || 0) + 1;
    }
    for (const warn of this.warnings) {
      warningsByType[warn.type] = (warningsByType[warn.type] || 0) + 1;
    }

    if (this.errors.length > 0) {
      lines.push(`**Errors:** ${this.errors.length} total`);
      for (const [type, count] of Object.entries(errorsByType)) {
        lines.push(`- ${count} ${type.replace(/_/g, ' ')} failure${count > 1 ? 's' : ''}`);
      }
    }

    if (this.warnings.length > 0) {
      lines.push(`**Warnings:** ${this.warnings.length} total`);
      for (const [type, count] of Object.entries(warningsByType)) {
        lines.push(`- ${count} ${type.replace(/_/g, ' ')} warning${count > 1 ? 's' : ''}`);
      }
    }

    // Detailed errors
    if (this.errors.length > 0) {
      lines.push('', '---', '', '## Errors', '');

      for (const err of this.errors) {
        lines.push(`### ${err.filename}`);
        lines.push('');
        lines.push(`- **Type:** ${err.type.replace(/_/g, ' ')}`);
        lines.push(`- **Error:** ${err.error}`);

        if (err.details.uuid) {
          lines.push(`- **UUID:** ${err.details.uuid}`);
        }
        if (err.details.path) {
          lines.push(`- **Path:** ${err.details.path}`);
        }
        if (err.details.httpStatus) {
          lines.push(`- **HTTP Status:** ${err.details.httpStatus}`);
        }

        if (err.details.urlsTried && err.details.urlsTried.length > 0) {
          lines.push('');
          lines.push('**URLs Tried:**');
          for (let i = 0; i < err.details.urlsTried.length; i++) {
            const urlInfo = err.details.urlsTried[i];
            const status = urlInfo.status ? ` → ${urlInfo.status}` : ' → failed';
            lines.push(`${i + 1}. \`${urlInfo.url}\`${status}`);
          }
        }

        if (err.details.fallbackAttempted) {
          lines.push('');
          lines.push(`**Fallback Attempted:** Yes`);
          lines.push(`**Fallback Result:** ${err.details.fallbackResult || 'Content not found in JSON'}`);
        }

        lines.push('');
        lines.push(`**Recovery:** ${err.recovery}`);
        lines.push('');
      }
    }

    // Detailed warnings
    if (this.warnings.length > 0) {
      lines.push('---', '', '## Warnings', '');

      for (const warn of this.warnings) {
        lines.push(`### ${warn.filename}`);
        lines.push('');
        lines.push(`- **Type:** ${warn.type.replace(/_/g, ' ')}`);
        lines.push(`- **Message:** ${warn.error}`);

        if (warn.details.note) {
          lines.push(`- **Note:** ${warn.details.note}`);
        }

        lines.push('');
        lines.push(`**Recovery:** ${warn.recovery}`);
        lines.push('');
      }
    }

    // Troubleshooting guide
    lines.push('---', '', '## Troubleshooting Guide', '');
    lines.push('### Common HTTP Status Codes');
    lines.push('');
    lines.push('| Status | Meaning | Solution |');
    lines.push('|--------|---------|----------|');
    lines.push('| 404 | File not found | File expired or deleted. Re-upload if needed. |');
    lines.push('| 403 | Forbidden | Session expired. Refresh claude.ai and retry. |');
    lines.push('| 401 | Unauthorized | Not logged in. Sign in to claude.ai and retry. |');
    lines.push('| 500 | Server error | Claude API issue. Wait and retry later. |');
    lines.push('');
    lines.push('### Manual Recovery Steps');
    lines.push('');
    lines.push('1. **For `artifact_opaque_mutation` warnings — run the replay CLI:**');
    lines.push('   ```');
    lines.push('   python3 replay_bash.py /path/to/this/export/folder');
    lines.push('   ```');
    lines.push('   The CLI replays each bash command in conversation order with per-command confirmation, in a tmpdir isolated by the OS on macOS, and writes the result into artefacts/ after saving the originals. Run `--dry-run` first to read the commands.');
    lines.push('2. **Check original.json:** Open the file and search for the filename. Content may exist in `tool_result` blocks.');
    lines.push('3. **Search for "view" tool results:** Blob file contents appear after Claude reads them.');
    lines.push('4. **Re-upload files:** If files expired, upload them to a new conversation.');
    lines.push('5. **Check project access:** Ensure you have access to the Claude Project.');
    lines.push('');
    lines.push('### Debugging Tips (for code fixes)');
    lines.push('');
    lines.push('- URLs tried are listed above - check if the path encoding is correct');
    lines.push('- Compare working vs failing files to identify patterns');
    lines.push('- Check browser console for additional error details');
    lines.push('- File UUID and path can help identify API endpoint issues');

    return lines.join('\n');
  }
}

// ============================================================================
// Mojibake Fix: Repair UTF-8 text corrupted via CP1252 misinterpretation
// ============================================================================

// buildMojibakeMap and fixMojibake are in export-core.js

// UTF-8 BOM prefix for markdown files (ensures browsers interpret encoding correctly)
const UTF8_BOM = '\uFEFF';

// Add UTF-8 BOM to text content for proper browser rendering
function withBOM(text) {
  return UTF8_BOM + (text || '');
}

// Add file to folder with BOM if it's a markdown file
function addFileWithBOM(folder, path, content) {
  if (path.endsWith('.md')) {
    folder.file(path, withBOM(content));
  } else {
    folder.file(path, content);
  }
}

// isTextFile is in export-core.js

// Write a downloaded file to artefacts/ and list it in the artifacts map. Binary
// files are listed with empty content, since the map's text is never used for them.
async function addArtefactBlob(folder, artifacts, filename, blob) {
  if (isTextFile(filename)) {
    const text = await blob.text();
    addFileWithBOM(folder, `artefacts/${filename}`, text);
    artifacts[filename] = text;
  } else {
    folder.file(`artefacts/${filename}`, blob);
    artifacts[filename] = '';
  }
}

// ============================================================================
// Offline viewer: viewer.html and its unzip check, at the ZIP root.
// ============================================================================

// An upload's text for the viewer. A failure here must never touch the export,
// so it only ever costs the preview. content: a Blob, or a string from JSON.
async function viewerUploadText(name, content) {
  try {
    if (!isTextFile(name)) return null;
    const limit = CTViewer.TEXT_EMBED_LIMIT;
    const text = typeof content === 'string'
      ? content
      : (content.size <= limit ? await content.text() : null);
    return text !== null && text.length <= limit ? fixMojibake(text) : null;
  } catch (e) {
    console.warn(`Viewer: could not read ${name}:`, e.message);
    return null;
  }
}

// Add viewer.html and viewer-check.gif to the ZIP root, once per export. Returns
// false and writes nothing on any failure, because the export must still download.
async function writeViewer(zip, chats) {
  try {
    if (!chats.length) return false;
    const assets = await Promise.all(CTViewer.VIEWER_ASSETS.map(async (asset) => {
      const response = await fetch(chrome.runtime.getURL(asset));
      if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
      return response.text();
    }));
    const [template, logic, app, marked, katex, css, highlight] = assets;
    // Large upload text goes to viewer-files/, loaded when the upload is opened.
    const { data, parts } = CTViewer.moveUploadText(CTViewer.buildViewerData(chats, { exported: new Date().toISOString() }));
    const html = CTViewer.assembleViewer({ template, css, marked, katex, highlight, logic, app, data, fileScripts: parts.length > 0 });
    for (const part of parts) zip.file(`viewer-files/${part.name}`, part.body);
    zip.file('viewer.html', html);
    zip.file(CTViewer.VIEWER_CHECK_FILE, CTViewer.VIEWER_CHECK_BASE64, { base64: true });
    return true;
  } catch (e) {
    console.error('Could not build viewer.html:', e);
    return false;
  }
}

// ============================================================================
// Upload inlining: rewrite sandbox-path references in text artifacts to
// self-contained base64 data URIs.
// ============================================================================

// Map common image/media extensions to MIME types for data URI generation.
function inferMimeFromFilename(filename) {
  const ext = ((filename || '').toLowerCase().split('.').pop()) || '';
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    tiff: 'image/tiff', tif: 'image/tiff',
    pdf: 'application/pdf',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac'
  };
  return map[ext] || 'application/octet-stream';
}

// Convert a Blob to a base64 string. Chunks the byte array so
// String.fromCharCode doesn't blow the call stack on large uploads.
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// File extensions for which we attempt sandbox-path -> base64 inlining.
const INLINEABLE_ARTIFACT_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'svg', 'md', 'xml'
]);

function isInlineableArtifact(filename) {
  const ext = ((filename || '').toLowerCase().split('.').pop()) || '';
  return INLINEABLE_ARTIFACT_EXTENSIONS.has(ext);
}

// Replace every occurrence of each sandbox path (e.g.
// /mnt/user-data/uploads/foo.png) in `content` with its base64 data URI.
// Returns { content, replacements } where replacements is the total count
// across all sandbox paths.
function inlineSandboxPaths(content, uploadDataUris) {
  if (!content || !uploadDataUris) return { content: content || '', replacements: 0 };
  let result = content;
  let total = 0;
  // Sort longest path first to avoid the case where one sandbox path is a
  // prefix of another (defensive — sandbox paths usually share /mnt/...
  // but the basename uniqueness makes this rare).
  const paths = Object.keys(uploadDataUris).sort((a, b) => b.length - a.length);
  for (const path of paths) {
    const dataUri = uploadDataUris[path];
    if (!path || !dataUri) continue;
    if (!result.includes(path)) continue;
    const parts = result.split(path);
    total += parts.length - 1;
    result = parts.join(dataUri);
  }
  return { content: result, replacements: total };
}

// ============================================================================
// Priority 1 Fixes: Core improvements matching claude_json_to_md.py
// ============================================================================

// Get appropriate code fence based on content (uses 4 backticks if content has 3)
// One upload's key, the same from extractUploadedFiles and from the message: its file
// UUID, or its prompt and name when it has none.
function uploadNameKey(uuid, promptNum, originalName) {
  return uuid ? `uuid:${uuid}` : `p${promptNum}:${String(originalName || '').normalize('NFC')}`;
}

// A fence one backtick longer than the longest run of backticks in the content, and never shorter than ```.
function getCodeFence(content) {
  const runs = String(content || '').match(/`+/g) || [];
  const longest = runs.reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

// getMessageChain, isBashTool, the heredoc helpers and extractArtifacts are in export-core.js

// A heredoc header line, which detectOpaqueMutations strips before looking for other writes.
const HEREDOC_HEADER_RE = /cat\s+>\s+\S+\s+<<-?\s*['"]?\w+['"]?/g;

// Detect and apply Claude's standard "encode upload to base64 and substitute
// a placeholder in an artifact" recipe.
//
// Claude's go-to pattern when asked to embed an image into self-contained HTML
// is to run two bash_tool Python scripts:
//
//   # Step 1 — encode the upload, stash the data URI to a temp file
//   data = open('/mnt/user-data/uploads/X.png','rb').read()
//   b64  = base64.b64encode(data).decode()
//   uri  = "data:image/png;base64," + b64
//   open('img_uri.txt','w').write(uri)
//
//   # Step 2 — substitute the placeholder in the artifact
//   uri  = open('img_uri.txt').read().strip()
//   html = open('booklet.html').read()
//   html = html.replace('__IMG_URI__', uri)
//   open('booklet.html','w').write(html)
//
// extractArtifacts cannot replay this because the substitution is hidden inside
// arbitrary bash. This function pattern-matches both steps against bash_tool
// commands in the message chain, then performs the substitution in JS using the
// already-downloaded upload bytes (uploadDataUris[sandboxPath]).
//
// The match is intentionally narrow. Any unrecognized bash mutation against a
// tracked artifact path emits an `artifact_opaque_mutation` warning so the
// user is told reconstruction may be incomplete rather than silently shipping
// stale content.
// Detect bash_tool commands that mutate a tracked artifact in a way the
// declarative replay (create_file / str_replace / rewrite / heredoc) can't
// reconstruct. Emits one `artifact_opaque_mutation` warning per distinct
// command, pointing the user at `replay_bash.py` for recovery.
//
// We deliberately do NOT try to replay bash scripts here. The companion CLI
// `replay_bash.py` runs the actual scripts in an isolated tmpdir with full
// shell + Python coverage; the extension's job is to flag what it can't
// handle, not to second-guess it. See docs/WASM_REPLAY_APPROACH.md for the
// architectural reasoning.
// A shell command split into simple commands at newlines, ;, &&, || and |, but not
// inside quotes, so a sed script like 's/a;b/c/' stays whole.
function shellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) { current += ch + command[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '\\' && i + 1 < command.length) { current += ch + command[++i]; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { segments.push(current); current = ''; i++; continue; }
    if (ch === '\n' || ch === ';' || ch === '|') { segments.push(current); current = ''; continue; }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function detectOpaqueMutations(data, errorCollector) {
  const messages = getMessageChain(data);
  const basenameOf = (p) => (p || '').split('/').pop();

  // Known artifact sandbox paths from create_file / str_replace / heredoc.
  const knownArtifactPaths = new Set();
  for (const msg of messages) {
    for (const block of (msg.content || [])) {
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      if ((block.name === 'create_file' || block.name === 'str_replace'
           || block.name === 'rewrite' || block.name === 'create_or_overwrite')
          && input.path) {
        knownArtifactPaths.add(input.path);
      }
      if ((block.name === 'Write' || block.name === 'Edit') && input.file_path) {
        knownArtifactPaths.add(input.file_path);
      }
      if (isBashTool(block.name)) {
        const cmd = input.command || '';
        for (const match of cmd.matchAll(HEREDOC_RE)) {
          knownArtifactPaths.add(heredocPath(match));
        }
      }
    }
  }

  const opaqueMutations = [];

  // Walk messages and classify each bash_tool command. We flag any command
  // that writes to a tracked artifact and isn't a heredoc create (those are
  // handled declaratively by extractArtifacts).
  //
  // An artifact may be referenced several ways:
  //   • Full sandbox path:   open('/home/claude/booklet/foo.html','w')
  //   • Just the basename:   `cd <dir> && open('foo.html','w')`
  //   • Via a variable:      f='foo.html'; open(f,'w').write(...)
  // We pre-scan for `<var> = '<literal>'` bindings whose literal matches
  // either a full path or the basename of a known artifact, then look for
  // write-back patterns that reference the path, the basename, or any such
  // aliasing variable.
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    for (let bi = 0; bi < (msg.content || []).length; bi++) {
      const block = msg.content[bi];
      if (block.type !== 'tool_use' || !isBashTool(block.name)) continue;
      const rawCommand = (block.input && block.input.command) || '';
      if (!rawCommand) continue;

      // extractArtifacts already handled the heredoc itself, so drop only its
      // `cat > path <<` line. The rest of the command can still mutate artifacts.
      const command = rawCommand.replace(HEREDOC_HEADER_RE, '');

      // Map variable name -> the artifact path it aliases (path or basename).
      const varToArtifact = {};
      const varBindingRe = /(?:^|[\s;])\s*(\w+)\s*=\s*(['"])((?:\\.|(?!\2).)*)\2/g;
      let vbm;
      while ((vbm = varBindingRe.exec(command)) !== null) {
        const varName = vbm[1];
        const value = vbm[3];
        for (const ap of knownArtifactPaths) {
          if (value === ap || value === basenameOf(ap)) {
            varToArtifact[varName] = ap;
            break;
          }
        }
      }

      for (const ap of knownArtifactPaths) {
        const basename = basenameOf(ap);
        const escapedPath = ap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedBase = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const aliasVars = Object.keys(varToArtifact).filter(v => varToArtifact[v] === ap);

        const referenced =
          command.includes(ap) ||
          command.includes(basename) ||
          aliasVars.length > 0;
        if (!referenced) continue;

        // Write-back patterns, against the full path or the basename (not as part of a
        // longer name) or an aliasing variable.
        const lit = "['\"](?:" + escapedPath + "|" + escapedBase + ")['\"]";
        const target = aliasVars.length > 0
          ? "(?:" + lit + "|" + aliasVars.map(v => '\\b' + v + '\\b').join('|') + ")"
          : lit;
        // Python: open(p, 'w' / 'a' / 'x' / 'r+' ..., encoding=...) and Path(p).write_text(...).
        const pyWriteRe = new RegExp(
          "open\\(\\s*" + target + "\\s*,\\s*(?:mode\\s*=\\s*)?['\"](?:[wax][bt]?\\+?|r[bt]?\\+)['\"]" +
          "|Path\\(\\s*" + target + "\\s*\\)\\s*\\.write_(?:text|bytes)\\s*\\("
        );
        const names = new Set([ap, basename]);
        const isTarget = (word) => names.has(word.replace(/^['"]|['"]$/g, ''));
        // Shell, one simple command at a time: a redirect into the file, sed/perl
        // in place, tee, or cp/mv/install onto it.
        const redirectRe = new RegExp(
          ">>?\\s*['\"]?(?:" + escapedPath + "|(?<![\\w./-])" + escapedBase + ")['\"]?(?![\\w.-])"
        );
        const shellWrites = shellSegments(command).some((segment) => {
          if (redirectRe.test(segment)) return true;
          const words = segment.trim().split(/\s+/).filter(Boolean);
          if (words[0] === 'sudo') words.shift();
          const tool = words[0];
          const args = words.slice(1);
          if (tool === 'sed' || tool === 'perl') {
            const inPlace = args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'));
            return inPlace && args.some(isTarget);
          }
          if (tool === 'tee') return args.some(isTarget);
          if (tool === 'cp' || tool === 'mv' || tool === 'install') return args.length > 1 && isTarget(args[args.length - 1]);
          if (tool === 'dd') return args.some((w) => w.startsWith('of=') && isTarget(w.slice(3)));
          return false;
        });

        if (pyWriteRe.test(command) || shellWrites) {
          opaqueMutations.push({ artifactPath: ap, msgIndex: mi, blockIndex: bi, command: rawCommand });
          break;
        }
      }
    }
  }

  // Surface every distinct opaque mutation as an `artifact_opaque_mutation`
  // warning. De-dupe by (basename, command) so the same script appearing
  // twice doesn't get listed twice. The recovery hint points users at the
  // companion `replay_bash.py` CLI.
  const seenCommands = new Set();
  for (const om of opaqueMutations) {
    const key = basenameOf(om.artifactPath) + '|' + om.command;
    if (seenCommands.has(key)) continue;
    seenCommands.add(key);
    if (errorCollector) {
      errorCollector.addWarning(
        'artifact_opaque_mutation',
        basenameOf(om.artifactPath),
        `A bash command modified ${basenameOf(om.artifactPath)} in a way the exporter cannot replay declaratively (it's not a create_file, str_replace, or heredoc). The exported artifact may differ from what Claude actually produced. Use replay_bash.py to reconstruct.`,
        { path: om.artifactPath, note: 'Run: python3 replay_bash.py <this-export-folder>' }
      );
    }
  }

  return { opaqueMutations };
}

// Extract text attachments from messages (pasted files with extracted_content)
// Returns { attachments: { filename -> content }, idToFilename: { id -> filename } }
function extractTextAttachments(data) {
  const attachments = {};
  const idToFilename = {};  // Maps attachment id to final filename
  const byMessage = {};  // message uuid -> [{ att, name }], saved attachments in order
  const messages = getMessageChain(data);  // Use ordered message chain
  let unnamedCounter = 1;
  let promptNum = 0;

  // Binary file extensions that should be changed to .txt when we only have extracted text
  const binaryExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'];

  for (const msg of messages) {
    // Track prompt number (only increment for human messages)
    if (msg.sender === 'human') {
      promptNum++;
    }

    for (const att of (msg.attachments || [])) {
      let filename = (att.file_name || '').normalize('NFC');
      const content = att.extracted_content || '';
      const attId = att.id || '';

      // Skip if no content
      if (!content) continue;

      // Generate filename if not provided
      if (!filename) {
        const ext = att.file_type || 'txt';
        filename = `attachment_${unnamedCounter}.${ext}`;
        unnamedCounter++;
      }

      // For binary file types, change extension to .txt since we only have extracted text
      const ext = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')).toLowerCase() : '';
      if (binaryExtensions.includes(ext)) {
        const base = filename.substring(0, filename.lastIndexOf('.'));
        filename = `${base}.txt`;
      }

      // Prefix with prompt number for grouping (p01_, p02_, etc.)
      const promptPrefix = `p${String(promptNum).padStart(2, '0')}_`;
      filename = promptPrefix + zipSafeName(filename);

      // Handle duplicate filenames by adding a suffix
      let finalName = filename;
      let counter = 1;
      while (attachments[finalName]) {
        const currentExt = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '';
        const base = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
        finalName = `${base}_${counter}${currentExt}`;
        counter++;
      }
      // Apply mojibake fix to repair encoding issues
      attachments[finalName] = fixMojibake(content);

      // Track the id -> filename mapping for linking in prompts
      if (attId) {
        idToFilename[attId] = finalName;
      }
      (byMessage[msg.uuid] = byMessage[msg.uuid] || []).push({ att, name: finalName });
    }
  }

  return { attachments, idToFilename, byMessage };
}

// Extract web search sources from conversation
function extractWebSources(data) {
  const sources = [];
  const seenUrls = new Set();
  const messages = data.chat_messages || [];

  for (const msg of messages) {
    for (const item of (msg.content || [])) {
      // Look for web_search tool results
      if (item.type === 'tool_result' && item.name === 'web_search') {
        for (const content of (item.content || [])) {
          if (content.type === 'knowledge' && content.url && !seenUrls.has(content.url)) {
            seenUrls.add(content.url);
            sources.push({
              title: content.title || 'Untitled',
              url: content.url,
              domain: content.metadata?.site_domain || '',
              siteName: content.metadata?.site_name || '',
              isCitable: content.is_citable !== false,
              isMissing: content.is_missing === true
            });
          }
        }
      }
    }
  }

  return sources;
}

// Generate sources.md from web search sources
function generateSources(sources) {
  if (!sources || sources.length === 0) return null;

  // Group by domain
  const byDomain = {};
  for (const src of sources) {
    const domain = src.domain || 'other';
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(src);
  }

  const lines = [
    '# Web Sources',
    '',
    `*${sources.length} sources from web search*`,
    '',
  ];

  // Sort domains by count
  const sortedDomains = Object.keys(byDomain).sort((a, b) => byDomain[b].length - byDomain[a].length);

  for (const domain of sortedDomains) {
    const domainSources = byDomain[domain];
    lines.push(`## ${domain} (${domainSources.length})`);
    lines.push('');
    for (const src of domainSources) {
      const flags = [];
      if (src.isMissing) flags.push('missing');
      if (!src.isCitable) flags.push('not citable');
      const flagStr = flags.length > 0 ? ` *(${flags.join(', ')})*` : '';
      lines.push(`- [${src.title}](${src.url})${flagStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// extractUploadedFiles, extractPresentedFiles and extractDeliveredFiles are in export-core.js

// Fetch project metadata and documents list from API
// Returns { files, docsJson, projectJson, failures, metadataError }
// Ensure data.project.name is populated. The page-side fetch intercepted by
// injected.js often returns only project_uuid (no nested project.name), so for
// project conversations we resolve the name from the projects endpoint and
// patch data.project in place. Idempotent.
async function ensureProjectName(data, organizationId) {
  if (!data || data.project?.name) return data;
  const projectUuid = data.project_uuid || data.project?.uuid;
  if (!projectUuid || !organizationId) return data;
  try {
    const url = `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}`;
    const response = await fetch(url, { credentials: 'include' });
    if (response.ok) {
      const json = await response.json();
      if (json?.name) {
        data.project = { ...(data.project || {}), uuid: projectUuid, name: json.name };
      }
    }
  } catch (e) {
    console.log('ensureProjectName: failed to resolve project name:', e.message);
  }
  return data;
}

async function fetchProjectDocs(data, organizationId) {
  const projectUuid = data.project_uuid || data.project?.uuid;
  if (!projectUuid || !organizationId) {
    return { files: [], docsJson: null, projectJson: null, failures: [], metadataError: null };
  }

  let projectJson = null;
  let metadataError = null;
  const failures = [];  // Track failed doc fetches

  try {
    // Fetch project metadata
    const projectUrl = `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}`;
    const projectResponse = await fetch(projectUrl, { credentials: 'include' });
    if (projectResponse.ok) {
      projectJson = await projectResponse.json();
      console.log(`Fetched project metadata: ${projectJson.name || projectUuid}`);
    } else {
      metadataError = {
        type: 'project_metadata',
        error: `HTTP ${projectResponse.status}`,
        httpStatus: projectResponse.status,
        url: projectUrl,
        projectUuid
      };
      console.log(`Failed to fetch project metadata: ${projectResponse.status}`);
    }
  } catch (e) {
    metadataError = {
      type: 'project_metadata',
      error: e.message,
      httpStatus: null,
      url: `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}`,
      projectUuid
    };
    console.log(`Error fetching project metadata: ${e.message}`);
  }

  try {
    // Fetch list of project docs
    const listUrl = `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}/docs`;
    const listResponse = await fetch(listUrl, { credentials: 'include' });
    if (!listResponse.ok) {
      console.log(`Failed to fetch project docs list: ${listResponse.status}`);
      failures.push({
        filename: 'docs list',
        error: `HTTP ${listResponse.status}`,
        httpStatus: listResponse.status,
        uuid: null,
        urlsTried: [{ url: listUrl, status: `HTTP ${listResponse.status}` }]
      });
      return { files: [], docsJson: null, projectJson, failures, metadataError };
    }

    const docs = await listResponse.json();
    if (!Array.isArray(docs) || docs.length === 0) {
      return { files: [], docsJson: docs, projectJson, failures: [], metadataError };
    }

    console.log(`Found ${docs.length} project docs`);

    // Extract content from docs - check if already in list response first
    const projectFiles = [];
    for (const doc of docs) {
      const docUuid = doc.uuid;
      const filename = doc.file_name || doc.filename || doc.name || `doc_${docUuid}.txt`;

      // Check if content is already in the docs list response
      let content = doc.content || doc.text || doc.body || null;
      const urlsTried = [];

      // If not in list response, try fetching from content endpoints
      if (!content) {
        const contentUrls = [
          `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}/docs/${docUuid}/content`,
          `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}/docs/${docUuid}`,
        ];

        for (const url of contentUrls) {
          try {
            const response = await fetch(url, { credentials: 'include' });
            if (response.ok) {
              const contentType = response.headers.get('content-type') || '';
              if (contentType.includes('application/json')) {
                const json = await response.json();
                content = json.content || json.text || json.body || JSON.stringify(json, null, 2);
              } else {
                content = await response.text();
              }
              urlsTried.push({ url, status: 'OK' });
              break;
            } else {
              urlsTried.push({ url, status: `HTTP ${response.status}` });
            }
          } catch (e) {
            urlsTried.push({ url, status: null, error: e.message });
            console.log(`Failed to fetch ${url}: ${e.message}`);
          }
        }
      }

      if (content) {
        projectFiles.push({
          uuid: docUuid,
          filename: filename,
          content: fixMojibake(content)
        });
      } else {
        console.log(`Could not fetch content for doc: ${filename}`);
        failures.push({
          filename,
          error: 'Could not fetch content from any endpoint',
          httpStatus: urlsTried.find(u => u.status?.startsWith('HTTP'))?.status?.replace('HTTP ', '') || null,
          uuid: docUuid,
          urlsTried
        });
      }
    }

    return { files: projectFiles, docsJson: docs, projectJson, failures, metadataError };
  } catch (e) {
    console.error('Error fetching project docs:', e);
    failures.push({
      filename: 'project docs',
      error: e.message,
      httpStatus: null,
      uuid: null,
      urlsTried: []
    });
    return { files: [], docsJson: null, projectJson, failures, metadataError };
  }
}

// List a project's knowledge files. Uploads such as PDFs appear here rather than
// under /docs. Returns { files, failure }.
async function fetchProjectFileList(projectUuid, organizationId) {
  const url = `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}/files`;
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      return {
        files: [],
        failure: {
          filename: 'project files list',
          error: `HTTP ${response.status}`,
          httpStatus: response.status,
          uuid: null,
          urlsTried: [{ url, status: `HTTP ${response.status}` }]
        }
      };
    }
    const files = await response.json();
    return { files: Array.isArray(files) ? files : [], failure: null };
  } catch (e) {
    return {
      files: [],
      failure: { filename: 'project files list', error: e.message, httpStatus: null, uuid: null, urlsTried: [{ url, status: null, error: e.message }] }
    };
  }
}

// Download a project's knowledge files into `folder` under `basePath`. Returns the
// saved names and any failures, in the shape the error collector takes.
async function saveProjectFiles(folder, basePath, files, organizationId, conversationId, onProgress) {
  const names = [];
  const failures = [];
  const usedNames = new Set();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const uuid = file.file_uuid || file.uuid;
    const name = (file.file_name || `file_${uuid}`).normalize('NFC').replace(/[\\/]/g, '_');
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.substring(0, dot) : name;
    const ext = dot > 0 ? name.substring(dot) : '';
    let finalName = name;
    for (let n = 2; usedNames.has(finalName.toLowerCase()); n++) {
      finalName = `${base}_${n}${ext}`;
    }
    usedNames.add(finalName.toLowerCase());

    if (onProgress) {
      onProgress(10 + Math.floor((i / files.length) * 5), 100, `Downloading: ${finalName}`);
    }
    try {
      const blob = await fetchUploadedFile(null, uuid, organizationId, conversationId, file.path || null);
      folder.file(`${basePath}/files/${finalName}`, blob);
      names.push(finalName);
    } catch (err) {
      console.error(`Failed to download project file ${finalName}:`, err);
      failures.push({ filename: finalName, error: err.message, uuid, httpStatus: err.httpStatus || null, urlsTried: err.urlsTried || [] });
    }
  }
  return { names, failures };
}

// Normalize a file path for comparison (handles various sanitization patterns)
function normalizePathForComparison(path) {
  if (!path) return '';
  // Strip to just alphanumerics for comparison - this handles all sanitization variations
  // Claude may replace spaces, periods, semicolons, etc. with underscores in different ways
  return path
    .replace(/[^a-zA-Z0-9]/g, '')  // Remove ALL non-alphanumerics
    .toLowerCase();
}

// Extract blob file content from view tool results in the conversation
// Blob files are ephemeral and can't be downloaded, but their content appears in tool results
// Returns { content, filename } where filename is the sanitized name from view tool
function extractBlobContent(data, blobPath) {
  const messages = data.chat_messages || [];

  // Read results don't name the file, so match them through their tool_use.
  // Skip partial reads, which would save only part of the file as if it were whole.
  const blobName = blobPath.split('/').pop();
  for (const msg of messages) {
    const content = msg.content || [];
    for (const use of content) {
      if (use.type !== 'tool_use' || use.name !== 'Read') continue;
      const input = use.input || {};
      if (input.offset != null || input.limit != null) continue;
      if ((input.file_path || '').split('/').pop() !== blobName) continue;
      const result = content.find((b) => b.type === 'tool_result' && b.tool_use_id === use.id);
      const text = (result?.content || []).find((c) => c.type === 'text')?.text;
      if (!text || result.is_error) continue;
      return {
        content: fixMojibake(text.split('\n').map((line) => line.replace(/^\s*\d+\t/, '')).join('\n')),
        filename: blobName
      };
    }
  }

  // view results: only a whole-file read of this very file counts. The header names the
  // file; the sandbox may have renamed odd characters to _, so compare basenames with
  // punctuation removed. A directory listing has no such header, and a view_range read
  // is only part of the file.
  const wanted = normalizePathForComparison(blobName);
  const viewInputs = {};
  for (const msg of messages) {
    for (const block of (msg.content || [])) {
      if (block.type === 'tool_use' && block.name === 'view' && block.id) viewInputs[block.id] = block.input || {};
    }
  }
  for (const msg of messages) {
    for (const item of (msg.content || [])) {
      if (item.type !== 'tool_result' || item.name !== 'view' || item.is_error) continue;
      const input = item.tool_use_id ? viewInputs[item.tool_use_id] : null;
      if (input && input.view_range != null) continue;
      for (const content of (item.content || [])) {
        if (content.type !== 'text' || !content.text) continue;
        const header = content.text.match(/^Here's the content of (.+?) with line numbers:\n/);
        if (!header) continue;
        const viewPath = header[1];
        const viewFilename = viewPath.split('/').pop();
        if (viewPath !== blobPath && normalizePathForComparison(viewFilename) !== wanted) continue;
        const lines = content.text.split('\n').slice(1).map((line) => {
          const match = line.match(/^\s*\d+\t(.*)$/);
          return match ? match[1] : line;
        });
        return { content: fixMojibake(lines.join('\n')), filename: viewFilename };
      }
    }
  }
  return null;
}

// Extract project files from view tool results (/mnt/project/ files)
// These are files from Claude Projects that were viewed during the conversation
function extractProjectFiles(data) {
  const projectFiles = {};
  const messages = data.chat_messages || [];

  for (const msg of messages) {
    for (const item of (msg.content || [])) {
      // Look for tool_result from "view" that read project files
      if (item.type === 'tool_result' && item.name === 'view') {
        for (const content of (item.content || [])) {
          if (content.type === 'text' && content.text) {
            // Check if this is project file content (not directory listing)
            const headerMatch = content.text.match(/^Here's the content of (\/mnt\/project\/[^\s]+) with line numbers:/);
            if (headerMatch) {
              const filePath = headerMatch[1];
              const filename = filePath.split('/').pop();

              // Extract the actual content (skip the header line and line numbers)
              const lines = content.text.split('\n');
              let startIdx = 0;
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(/^\s*\d+\t/)) {
                  startIdx = i;
                  break;
                }
              }
              // Remove line number prefixes and reconstruct content
              const contentLines = lines.slice(startIdx).map(line => {
                const match = line.match(/^\s*\d+\t(.*)$/);
                return match ? match[1] : line;
              });

              // Apply mojibake fix to repair encoding issues
              projectFiles[filename] = fixMojibake(contentLines.join('\n'));
            }
          }
        }
      }
    }
  }

  return projectFiles;
}

// Custom error class for file fetch failures with detailed context
class FileFetchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FileFetchError';
    this.urlsTried = details.urlsTried || [];
    this.httpStatus = details.httpStatus || null;
    this.uuid = details.uuid || null;
    this.path = details.path || null;
  }
}

// Fetch a file from Claude's API with fallback URLs
// Returns blob on success, throws FileFetchError with detailed context on failure
async function fetchUploadedFile(url, fileUuid = null, orgId = null, conversationId = null, filePath = null) {
  const urlsToTry = [];
  const urlResults = [];  // Track {url, status, error} for each attempt

  // Primary URL (if provided and not empty)
  if (url) {
    const fullUrl = url.startsWith('http') ? url : `https://claude.ai${url}`;
    urlsToTry.push(fullUrl);
  }

  // Wiggle endpoint using conversation ID and file path (works for blobs too!)
  if (orgId && conversationId && filePath) {
    // encodeURIComponent doesn't encode parentheses, but the wiggle endpoint requires them encoded
    const encodedPath = encodeURIComponent(filePath)
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29');
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodedPath}`);

    // Also try with sanitized path (Claude converts special chars to underscores)
    // Example: "Source_Strange world of the moon; an e - Firsoff, V. A. (Valdemar Axel),.pdf.md"
    //       → "Source_Strange_world_of_the_moon__an_e_-_Firsoff__V__A___Valdemar_Axel___pdf.md"
    const filename = filePath.split('/').pop();
    const dir = filePath.substring(0, filePath.length - filename.length);
    // Replace all special chars (except - and final .ext) with underscore
    // Keep the last .ext intact
    const lastDotIdx = filename.lastIndexOf('.');
    const hasExt = lastDotIdx > 0;
    const basename = hasExt ? filename.substring(0, lastDotIdx) : filename;
    const ext = hasExt ? filename.substring(lastDotIdx) : '';
    // Sanitize basename: replace any non-alphanumeric (except _ and -) with _
    const sanitizedBasename = basename.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const sanitizedFilename = sanitizedBasename + ext;
    const sanitizedPath = dir + sanitizedFilename;
    if (sanitizedPath !== filePath) {
      const encodedSanitized = encodeURIComponent(sanitizedPath);
      urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodedSanitized}`);
    }
  }

  // Fallback URLs using file UUID if available
  if (fileUuid && orgId) {
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/files/${fileUuid}/contents`);
    urlsToTry.push(`https://claude.ai/api/${orgId}/files/${fileUuid}/preview`);
    urlsToTry.push(`https://claude.ai/api/${orgId}/files/${fileUuid}/content`);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/files/${fileUuid}/content`);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/files/${fileUuid}`);
  }

  if (urlsToTry.length === 0) {
    throw new FileFetchError('No URL or path available to fetch file', {
      uuid: fileUuid,
      path: filePath
    });
  }

  let lastStatus = null;
  for (const tryUrl of urlsToTry) {
    try {
      const response = await fetch(tryUrl, {
        credentials: 'include',
        headers: { 'Accept': '*/*' }
      });

      if (response.ok) {
        return await response.blob();
      }
      lastStatus = response.status;
      urlResults.push({ url: tryUrl, status: `HTTP ${response.status}`, error: null });
    } catch (err) {
      urlResults.push({ url: tryUrl, status: null, error: err.message });
    }
  }

  throw new FileFetchError(
    `Failed to fetch file (${lastStatus ? `HTTP ${lastStatus}` : 'network error'})`,
    {
      urlsTried: urlResults,
      httpStatus: lastStatus,
      uuid: fileUuid,
      path: filePath
    }
  );
}

// Get syntax highlighting language from filename extension
function getLanguageFromFilename(filename) {
  const ext = (filename.match(/\.([^.]+)$/) || [])[1] || '';
  const extToLang = {
    'js': 'javascript',
    'ts': 'typescript',
    'tsx': 'tsx',
    'jsx': 'jsx',
    'py': 'python',
    'rb': 'ruby',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'swift': 'swift',
    'kt': 'kotlin',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'html': 'html',
    'css': 'css',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'svg': 'svg',
    'csv': 'csv',
    'txt': 'text'
  };
  return extToLang[ext.toLowerCase()] || 'text';
}

// Process text with citations, inserting footnote markers with HTML anchors
// Returns { text: processedText, references: [{num, title, url, domain, backlinks: []}] }
function processTextWithCitations(text, citations) {
  if (!citations || !Array.isArray(citations) || citations.length === 0) {
    return { text, references: [] };
  }

  // Sort citations by start_index ascending
  const sortedByPosition = [...citations].sort((a, b) => a.start_index - b.start_index);

  // Track unique URLs and assign reference numbers
  const urlToNum = new Map();
  const urlOccurrenceCount = new Map();
  const references = [];
  let refNum = 0;

  // First pass: assign reference numbers to unique URLs
  for (const cit of sortedByPosition) {
    if (!urlToNum.has(cit.url)) {
      refNum++;
      urlToNum.set(cit.url, refNum);
      urlOccurrenceCount.set(cit.url, 0);
      references.push({
        num: refNum,
        title: cit.title || 'Source',
        url: cit.url || '',
        domain: cit.metadata?.site_domain || cit.metadata?.site_name || '',
        backlinks: []
      });
    }
  }

  // Second pass: build citation markers with anchors
  const insertedPositions = new Set();
  const positionToMarker = new Map();

  for (const cit of sortedByPosition) {
    if (insertedPositions.has(cit.end_index)) continue;
    insertedPositions.add(cit.end_index);

    const num = urlToNum.get(cit.url);
    const refIndex = num - 1;
    const occCount = urlOccurrenceCount.get(cit.url);
    urlOccurrenceCount.set(cit.url, occCount + 1);

    // Create anchor ID and label (3, 3:1, 3:2, etc.)
    const anchorId = occCount === 0 ? `cite-${num}` : `cite-${num}-${occCount}`;
    const label = occCount === 0 ? `${num}` : `${num}:${occCount}`;

    // Store backlink info
    references[refIndex].backlinks.push({ id: anchorId, label: label });

    // Create marker with HTML anchor for back-linking
    const marker = `<sup id="${anchorId}">[[${num}]](#ref-${num})</sup>`;
    positionToMarker.set(cit.end_index, marker);
  }

  // Third pass: insert markers from end to start
  let processedText = text;
  const sortedPositions = [...positionToMarker.keys()].sort((a, b) => b - a);

  for (const pos of sortedPositions) {
    const marker = positionToMarker.get(pos);
    if (pos <= processedText.length) {
      processedText = processedText.slice(0, pos) + marker + processedText.slice(pos);
    }
  }

  return { text: processedText, references };
}

// Format references as a list with clickable back-reference links [1], [1:1], [1:2]
function formatReferences(references) {
  if (!references || references.length === 0) return '';

  const lines = ['', '---', '**References:**', ''];
  for (const ref of references) {
    const domain = ref.domain ? ` - ${ref.domain}` : '';

    // Build back-reference links: [1], [1:1], [1:2], [1:3]
    const backlinks = ref.backlinks && ref.backlinks.length > 0
      ? ' ' + ref.backlinks.map(bl => `[[${bl.label}]](#${bl.id})`).join(', ')
      : '';

    lines.push(`${ref.num}. <span id="ref-${ref.num}">[${ref.title}](${ref.url})</span>${domain}${backlinks}`);
  }
  return lines.join('\n');
}

// Get syntax highlighting language from content type
function getLanguageFromType(type) {
  const typeToLang = {
    'text/markdown': 'markdown',
    'text/plain': 'text',
    'text/html': 'html',
    'text/css': 'css',
    'text/csv': 'csv',
    'application/javascript': 'javascript',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/x-python': 'python',
    'text/x-java': 'java',
    'text/x-c': 'c',
    'text/x-cpp': 'cpp',
    'text/x-csharp': 'csharp',
    'text/x-ruby': 'ruby',
    'text/x-go': 'go',
    'text/x-rust': 'rust',
    'text/x-swift': 'swift',
    'text/x-kotlin': 'kotlin',
    'text/x-typescript': 'typescript',
    'text/x-sql': 'sql',
    'text/x-shell': 'bash',
    'text/x-yaml': 'yaml',
    'image/svg+xml': 'svg',
    'application/vnd.ant.react': 'jsx',
    'application/vnd.ant.code': 'text'
  };
  return typeToLang[type] || 'text';
}

// Get thinking summary - uses summaries array when available, falls back to first line
function getThinkingSummary(block) {
  // Check for summaries array (Claude's actual summary)
  if (block.summaries && Array.isArray(block.summaries) && block.summaries.length > 0) {
    const lastSummary = block.summaries[block.summaries.length - 1];
    if (lastSummary.summary) {
      return lastSummary.summary;
    }
  }

  // Fall back to first line of thinking text
  const text = block.thinking || '';
  if (!text) return '';

  const firstLine = text.split('\n')[0];
  if (firstLine.length > 80) {
    return firstLine.substring(0, 77) + '...';
  }
  return firstLine;
}

// Convert markdown to plain text (for integrated_chat.txt)
function markdownToPlainText(markdown) {
  if (!markdown) return '';

  let text = markdown;

  // Remove BOM if present
  text = text.replace(/^\uFEFF/, '');

  // Code is kept exactly as written: fenced blocks and inline code are set aside
  // before any Markdown markers are stripped, and put back at the end.
  const kept = [];
  const keep = (value) => `\uE000${kept.push(value) - 1}\uE001`;
  text = text.replace(/^(`{3,})[^\n`]*\n([\s\S]*?)\n?^\1[ \t]*$/gm, (match, fence, code) =>
    keep('\n' + '-'.repeat(80) + '\n' + code.replace(/^\n+|\s+$/g, '') + '\n' + '-'.repeat(80) + '\n'));
  text = text.replace(/`([^`\n]+)`/g, (match, code) => keep(code));

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove HTML anchor tags but keep content
  text = text.replace(/<a[^>]*>(.*?)<\/a>/g, '$1');
  text = text.replace(/<span[^>]*>(.*?)<\/span>/g, '$1');
  text = text.replace(/<sup[^>]*>(.*?)<\/sup>/g, '');

  // Convert headings to plain text with underlines
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (match, heading) => {
    return '\n' + heading.toUpperCase() + '\n' + '='.repeat(Math.min(heading.length, 80)) + '\n';
  });

  // Remove bold/italic markers
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '$1'); // bold+italic
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');     // bold
  text = text.replace(/\*(.+?)\*/g, '$1');         // italic
  text = text.replace(/___(.+?)___/g, '$1');       // bold+italic
  text = text.replace(/__(.+?)__/g, '$1');         // bold
  text = text.replace(/_(.+?)_/g, '$1');           // italic

  // Convert lists to simple format
  text = text.replace(/^\s*[-*+]\s+/gm, '  • ');
  text = text.replace(/^\s*\d+\.\s+/gm, '  ');

  // Convert markdown links to plain text: [text](url) -> text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Remove blockquote markers
  text = text.replace(/^>\s?/gm, '');

  // Remove horizontal rules (---, ***, ___)
  text = text.replace(/^[\-*_]{3,}$/gm, '\n' + '~'.repeat(80) + '\n');

  // Clean up multiple blank lines (more than 2)
  text = text.replace(/\n{4,}/g, '\n\n\n');

  text = text.replace(/\uE000(\d+)\uE001/g, (match, i) => kept[Number(i)]);

  // Remove leading/trailing whitespace
  text = text.trim();

  return text;
}

// ============================================================================
// Priority 2: Enhanced Export - Zip Archive Support
// ============================================================================

// Extract all code blocks from text
function extractCodeBlocks(text) {
  const pattern = /```(\w*)\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push({ lang: match[1] || 'text', code: match[2].trim() });
  }
  return blocks;
}

// Extract all URLs from text
function extractUrls(text) {
  const urls = [];
  const seen = new Set();

  // Markdown links [text](url)
  const mdLinks = text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
  for (const match of mdLinks) {
    if (!seen.has(match[2])) {
      seen.add(match[2]);
      urls.push({ url: match[2], context: match[1] });
    }
  }

  // Bare URLs
  const bareUrls = text.matchAll(/(?<!\()https?:\/\/[^\s)>\]]+/g);
  for (const match of bareUrls) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      urls.push({ url: match[0], context: '' });
    }
  }

  return urls;
}

// Sanitize text for use as filename
function sanitizeForFilename(text, maxLen = 50) {
  let clean = text.replace(/\*+/g, '').replace(/#+\s*/g, '').trim();
  clean = clean.replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/[\s-]+/g, '_');
  clean = clean.replace(/^_+|_+$/g, '').toLowerCase();
  return Array.from(clean).slice(0, maxLen).join('') || 'untitled';
}

// Extract first heading from markdown
function extractFirstHeading(text) {
  const match = text.match(/^#+\s+(.+)$/m);
  if (match) return match[1].trim();

  const boldMatch = text.match(/^\*\*(.+?)\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  const firstLine = text.trim().split('\n')[0].substring(0, 50);
  return firstLine || 'response';
}

// Escape markdown special characters for display in plain text
function escapeMarkdown(text) {
  if (!text) return text;
  // Escape backticks, asterisks, underscores, brackets, and other special chars
  return text.replace(/([`*_\[\]<>#\\])/g, '\\$1');
}

// Extract text-only content from a message (no thinking/tools)
function extractResponseTextOnly(msg, artifacts) {
  const lines = [];
  for (const block of (msg.content || [])) {
    if (block.type === 'text') {
      lines.push(block.text || '');
    }
  }
  return lines.join('\n\n');
}

// Generate meta.md content
function generateMeta(data, messages, artifacts, codeBlocks, urls, textAttachments = {}, projectFiles = {}, uploadedFiles = [], webSources = [], failedUploadCount = 0, projectUploadCount = 0) {
  const title = data.name || 'Claude Conversation';
  const promptCount = messages.filter(m => m.sender === 'human').length;
  const responseCount = messages.filter(m => m.sender === 'assistant').length;

  let promptWords = 0, responseWords = 0;
  for (const msg of messages) {
    const text = extractTextContent(msg.content);
    const words = text.split(/\s+/).filter(w => w).length;
    if (msg.sender === 'human') promptWords += words;
    else if (msg.sender === 'assistant') responseWords += words;
  }

  // Count languages
  const langCounts = {};
  for (const block of codeBlocks) {
    langCounts[block.lang] = (langCounts[block.lang] || 0) + 1;
  }

  // Calculate duration
  const firstMsgTime = messages[0]?.created_at ? new Date(messages[0].created_at) : null;
  const lastMsgTime = messages[messages.length - 1]?.created_at ? new Date(messages[messages.length - 1].created_at) : null;
  let duration = '';
  if (firstMsgTime && lastMsgTime) {
    const diffMs = lastMsgTime - firstMsgTime;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays > 0) duration = `${diffDays}d ${diffHours % 24}h`;
    else if (diffHours > 0) duration = `${diffHours}h ${diffMins % 60}m`;
    else duration = `${diffMins}m`;
  }

  // Get settings
  const settings = data.settings || {};
  const features = [];
  const usedWebSearch = messages.some((m) => (m.content || []).some((b) => b.type === 'tool_use' && b.name === 'web_search'));
  if (usedWebSearch) features.push('Web Search');
  if (Object.keys(artifacts).length > 0) features.push('Artifacts');
  if (settings.paprika_mode === 'extended') features.push('Extended Thinking');
  else if (settings.paprika_mode === 'normal') features.push('Thinking');

  const lines = [
    '# Conversation Metadata',
    '',
    '## Basic Info',
    '',
    '| Property | Value |',
    '|----------|-------|',
    `| **Title** | ${title} |`,
    `| **UUID** | \`${data.uuid || ''}\` |`,
    `| **Model** | ${getModelName(data)} |`,
    `| **Created** | ${formatTimestamp(data.created_at)} |`,
    `| **Updated** | ${formatTimestamp(data.updated_at)} |`,
    `| **Duration** | ${duration || 'N/A'} |`,
    `| **Starred** | ${data.is_starred ? '⭐ Yes' : 'No'} |`,
    `| **Features** | ${features.length > 0 ? features.join(', ') : 'None'} |`,
    `| **Link** | [Open in Claude](https://claude.ai/chat/${data.uuid}) |`,
    '',
    '## Statistics',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| **Total Messages** | ${messages.length} |`,
    `| **Prompts** | ${promptCount} |`,
    `| **Responses** | ${responseCount} |`,
    `| **Artifacts** | ${Object.keys(artifacts).length} |`,
    `| **Text Attachments** | ${Object.keys(textAttachments).length} |`,
    `| **Project Files** | ${Object.keys(projectFiles).length + projectUploadCount} |`,
    `| **Uploaded Files** | ${uploadedFiles.length}${failedUploadCount > 0 ? ` (${failedUploadCount} failed)` : ''} |`,
    `| **Code Blocks** | ${codeBlocks.length} |`,
    `| **Links** | ${urls.length} |`,
    `| **Web Sources** | ${webSources.length} |`,
    '',
    '## Word Counts',
    '',
    '| Type | Words |',
    '|------|-------|',
    `| **Prompts** | ${promptWords.toLocaleString()} |`,
    `| **Responses** | ${responseWords.toLocaleString()} |`,
    `| **Total** | ${(promptWords + responseWords).toLocaleString()} |`,
    '',
    '## Timeline',
    '',
    '| Event | Timestamp |',
    '|-------|-----------|',
    `| **First Message** | ${formatTimestamp(messages[0]?.created_at)} |`,
    `| **Last Message** | ${formatTimestamp(messages[messages.length - 1]?.created_at)} |`,
    `| **Exported** | ${formatTimestamp(new Date().toISOString())} |`,
    '',
    '## Code Languages',
    ''
  ];

  if (Object.keys(langCounts).length > 0) {
    lines.push('| Language | Count |');
    lines.push('|----------|-------|');
    const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
    for (const [lang, count] of sorted) {
      lines.push(`| ${lang} | ${count} |`);
    }
  } else {
    lines.push('*No code blocks found*');
  }

  return lines.join('\n');
}

// Generate prompts.md content
// uploadNames: from populateConversationFolder, uploadNameKey -> [saved name or null], in order.
// attachmentFiles: from extractTextAttachments, message uuid -> [{ att, name }].
function generatePrompts(messages, responseFiles, attachmentIdMap = {}, uploadNames = null, attachmentFiles = null) {
  const takenUploads = {};
  const lines = ['# Prompts', ''];
  let promptNum = 0;
  let responseNum = 0;

  // Build prompt to response mapping
  const promptResponses = {};
  for (const msg of messages) {
    if (msg.sender === 'human') {
      promptNum++;
      promptResponses[promptNum] = [];
    } else if (msg.sender === 'assistant') {
      const text = extractResponseTextOnly(msg, {});
      if (text.trim()) {
        responseNum++;
        if (promptNum > 0) {
          promptResponses[promptNum].push(responseNum);
        }
      }
    }
  }

  promptNum = 0;
  for (const msg of messages) {
    if (msg.sender !== 'human') continue;
    promptNum++;

    lines.push(`## Prompt ${promptNum}`);
    lines.push(`*${formatTimestamp(msg.created_at)}*`);
    lines.push('');

    // Check for text attachments (pasted files) - include those with extracted_content even if no file_name
    const attachments = (msg.attachments || []).filter(a => a.extracted_content);
    if (attachments.length > 0) {
      lines.push('**Attachments:**');
      for (const att of attachments) {
        // Use id-to-filename map for accurate filename, fall back to original file_name
        const attId = att.id || '';
        const saved = attachmentFiles && (attachmentFiles[msg.uuid] || []).find((entry) => entry.att === att);
        const filename = saved ? saved.name : (attId && attachmentIdMap[attId]) ? attachmentIdMap[attId] : (att.file_name || 'unknown');
        lines.push(`- [${filename}](attachments/${encodeURIComponent(filename)})`);
      }
      lines.push('');
    }

    // Check for uploaded files (PDFs, images) - both files_v2 and files arrays
    const uploadsV2 = (msg.files_v2 || []).filter(f => f.success && f.file_name);
    const uploadsOld = (msg.files || []).filter(f => f.success && (f.path || f.file_name));
    if (uploadsV2.length > 0 || uploadsOld.length > 0) {
      lines.push('**Uploaded Files:**');
      // files_v2 format
      // Link each upload to the name it was saved under; one that failed is named, not linked.
      const uploadLine = (label, uuid, original, pageInfo) => {
        if (!uploadNames) {
          // No record of what was saved: link to the name an export would use.
          const guessed = (`p${String(promptNum).padStart(2, '0')}_` + zipSafeName(original)).normalize('NFC');
          return `- [${label}](uploads/${encodeURIComponent(guessed)})${pageInfo}`;
        }
        const key = uploadNameKey(uuid, promptNum, original);
        const nth = takenUploads[key] || 0;
        takenUploads[key] = nth + 1;
        const saved = (uploadNames[key] || [])[nth];
        return saved
          ? `- [${label}](uploads/${encodeURIComponent(saved)})${pageInfo}`
          : `- ${label}${pageInfo} *(not saved, see errors.txt)*`;
      };
      for (const file of uploadsV2) {
        const pageInfo = file.document_asset?.page_count ? ` (${file.document_asset.page_count} pages)` : '';
        lines.push(uploadLine(file.file_name, file.file_uuid, file.file_name, pageInfo));
      }
      // files format (older) - get filename from path or file_name
      for (const file of uploadsOld) {
        const filename = file.path ? file.path.split('/').pop() : file.file_name;
        const pageInfo = file.document_asset?.page_count ? ` (${file.document_asset.page_count} pages)` : '';
        lines.push(uploadLine(filename, file.file_uuid, filename, pageInfo));
      }
      lines.push('');
    }

    lines.push(extractTextContent(msg.content));
    lines.push('');

    const resps = promptResponses[promptNum] || [];
    if (resps.length > 0) {
      lines.push('**Responses:**');
      for (const rNum of resps) {
        const rf = responseFiles[rNum - 1];
        if (rf) {
          lines.push(`- Response ${rNum}: [text](responses/${rf.pure}) | [full](responses/${rf.full})`);
        }
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// Generate responses_text_only.md
function generateResponsesTextOnly(messages, artifacts) {
  const lines = ['# Responses (Text Only)', ''];
  let responseNum = 0;
  let promptNum = 0;

  for (const msg of messages) {
    if (msg.sender === 'human') {
      promptNum++;
    } else if (msg.sender === 'assistant') {
      const text = extractResponseTextOnly(msg, artifacts);
      if (text.trim()) {
        responseNum++;
        lines.push(`## Response ${responseNum}`);
        lines.push(`*[Prompt ${promptNum}](prompts.md#prompt-${promptNum})*`);
        lines.push('');
        lines.push(text);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// Generate code_snippets.md
function generateCodeSnippets(codeBlocks) {
  const lines = [
    '# Code Snippets',
    '',
    `*${codeBlocks.length} code blocks extracted from conversation*`,
    ''
  ];

  codeBlocks.forEach((block, i) => {
    const header = block.filename
      ? `## Snippet ${i + 1}: ${block.filename} (${block.lang})`
      : `## Snippet ${i + 1} (${block.lang})`;
    lines.push(header);
    lines.push('');
    const fence = getCodeFence(block.code);
    lines.push(`${fence}${block.lang}`);
    lines.push(block.code);
    lines.push(fence);
    lines.push('');
  });

  return lines.join('\n');
}

// Generate combined links_and_sources.md
function generateLinksAndSources(urls, webSources) {
  if (urls.length === 0 && webSources.length === 0) return null;

  const lines = [
    '# Links & Sources',
    '',
  ];

  // Web Sources section
  if (webSources.length > 0) {
    lines.push('## Web Search Sources');
    lines.push('');
    lines.push(`*${webSources.length} sources from web search*`);
    lines.push('');

    // Group by domain
    const byDomain = {};
    for (const src of webSources) {
      const domain = src.domain || 'other';
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(src);
    }

    // Sort domains by count
    const sortedDomains = Object.keys(byDomain).sort((a, b) => byDomain[b].length - byDomain[a].length);

    for (const domain of sortedDomains) {
      const domainSources = byDomain[domain];
      lines.push(`### ${domain} (${domainSources.length})`);
      lines.push('');
      for (const src of domainSources) {
        const flags = [];
        if (src.isMissing) flags.push('missing');
        if (!src.isCitable) flags.push('not citable');
        const flagStr = flags.length > 0 ? ` *(${flags.join(', ')})*` : '';
        lines.push(`- [${src.title}](${src.url})${flagStr}`);
      }
      lines.push('');
    }
  }

  // Links section
  if (urls.length > 0) {
    lines.push('## Links in Conversation');
    lines.push('');
    lines.push(`*${urls.length} unique URLs found in text*`);
    lines.push('');

    // Group by domain
    const domains = {};
    for (const { url, context } of urls) {
      try {
        const domain = new URL(url).hostname;
        if (!domains[domain]) domains[domain] = [];
        domains[domain].push({ url, context });
      } catch {
        if (!domains['other']) domains['other'] = [];
        domains['other'].push({ url, context });
      }
    }

    for (const domain of Object.keys(domains).sort()) {
      lines.push(`### ${domain}`);
      lines.push('');
      for (const { url, context } of domains[domain]) {
        if (context) {
          lines.push(`- [${context}](${url})`);
        } else {
          lines.push(`- <${url}>`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// Populate a zip folder with all conversation files
// Used by both single export and mega-zip export
// In a mega-ZIP, sharedProjects stores each project's files once at the archive
// root: { root, byUuid: Map, usedDirs: Set }. Without it, files go in this folder.
// folderName is this folder's path from the ZIP root, for the viewer's links.
async function populateConversationFolder(folder, data, onProgress = null, organizationId = null, sharedProjects = null, folderName = '') {
  const title = data.name || 'Claude Conversation';
  const messages = getMessageChain(data);

  // Initialize error collector for comprehensive error tracking
  const errorCollector = new ExportErrorCollector(data.name, data.uuid);

  const artifactIndex = {};
  const artifacts = extractArtifacts(data, errorCollector, artifactIndex);
  const { attachments: textAttachments, idToFilename: attachmentIdMap, byMessage: attachmentFiles } = extractTextAttachments(data);
  const uploadedFiles = extractUploadedFiles(data, organizationId);
  const presentedFiles = extractPresentedFiles(data);
  const webSources = extractWebSources(data);

  // Fetch project files: try API first (full files), fall back to view tool results (truncated)
  let projectFiles = {};
  let projectFilesFromApi = false;
  let projectDocsJson = null;
  let projectMetadataJson = null;
  let projectInstructions = '';  // The project's prompt template, for the viewer
  let projectUploads = [];  // Names of the project's saved knowledge files
  let projectFilesPath = 'project/files';  // Where they are, relative to this folder
  if (data.project_uuid || data.project?.uuid) {
    if (onProgress) onProgress('Fetching project files...');
    // In a mega-ZIP, every chat in a project needs the same metadata and docs, so a
    // complete fetch is kept for the next chat. One with failures is fetched again.
    const docsKey = data.project_uuid || data.project?.uuid;
    let fetched = sharedProjects?.docsByUuid?.get(docsKey);
    if (!fetched) {
      fetched = await fetchProjectDocs(data, organizationId);
      if (sharedProjects && !fetched.metadataError && fetched.failures.length === 0) {
        if (!sharedProjects.docsByUuid) sharedProjects.docsByUuid = new Map();
        sharedProjects.docsByUuid.set(docsKey, fetched);
      }
    }
    const { files: apiDocs, docsJson, projectJson, failures: projectFailures, metadataError } = fetched;
    projectDocsJson = docsJson;
    projectMetadataJson = projectJson;
    projectInstructions = projectJson?.prompt_template ? fixMojibake(String(projectJson.prompt_template)) : '';

    // Patch data.project.name if it wasn't populated by the original fetch,
    // so the project prefix is applied to the export filename.
    if (projectJson?.name && !data.project?.name) {
      const projectUuid = data.project_uuid || data.project?.uuid;
      data.project = { ...(data.project || {}), uuid: projectUuid, name: projectJson.name };
    }

    // Track project metadata errors
    if (metadataError) {
      errorCollector.addWarning('project_metadata', 'project metadata', metadataError.error, {
        uuid: metadataError.projectUuid,
        httpStatus: metadataError.httpStatus,
        note: 'Project metadata could not be fetched; project.json will not be included'
      });
    }

    // Track project doc failures
    for (const failure of projectFailures) {
      errorCollector.addError('project_doc', failure.filename, failure.error, {
        uuid: failure.uuid,
        httpStatus: failure.httpStatus,
        urlsTried: failure.urlsTried || []
      });
    }

    if (apiDocs.length > 0) {
      projectFilesFromApi = true;
      // Docs are named by their titles, which can repeat or match the metadata
      // files written beside them, so each gets a free name, compared case-insensitively.
      const taken = new Set(['project.json', 'docs.json', 'files.json', 'prompt_template.md', 'files']);
      for (const doc of apiDocs) {
        const name = zipSafeName(doc.filename) || 'document.md';
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.substring(0, dot) : name;
        const ext = dot > 0 ? name.substring(dot) : '';
        let finalName = name;
        for (let n = 2; taken.has(finalName.toLowerCase()); n++) finalName = `${base}_${n}${ext}`;
        taken.add(finalName.toLowerCase());
        projectFiles[finalName] = doc.content;
      }
      console.log(`Fetched ${apiDocs.length} project files from API`);
    }

    // Download knowledge files, once per project in a mega-ZIP.
    const projectUuid = data.project_uuid || data.project?.uuid;
    let saved = sharedProjects?.byUuid.get(projectUuid);
    if (saved) {
      // A shared download that failed is still missing from this chat.
      if (!projectInstructions) projectInstructions = saved.instructions || '';
      projectUploads = saved.names;
      projectFilesPath = `../projects/${saved.dir}/files`;
    } else {
      const { files: knowledgeFiles, failure: listFailure } = await fetchProjectFileList(projectUuid, organizationId);
      let target = folder;
      let basePath = 'project';
      let dir = null;
      if (sharedProjects && knowledgeFiles.length > 0) {
        const baseDir = safeFilename(projectJson?.name || data.project?.name || projectUuid);
        dir = baseDir;
        for (let n = 2; sharedProjects.usedDirs.has(dir.toLowerCase()); n++) {
          dir = `${baseDir}_${n}`;
        }
        sharedProjects.usedDirs.add(dir.toLowerCase());
        target = sharedProjects.root;
        basePath = `projects/${dir}`;
      }
      if (knowledgeFiles.length > 0) {
        target.file(`${basePath}/files.json`, JSON.stringify(knowledgeFiles, null, 2));
      }
      const { names, failures } = await saveProjectFiles(target, basePath, knowledgeFiles, organizationId, data.uuid, onProgress);
      saved = { dir, names, instructions: projectInstructions, count: knowledgeFiles.length, failures: listFailure ? [listFailure, ...failures] : failures };
      if (sharedProjects && !listFailure) {
        sharedProjects.byUuid.set(projectUuid, saved);
      }
      projectUploads = names;
      if (dir) projectFilesPath = `../projects/${dir}/files`;
    }
    for (const failure of saved.failures) {
      errorCollector.addError('project_doc', failure.filename, failure.error, {
        uuid: failure.uuid,
        httpStatus: failure.httpStatus,
        urlsTried: failure.urlsTried || []
      });
    }

    // The project's own counts catch anything these lists no longer return.
    const expected = (projectJson?.docs_count || 0) + (projectJson?.files_count || 0);
    const received = (Array.isArray(docsJson) ? docsJson.length : 0) + saved.count;
    if (expected > received) {
      errorCollector.addWarning('project_doc', 'project contents', `The project reports ${expected} item(s), but the export found ${received}.`, {
        uuid: projectUuid,
        note: 'Some project content may be missing, or claude.ai may have changed where it stores project files.'
      });
    }
  }
  // Fall back to extracted view tool results if API didn't return files
  if (Object.keys(projectFiles).length === 0 && projectUploads.length === 0) {
    projectFiles = extractProjectFiles(data);
    // Add warnings for truncated project files (extracted from JSON, not full API response)
    if (Object.keys(projectFiles).length > 0) {
      for (const filename of Object.keys(projectFiles)) {
        errorCollector.addWarning('project_doc', filename, 'Full file could not be fetched; content extracted from conversation (may be truncated)', {
          truncated: true,
          note: 'Content was extracted from view tool results in the conversation JSON'
        });
      }
    }
  }

  // Collect all text for extraction
  let chatText = '';
  for (const msg of messages) {
    chatText += extractTextContent(msg.content) + '\n\n';
  }
  let allText = chatText;
  for (const content of Object.values(artifacts)) {
    allText += content + '\n\n';
  }

  // Code blocks from the chat itself. Artifacts are added whole below, so the
  // blocks inside them aren't listed a second time.
  const codeBlocks = extractCodeBlocks(chatText);

  // Also include artifacts themselves as code blocks
  for (const [filename, content] of Object.entries(artifacts)) {
    const ext = filename.split('.').pop().toLowerCase();
    const langMap = {
      md: 'markdown', html: 'html', css: 'css', js: 'javascript', jsx: 'jsx',
      py: 'python', json: 'json', xml: 'xml', txt: 'text', svg: 'svg',
      ts: 'typescript', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp',
      rb: 'ruby', go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin',
      sql: 'sql', sh: 'bash', yaml: 'yaml', yml: 'yaml'
    };
    const lang = langMap[ext] || 'text';
    codeBlocks.push({ lang: lang, code: content, filename: filename });
  }

  const urls = extractUrls(allText);

  // Generate response files
  const responseFiles = [];
  let responseNum = 0;
  let promptNum = 0;
  const responseToPrompt = {};

  // First pass: map responses to prompts
  for (const msg of messages) {
    if (msg.sender === 'human') {
      promptNum++;
    } else if (msg.sender === 'assistant') {
      const text = extractResponseTextOnly(msg, artifacts);
      if (text.trim()) {
        responseNum++;
        responseToPrompt[responseNum] = promptNum;
      }
    }
  }

  // Second pass: create response files
  responseNum = 0;
  promptNum = 0;
  for (const msg of messages) {
    if (msg.sender === 'human') {
      promptNum++;
      continue;
    }
    if (msg.sender !== 'assistant') continue;

    const textOnly = extractResponseTextOnly(msg, artifacts);
    if (!textOnly.trim()) continue;

    responseNum++;
    const pNum = responseToPrompt[responseNum];

    // Get full content with meta
    const fullContent = [];
    const fullReferences = [];
    const fullSeenUrls = new Set();

    for (const block of (msg.content || [])) {
      if (block.type === 'thinking') {
        const thinkingText = block.thinking || '';
        if (thinkingText) {
          const fence = getCodeFence(thinkingText);
          const summary = getThinkingSummary(block);
          fullContent.push(`${fence}plaintext`);
          fullContent.push(`Thought process: ${summary}`);
          fullContent.push('');
          fullContent.push(thinkingText);
          fullContent.push(fence);
          fullContent.push('');
        }
      } else if (block.type === 'tool_use') {
        const toolName = block.name || '';
        const input = block.input || {};
        if (toolName === 'web_search') {
          fullContent.push('```plaintext');
          fullContent.push(`Web Search: ${input.query || ''}`);
          fullContent.push('```');
          fullContent.push('');
        } else if (toolName === 'create_file' || toolName === 'Write') {
          const filename = (input.path || input.file_path || '').split('/').pop();
          const fileText = input.file_text || input.content || '';
          fullContent.push('```plaintext');
          fullContent.push(`Creating artifact: ${filename}`);
          fullContent.push('```');
          fullContent.push('');
          if (fileText) {
            const lang = getLanguageFromFilename(filename);
            const fence = getCodeFence(fileText);
            fullContent.push(`${fence}${lang}`);
            fullContent.push(fileText);
            fullContent.push(fence);
            fullContent.push('');
          }
        } else if (toolName === 'artifacts' && ['create', 'update', 'rewrite'].includes(input.command)) {
          const title = input.title || input.id || 'Untitled';
          const action = input.command === 'update' ? 'Updating' : input.command === 'rewrite' ? 'Rewriting' : 'Creating';
          const content = input.content || '';
          const type = input.type || 'text/plain';
          fullContent.push('```plaintext');
          fullContent.push(`${action} artifact: ${title}`);
          fullContent.push('```');
          fullContent.push('');
          if (content) {
            const lang = getLanguageFromType(type);
            const fence = getCodeFence(content);
            fullContent.push(`${fence}${lang}`);
            fullContent.push(content);
            fullContent.push(fence);
            fullContent.push('');
          }
        }
      } else if (block.type === 'tool_result' && block.name === 'web_search') {
        if (Array.isArray(block.content)) {
          for (const result of block.content) {
            if (result.type === 'knowledge') {
              fullContent.push(`> **${result.title || ''}** [${result.metadata?.site_domain || ''}](${result.url || ''})`);
              fullContent.push('>');
            }
          }
          fullContent.push('');
        }
      } else if (block.type === 'text') {
        const rawText = block.text || '';
        const citations = block.citations || [];

        if (citations.length > 0) {
          const { text: processedText, references } = processTextWithCitations(rawText, citations);
          fullContent.push(processedText);

          // Collect unique references
          for (const ref of references) {
            if (!fullSeenUrls.has(ref.url)) {
              fullSeenUrls.add(ref.url);
              fullReferences.push(ref);
            }
          }
        } else {
          fullContent.push(rawText);
        }
        fullContent.push('');
      }
    }

    // Add references section if any citations were found
    if (fullReferences.length > 0) {
      fullContent.push(formatReferences(fullReferences));
    }

    const heading = extractFirstHeading(textOnly);
    const baseName = sanitizeForFilename(heading);
    const pureFilename = `${String(responseNum).padStart(3, '0')}_${baseName}_response.md`;
    const fullFilename = `${String(responseNum).padStart(3, '0')}_${baseName}_response.full.md`;

    addFileWithBOM(folder, `responses/${pureFilename}`, textOnly);
    const backLink = `← [Prompt ${pNum}](../prompts.md#prompt-${pNum})\n\n---\n\n`;
    addFileWithBOM(folder, `responses/${fullFilename}`, backLink + fullContent.join('\n'));

    responseFiles.push({ pure: pureFilename, full: fullFilename, heading, type: 'response' });
  }

  // Add artifacts from JSON (create_file, artifacts tool, heredoc)
  for (const [filename, content] of Object.entries(artifacts)) {
    addFileWithBOM(folder, `artefacts/${filename}`, content);
  }

  // Flag any bash_tool command that mutates a tracked artifact in a way the
  // declarative replay can't reconstruct. Emits `artifact_opaque_mutation`
  // warnings in errors.txt pointing the user at the companion replay_bash.py
  // CLI for recovery. See docs/WASM_REPLAY_APPROACH.md for
  // why we don't try to interpret bash scripts in the extension. It runs before
  // the presented files, which use its warnings.
  detectOpaqueMutations(data, errorCollector);

  // Download presented files (files Claude showed the user). One the replay
  // already rebuilt is skipped, unless the replay is known to be off for it (an
  // edit that couldn't be applied, or a script that changed it): then the
  // presented copy is the real final state, and it replaces the replayed file
  // and its last version. Two presented files with one name from different
  // folders are kept apart as <base>_2<ext>.
  const replayIsOff = (name) => errorCollector.warnings.some((w) =>
    (w.type === 'str_replace_failed' || w.type === 'artifact_opaque_mutation') && w.filename === name);
  const presentedNames = {};  // presented path -> its name in artefacts/
  const presentedFrom = {};   // name in artefacts/ -> the presented path that took it
  for (let i = 0; i < presentedFiles.length; i++) {
    const file = presentedFiles[i];
    let name = file.filename;
    if (presentedFrom[name] && presentedFrom[name] !== file.path) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.substring(0, dot) : name;
      const ext = dot > 0 ? name.substring(dot) : '';
      for (let n = 2; Object.prototype.hasOwnProperty.call(artifacts, name) || presentedFrom[name]; n++) name = `${base}_${n}${ext}`;
      errorCollector.addWarning('artifact_basename_collision', name,
        `Another presented file is already named "${file.filename}". This one was saved as "${name}" to avoid overwriting.`,
        { path: file.path, note: 'Check that both files are intended.' });
    }
    const replayed = Object.prototype.hasOwnProperty.call(artifacts, name) && !presentedFrom[name];
    presentedNames[file.path] = name;
    presentedFrom[name] = file.path;
    if (replayed && !replayIsOff(name)) continue;

    if (onProgress) {
      onProgress(15 + Math.floor((i / presentedFiles.length) * 5), 100, `Downloading: ${file.filename}`);
    }

    try {
      const conversationId = data.uuid;
      const blob = await fetchUploadedFile(null, file.uuid, organizationId, conversationId, file.path);
      await addArtefactBlob(folder, artifacts, name, blob);
      if (replayed) {
        const entry = Object.values(artifactIndex).find((e) => e.filename === name);
        if (entry && entry.versions.length > 1) await addArtefactBlob(folder, artifacts, entry.versions[entry.versions.length - 1], blob);
        errorCollector.clearWarnings('artifact_opaque_mutation', name);
      }
      // The download is the file's final state, so edits that couldn't be
      // replayed against it aren't missing.
      errorCollector.clearWarnings('str_replace_failed', name);
    } catch (err) {
      console.error(`Failed to download presented file ${file.filename}:`, err);
      errorCollector.addError('presented_file', name, err.message, {
        uuid: file.uuid,
        path: file.path,
        urlsTried: err.urlsTried || [],
        httpStatus: err.httpStatus || null
      });
    }
  }

  // Download files Claude sent with SendUserFile. Their bytes exist only on the
  // server, so these are fetched by UUID.
  const deliveredFiles = extractDeliveredFiles(data, Object.keys(artifacts));
  // Saved files only, for the viewer's deliveries map (see buildViewerDeliveries).
  const savedDeliveries = [];
  for (let i = 0; i < deliveredFiles.length; i++) {
    const file = deliveredFiles[i];
    if (onProgress) {
      onProgress(15 + Math.floor((i / deliveredFiles.length) * 5), 100, `Downloading: ${file.filename}`);
    }

    try {
      const blob = await fetchUploadedFile(null, file.uuid, organizationId, data.uuid, null);
      await addArtefactBlob(folder, artifacts, file.filename, blob);
      savedDeliveries.push(file);
    } catch (err) {
      console.error(`Failed to download delivered file ${file.filename}:`, err);
      errorCollector.addError('delivered_file', file.filename, err.message, {
        uuid: file.uuid,
        path: file.path,
        urlsTried: err.urlsTried || [],
        httpStatus: err.httpStatus || null
      });
    }
  }

  // Add text attachments (pasted files)
  for (const [filename, content] of Object.entries(textAttachments)) {
    addFileWithBOM(folder, `attachments/${filename}`, content);
  }

  // Add project files (from Claude Projects, viewed during conversation)
  // If from JSON extraction (truncated), add _truncated suffix to filename
  const projectFileMapping = {}; // original filename -> actual filename in zip
  for (const [filename, content] of Object.entries(projectFiles)) {
    let actualFilename = filename;
    if (!projectFilesFromApi) {
      // Add _truncated before the extension
      const lastDot = filename.lastIndexOf('.');
      if (lastDot > 0) {
        actualFilename = filename.substring(0, lastDot) + '_truncated' + filename.substring(lastDot);
      } else {
        actualFilename = filename + '_truncated';
      }
    }
    projectFileMapping[filename] = actualFilename;
    addFileWithBOM(folder, `project/${actualFilename}`, content);
  }

  // Save raw docs.json if we fetched from API
  if (projectDocsJson) {
    folder.file('project/docs.json', JSON.stringify(projectDocsJson, null, 2));
  }

  // Save project.json and prompt_template.md if we fetched project metadata
  if (projectMetadataJson) {
    folder.file('project/project.json', JSON.stringify(projectMetadataJson, null, 2));
    // Extract prompt_template as separate markdown file
    if (projectMetadataJson.prompt_template) {
      addFileWithBOM(folder, 'project/prompt_template.md', fixMojibake(projectMetadataJson.prompt_template));
    }
  }

  // Fetch and add uploaded files (PDFs, images, etc.)
  const downloadedFiles = [];
  const failedFiles = [];  // Keep for README.md backward compatibility
  const usedUploadNames = new Set();  // lowercase names already in uploads/
  const savedUploadNames = {};  // uploadNameKey -> [saved name, or null when it failed], in order
  const viewerUploads = {};  // File UUID (or name) -> { path, text }, saved files only
  // sandboxPath -> { blob, filename }, encoded as a data URI only when an artifact refers to it.
  const uploadSources = {};

  for (let i = 0; i < uploadedFiles.length; i++) {
    const file = uploadedFiles[i];
    if (onProgress) {
      onProgress(20 + Math.floor((i / uploadedFiles.length) * 40), 100, `Processing: ${file.filename}`);
    }

    // Handle duplicate filenames. Compared case-insensitively, because Photo.PNG and
    // photo.png are one file once unzipped on macOS or Windows.
    const freeUploadName = (name) => {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.substring(0, dot) : name;
      const ext = dot > 0 ? name.substring(dot) : '';
      let free = name;
      for (let counter = 1; usedUploadNames.has(free.toLowerCase()); counter++) free = `${base}_${counter}${ext}`;
      usedUploadNames.add(free.toLowerCase());
      return free;
    };
    const finalName = freeUploadName(file.filename);
    const uploadKey = uploadNameKey(file.uuid, file.promptNum, file.originalFilename);
    (savedUploadNames[uploadKey] = savedUploadNames[uploadKey] || []).push(null);
    const recordSaved = (name) => { savedUploadNames[uploadKey][savedUploadNames[uploadKey].length - 1] = name; };

    try {
      const conversationId = data.uuid;
      let fallbackAttempted = false;
      let fallbackResult = null;

      // Try API download first (works for all file types including blobs via wiggle endpoint)
      try {
        const blob = await fetchUploadedFile(
          file.url || null,
          file.uuid,
          organizationId,
          conversationId,
          file.path
        );
        folder.file(`uploads/${finalName}`, blob);
        recordSaved(finalName);
        downloadedFiles.push({ name: finalName, fromJson: false });
        viewerUploads[file.uuid || file.originalFilename] = { path: `uploads/${finalName}`, text: await viewerUploadText(finalName, blob) };
        // Keep the blob by sandbox path, so the inline pass below can turn it into a
        // data URI if a text artifact refers to it. Most uploads are never referred
        // to, so nothing is encoded here.
        //
        // The older `files` array format doesn't carry an explicit path, so
        // we synthesize one from the conventional sandbox location
        // /mnt/user-data/uploads/<original filename>. We always register that
        // synthesized key, plus file.path when present (newer files_v2 entries
        // carry it). Both point at the same upload.
        const source = { blob, filename: file.filename };
        if (file.path) uploadSources[file.path] = source;
        if (file.originalFilename) uploadSources[`/mnt/user-data/uploads/${file.originalFilename}`] = source;
      } catch (apiErr) {
        // API failed - try JSON fallback for blob files
        if (file.isBlob && file.path) {
          fallbackAttempted = true;
          const result = extractBlobContent(data, file.path);
          if (result && result.content) {
            fallbackResult = 'Content recovered from JSON';
            // Use the sanitized filename from view tool, but keep prompt prefix
            const promptPrefix = `p${String(file.promptNum).padStart(2, '0')}_`;
            const baseName = zipSafeName(result.filename || file.originalFilename || '');
            // The sandbox may have renamed the file; keep finalName unless the name differs.
            const wanted = baseName ? (/^p\d{2}_/.test(baseName) ? baseName : promptPrefix + baseName).normalize('NFC') : finalName;
            let savedName = finalName;
            if (wanted.toLowerCase() !== finalName.toLowerCase()) {
              usedUploadNames.delete(finalName.toLowerCase());
              savedName = freeUploadName(wanted);
            }
            folder.file(`uploads/${savedName}`, result.content);
            recordSaved(savedName);
            downloadedFiles.push({ name: savedName, fromJson: true });
            viewerUploads[file.uuid || file.originalFilename] = { path: `uploads/${savedName}`, text: await viewerUploadText(savedName, result.content) };
          } else {
            fallbackResult = 'Content not found in JSON';
            // Create enhanced error with all context
            const enhancedErr = new FileFetchError(
              `API failed (${apiErr.message}) and content not found in JSON`,
              {
                urlsTried: apiErr.urlsTried || [],
                httpStatus: apiErr.httpStatus || null,
                uuid: file.uuid,
                path: file.path
              }
            );
            enhancedErr.fallbackAttempted = true;
            enhancedErr.fallbackResult = fallbackResult;
            throw enhancedErr;
          }
        } else {
          throw apiErr;
        }
      }
    } catch (err) {
      console.error(`Failed to process ${file.filename}:`, err);

      // Add to error collector with full context
      errorCollector.addError('upload', file.filename, err.message, {
        uuid: file.uuid,
        path: file.path,
        urlsTried: err.urlsTried || [],
        httpStatus: err.httpStatus || null,
        fallbackAttempted: err.fallbackAttempted || false,
        fallbackResult: err.fallbackResult || null
      });

      // Also track in failedFiles for README.md backward compatibility
      failedFiles.push({
        filename: file.filename,
        error: err.message
      });
    }
  }

  // Self-contained HTML pass: rewrite sandbox-path references (e.g.
  // /mnt/user-data/uploads/foo.png) in text-based artifacts as base64 data
  // URIs, then re-write those entries into the zip. We deliberately keep the
  // artifacts map itself un-substituted so downstream consumers (code_snippets,
  // full_chat embedded markdown) aren't bloated with giant base64 strings —
  // only the on-disk artifact files become self-contained.
  const viewerArtifacts = {};  // Inlined text, so viewer previews match the files on disk
  // Encode only the uploads some inlineable artifact mentions, each once.
  const uploadDataUris = {};
  const encoded = new Map();  // source -> data URI, or null when encoding failed
  for (const [sandboxPath, source] of Object.entries(uploadSources)) {
    const used = Object.entries(artifacts).some(([filename, content]) => isInlineableArtifact(filename) && typeof content === 'string' && content.includes(sandboxPath));
    if (!used) continue;
    if (!encoded.has(source)) {
      try {
        const b64 = await blobToBase64(source.blob);
        const mime = (source.blob.type && source.blob.type !== 'application/octet-stream') ? source.blob.type : inferMimeFromFilename(source.filename);
        encoded.set(source, `data:${mime};base64,${b64}`);
      } catch (encErr) {
        console.warn(`Could not build data URI for ${source.filename}:`, encErr.message);
        encoded.set(source, null);
      }
    }
    if (encoded.get(source)) uploadDataUris[sandboxPath] = encoded.get(source);
  }
  if (Object.keys(uploadDataUris).length > 0) {
    for (const [filename, content] of Object.entries(artifacts)) {
      if (!isInlineableArtifact(filename)) continue;
      const { content: substituted, replacements } = inlineSandboxPaths(content, uploadDataUris);
      if (replacements > 0) {
        // folder.file() with the same path overwrites the existing entry.
        addFileWithBOM(folder, `artefacts/${filename}`, substituted);
        viewerArtifacts[filename] = substituted;
        console.log(`[Claude Takeout] Inlined ${replacements} upload reference(s) in artefacts/${filename}`);
      }
    }
  }

  // Generate all markdown files (with BOM for proper browser encoding)
  addFileWithBOM(folder, 'meta.md', generateMeta(data, messages, artifacts, codeBlocks, urls, textAttachments, projectFiles, downloadedFiles, webSources, failedFiles.length, projectUploads.length));
  addFileWithBOM(folder, 'prompts.md', generatePrompts(messages, responseFiles, attachmentIdMap, savedUploadNames, attachmentFiles));
  addFileWithBOM(folder, 'responses_text_only.md', generateResponsesTextOnly(messages, artifacts));

  if (codeBlocks.length > 0) {
    addFileWithBOM(folder, 'code_snippets.md', generateCodeSnippets(codeBlocks));
  }
  const linksAndSourcesContent = generateLinksAndSources(urls, webSources);
  if (linksAndSourcesContent) {
    addFileWithBOM(folder, 'links_and_sources.md', linksAndSourcesContent);
  }

  // The Markdown links to what this export really saved.
  const saved = { artifacts, attachmentFiles, uploadNames: savedUploadNames, presentedNames };
  addFileWithBOM(folder, 'full_chat.md', convertToMarkdown(data, { embedArtifacts: true, includeThinking: settings.includeThinking, ...saved }));
  const integratedChatMd = convertToMarkdown(data, { embedArtifacts: true, seamlessMd: true, includeThinking: settings.includeThinking, ...saved });
  addFileWithBOM(folder, 'integrated_chat.md', integratedChatMd);
  folder.file('integrated_chat.txt', markdownToPlainText(integratedChatMd));
  folder.file('original.json', JSON.stringify(data, null, 2));

  // Generate README.md
  const readmeLines = [
    `# ${title}`,
    '',
    `**Created:** ${formatTimestamp(data.created_at)}`,
    `**Exported:** ${formatTimestamp(new Date().toISOString())}`,
    `**Link:** [https://claude.ai/chat/${data.uuid}](https://claude.ai/chat/${data.uuid})`,
    '',
    '---',
    '',
    '## Overview',
    '',
    '- [meta.md](meta.md) *(statistics, metadata, word counts)*',
    '- [full_chat.md](full_chat.md) *(complete conversation with embedded artifacts)*',
    '- [integrated_chat.md](integrated_chat.md) *(markdown artifacts flow seamlessly)*',
    '- [integrated_chat.txt](integrated_chat.txt) *(plain text version, no markdown formatting)*',
    '- [original.json](original.json) *(original export)*',
    '',
    '---',
    '',
    `## Prompts (${messages.filter(m => m.sender === 'human').length})`,
    '',
    '- [prompts.md](prompts.md)',
    '',
    '---',
    '',
    `## Responses (${responseFiles.length})`,
    '',
    '- [responses_text_only.md](responses_text_only.md) *(pure text, no thinking/tools)*',
    ''
  ];

  if (codeBlocks.length > 0 || urls.length > 0 || webSources.length > 0) {
    readmeLines.push('---');
    readmeLines.push('');
    readmeLines.push('## Extras');
    readmeLines.push('');
    if (codeBlocks.length > 0) {
      readmeLines.push(`- [code_snippets.md](code_snippets.md) *(${codeBlocks.length} code blocks)*`);
    }
    if (urls.length > 0 || webSources.length > 0) {
      const parts = [];
      if (webSources.length > 0) parts.push(`${webSources.length} web sources`);
      if (urls.length > 0) parts.push(`${urls.length} links`);
      readmeLines.push(`- [links_and_sources.md](links_and_sources.md) *(${parts.join(', ')})*`);
    }
    readmeLines.push('');
  }

  for (const rf of responseFiles) {
    const truncated = rf.heading.length > 50 ? rf.heading.substring(0, 47) + '...' : rf.heading;
    const display = escapeMarkdown(truncated);
    readmeLines.push(`- ${display}: [text](responses/${rf.pure}) | [full](responses/${rf.full})`);
  }

  readmeLines.push('');
  readmeLines.push('---');
  readmeLines.push('');
  readmeLines.push(`## Artefacts (${Object.keys(artifacts).length})`);
  readmeLines.push('');
  for (const filename of Object.keys(artifacts).sort()) {
    readmeLines.push(`- [${filename}](artefacts/${encodeURIComponent(filename)})`);
  }

  // Add text attachments section
  if (Object.keys(textAttachments).length > 0) {
    readmeLines.push('');
    readmeLines.push('---');
    readmeLines.push('');
    readmeLines.push(`## Text Attachments (${Object.keys(textAttachments).length})`);
    readmeLines.push('');
    for (const filename of Object.keys(textAttachments).sort()) {
      readmeLines.push(`- [${filename}](attachments/${encodeURIComponent(filename)})`);
    }
  }

  // Add project files section
  const hasProjectContent = Object.keys(projectFiles).length > 0 || projectMetadataJson || projectDocsJson || projectUploads.length > 0;
  if (hasProjectContent) {
    readmeLines.push('');
    readmeLines.push('---');
    readmeLines.push('');
    readmeLines.push(`## Project`);
    readmeLines.push('');

    // Add metadata files first
    if (projectMetadataJson) {
      readmeLines.push(`- [project.json](project/project.json) - Project metadata`);
      if (projectMetadataJson.prompt_template) {
        readmeLines.push(`- [prompt_template.md](project/prompt_template.md) - System prompt template`);
      }
    }
    if (projectDocsJson) {
      readmeLines.push(`- [docs.json](project/docs.json) - Document list metadata`);
    }

    // Add project files
    if (projectUploads.length > 0) {
      readmeLines.push('');
      readmeLines.push(`### Files (${projectUploads.length})`);
      readmeLines.push('');
      for (const name of [...projectUploads].sort()) {
        readmeLines.push(`- [${name}](${projectFilesPath}/${encodeURIComponent(name)})`);
      }
    }

    if (Object.keys(projectFiles).length > 0) {
      readmeLines.push('');
      readmeLines.push(`### Documents (${Object.keys(projectFiles).length})`);
      readmeLines.push('');
      if (projectFilesFromApi) {
        readmeLines.push('*Full files downloaded from Claude Project*');
      } else {
        readmeLines.push("*Partial files extracted from conversation (truncated by Claude's view tool)*");
      }
      readmeLines.push('');
      for (const filename of Object.keys(projectFiles).sort()) {
        const actualFilename = projectFileMapping[filename] || filename;
        readmeLines.push(`- [${actualFilename}](project/${encodeURIComponent(actualFilename)})`);
      }
    }
  }

  // Add uploads section (PDFs, images, etc.)
  if (downloadedFiles.length > 0 || failedFiles.length > 0) {
    readmeLines.push('');
    readmeLines.push('---');
    readmeLines.push('');
    readmeLines.push(`## Uploaded Files (${downloadedFiles.length}${failedFiles.length > 0 ? `, ${failedFiles.length} failed` : ''})`);
    readmeLines.push('');
    // Sort by name and display with source indicator
    const sorted = [...downloadedFiles].sort((a, b) => a.name.localeCompare(b.name));
    for (const file of sorted) {
      const sourceNote = file.fromJson ? ' *(from JSON)*' : '';
      readmeLines.push(`- [${file.name}](uploads/${encodeURIComponent(file.name)})${sourceNote}`);
    }
    if (failedFiles.length > 0) {
      readmeLines.push('');
      readmeLines.push('**Failed to download:**');
      for (const { filename, error } of failedFiles) {
        readmeLines.push(`- ${filename}: ${error}`);
      }
    }
  }

  addFileWithBOM(folder, 'README.md', readmeLines.join('\n'));

  // The viewer's copy of this chat. It can only fail by itself: the chat is
  // already written, so a failure is reported and the export carries on.
  let viewerChat = null;
  try {
    viewerChat = CTViewer.buildViewerChat(data, {
      folder: folderName,
      model: CTViewer.modelLabel(data.model, getModelName(data)),
      fixText: fixMojibake,
      artifacts: { ...artifacts, ...viewerArtifacts },
      artifactIndex,
      uploads: viewerUploads,
      deliveries: buildViewerDeliveries(savedDeliveries),
      heredocs: heredocFiles,
      project: viewerProject(data, projectFiles, projectFileMapping, projectFilesPath, projectUploads, projectInstructions, CTViewer.TEXT_EMBED_LIMIT)
    });
  } catch (err) {
    console.error('Could not build the viewer chat:', err);
    errorCollector.addWarning('viewer', 'viewer.html', `This chat could not be added to viewer.html: ${err.message}`);
  }

  // Write comprehensive errors report if any failures occurred
  if (errorCollector.hasAny()) {
    const errorReport = errorCollector.generateErrorReport();
    if (errorReport) {
      folder.file('errors.txt', errorReport);
    }
  }

  return { messages, artifacts, textAttachments, uploadedFiles: downloadedFiles, failedFiles, errorCollector, codeBlocks, urls, responseFiles, viewerChat };
}

// Create full zip export with progress callback
async function createZipExport(data, onProgress = null) {
  const zip = new JSZip();
  const title = data.name || 'Claude Conversation';

  const report = (step, total, msg) => {
    if (onProgress) onProgress(step, total, msg);
  };

  report(5, 100, 'Analyzing conversation...');

  // Use shared helper to populate the zip
  const result = await populateConversationFolder(zip, data, onProgress, orgId);

  report(85, 100, 'Building viewer...');
  const viewerBuilt = await writeViewer(zip, result.viewerChat ? [result.viewerChat] : []);

  report(90, 100, 'Compressing archive...');

  // Generate and download zip
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  report(98, 100, 'Downloading...');

  // Prepend project name if conversation is part of a project
  const projectName = data.project?.name;
  const projectPrefix = projectName ? `[${sanitizeForFilename(projectName, 30)}-project]_` : '';
  const zipName = `${projectPrefix}${sanitizeForFilename(title, 60)}_claude-chat.zip`;

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);

  report(100, 100, 'Complete!');

  return {
    responseCount: result.responseFiles.length,
    artifactCount: Object.keys(result.artifacts).length,
    errorCount: result.errorCollector?.errors?.length || 0,
    warningCount: result.errorCollector?.warnings?.length || 0,
    hasErrors: result.errorCollector?.hasAny() || false,
    viewerBuilt
  };
}

// ============================================================================
// Original functions (updated to use new helpers)
// ============================================================================

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

// getModelName is in export-core.js

// Convert conversation to Markdown
// options.artifacts, attachmentFiles, uploadNames and presentedNames come from
// populateConversationFolder in a ZIP: what was really saved, so the Markdown links
// to those files. A single Markdown file has none of them and embeds pasted text.
function convertToMarkdown(data, options = {}) {
  const { embedArtifacts = false, seamlessMd = false, includeThinking = true,
    attachmentFiles = null, uploadNames = null, presentedNames = {} } = options;
  const lines = [];
  const title = data.name || 'Claude Conversation';

  // Extract artifacts for embedding or reference. In a ZIP these include the
  // presented and delivered files that were downloaded.
  const artifacts = options.artifacts || extractArtifacts(data);
  let promptNum = 0;
  const takenUploads = {};

  // Header
  lines.push(`# ${title}`);
  lines.push('');
  if (data.created_at) {
    lines.push(`**Created:** ${formatTimestamp(data.created_at)}  `);
  }
  if (data.updated_at) {
    lines.push(`**Updated:** ${formatTimestamp(data.updated_at)}  `);
  }
  lines.push(`**Exported:** ${formatTimestamp(new Date().toISOString())}  `);
  if (data.uuid) {
    lines.push(`**Link:** [https://claude.ai/chat/${data.uuid}](https://claude.ai/chat/${data.uuid})  `);
  }
  lines.push('');

  // Use message chain to handle branched conversations
  const messages = getMessageChain(data);

  for (const msg of messages) {
    const timestamp = formatTimestamp(msg.created_at);
    const sender = msg.sender;

    if (sender === 'human') {
      lines.push('## Prompt:');
      lines.push(timestamp);
      lines.push('');
      const text = extractTextContent(msg.content);
      lines.push(text);
      lines.push('');
      promptNum++;

      // Pasted text: linked to its saved file in a ZIP, written out otherwise.
      const pasted = (msg.attachments || []).filter((a) => a.extracted_content);
      const savedPastes = (attachmentFiles && attachmentFiles[msg.uuid]) || [];
      // Unnamed pastes are "Pasted text", numbered when a prompt has several, as in the viewer.
      const unnamed = pasted.filter((a) => !a.file_name).length;
      let pasteNum = 0;
      const pasteLabels = pasted.map((a) => a.file_name || (unnamed > 1 ? `Pasted text ${++pasteNum}` : 'Pasted text'));
      pasted.forEach((att, i) => {
        const saved = savedPastes.find((entry) => entry.att === att);
        if (saved) {
          lines.push(`**${pasteLabels[i]}:** [${saved.name}](attachments/${encodeURIComponent(saved.name)})`);
          lines.push('');
          return;
        }
        const body = fixMojibake(att.extracted_content);
        const fence = getCodeFence(body);
        lines.push(`**${pasteLabels[i]}:**`);
        lines.push('');
        lines.push(fence);
        lines.push(body);
        lines.push(fence);
        lines.push('');
      });

      // Uploaded files, by name, linked where a ZIP saved them.
      const uploads = [
        ...(msg.files_v2 || []).filter((f) => f.success && f.file_name).map((f) => ({ uuid: f.file_uuid, name: f.file_name })),
        ...(msg.files || []).filter((f) => f.success && (f.path || f.file_name)).map((f) => ({ uuid: f.file_uuid, name: f.path ? f.path.split('/').pop() : f.file_name })),
      ];
      if (uploads.length > 0) {
        lines.push('**Uploaded files:**');
        for (const upload of uploads) {
          const key = uploadNameKey(upload.uuid, promptNum, upload.name);
          const nth = takenUploads[key] || 0;
          takenUploads[key] = nth + 1;
          const saved = uploadNames && (uploadNames[key] || [])[nth];
          lines.push(saved ? `- [${upload.name}](uploads/${encodeURIComponent(saved)})` : `- ${upload.name}`);
        }
        lines.push('');
      }
      lines.push('');

    } else if (sender === 'assistant') {
      lines.push('## Response:');
      lines.push(timestamp);
      lines.push('');

      // Claude's summary of earlier context, when this turn compacted it.
      const compactionText = (msg.compaction_summary || [])
        .map((part) => part.text || '')
        .join('\n')
        .trim();
      if (compactionText) {
        const fence = getCodeFence(compactionText);
        lines.push('**Context compaction summary**');
        lines.push('');
        lines.push(`${fence}plaintext`);
        lines.push(compactionText);
        lines.push(fence);
        lines.push('');
      }

      const content = msg.content || [];

      // Collect all references from this response for footnotes
      const allReferences = [];
      const seenUrls = new Set();

      for (const block of content) {
        if (block.type === 'thinking') {
          // Thinking block with proper summary (if enabled)
          if (includeThinking) {
            const thinkingText = block.thinking || '';
            if (thinkingText) {
              const fence = getCodeFence(thinkingText);
              const summary = getThinkingSummary(block);
              lines.push(`${fence}plaintext`);
              lines.push(`Thought process: ${summary}`);
              lines.push('');
              lines.push(thinkingText);
              lines.push(fence);
              lines.push('');
            }
          }

        } else if (block.type === 'tool_use') {
          const toolName = block.name || '';
          const input = block.input || {};

          if (toolName === 'create_file' || toolName === 'Write') {
            // Artifact creation
            const path = input.path || input.file_path || '';
            const filename = path.split('/').pop();
            const desc = input.description || '';
            const fileText = input.file_text || input.content || '';

            if (embedArtifacts && fileText) {
              // Embed the actual artifact content
              const ext = filename.split('.').pop().toLowerCase();

              // Seamless embedding for markdown files
              if (seamlessMd && ext === 'md') {
                lines.push(`\n---\n\n**📄 ${filename}**\n`);
                lines.push(fileText);
                lines.push('\n---\n');
              } else {
                const langMap = {
                  md: 'markdown', html: 'html', css: 'css', js: 'javascript', jsx: 'jsx',
                  py: 'python', json: 'json', xml: 'xml', txt: '', svg: 'svg'
                };
                const lang = langMap[ext] || '';
                const fence = getCodeFence(fileText);
                lines.push(`\n**Artifact: ${filename}**\n`);
                lines.push(`${fence}${lang}`);
                lines.push(fileText);
                lines.push(fence);
              }
              lines.push('');
            } else {
              // Just show metadata
              lines.push('```plaintext');
              lines.push(`Creating artifact: ${filename}`);
              if (desc) lines.push(`Description: ${desc}`);
              lines.push('```');
              lines.push('');
            }

          } else if (toolName === 'present_files') {
            // Present files - embed or reference artifacts
            const filepaths = input.filepaths || [];
            for (const filepath of filepaths) {
              const filename = presentedNames[filepath] || zipSafeName(filepath.split('/').pop());
              if (Object.prototype.hasOwnProperty.call(artifacts, filename) && artifacts[filename] === '') {
                // A binary file the ZIP saved: link it.
                lines.push(`\n**Artifact: ${filename}** - [artefacts/${filename}](artefacts/${encodeURIComponent(filename)})\n`);
              } else if (artifacts[filename]) {
                if (embedArtifacts) {
                  // Embed the actual content
                  const content = artifacts[filename];
                  const ext = filename.split('.').pop().toLowerCase();

                  // Seamless embedding for markdown files
                  if (seamlessMd && ext === 'md') {
                    lines.push(`\n---\n\n**📄 ${filename}**\n`);
                    lines.push(content);
                    lines.push('\n---\n');
                  } else {
                    const langMap = { md: 'markdown', js: 'javascript', jsx: 'jsx', py: 'python', json: 'json', txt: '' };
                    const lang = langMap[ext] || '';
                    const fence = getCodeFence(content);
                    lines.push(`\n**Artifact: ${filename}**\n`);
                    lines.push(`${fence}${lang}`);
                    lines.push(content);
                    lines.push(fence);
                  }
                  lines.push('');
                } else {
                  // Reference format (compatible with replace_filepaths.py)
                  lines.push(`\n**Artifact: ${filename}**\n`);
                  lines.push('*Request*');
                  lines.push('');
                  lines.push('````javascript');
                  lines.push(JSON.stringify({ filepaths: [filepath] }, null, 2));
                  lines.push('````');
                  lines.push('');
                }
              } else {
                lines.push(`\n**Artifact: ${filename}** (not found)\n`);
              }
            }

          } else if (toolName === 'web_search') {
            // Web search
            const query = input.query || '';
            lines.push('```plaintext');
            lines.push(`Web Search: ${query}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'web_fetch') {
            // Web fetch
            const url = input.url || '';
            lines.push('```plaintext');
            lines.push(`Web Fetch: ${url}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'bash_tool' || toolName === 'bash') {
            // Bash command
            const cmd = input.command || '';
            const truncatedCmd = cmd.length > 100 ? cmd.substring(0, 100) + '...' : cmd;
            lines.push('```plaintext');
            lines.push(`Bash: ${truncatedCmd}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'str_replace' || toolName === 'str_replace_editor') {
            // String replace / file edit
            const path = input.path || input.file_path || '';
            const filename = path.split('/').pop();
            lines.push('```plaintext');
            lines.push(`Edit: ${filename}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'view' || toolName === 'read_file') {
            // View/read file
            const path = input.path || input.file_path || '';
            const filename = path.split('/').pop();
            lines.push('```plaintext');
            lines.push(`Reading: ${filename}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'write_file' || toolName === 'write') {
            // Write file
            const path = input.path || input.file_path || '';
            const filename = path.split('/').pop();
            lines.push('```plaintext');
            lines.push(`Writing: ${filename}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'list_directory' || toolName === 'ls') {
            // List directory
            const path = input.path || '.';
            lines.push('```plaintext');
            lines.push(`Listing: ${path}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'artifacts') {
            // Artifact creation/update via artifacts tool
            const title = input.title || input.id || 'Untitled';
            const command = input.command || 'create';
            const action = command === 'update' ? 'Updating' : command === 'rewrite' ? 'Rewriting' : 'Creating';

            if (command === 'create' || command === 'update' || command === 'rewrite') {
              if (embedArtifacts && input.content) {
                // Embed the artifact content
                const content = input.content;
                const type = input.type || 'text/plain';
                const ext = type.includes('markdown') ? 'md' : 'txt';

                if (seamlessMd && ext === 'md') {
                  lines.push(`\n---\n\n**📄 ${title}**\n`);
                  lines.push(content);
                  lines.push('\n---\n');
                } else {
                  const langMap = { 'text/markdown': 'markdown', 'application/javascript': 'javascript', 'text/x-python': 'python', 'application/json': 'json' };
                  const lang = langMap[type] || '';
                  const fence = getCodeFence(content);
                  lines.push(`\n**Artifact: ${title}**\n`);
                  lines.push(`${fence}${lang}`);
                  lines.push(content);
                  lines.push(fence);
                }
                lines.push('');
              } else {
                lines.push('```plaintext');
                lines.push(`${action} artifact: ${title}`);
                lines.push('```');
                lines.push('');
              }
            }

          } else {
            // Other tool use - show concisely
            const inputStr = JSON.stringify(input, null, 2);
            const fence = getCodeFence(inputStr);
            lines.push(`${fence}plaintext`);
            lines.push(`Tool: ${toolName}`);
            lines.push(inputStr);
            lines.push(fence);
            lines.push('');
          }

        } else if (block.type === 'tool_result') {
          const toolName = block.name || '';

          if (toolName === 'web_search' && Array.isArray(block.content)) {
            // Format web search results nicely
            for (const result of block.content) {
              if (result.type === 'knowledge') {
                const resultTitle = result.title || '';
                const url = result.url || '';
                const domain = result.metadata?.site_domain || '';
                lines.push(`> **${resultTitle}** [${domain}](${url})`);
                lines.push('>');
              }
            }
            lines.push('');
          } else if (block.content) {
            const toolContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content, null, 2);
            const fence = getCodeFence(toolContent);
            lines.push(`${fence}plaintext`);
            lines.push(toolContent);
            lines.push(fence);
            lines.push('');
          }

        } else if (block.type === 'text') {
          const rawText = block.text || '';
          const citations = block.citations || [];

          if (citations.length > 0) {
            // Process text with citations
            const { text: processedText, references } = processTextWithCitations(rawText, citations);
            lines.push(processedText);

            // Collect unique references
            for (const ref of references) {
              if (!seenUrls.has(ref.url)) {
                seenUrls.add(ref.url);
                allReferences.push(ref);
              }
            }
          } else {
            lines.push(rawText);
          }
          lines.push('');
        }
      }

      // Add references section at the end of the response
      if (allReferences.length > 0) {
        lines.push(formatReferences(allReferences));
      }

      // Check for attachments/files (legacy handling)
      lines.push('');
    }
  }

  return lines.join('\n');
}

// Extract text content from message
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

// getSummary removed - replaced by getThinkingSummary() above

// Download file
function download(content, filename, type) {
  const blob = new Blob([content], { type: type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Safe filename
// Letters and digits from any script are kept, so a Cyrillic or Japanese title stays
// readable; everything else becomes _. ASCII titles come out as they always did.
function safeFilename(name) {
  return Array.from((name || 'conversation').replace(/[^\p{L}\p{N}\p{M}]/gu, '_')).slice(0, 50).join('');
}

// Update UI based on data availability
// preserveStatus leaves the status pill alone, so a refresh that was deferred
// until an export finished doesn't overwrite that export's result message.
function updateUI(data, org, { preserveStatus = false } = {}) {
  const status = document.getElementById('status');
  const info = document.getElementById('info');
  const exportMd = document.getElementById('exportMd');
  const exportMdEmbed = document.getElementById('exportMdEmbed');
  const exportZip = document.getElementById('exportZip');
  const exportJson = document.getElementById('exportJson');

  if (org) {
    orgId = org;
  }

  if (data && data.chat_messages) {
    conversationData = data;
    const messages = getMessageChain(data);
    const msgCount = messages.length;
    const artifacts = extractArtifacts(data);
    const artifactCount = Object.keys(artifacts).length;
    const title = data.name || 'Untitled';

    if (!preserveStatus) {
      status.className = 'status ready';
      status.textContent = 'Ready to export!';
    }
    const artifactInfo = artifactCount > 0 ? `, ${artifactCount} artifacts` : '';
    info.textContent = `Current: "${title}" (${msgCount} messages${artifactInfo})`;

    exportMd.disabled = false;
    exportMdEmbed.disabled = false;
    exportZip.disabled = false;
    exportJson.disabled = false;
  } else {
    // Drop the old conversation so nothing can export it by mistake.
    conversationData = null;
    if (!preserveStatus) {
      status.className = 'status waiting';
      status.textContent = org ? 'Open a chat to export it.' : 'Sign in to claude.ai and open a chat.';
    }
    info.textContent = org ? `Org ID: ${org.substring(0, 8)}...` : '';
    exportMd.disabled = true;
    exportMdEmbed.disabled = true;
    exportZip.disabled = true;
    exportJson.disabled = true;
  }
}

// Show progress
function showProgress(current, total, text) {
  const progress = document.getElementById('progress');
  const fill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  progress.style.display = 'block';
  fill.style.width = `${(current / total) * 100}%`;
  progressText.textContent = text || `${current} / ${total}`;
}

function hideProgress() {
  document.getElementById('progress').style.display = 'none';
  if (refreshDeferred) {
    refreshDeferred = false;
    requestData({ preserveStatus: true });
  }
}

// ============================================================================
// Keeping the UI on the selected conversation
// ============================================================================

const REFRESH_DEBOUNCE_MS = 150;
let refreshTimer = null;
let refreshDeferred = false;
let latestRefreshId = 0;

// Returns the conversation UUID from a claude.ai/chat/<uuid> URL, or null.
function getChatIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/chat\/([0-9a-f-]{36})(?:\/|$)/i);
    return match ? match[1].toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

// chrome.tabs.sendMessage as a promise. Resolves with { connectionError } when
// nothing in the tab is listening.
function sendOnce(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ connectionError: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || {});
    });
  });
}

// Message a tab, injecting content.js if it isn't there. A tab that was open
// when the extension was installed or reloaded has no working content script.
async function sendToTab(tabId, message) {
  const response = await sendOnce(tabId, message);
  if (!response.connectionError) return response;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    return { connectionError: e.message };
  }
  return sendOnce(tabId, message);
}

// Load the conversation for the active tab. The tab URL decides which chat is
// selected, and the REST API supplies its data. claude.ai loads chats over its
// StreamTimeline RPC, which the extension can't read.
async function requestData({ preserveStatus = false } = {}) {
  const refreshId = ++latestRefreshId;
  const isStale = () => refreshId !== latestRefreshId;
  const status = document.getElementById('status');
  const uiOptions = { preserveStatus };
  const setStatus = (className, text) => {
    if (preserveStatus) return;
    status.className = className;
    status.textContent = text;
  };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isStale()) return;

    // tab.url is undefined for sites outside the extension's host permissions.
    const url = tab?.url || '';
    if (!url.includes('claude.ai')) {
      updateUI(null, null, uiOptions);
      setStatus('status error', 'Please navigate to claude.ai');
      return;
    }

    const response = await sendToTab(tab.id, { action: 'getOrgId' });
    if (isStale()) return;

    if (response.connectionError) {
      console.log('Error:', response.connectionError);
      updateUI(null, null, uiOptions);
      setStatus('status error', `Can't reach this tab: ${response.connectionError}`);
      return;
    }

    const org = response.orgId;
    const chatId = getChatIdFromUrl(url);

    if (!chatId) {
      updateUI(null, org, uiOptions);
      return;
    }

    // Export stays disabled until a different chat has loaded.
    if (conversationData?.uuid !== chatId) {
      updateUI(null, org, uiOptions);
      setStatus('status waiting', 'Loading selected conversation...');
    }

    const result = await sendToTab(tab.id, { action: 'fetchConversation', conversationId: chatId, orgId: org });
    if (isStale()) return;

    if (result.data?.chat_messages) {
      updateUI(result.data, org, uiOptions);
    } else {
      setStatus('status error', `Could not load this conversation: ${result.error || result.connectionError || 'no data returned'}`);
    }
  } catch (e) {
    console.error(e);
    if (!isStale()) {
      updateUI(null, null, uiOptions);
      setStatus('status error', `Could not load this conversation: ${e.message}`);
    }
  }
}

// Fetch the selected chat for an export, so it includes messages added since
// the panel last loaded it. Throws rather than exporting an older copy.
async function loadConversationForExport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const chatId = getChatIdFromUrl(tab?.url || '');
  if (!chatId) throw new Error('No conversation selected.');

  const result = await sendToTab(tab.id, { action: 'fetchConversation', conversationId: chatId, orgId });
  if (!result.data?.chat_messages) {
    throw new Error(`Could not load the latest copy: ${result.error || result.connectionError || 'no data returned'}`);
  }

  latestRefreshId++;
  updateUI(result.data, orgId, { preserveStatus: true });
  return result.data;
}

// Coalesce bursts of tab events. An export shows the progress bar
// while it runs, so wait for it to finish rather than change chats underneath it.
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (document.getElementById('progress').style.display === 'block') {
      refreshDeferred = true;
      return;
    }
    requestData();
  }, REFRESH_DEBOUNCE_MS);
}

// The side panel stays open across chat and tab changes, so it has to follow them.
chrome.tabs.onActivated.addListener(() => scheduleRefresh());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
    scheduleRefresh();
  }
});

// Bulk export
async function bulkExport(format) {
  const status = document.getElementById('status');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes('claude.ai')) {
    status.className = 'status error';
    status.textContent = 'Please navigate to claude.ai first';
    return;
  }

  status.className = 'status waiting';
  status.textContent = 'Fetching conversation list...';

  // Get all conversations
  chrome.tabs.sendMessage(tab.id, { action: 'fetchAllConversations' }, async (response) => {
    if (chrome.runtime.lastError || response?.error) {
      status.className = 'status error';
      status.textContent = response?.error || chrome.runtime.lastError.message;
      return;
    }

    const conversations = response.data;
    const total = conversations.length;

    status.textContent = `Found ${total} conversations. Exporting...`;
    showProgress(0, total, `0 / ${total}`);

    let exported = 0;
    let errors = [];

    for (const conv of conversations) {
      try {
        // Fetch full conversation
        const result = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'fetchConversation',
            conversationId: conv.uuid
          }, resolve);
        });

        if (result.error) {
          throw new Error(result.error);
        }

        const data = result.data;
        await ensureProjectName(data, orgId);
        let content, filename;
        const projectPrefix = data.project?.name ? `[${safeFilename(data.project.name)}-project]_` : '';

        if (format === 'json') {
          content = JSON.stringify(data, null, 2);
          filename = `${projectPrefix}${safeFilename(data.name)}.json`;
        } else if (format === 'embedded') {
          content = convertToMarkdown(data, { embedArtifacts: true, includeThinking: settings.includeThinking });
          filename = `${projectPrefix}${safeFilename(data.name)}_embedded.md`;
        } else {
          content = convertToMarkdown(data, { includeThinking: settings.includeThinking });
          filename = `${projectPrefix}${safeFilename(data.name)}.md`;
        }

        download(content, filename, format === 'json' ? 'application/json' : 'text/markdown');
        exported++;

      } catch (e) {
        errors.push(`${conv.name || conv.uuid}: ${e.message}`);
      }

      showProgress(exported + errors.length, total, `${exported} / ${total}`);

      // Small delay to avoid overwhelming
      await new Promise(r => setTimeout(r, 300));
    }

    hideProgress();

    if (errors.length > 0) {
      status.className = 'status error';
      status.textContent = `Exported ${exported}/${total}. ${errors.length} failed.`;
      console.error('Export errors:', errors);
    } else {
      status.className = 'status ready';
      status.textContent = `Exported ${exported} conversations!`;
    }
  });
}

// Bulk export all conversations as a single mega-zip
async function bulkExportZip() {
  const status = document.getElementById('status');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes('claude.ai')) {
    status.className = 'status error';
    status.textContent = 'Please navigate to claude.ai first';
    return;
  }

  status.className = 'status waiting';
  status.textContent = 'Fetching conversation list...';

  // Get all conversations
  chrome.tabs.sendMessage(tab.id, { action: 'fetchAllConversations' }, async (response) => {
    if (chrome.runtime.lastError || response?.error) {
      status.className = 'status error';
      status.textContent = response?.error || chrome.runtime.lastError.message;
      return;
    }

    const conversations = response.data;
    const total = conversations.length;

    status.textContent = `Found ${total} conversations. Creating mega-zip...`;
    showProgress(0, total, `0 / ${total}`);

    const megaZip = new JSZip();
    const indexEntries = [];
    let exported = 0;
    let errors = [];  // Conversation-level errors (failed to fetch/process entire conversation)
    let totalFileErrors = 0;  // File-level errors across all conversations
    let totalFileWarnings = 0;  // File-level warnings across all conversations
    // `projects` holds the shared project files, so no chat may take that name.
    const usedFolderNames = new Set(['projects']);
    const sharedProjects = { root: megaZip, byUuid: new Map(), usedDirs: new Set() };
    const viewerChats = [];

    for (const conv of conversations) {
      try {
        // Fetch full conversation
        const result = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'fetchConversation',
            conversationId: conv.uuid
          }, resolve);
        });

        if (result.error) {
          throw new Error(result.error);
        }

        const data = result.data;
        await ensureProjectName(data, orgId);
        const projectPrefix = data.project?.name ? `[${safeFilename(data.project.name)}-project]_` : '';
        const baseFolderName = `${projectPrefix}${safeFilename(data.name || conv.uuid)}`;
        // Titles can match, or match once cut to length. Compare without case,
        // because macOS and Windows would merge folders that differ only by case.
        let folderName = baseFolderName;
        for (let n = 2; usedFolderNames.has(folderName.toLowerCase()); n++) {
          folderName = `${baseFolderName}_${n}`;
        }
        usedFolderNames.add(folderName.toLowerCase());
        const folder = megaZip.folder(folderName);

        // Use shared helper to populate the folder (same structure as individual zip)
        const folderResult = await populateConversationFolder(folder, data, null, orgId, sharedProjects, folderName);
        if (folderResult.viewerChat) viewerChats.push(folderResult.viewerChat);

        // Track file-level errors/warnings
        if (folderResult.errorCollector) {
          totalFileErrors += folderResult.errorCollector.errors?.length || 0;
          totalFileWarnings += folderResult.errorCollector.warnings?.length || 0;
        }

        // Add to index
        indexEntries.push({
          name: data.name || 'Untitled',
          folder: folderName,
          messages: folderResult.messages.length,
          created: data.created_at ? formatTimestamp(data.created_at) : '',
          uuid: data.uuid,
          fileErrors: folderResult.errorCollector?.errors?.length || 0,
          fileWarnings: folderResult.errorCollector?.warnings?.length || 0
        });

        exported++;

      } catch (e) {
        errors.push(`${conv.name || conv.uuid}: ${e.message}`);
      }

      showProgress(exported + errors.length, total, `${exported} / ${total}`);

      // Small delay to avoid overwhelming
      await new Promise(r => setTimeout(r, 200));
    }

    // Create index.md at root
    const indexLines = [
      '# Claude Takeout - All Conversations',
      '',
      `**Exported:** ${formatTimestamp(new Date().toISOString())}`,
      `**Total Conversations:** ${exported}`,
    ];

    // Add summary of file-level issues
    if (totalFileErrors > 0 || totalFileWarnings > 0) {
      const issueParts = [];
      if (totalFileErrors > 0) issueParts.push(`${totalFileErrors} file error${totalFileErrors > 1 ? 's' : ''}`);
      if (totalFileWarnings > 0) issueParts.push(`${totalFileWarnings} warning${totalFileWarnings > 1 ? 's' : ''}`);
      indexLines.push(`**Issues:** ${issueParts.join(', ')} (see errors.txt in affected folders)`);
    }

    indexLines.push(
      '',
      '## Conversations',
      '',
      '| # | Conversation | Messages | Created | Issues |',
      '|---|--------------|----------|---------|--------|'
    );

    indexEntries.forEach((entry, i) => {
      const issueCount = (entry.fileErrors || 0) + (entry.fileWarnings || 0);
      const issueStr = issueCount > 0 ? `${issueCount}` : '-';
      indexLines.push(`| ${i + 1} | [${entry.name}](${entry.folder}/README.md) | ${entry.messages} | ${entry.created} | ${issueStr} |`);
    });

    if (errors.length > 0) {
      indexLines.push('', '## Failed Conversations', '');
      errors.forEach(err => indexLines.push(`- ${err}`));
    }

    addFileWithBOM(megaZip, 'index.md', indexLines.join('\n'));

    status.textContent = 'Building viewer...';
    const viewerBuilt = exported === 0 || await writeViewer(megaZip, viewerChats);
    viewerChats.length = 0;  // viewer.html holds them now, and compressing needs the memory
    const viewerNote = viewerBuilt ? '' : ' viewer.html could not be built.';

    // Generate and download
    status.textContent = 'Compressing archive...';
    showProgress(95, 100, 'Compressing...');

    try {
      const zipBlob = await megaZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      const dateStr = new Date().toISOString().slice(0, 10);
      download(zipBlob, `claude-takeout-${dateStr}.zip`, 'application/zip');

      hideProgress();

      // Determine status based on errors
      const hasConvErrors = errors.length > 0;
      const hasFileIssues = totalFileErrors > 0 || totalFileWarnings > 0;

      if (hasConvErrors) {
        // Conversation-level failures (couldn't fetch/process entire conversations)
        status.className = 'status error';
        let msg = `Exported ${exported}/${total} to mega-zip. ${errors.length} conversation${errors.length > 1 ? 's' : ''} failed.`;
        if (hasFileIssues) {
          msg += ` Also ${totalFileErrors} file error${totalFileErrors !== 1 ? 's' : ''}.`;
        }
        status.textContent = msg + viewerNote;
        console.error('Export errors:', errors);
      } else if (hasFileIssues) {
        // File-level issues but all conversations exported
        const issueParts = [];
        if (totalFileErrors > 0) issueParts.push(`${totalFileErrors} file error${totalFileErrors > 1 ? 's' : ''}`);
        if (totalFileWarnings > 0) issueParts.push(`${totalFileWarnings} warning${totalFileWarnings > 1 ? 's' : ''}`);
        status.className = 'status warning';
        status.textContent = `Exported ${exported} conversations - ${issueParts.join(', ')}. See errors.txt${viewerBuilt ? '' : `.${viewerNote}`}`;
      } else if (!viewerBuilt) {
        status.className = 'status warning';
        status.textContent = `Exported ${exported} conversations to mega-zip.${viewerNote}`;
      } else {
        status.className = 'status ready';
        status.textContent = `Exported ${exported} conversations to mega-zip!`;
      }
    } catch (e) {
      hideProgress();
      status.className = 'status error';
      status.textContent = `Zip generation failed: ${e.message}`;
    }
  });
}

// Event listeners with settings-aware filenames
document.getElementById('exportMd').addEventListener('click', async () => {
  if (!conversationData) return;
  const status = document.getElementById('status');
  try {
    const data = await loadConversationForExport();
    await ensureProjectName(data, orgId);
    const md = convertToMarkdown(data, { includeThinking: settings.includeThinking });
    const filename = generateFilename(data.name, 'md', data.project?.name);
    download(md, filename, 'text/markdown');
    status.className = 'status ready';
    status.textContent = 'Markdown exported successfully!';
  } catch (e) {
    console.error('Markdown export error:', e);
    status.className = 'status error';
    status.textContent = 'Export failed: ' + e.message;
  }
});

document.getElementById('exportMdEmbed').addEventListener('click', async () => {
  if (!conversationData) return;
  const status = document.getElementById('status');
  try {
    const data = await loadConversationForExport();
    await ensureProjectName(data, orgId);
    const md = convertToMarkdown(data, {
      embedArtifacts: true,
      includeThinking: settings.includeThinking
    });
    const baseName = safeFilename(data.name);
    const filename = generateFilename(baseName + '_embedded', 'md', data.project?.name);
    download(md, filename, 'text/markdown');
    status.className = 'status ready';
    status.textContent = 'Embedded markdown exported successfully!';
  } catch (e) {
    console.error('Embedded export error:', e);
    status.className = 'status error';
    status.textContent = 'Export failed: ' + e.message;
  }
});

document.getElementById('exportZip').addEventListener('click', async () => {
  if (!conversationData) return;
  const status = document.getElementById('status');

  // Show progress
  showProgress(0, 100, 'Initializing...');

  try {
    status.className = 'status waiting';
    status.textContent = 'Creating zip archive...';

    const data = await loadConversationForExport();
    await ensureProjectName(data, orgId);
    const result = await createZipExport(data, (step, total, message) => {
      showProgress(step, total, message);
    });

    hideProgress();

    // Show success with error/warning indicator if applicable
    const viewerNote = result.viewerBuilt ? '' : ' viewer.html could not be built.';
    if (result.hasErrors) {
      const errorParts = [];
      if (result.errorCount > 0) errorParts.push(`${result.errorCount} error${result.errorCount > 1 ? 's' : ''}`);
      if (result.warningCount > 0) errorParts.push(`${result.warningCount} warning${result.warningCount > 1 ? 's' : ''}`);
      status.className = 'status warning';
      status.textContent = `Exported zip (${result.responseCount} responses) - ${errorParts.join(', ')}. See errors.txt${result.viewerBuilt ? '' : `.${viewerNote}`}`;
    } else if (!result.viewerBuilt) {
      status.className = 'status warning';
      status.textContent = `Exported zip (${result.responseCount} responses).${viewerNote}`;
    } else {
      status.className = 'status ready';
      status.textContent = `Exported zip (${result.responseCount} responses, ${result.artifactCount} artifacts)`;
    }
  } catch (e) {
    hideProgress();
    console.error('Zip export error:', e);
    status.className = 'status error';
    status.textContent = 'Zip export failed: ' + e.message;
  }
});

document.getElementById('exportJson').addEventListener('click', async () => {
  if (!conversationData) return;
  const status = document.getElementById('status');
  try {
    const data = await loadConversationForExport();
    await ensureProjectName(data, orgId);
    const json = JSON.stringify(data, null, 2);
    const filename = generateFilename(data.name, 'json', data.project?.name);
    download(json, filename, 'application/json');
    status.className = 'status ready';
    status.textContent = 'JSON exported successfully!';
  } catch (e) {
    console.error('JSON export error:', e);
    status.className = 'status error';
    status.textContent = 'Export failed: ' + e.message;
  }
});

document.getElementById('exportAllMd').addEventListener('click', () => {
  bulkExport('markdown');
});

document.getElementById('exportAllEmbed').addEventListener('click', () => {
  bulkExport('embedded');
});

document.getElementById('exportAllZip').addEventListener('click', () => {
  bulkExportZip();
});

document.getElementById('exportAllJson').addEventListener('click', () => {
  bulkExport('json');
});

document.getElementById('refresh').addEventListener('click', () => scheduleRefresh());

// ============================================================================
// Settings Panel
// ============================================================================

const defaultSettings = {
  filenameStyle: 'title',
  includeThinking: true,
  showShortcuts: true,
  useSidePanel: false
};

let settings = { ...defaultSettings };

// Load settings from storage
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(['exporterSettings', 'useSidePanel']);
    if (stored.exporterSettings) {
      settings = { ...defaultSettings, ...stored.exporterSettings };
    }
    // Top-level useSidePanel takes precedence (set by background.js listener)
    if (typeof stored.useSidePanel === 'boolean') {
      settings.useSidePanel = stored.useSidePanel;
    }
    applySettings();
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

// Save settings to storage
async function saveSettings() {
  try {
    // Save all settings together, plus useSidePanel at top level for background.js
    await chrome.storage.local.set({
      exporterSettings: settings,
      useSidePanel: settings.useSidePanel  // Also save at top level for background.js
    });
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// Apply settings to UI
function applySettings() {
  document.getElementById('filenameStyle').value = settings.filenameStyle;
  document.getElementById('includeThinking').checked = settings.includeThinking;
  document.getElementById('showShortcuts').checked = settings.showShortcuts;

  // Side panel checkbox (may not exist in all views)
  const sidePanelCheckbox = document.getElementById('useSidePanel');
  if (sidePanelCheckbox) {
    sidePanelCheckbox.checked = settings.useSidePanel;
  }

  // Show/hide shortcut labels
  const shortcuts = document.querySelectorAll('.shortcut');
  shortcuts.forEach(el => {
    el.style.display = settings.showShortcuts ? 'inline' : 'none';
  });
}

// Settings toggle
document.getElementById('settingsToggle').addEventListener('click', () => {
  document.getElementById('settingsPanel').classList.toggle('visible');
});

document.getElementById('settingsClose').addEventListener('click', () => {
  document.getElementById('settingsPanel').classList.remove('visible');
});

// Settings change handlers
document.getElementById('filenameStyle').addEventListener('change', (e) => {
  settings.filenameStyle = e.target.value;
  saveSettings();
});

document.getElementById('includeThinking').addEventListener('change', (e) => {
  settings.includeThinking = e.target.checked;
  saveSettings();
});

document.getElementById('showShortcuts').addEventListener('change', (e) => {
  settings.showShortcuts = e.target.checked;
  saveSettings();
  applySettings();
});

// Side panel toggle (may not exist in all views)
const sidePanelCheckbox = document.getElementById('useSidePanel');
if (sidePanelCheckbox) {
  sidePanelCheckbox.addEventListener('change', (e) => {
    settings.useSidePanel = e.target.checked;
    saveSettings();

    // Update background script behavior
    if (e.target.checked) {
      chrome.runtime.sendMessage({ action: 'enableSidePanelMode' });
    } else {
      chrome.runtime.sendMessage({ action: 'disableSidePanelMode' });
    }
  });
}

// Help link
document.getElementById('helpLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('README.md') });
});

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;

  const key = e.key.toLowerCase();
  let handled = true;

  switch (key) {
    case 'm':
      document.getElementById('exportMd').click();
      break;
    case 'e':
      document.getElementById('exportMdEmbed').click();
      break;
    case 'z':
      document.getElementById('exportZip').click();
      break;
    case 'j':
      document.getElementById('exportJson').click();
      break;
    case 'a':
      document.getElementById('exportAllMd').click();
      break;
    case 'r':
      document.getElementById('refresh').click();
      break;
    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
  }
});

// ============================================================================
// Enhanced Error Handling
// ============================================================================

// Wrap export functions with error handling
function withErrorHandling(fn, actionName) {
  return async function(...args) {
    const status = document.getElementById('status');
    try {
      return await fn.apply(this, args);
    } catch (error) {
      console.error(`${actionName} failed:`, error);
      status.className = 'status error';

      // Provide helpful error messages
      let message = error.message || 'Unknown error';
      if (message.includes('network') || message.includes('fetch')) {
        message = 'Network error. Check your connection and try again.';
      } else if (message.includes('permission')) {
        message = 'Permission denied. Try refreshing the page.';
      } else if (message.includes('quota')) {
        message = 'Storage quota exceeded. Clear some browser data.';
      }

      status.textContent = `${actionName} failed: ${message}`;

      // Auto-clear error after 5 seconds
      setTimeout(() => {
        if (status.classList.contains('error')) {
          updateUI(conversationData, orgId);
        }
      }, 5000);

      throw error;
    }
  };
}

// ============================================================================
// Filename Generation with Settings
// ============================================================================

function generateFilename(name, ext, projectName = null) {
  const title = safeFilename(name);
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const projectPrefix = projectName ? `[${safeFilename(projectName)}-project]_` : '';

  switch (settings.filenameStyle) {
    case 'title_date':
      return `${projectPrefix}${title}_${date}.${ext}`;
    case 'date_title':
      return `${projectPrefix}${date}_${title}.${ext}`;
    default:
      return `${projectPrefix}${title}.${ext}`;
  }
}

// ============================================================================
// Initialize
// ============================================================================

loadSettings();
requestData();
