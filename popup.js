// Popup script - handles export UI

let conversationData = null;
let orgId = null;
// The screen shown (showScreen) and whether requestData skipped a repaint because another screen was up.
let currentScreen = 'main';
let refreshSkipped = false;
// The Everything section's state: this org's export record, the counts (Count button; kept for the panel's
// life), whether Count is running or failed (its code), a short-lived summary message, and whether the tab is
// on claude.ai.
const panel = { record: null, counts: null, countsOrg: null, counting: false, countError: '', flash: '', flashTimer: null, staleTimer: null, onClaude: false };

// ============================================================================
// Error Collector: Structured error tracking for comprehensive error reporting
// ============================================================================

class ExportErrorCollector {
  // label: an export that is not one conversation (Export Artifacts); the report's header names it instead.
  constructor(conversationName, conversationUuid, { label = null } = {}) {
    this.conversationName = conversationName || 'Untitled';
    this.conversationUuid = conversationUuid || 'unknown';
    this.label = label;
    this.errors = [];
    this.warnings = [];
    this.notes = [];
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

  // A note says something about the export that is not missing content: the report lists it apart from warnings.
  addNote(type, filename, message, details = {}) {
    this.notes.push({
      type,
      severity: 'note',
      filename,
      error: message,
      details: {
        uuid: details.uuid || null,
        path: details.path || null,
        note: details.note || null
      },
      recovery: this._getNoteHint(type)
    });
  }

  _getNoteHint(type) {
    switch (type) {
      case 'draft_superseded':
        return 'The finished files from this folder are in the export; this draft is kept for reference. replay_bash.py can try to rebuild it.';
      case 'helper_script':
        return "Claude's helper script, not a delivered file.";
      case 'name_changed':
        return 'Both files are kept; only the name changed.';
      default:
        return 'No action needed.';
    }
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

      case 'export_health':
        return "claude.ai's data for this chat looks incomplete, which usually means its API changed. The export holds everything that came back, and original.json has the raw data. Check the chat on claude.ai, and report it if the problem repeats so the exporter can be updated.";

      case 'claude_doc_unreplayed':
        return 'Claude edited this Claude Docs document in a way the export can\'t rebuild from the chat. The exported .md and .html hold what could be rebuilt; open the live document on claude.ai (link in the note) for the current version.';

      case 'tool_image':
        return 'A picture Claude looked at in the chat (a photo it opened, a page it rendered) could not be downloaded from claude.ai. Export again later; it is still shown in the chat on claude.ai.';

      case 'web_image':
        if (String(details.note || '').startsWith('No permission')) {
          return 'Claude Takeout may not fetch images from other sites. The link in full_chat.md still points to each image. To save these images, turn on Settings > Save web images and artifact card pictures (Chrome asks once), then export again.';
        }
        return 'An image Claude found with image search could not be saved: the site refused it (403) or it is gone (404); nothing in Claude Takeout can fetch it. The link in full_chat.md still points to it.';

      case 'published_page':
        return 'A page Claude published on claude.ai (publish_files) could not be saved, or only in part, or its file names were changed to be safe on disk. The chat itself is exported. Open the page on claude.ai (link in the note) while signed in, and export again; a page that was unpublished or deleted can no longer be saved.';

      case 'artifact_export':
        return 'Export Artifacts saves the current version of each artifact claude.ai lists. This one was not saved, or only in part, or its file names were changed to stay inside its folder; the other artifacts are in the export. Open it on claude.ai (link in the note) while signed in, and run Export Artifacts again. An artifact that was unpublished, deleted or unshared can no longer be saved. When claude.ai\'s full list could not be read in full (a code, or longer than the export reads), compare index.md with claude.ai/artifacts. Artifacts found only by paging are saved without a card picture.';

      case 'doc_diagram':
        return 'claude.ai draws a Claude Docs document\'s diagrams only on the document\'s own page, so the export shows each by its caption. To keep them, ask Claude in the chat to export the document as a self-contained HTML file, then export the chat again: that copy is saved in artefacts/ and linked from the document. Or open the live document (link in the note).';

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

  hasNotes() {
    return this.notes.length > 0;
  }

  hasAny() {
    return this.hasErrors() || this.hasWarnings() || this.hasNotes();
  }

  generateErrorReport() {
    if (!this.hasAny()) return null;

    const lines = [
      '# Export Errors Report',
      '',
      `**Export Date:** ${new Date().toISOString()}`,
      ...(this.label ? [`**Export:** ${this.label}`] : [`**Conversation:** ${this.conversationName}`, `**UUID:** ${this.conversationUuid}`]),
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

    if (this.notes.length > 0) {
      const notesByType = {};
      for (const note of this.notes) notesByType[note.type] = (notesByType[note.type] || 0) + 1;
      lines.push(`**Notes:** ${this.notes.length} total`);
      for (const [type, count] of Object.entries(notesByType)) {
        lines.push(`- ${count} ${type.replace(/_/g, ' ')} note${count > 1 ? 's' : ''}`);
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

    // Detailed notes
    if (this.notes.length > 0) {
      lines.push('---', '', '## Notes', '');

      for (const note of this.notes) {
        lines.push(`### ${note.filename}`);
        lines.push('');
        lines.push(`- **Type:** ${note.type.replace(/_/g, ' ')}`);
        lines.push(`- **Message:** ${note.error}`);

        if (note.details.path) {
          lines.push(`- **Path:** ${note.details.path}`);
        }
        if (note.details.note) {
          lines.push(`- **Note:** ${note.details.note}`);
        }

        lines.push('');
        lines.push(`**Recovery:** ${note.recovery}`);
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
    // An export that is not one chat (Export Artifacts) has none of the chat files the steps below name.
    if (this.label) {
      lines.push('Sign in to claude.ai, open the artifact there, and run Export Artifacts again.');
      return lines.join('\n');
    }
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

// The chat README's "About some files" section: the notes by kind, so a reader knows why a file is there.
const README_NOTE_KINDS = [
  ['draft_superseded', 'Drafts'],
  ['helper_script', 'Helper scripts'],
  ['name_changed', 'Renamed files']
];
function readmeNoteLines(notes) {
  const groups = README_NOTE_KINDS
    .map(([type, heading]) => [heading, (notes || []).filter((n) => n.type === type)])
    .filter(([, list]) => list.length > 0);
  if (groups.length === 0) return [];
  const lines = ['## About some files', ''];
  for (const [heading, list] of groups) {
    lines.push(`### ${heading}`, '');
    for (const n of list) lines.push(`- \`${n.filename}\`: ${n.error}`);
    lines.push('');
  }
  lines.pop();
  return lines;
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

// A Claude Docs document as one self-contained page to read, print or share. Raw HTML in the Markdown is
// shown as text, and only web and mail links, https images and the diagram screenshots saved in the
// chat's images/ folder (../images/<name>) are kept; the page's CSP allows no script at all, so nothing
// in it can run.
// marked hands some attribute values over already escaped (titles, alt text, autolinks) and others not,
// so each is unescaped first and then escaped exactly once.
const docAttr = (s) => escapeHtmlText(String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]));
let docMarked = null;
function claudeDocHtml(title, markdown) {
  if (!docMarked) {
    docMarked = new marked.Marked({
      gfm: true,
      tokenizer: {
        // An inline <code> or <pre> would make marked copy the text after it unescaped; this page shows
        // raw HTML as text, so that state is never entered.
        tag(src) {
          const token = marked.Tokenizer.prototype.tag.call(this, src);
          if (token) { this.lexer.state.inRawBlock = false; this.lexer.state.inLink = false; token.inRawBlock = false; token.inLink = false; }
          return token;
        },
      },
      renderer: {
        html(raw, block) { return block ? `<p>${escapeHtmlText(raw.trimEnd())}</p>` : escapeHtmlText(raw); },
        link(href, linkTitle, text) {
          if (!/^(https?:|mailto:|#)/i.test(String(href || '').trim())) return text;
          return `<a href="${docAttr(href)}"${linkTitle ? ` title="${docAttr(linkTitle)}"` : ''} rel="noopener noreferrer">${text}</a>`;
        },
        image(href, imageTitle, text) {
          // https, or a diagram's screenshot the export saved beside the document (docDiagramPictures).
          if (!/^(https:|\.\.\/images\/[^/?#\\]+$)/i.test(String(href || '').trim())) return docAttr(text || '');
          return `<img src="${docAttr(href)}" alt="${docAttr(text || '')}"${imageTitle ? ` title="${docAttr(imageTitle)}"` : ''}>`;
        },
      },
    });
  }
  const body = docMarked.parse(String(markdown || ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data: file:">
<title>${escapeHtmlText(title)}</title>
<style>
:root { --bg: #faf9f6; --ink: #1f1e1c; --soft: #4a4844; --mute: #77736b; --line: #e3dfd6; --card: #fff; --accent: #b4552d; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1c1a; --ink: #ecebe6; --soft: #cfcdc6; --mute: #9b978e; --line: #3a3833; --card: #262522; --accent: #e08a5f; } }
html { background: var(--bg); }
body { margin: 0; color: var(--ink); font: 17px/1.65 Georgia, "Iowan Old Style", "Times New Roman", serif; }
main { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px; }
h1, h2, h3, h4 { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.3; }
h1 { font-size: 30px; margin: 0 0 .4em; }
h2 { font-size: 21px; margin: 1.8em 0 .5em; }
h3 { font-size: 17px; margin: 1.5em 0 .4em; }
p, ul, ol, table, blockquote, pre { margin: 0 0 1em; }
a { color: var(--accent); }
blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid var(--line); color: var(--soft); }
code { font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
pre code { border: 0; padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; font-size: 15px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--card); font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
img { max-width: 100%; }
@media print { html, body { background: #fff; color: #000; } main { max-width: none; padding: 0; } a { color: inherit; } h2, h3 { break-after: avoid; } tr, pre, blockquote { break-inside: avoid; } }
</style>
</head>
<body>
<main>
${body}</main>
</body>
</html>
`;
}

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
// opts (Export All): { artifacts: { views (its artifact step's), records (each artifact.json written, with dir, its
// folder from the root, and versionOrder, its version keys in order), listFetched (claude.ai's list is in this export), listed, exported, since }, firstPart: the
// first viewer-files part number the chats may use, after the artifact step's parts }.
async function writeViewer(zip, chats, opts = {}) {
  try {
    const artifacts = opts && opts.artifacts && typeof opts.artifacts === 'object' ? opts.artifacts : null;
    // No chats and no artifact views: nothing to show. Artifacts alone (an Export Changes run with no chat changes) still get a viewer.
    if (!chats.length && !(artifacts && Array.isArray(artifacts.views) && artifacts.views.length)) return false;
    const assets = await Promise.all(CTViewer.VIEWER_ASSETS.map(async (asset) => {
      const response = await fetch(chrome.runtime.getURL(asset));
      if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
      return response.text();
    }));
    const [template, logic, app, marked, katex, css, highlight, artifactsApp, artifactsCss] = assets;
    // Large upload text goes to viewer-files/, loaded when the upload is opened.
    const firstPart = opts && Number.isInteger(opts.firstPart) && opts.firstPart > 1 ? opts.firstPart : 1;
    const { data, parts } = CTViewer.moveUploadText(CTViewer.buildViewerData(chats, { exported: new Date().toISOString(), artifacts }), { firstPart });
    const html = CTViewer.assembleViewer({ template, css, marked, katex, highlight, logic, app, artifactsApp, artifactsCss, data, fileScripts: parts.length > 0 || firstPart > 1 });
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
// Shared helpers: upload keys and code fences
// ============================================================================

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

// Detect bash_tool commands that mutate a tracked artifact in a way the
// declarative replay (create_file / str_replace / rewrite / heredoc, and a
// literal sed -i or cat >> passed in as options.replayed) can't reconstruct.
// Returns one entry per changed file (all its commands merged); sortOpaque
// later turns each into nothing, a note or an `artifact_opaque_mutation`
// warning pointing the user at `replay_bash.py`.
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

// One simple command's words, quotes removed, and the targets of its output redirects (> and >>,
// with or without a file descriptor). Quoted text is never a redirect: echo '<a>x.html</a>' > f has
// one target, f.
function shellWords(segment) {
  const words = [];
  const redirects = [];
  let current = '', started = false, quote = null, into = null;
  const end = () => {
    if (started) {
      if (into === 'out') redirects.push(current);
      else if (into !== 'in') words.push(current);
      into = null;
    }
    current = ''; started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < segment.length) { current += segment[++i]; started = true; continue; }
    if (/\s/.test(ch)) { end(); continue; }
    if (ch === '>' || ch === '<') {
      if (started && /^(\d+|&)$/.test(current)) { current = ''; started = false; } else end();
      if (ch === '>' && /[>|&]/.test(segment[i + 1] || '')) i++;
      into = ch === '>' ? 'out' : 'in';
      continue;
    }
    current += ch; started = true;
  }
  end();
  return { words, redirects };
}

// Any heredoc's body taken out, the rest of its first line kept: the body is input, not shell.
const ANY_HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n(?:[\s\S]*?\n)??[ \t]*\2[ \t]*(?=\n|$)/g;

// options.index: extractArtifacts' index (key -> { filename, ... }), for each file's name in artefacts/.
// options.replayed: toolUseId + '|' + path keys of commands already replayed, skipped here.
// Returns { opaqueMutations (one per command and file), byFile (path -> { path, filename, msgIndexes,
// lastMsgIndex, lastBlockIndex, count, resolved, candidates }) }. resolved is false when a command named
// the file only by a name several known files share, with no working directory to tell them apart (or
// a glob with none), or by a relative name its uncertain working directory (commandCwds) doesn't join
// to a known file (resolveTouch). candidates: for such a file, every known file those names could be.
function detectOpaqueMutations(data, errorCollector, { replayed = new Set(), index = {} } = {}) {
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
        for (const match of heredocMatches(cmd)) {
          knownArtifactPaths.add(heredocPath(match));
        }
      }
    }
  }
  // Matched normalized (/home/claude//g.txt is /home/claude/g.txt); hits are filed under the raw keys.
  const { list: known, raw: rawKeys } = normalizedKeys(knownArtifactPaths);
  const uncertainCwds = new Set();
  const cwds = commandCwds(messages, uncertainCwds);

  const opaqueMutations = [];

  // Walk messages and classify each bash_tool command. We flag any command
  // that writes to a tracked artifact and isn't a heredoc create (those are
  // handled declaratively by extractArtifacts).
  //
  // An artifact may be referenced several ways, each resolved against the
  // command's working directory (commandCwds) by resolveSandboxPath:
  //   • Full sandbox path:   open('/home/claude/booklet/foo.html','w')
  //   • A relative name:     `cd <dir> && open('foo.html','w')`
  //   • Via a variable:      f='foo.html'; open(f,'w').write(...)
  //   • A glob:              sed -i ... *.html
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    for (let bi = 0; bi < (msg.content || []).length; bi++) {
      const block = msg.content[bi];
      if (block.type !== 'tool_use' || !isBashTool(block.name)) continue;
      const rawCommand = (block.input && block.input.command) || '';
      if (!rawCommand) continue;
      const cwd = cwds.has(block.id) ? cwds.get(block.id) : null;
      const uncertain = uncertainCwds.has(block.id);

      // The files this command changes: raw key -> { resolved, candidates }. candidates: for an
      // unresolved hit, every known file the word could name (raw keys).
      const hits = new Map();
      const hit = (path, resolved, candidates = []) => {
        for (const key of rawKeys.get(normalizeSandboxPath(path)) || []) {
          const h = hits.get(key) || { resolved: true, candidates: new Set() };
          h.resolved = h.resolved && resolved;
          if (!resolved) for (const c of candidates) for (const k of rawKeys.get(normalizeSandboxPath(c)) || []) h.candidates.add(k);
          hits.set(key, h);
        }
      };
      // A word naming a file: its path, a relative name, or a glob.
      const target = (word) => {
        if (!word) return;
        if (/[*?]/.test(word)) {
          const full = word.startsWith('/') ? normalizeSandboxPath(word) : cwd ? normalizeSandboxPath(cwd + '/' + word) : null;
          const re = (w) => new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
          const found = full ? known.filter((ap) => re(full).test(ap)) : [];
          if (found.length) found.forEach((ap) => hit(ap, true));
          else if ((!full || (uncertain && !word.startsWith('/'))) && !word.includes('/')) {
            // No directory, or one that may be wrong and names no known file: every file the glob
            // could name, unresolved.
            const loose = known.filter((ap) => re(word).test(basenameOf(ap)));
            for (const ap of loose) hit(ap, false, loose);
          }
          return;
        }
        const { path, candidates, resolved } = resolveTouch(word, cwd, known, uncertain);
        if (path) hit(path, resolved);
        else for (const c of candidates) hit(c, false, candidates);
      };

      // extractArtifacts already handled each `cat > path << DELIM` heredoc, so drop
      // the whole heredoc, body included: a body is text, and `<a href>about.html`
      // in it is no redirect. The rest of the command can still mutate artifacts.
      const catHeredocs = heredocMatches(rawCommand);
      let command = rawCommand;
      for (const match of catHeredocs.slice().reverse()) command = command.slice(0, match.index) + command.slice(match.index + match[0].length);
      // For the shell checks, other heredocs' bodies go too (a Python script is checked as Python),
      // so an apostrophe in a script's comment can't hide the sed after it.
      const shellCommand = command.replace(ANY_HEREDOC_RE, '$3');
      // An unquoted delimiter means bash expanded $, ` and \ in the body, so the
      // file Claude got differs from the text in the command.
      for (const match of catHeredocs) {
        if (match[2] === '' && /[$`\\]/.test(match[4] || '')) hit(heredocPath(match), true);
      }

      // Python: open(p, 'w' / 'a' / 'x' / 'r+' ..., encoding=...), open(file=p, mode='w'),
      // Path(p).write_text(...) and p.write_text(...), p a literal or a variable bound to one
      // (f = 'foo.html', or p = Path('/home/claude/foo.html'), also first in a python3 -c "..." script).
      const bindings = {};
      const varBindingRe = /(?:^|[\s;'"])\s*(\w+)\s*=\s*(?:(?:pathlib\.)?Path\(\s*)?(['"])((?:\\.|(?!\2).)*)\2/g;
      let vbm;
      while ((vbm = varBindingRe.exec(command)) !== null) {
        (bindings[vbm[1]] = bindings[vbm[1]] || []).push(vbm[3]);
      }
      const operand = "(?:(['\"])((?:\\\\.|(?!\\1).)*)\\1|([A-Za-z_]\\w*))";
      const pyWriteRes = [
        new RegExp("open\\(\\s*(?:file\\s*=\\s*)?" + operand + "\\s*,\\s*(?:mode\\s*=\\s*)?['\"](?:[wax][bt]?\\+?|r[bt]?\\+)['\"]", 'g'),
        new RegExp("Path\\(\\s*" + operand + "\\s*\\)\\s*\\.write_(?:text|bytes)\\s*\\(", 'g'),
        new RegExp("(?:^|[^\\w.)\\]])()()([A-Za-z_]\\w*)\\s*\\.\\s*write_(?:text|bytes)\\s*\\(", 'g'),
      ];
      for (const re of pyWriteRes) {
        for (const m of command.matchAll(re)) {
          if (m[2] !== undefined && m[1]) target(m[2]);
          else if (m[3]) for (const value of bindings[m[3]] || []) target(value);
        }
      }

      // Shell, one simple command at a time: a redirect into the file, sed/perl/awk
      // in place, tee, cp/mv/install onto it, or dd of=.
      for (const segment of shellSegments(shellCommand)) {
        const { words, redirects } = shellWords(segment);
        redirects.forEach(target);
        if (words[0] === 'sudo') words.shift();
        const tool = words[0];
        const args = words.slice(1);
        if (tool === 'sed' || tool === 'perl') {
          if (args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) args.filter((w) => !w.startsWith('-')).forEach(target);
        } else if (tool === 'awk' || tool === 'gawk') {
          if (args.some((w, i) => (w === '-i' && args[i + 1] === 'inplace') || w === '-iinplace' || w === '--include=inplace')) args.filter((w) => !w.startsWith('-')).forEach(target);
        } else if (tool === 'tee') {
          args.filter((w) => !w.startsWith('-')).forEach(target);
        } else if (tool === 'cp' || tool === 'mv' || tool === 'install') {
          if (args.length > 1) target(args[args.length - 1]);
        } else if (tool === 'dd') {
          args.filter((w) => w.startsWith('of=')).forEach((w) => target(w.slice(3)));
        }
      }

      // Every file the command changes is recorded, not just the first.
      for (const [path, h] of hits) {
        if (replayed.has(block.id + '|' + path)) continue;
        opaqueMutations.push({ artifactPath: path, msgIndex: mi, blockIndex: bi, toolUseId: block.id, resolved: h.resolved, candidates: Array.from(h.candidates), command: rawCommand });
      }
    }
  }

  // One entry per file: all its commands merged and counted.
  const byFile = new Map();
  for (const om of opaqueMutations) {
    const own = Object.prototype.hasOwnProperty.call(index, om.artifactPath) ? index[om.artifactPath] : null;
    let entry = byFile.get(om.artifactPath);
    if (!entry) {
      entry = { path: om.artifactPath, filename: (own && own.filename) || basenameOf(om.artifactPath), msgIndexes: [], lastMsgIndex: om.msgIndex, lastBlockIndex: om.blockIndex, count: 0, resolved: true, candidates: [] };
      byFile.set(om.artifactPath, entry);
    }
    entry.count++;
    if (!entry.msgIndexes.includes(om.msgIndex)) entry.msgIndexes.push(om.msgIndex);
    if (om.msgIndex > entry.lastMsgIndex || (om.msgIndex === entry.lastMsgIndex && om.blockIndex > entry.lastBlockIndex)) {
      entry.lastMsgIndex = om.msgIndex;
      entry.lastBlockIndex = om.blockIndex;
    }
    entry.resolved = entry.resolved && om.resolved;
    for (const c of om.candidates || []) if (!entry.candidates.includes(c)) entry.candidates.push(c);
  }

  return { opaqueMutations, byFile };
}

// The file tools that change a file at its path (input.path or input.file_path), by name.
const FILE_EDIT_TOOLS = ['create_file', 'str_replace', 'rewrite', 'create_or_overwrite', 'Write', 'Edit'];

// Run scripts, which rule c of sortOpaque treats as helper scripts. Other code (.js, .ts, .sql, ...)
// is as often what Claude made for the user, so it stays a warning.
const HELPER_SCRIPT_EXTENSIONS = ['.py', '.sh', '.bash', '.pl', '.rb'];

// claude.ai's two sandbox folders: drafts are made in the first, deliveries come from the second.
const SANDBOX_HOME = '/home/claude';
const SANDBOX_OUTPUTS = '/mnt/user-data/outputs';
const OUTPUTS_NAMED_RE = /\/mnt\/user-data\/outputs(?![^/\s'"`;&|)<>])/;

// Whether position a (msgIndex, blockIndex) is at or after b. A missing block means the end of a
// message for a (a save known only by its message) and its start for b, as before blocks were kept.
function atOrAfter(aMsg, aBlock, bMsg, bBlock) {
  if (aMsg !== bMsg) return aMsg > bMsg;
  return (Number.isInteger(aBlock) ? aBlock : Infinity) >= (Number.isInteger(bBlock) ? bBlock : -1);
}

// Sorts each file's unreplayable changes (detectOpaqueMutations' byFile) into nothing, a note or a
// warning (spec section 2, rules a-d; the first that matches wins). An entry's last change is the later
// of (lastMsgIndex, lastBlockIndex) and (lastChange, lastChangeBlock), its last change of any kind,
// replayed or not; rules a and b count only saves at or after it, a save earlier in the same message
// being before it. saved: [{ path, filename, msgIndex, blockIndex? }], the presentations and deliveries
// that downloaded. shownPaths: every path presented or delivered, downloaded or not (defaults to
// saved's). options.commands: the chat's bash commands [{ msgIndex, blockIndex, text, failed }], for
// rule b's outputs/ case. Message numbers in the texts count from 1 along the branch.
function sortOpaque(byFile, saved, errorCollector, shownPaths = null, { commands = [] } = {}) {
  const norm = (p) => normalizeSandboxPath(String(p || ''));
  const shown = new Set((shownPaths ? Array.from(shownPaths) : saved.map((s) => s.path)).map(norm));
  const extOf = (p) => { const dot = p.lastIndexOf('.'); return dot > p.lastIndexOf('/') ? p.slice(dot).toLowerCase() : ''; };
  const stemOf = (p) => { const name = p.split('/').pop(); const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; };
  const isHelper = (p) => HELPER_SCRIPT_EXTENSIONS.includes(extOf(p)) && !shown.has(p);
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const entry of byFile.values()) {
    const path = norm(entry.path);
    const indexes = (entry.msgIndexes || []).slice().sort((a, b) => a - b).map((i) => i + 1);
    const commandsText = `${entry.count} command${entry.count === 1 ? '' : 's'}`;
    const where = indexes.length ? `message${indexes.length === 1 ? '' : 's'} ${indexes.join(', ')}` : '';
    const counted = where ? `${commandsText}; ${where}` : commandsText;
    const block = (b) => (Number.isInteger(b) ? b : -1);
    let lastMsg = entry.lastMsgIndex, lastBlock = block(entry.lastBlockIndex);
    if (Number.isInteger(entry.lastChange) && (entry.lastChange > lastMsg || (entry.lastChange === lastMsg && block(entry.lastChangeBlock) > lastBlock))) {
      lastMsg = entry.lastChange; lastBlock = block(entry.lastChangeBlock);
    }
    const isLater = (s) => atOrAfter(s.msgIndex, s.blockIndex, lastMsg, lastBlock);
    const later = saved.filter(isLater);
    const name = entry.filename;
    const details = { path: entry.path };
    if (entry.resolved) {
      // a: a download saved under the file's own name in artefacts/ at its last change or later (the file
      // itself, or a copy presented from outputs/) replaced it, so the export has its final state. A copy kept
      // apart as <base>_delivered does not count.
      if (later.some((s) => s.filename === name)) continue;
      // b: files saved afterwards from its folder or below: this one is likely their draft. A draft in
      // /home/claude also counts a file saved from outputs/ when its name has the draft's stem, or when a
      // bash command that didn't fail, at or after the draft's last change, names both the draft and outputs/.
      const folder = path.slice(0, path.lastIndexOf('/')) || '/';
      const base = path.split('/').pop();
      const namesDraft = new RegExp(`(?:^|[^\\w.-])${escape(base)}(?![\\w.-])`);
      const linked = isUnderFolder(path, SANDBOX_HOME) && commands.some((c) => !c.failed
        && atOrAfter(c.msgIndex, c.blockIndex, lastMsg, lastBlock)
        && namesDraft.test(c.text) && OUTPUTS_NAMED_RE.test(c.text));
      const fromOutputs = (s) => isUnderFolder(path, SANDBOX_HOME) && isUnderFolder(s.path, SANDBOX_OUTPUTS) && (linked || stemOf(norm(s.path)) === stemOf(path));
      const names = [];
      for (const s of later) if (norm(s.path) !== path && (isUnderFolder(s.path, folder) || fromOutputs(s)) && !names.includes(s.filename)) names.push(s.filename);
      if (names.length) {
        const more = names.length - 3;
        const list = more > 0 ? `${names.slice(0, 3).join(', ')} and ${more} more` : names.join(', ');
        errorCollector.addNote('draft_superseded', name,
          `Draft changed by a command the export can't follow (${counted}). The files Claude delivered from this folder afterwards are in the export: ${list}. This draft is likely an earlier state of one of them.`,
          details);
        continue;
      }
    }
    // c: a run script never presented or delivered is one Claude ran. An unresolved file is one when
    // every file its command could have meant is.
    const candidates = entry.resolved ? [path] : (entry.candidates || []).map(norm);
    if (candidates.length && candidates.every(isHelper)) {
      errorCollector.addNote('helper_script', name,
        `Helper script Claude ran; changed by a command the export can't follow (${counted}), so this copy may be older than the one Claude ran. Scripts are not what Claude delivered.`,
        details);
      continue;
    }
    // d: a warning, pointing at the companion replay_bash.py CLI.
    errorCollector.addWarning('artifact_opaque_mutation', name,
      `Changed by ${commandsText} the export can't replay${where ? ` (${where})` : ''}.`,
      { ...details, note: 'Run: python3 replay_bash.py <this-export-folder>' });
  }
}

// Extract text attachments from messages (pasted files with extracted_content)
// Returns { attachments: { filename -> content }, idToFilename: { id -> filename } }
function extractTextAttachments(data) {
  const attachments = {};
  const idToFilename = {};  // Maps attachment id to final filename
  const byMessage = {};  // message uuid -> [{ att, name }], saved attachments in order
  const takenLower = new Set();  // Notes.txt and notes.txt are one file on macOS and Windows
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
      while (takenLower.has(finalName.toLowerCase())) {
        const currentExt = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '';
        const base = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
        finalName = `${base}_${counter}${currentExt}`;
        counter++;
      }
      // Apply mojibake fix to repair encoding issues
      attachments[finalName] = fixMojibake(content);
      takenLower.add(finalName.toLowerCase());

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

  // Markdown links to plain text, [text](url) -> text (url), the url set aside so its _ and * stay.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => `${label} (${keep(url)})`);

  // Remove bold/italic markers. A marker opens and closes next to text, and _ only at a word's
  // edge, so MAX_RETRIES and 2 * 3 * 4 stay as written.
  text = text.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '$1');            // bold+italic
  text = text.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1');                  // bold
  text = text.replace(/\*(?=[^\s*])(.+?)(?<=[^\s*])\*/g, '$1');              // italic
  text = text.replace(/(?<![\w_])___(?=\S)(.+?)(?<=\S)___(?![\w_])/g, '$1'); // bold+italic
  text = text.replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '$1');   // bold
  text = text.replace(/(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g, '$1'); // italic

  // Convert lists to simple format
  text = text.replace(/^\s*[-*+]\s+/gm, '  • ');
  text = text.replace(/^\s*\d+\.\s+/gm, '  ');

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
async function populateConversationFolder(folder, data, onProgress = null, organizationId = null, sharedProjects = null, folderName = '', fetchPublished = null) {
  const title = data.name || 'Claude Conversation';
  const messages = getMessageChain(data);

  // Initialize error collector for comprehensive error tracking
  const errorCollector = new ExportErrorCollector(data.name, data.uuid);
  // Signs that claude.ai's data came back incomplete, such as after an API change.
  let healthIssues = 0;
  const addHealth = (message, note = '') => {
    healthIssues++;
    errorCollector.addWarning('export_health', 'original.json', `This chat looks incomplete: ${message}`, { note });
  };
  for (const problem of chatHealth(data)) addHealth(problem.message, problem.check);

  const artifactIndex = {};
  const replayedEdits = new Set();  // literal sed -i / cat >> the replay applied, not opaque
  const artifacts = extractArtifacts(data, errorCollector, artifactIndex, replayedEdits);
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
    if (onProgress) onProgress(8, 100, 'Fetching project files...');
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

  // Images from web searches, before the response files that show them.
  const webImages = await saveWebImages(folder, data, errorCollector, onProgress);
  const toolImages = await saveToolImages(folder, data, errorCollector);

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
        } else if (isWidgetTool(toolName)) {
          const name = widgetFileName(input, block, msg, artifactIndex);
          if (name) fullContent.push(...widgetLines(input, name, '../'));
        } else if (isImageSearchTool(toolName)) {
          fullContent.push('```plaintext', `Image search: ${input.query || ''}`, '```', '');
        } else if (isDisplayTool(toolName)) {
          const result = (msg.content || []).find((r) => r && r.type === 'tool_result' && r.tool_use_id === block.id);
          fullContent.push(...displayLines(toolName, input, result, webImages, '../'));
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
      } else if (block.type === 'tool_result' && toolImageLines(block, toolImages).length) {
        fullContent.push(...toolImageLines(block, toolImages, '../'));
      } else if (block.type === 'tool_result' && isImageSearchTool(block.name)) {
        fullContent.push(...imageSearchLines(block, webImages, '../'));
      } else if (block.type === 'tool_result' && (isPublishTool(block.name) || publishedReply(block.name, block))) {
        fullContent.push(...publishedLines(block));
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

  // Find each file a bash command changed in a way the declarative replay can't
  // reconstruct (see docs/WASM_REPLAY_APPROACH.md for why we don't interpret bash
  // scripts in the extension), merged with the replay-shaped edits extractArtifacts
  // left out. Once the presented and delivered files are in, sortOpaque turns each
  // into nothing, a note or an `artifact_opaque_mutation` warning.
  const { byFile: opaqueFiles } = detectOpaqueMutations(data, errorCollector, { index: artifactIndex, replayed: replayedEdits });
  const later = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);  // positions [chain index, block index]
  for (const [key, entry] of Object.entries(artifactIndex)) {
    if (!entry || !Array.isArray(entry.skipped) || !entry.skipped.length) continue;
    let merged = opaqueFiles.get(key);
    if (!merged) {
      merged = { path: key, filename: entry.filename, msgIndexes: [], lastMsgIndex: -1, lastBlockIndex: -1, count: 0, resolved: true, candidates: [] };
      opaqueFiles.set(key, merged);
    }
    // The detector usually counted these commands already; one per message is added only when it didn't.
    for (const mi of entry.skipped) {
      if (merged.msgIndexes.includes(mi)) continue;
      merged.msgIndexes.push(mi);
      merged.count++;
    }
    for (const at of entry.skippedAt || entry.skipped.map((mi) => [mi, -1])) {
      if (later(at, [merged.lastMsgIndex, Number.isInteger(merged.lastBlockIndex) ? merged.lastBlockIndex : -1])) [merged.lastMsgIndex, merged.lastBlockIndex] = at;
    }
  }
  // Each file's last change of any kind, as [chain index, block index]: a file tool that succeeded in
  // the chat (even one the replay could not apply: an Edit whose old text a script had changed makes no
  // version), a heredoc that wrote it, a bash edit replayed on it, a change the replay couldn't follow
  // (opaque or skipped), and the message of the last version the replay made (its end, when none of
  // these says which block).
  const chainIndex = new Map(messages.map((m, i) => [m.uuid, i]));
  const failedTools = failedToolUseIds(messages);
  const toolAt = new Map();  // tool_use id -> [chain index, block index]
  const lastWrite = {};  // sandbox path -> position of the last file tool (not failed) or heredoc on it
  const bashCommands = [];  // for sortOpaque's rule b: [{ msgIndex, blockIndex, text, failed }]
  const resultsById = new Map();
  messages.forEach((msg) => { for (const b of (msg.content || [])) if (b && b.type === 'tool_result' && b.tool_use_id) resultsById.set(b.tool_use_id, b); });
  messages.forEach((msg, mi) => {
    (msg.content || []).forEach((block, bi) => {
      if (!block || block.type !== 'tool_use') return;
      toolAt.set(block.id, [mi, bi]);
      const input = block.input || {};
      if (isBashTool(block.name)) {
        const text = String(input.command || '');
        for (const m of heredocMatches(text)) lastWrite[heredocPath(m)] = [mi, bi];
        bashCommands.push({ msgIndex: mi, blockIndex: bi, text, failed: failedTools.has(block.id) || bashFailed(resultsById.get(block.id)) });
        return;
      }
      if (!FILE_EDIT_TOOLS.includes(block.name) || failedTools.has(block.id)) return;
      const p = input.path || input.file_path;
      if (typeof p === 'string') lastWrite[p] = [mi, bi];
    });
  });
  for (const id of replayedEdits) {
    const cut = id.indexOf('|');
    const at = toolAt.get(id.slice(0, cut));
    const key = id.slice(cut + 1);
    if (at && (!lastWrite[key] || later(at, lastWrite[key]))) lastWrite[key] = at;
  }
  const lastChangeAt = (key) => {
    const entry = Object.prototype.hasOwnProperty.call(artifactIndex, key) ? artifactIndex[key] : null;
    const opaque = opaqueFiles.get(key);
    let last = opaque ? [opaque.lastMsgIndex, Number.isInteger(opaque.lastBlockIndex) ? opaque.lastBlockIndex : -1] : [-1, -1];
    if (Object.prototype.hasOwnProperty.call(lastWrite, key) && later(lastWrite[key], last)) last = lastWrite[key];
    for (const uuid of (entry && entry.messages) || []) {
      if (chainIndex.has(uuid) && chainIndex.get(uuid) > last[0]) last = [chainIndex.get(uuid), Number.MAX_SAFE_INTEGER];
    }
    return { msgIndex: last[0], blockIndex: last[1] };
  };
  // Whether a presentation or delivery comes at or after the last change of key.
  const savedAfterChange = (file, key) => {
    const at = lastChangeAt(key);
    return atOrAfter(file.msgIndex, file.blockIndex, at.msgIndex, at.blockIndex);
  };
  for (const [key, entry] of opaqueFiles) {
    const at = lastChangeAt(key);
    entry.lastChange = at.msgIndex;
    entry.lastChangeBlock = at.blockIndex;
  }
  // Presentations and deliveries that downloaded, for sortOpaque; and every path shown.
  const savedFiles = [];
  const shownPaths = new Set(presentedFiles.map((f) => f.path));

  // Download presented files (files Claude showed the user). One the replay
  // already rebuilt is skipped, unless the replay is known to be off for it (an
  // edit that couldn't be applied, or a script that changed it): then the
  // presented copy is the real final state, and it replaces the replayed file
  // and its last version. Two presented files with one name from different
  // folders are kept apart as <base>_2<ext>.
  const offNames = new Set(Array.from(opaqueFiles.values(), (e) => e.filename));
  const replayIsOff = (name) => offNames.has(name)
    || errorCollector.warnings.some((w) => w.type === 'str_replace_failed' && w.filename === name);
  const docHtmlNames = new Set();  // lowercase names of the Claude Docs .html pages written
  const docHtmlFiles = [];  // their names, for README.md
  const presentedNames = {};  // presented path -> its name in artefacts/
  const presentedFrom = {};   // name in artefacts/ -> the presented path that took it
  for (let i = 0; i < presentedFiles.length; i++) {
    const file = presentedFiles[i];
    // The artifact Claude wrote at this exact path, when there is one: another file with the same name
    // elsewhere (a draft in /home/claude) must not stand in for it.
    const own = Object.prototype.hasOwnProperty.call(artifactIndex, file.path) ? artifactIndex[file.path] : null;
    let name = own ? own.filename : file.filename;
    if (!own && presentedFrom[name] && presentedFrom[name] !== file.path) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.substring(0, dot) : name;
      const ext = dot > 0 ? name.substring(dot) : '';
      for (let n = 2; Object.prototype.hasOwnProperty.call(artifacts, name) || presentedFrom[name]; n++) name = `${base}_${n}${ext}`;
      const message = `Two different files were named ${file.filename}; this one, from ${file.path}, was saved as ${name}. The other is ${file.filename} from ${presentedFrom[file.filename]}.`;
      const details = { path: file.path, note: `Other file: ${file.filename} from ${presentedFrom[file.filename]}` };
      if (typeof errorCollector.addNote === 'function') errorCollector.addNote('name_changed', name, message, details);
      else errorCollector.addWarning('artifact_basename_collision', name, message, details);
    }
    const replayed = own ? !presentedFrom[name] : Object.prototype.hasOwnProperty.call(artifacts, name) && !presentedFrom[name];
    presentedNames[file.path] = name;
    presentedFrom[name] = file.path;
    // An off replay is replaced only by a presentation at or after the file's last change; an earlier
    // one is left out like a clean replay's, and sortOpaque keeps the file's entry.
    const ownEntry = replayed ? own || Object.values(artifactIndex).find((e) => e.filename === name) : null;
    if (replayed && (!replayIsOff(name) || (ownEntry && !savedAfterChange(file, ownEntry.path)))) continue;

    if (onProgress) {
      onProgress(15 + Math.floor((i / presentedFiles.length) * 5), 100, `Downloading: ${file.filename}`);
    }

    try {
      const conversationId = data.uuid;
      const blob = await fetchUploadedFile(null, file.uuid, organizationId, conversationId, file.path);
      await addArtefactBlob(folder, artifacts, name, blob);
      if (replayed) {
        const entry = ownEntry;
        if (entry && entry.versions.length > 1) await addArtefactBlob(folder, artifacts, entry.versions[entry.versions.length - 1], blob);
      }
      savedFiles.push({ path: file.path, filename: name, msgIndex: file.msgIndex, blockIndex: file.blockIndex });
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
  // A delivery of an artifact's own path at or after its last change, when the replay
  // is off, is its final state: it takes the artifact's name and replaces the last version too.
  const offPaths = new Map();
  for (const file of extractDeliveredFiles(data, Object.keys(artifacts))) {
    const own = Object.prototype.hasOwnProperty.call(artifactIndex, file.path) ? artifactIndex[file.path] : null;
    if (!own || !replayIsOff(own.filename)) continue;
    if (savedAfterChange(file, file.path)) offPaths.set(file.path, own.filename);
  }
  const deliveredFiles = extractDeliveredFiles(data, Object.keys(artifacts), offPaths);
  // Saved files only, for the viewer's deliveries map (see buildViewerDeliveries).
  const savedDeliveries = [];
  for (let i = 0; i < deliveredFiles.length; i++) {
    const file = deliveredFiles[i];
    if (onProgress) {
      onProgress(15 + Math.floor((i / deliveredFiles.length) * 5), 100, `Downloading: ${file.filename}`);
    }

    try {
      shownPaths.add(file.path);
      const blob = await fetchUploadedFile(null, file.uuid, organizationId, data.uuid, null);
      await addArtefactBlob(folder, artifacts, file.filename, blob);
      if (file.replaces) {
        const entry = artifactIndex[file.path];
        if (entry && entry.versions.length > 1) await addArtefactBlob(folder, artifacts, entry.versions[entry.versions.length - 1], blob);
        errorCollector.clearWarnings('str_replace_failed', file.filename);
      }
      savedDeliveries.push(file);
      savedFiles.push({ path: file.path, filename: file.filename, msgIndex: file.msgIndex, blockIndex: file.blockIndex });
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

  sortOpaque(opaqueFiles, savedFiles, errorCollector, shownPaths, { commands: bashCommands });

  // Claude Docs diagrams show by caption, as only claude.ai's page draws them. A self-contained HTML copy
  // Claude made in the chat (docCompanions) is linked under the document's title; without one, the note
  // says the diagrams aren't included and how to get them, and errors.txt says so too. Only the final
  // document has the note: its versions stay as rebuilt.
  const pathNames = {};  // sandbox path -> its name in artefacts/: the replayed file first, then presented, then delivered
  for (const f of savedDeliveries) pathNames[f.path] = f.filename;  // the final copy comes last
  Object.assign(pathNames, presentedNames);
  for (const [key, entry] of Object.entries(artifactIndex)) {
    if (entry && !key.startsWith('doc:') && !key.startsWith('artifact:') && !key.startsWith('widget:')) pathNames[key] = entry.filename;
  }
  const companions = docCompanions(data, artifacts, artifactIndex, pathNames);
  // A diagram Claude took a screenshot of (Claude_Docs__read) shows that picture, saved by saveToolImages,
  // where its caption stood; only diagrams still shown by caption count for the note and doc_diagram.
  // Each widget's code is kept as <doc base>_diagram<N>.jsx, N in the document's order.
  const widgetShots = docWidgetShots(data);
  const widgetCode = docWidgetCode(data);
  const widgetEmbeds = docWidgetEmbeds(data);
  const docJsx = {};  // doc key -> [{ node, code }] in the document's order
  const rebuiltDocs = {};  // file name -> the document as extractArtifacts rebuilt it
  // The viewer's copy keeps the captions: viewer.html sits at the export's root and its sanitizer drops a
  // ../images/ picture, so it shows each diagram by caption, as before v1.22.1.
  const viewerDocs = {};  // file name -> the document for viewer.html
  for (const [key, entry] of Object.entries(artifactIndex)) {
    if (!key.startsWith('doc:') || !entry || typeof artifacts[entry.filename] !== 'string') continue;
    const mine = widgetEmbeds.filter((e) => e.doc === key);
    const unplaced = mine.slice();
    const ordered = [];
    for (const line of artifacts[entry.filename].match(DOC_CAPTION_RE) || []) {
      const caption = line === '[embedded content]' ? '' : line.slice('[embedded content: '.length, -1);
      const i = unplaced.findIndex((e) => e.caption === caption);
      if (i !== -1) ordered.push(unplaced.splice(i, 1)[0]);
    }
    const pictures = ordered.map((e) => {
      const shot = widgetShots.get(e.node);
      const saved = shot && Object.prototype.hasOwnProperty.call(toolImages, shot.fileUuid) ? toolImages[shot.fileUuid] : null;
      return saved ? { caption: e.caption, src: `../${saved}`, note: shot.editedAfter ? 'screenshot taken before a later edit' : '' } : null;
    }).filter(Boolean);
    rebuiltDocs[entry.filename] = artifacts[entry.filename];
    artifacts[entry.filename] = docDiagramPictures(artifacts[entry.filename], pictures).markdown;
    const nodes = [];
    for (const e of ordered.concat(unplaced)) if (!nodes.includes(e.node) && widgetCode.has(e.node)) nodes.push(e.node);
    docJsx[key] = nodes.map((node) => ({ node, code: widgetCode.get(node) }));
  }
  for (const [key, entry] of Object.entries(artifactIndex)) {
    if (!key.startsWith('doc:') || !entry || typeof artifacts[entry.filename] !== 'string') continue;
    const names = companions[key] || [];
    const { markdown, captions } = docCompanionNote(artifacts[entry.filename], names);
    if (rebuiltDocs[entry.filename] !== undefined) viewerDocs[entry.filename] = docCompanionNote(rebuiltDocs[entry.filename], names, captions).markdown;
    if (markdown !== artifacts[entry.filename] || markdown !== rebuiltDocs[entry.filename]) {
      artifacts[entry.filename] = markdown;
      addFileWithBOM(folder, `artefacts/${entry.filename}`, markdown);
    }
    if (captions && !names.length) {
      const url = (/^\*Live document on claude\.ai: (\S+)\*$/m.exec(markdown) || [])[1];
      errorCollector.addWarning('doc_diagram', entry.filename,
        `${captions} diagram${captions === 1 ? '' : 's'} in this Claude Docs document ${captions === 1 ? 'is' : 'are'} not in the export: claude.ai draws ${captions === 1 ? 'it' : 'them'} only on the document's page, and this chat has no self-contained HTML copy of the document.`,
        { path: key, note: url ? `Open the live document: ${url}` : 'Open the document on claude.ai.' });
    }
  }

  // Each Claude Docs document also gets a standalone .html beside its .md, from its final state.
  for (const [key, entry] of Object.entries(artifactIndex)) {
    if (!key.startsWith('doc:') || !entry || typeof artifacts[entry.filename] !== 'string') continue;
    const markdown = artifacts[entry.filename];
    const base = entry.filename.replace(/\.md$/, '');
    // Unique whatever the case: notes.html and Notes.html are one file on macOS and Windows.
    const taken = new Set(Object.keys(artifacts).map((n) => n.toLowerCase()));
    let htmlName = `${base}.html`;
    for (let n = 1; taken.has(htmlName.toLowerCase()) || docHtmlNames.has(htmlName.toLowerCase()); n++) htmlName = `${base}_doc${n > 1 ? `_${n}` : ''}.html`;
    docHtmlNames.add(htmlName.toLowerCase());
    const title = ((/^#\s+(.+)$/m.exec(markdown) || [])[1] || base).trim();
    try {
      folder.file(`artefacts/${htmlName}`, claudeDocHtml(title, markdown));
      docHtmlFiles.push(htmlName);
    } catch (err) {
      console.warn(`Could not write ${htmlName}:`, err.message);
    }
    // Its diagrams' code, named uniquely the same way.
    (docJsx[key] || []).forEach(({ code }, i) => {
      let jsxName = `${base}_diagram${i + 1}.jsx`;
      for (let n = 2; taken.has(jsxName.toLowerCase()) || docHtmlNames.has(jsxName.toLowerCase()); n++) jsxName = `${base}_diagram${i + 1}_${n}.jsx`;
      docHtmlNames.add(jsxName.toLowerCase());
      folder.file(`artefacts/${jsxName}`, code);
      docHtmlFiles.push(jsxName);
    });
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
    // A project document is text, even one claude.ai made from a PDF and kept under the PDF's name,
    // so a name that isn't a text type gets .txt: report.pdf.txt opens, report.pdf would not.
    if (!isTextFile(actualFilename)) actualFilename += '.txt';
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
        viewerUploads[viewerUploadKey(file)] = { path: `uploads/${finalName}`, text: await viewerUploadText(finalName, blob) };
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
            viewerUploads[viewerUploadKey(file)] = { path: `uploads/${savedName}`, text: await viewerUploadText(savedName, result.content) };
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

  if (uploadedFiles.length > 1 && downloadedFiles.length === 0) {
    addHealth(`none of the ${uploadedFiles.length} uploads could be downloaded.`, 'uploads');
  }
  // Files claude.ai attached to Claude's own messages (a page it published) are its output: saved in
  // artefacts/, unless a replayed artifact there already has the name, and shown on that message in the viewer.
  const attachedSaved = [];  // the ones downloaded, for savePublishedPages
  for (const file of extractAttachedFiles(data, Object.keys(artifacts))) {
    if (!file.existing) {
      try {
        await addArtefactBlob(folder, artifacts, file.filename, await fetchUploadedFile(null, file.uuid, organizationId, data.uuid, null));
        attachedSaved.push(file);
      } catch (err) {
        console.error(`Failed to download attached file ${file.filename}:`, err);
        errorCollector.addError('delivered_file', file.filename, err.message, {
          uuid: file.uuid, path: file.path, urlsTried: err.urlsTried || [], httpStatus: err.httpStatus || null
        });
        continue;
      }
    }
    viewerUploads[file.uuid] = { path: `artefacts/${file.filename}`, text: null };
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

  // Pages the chat published, after the inline pass, so "same" compares the text as written to disk.
  if (onProgress) onProgress(70, 100, 'Saving published pages...');
  const published = await savePublishedPages(folder, data, {
    errorCollector, artifacts: { ...artifacts, ...viewerArtifacts }, artifactIndex, attached: attachedSaved,
    fetchPublished, shared: sharedProjects, chatFolder: folderName,
  });
  const pageLinks = publishedLinks(published);

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
  const saved = { artifacts, artifactIndex, attachmentFiles, uploadNames: savedUploadNames, presentedNames, webImages, toolImages, publishedLinks: pageLinks };
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

  const noteLines = readmeNoteLines(errorCollector.notes);
  if (noteLines.length > 0) {
    readmeLines.push('---', '', ...noteLines, '');
  }

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
  const artefactNames = Object.keys(artifacts).concat(docHtmlFiles);
  readmeLines.push(`## Artefacts (${artefactNames.length})`);
  readmeLines.push('');
  for (const filename of artefactNames.sort()) {
    readmeLines.push(`- [${filename}](artefacts/${encodeURIComponent(filename)})`);
  }
  readmeLines.push(...publishedReadmeLines(published));

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
      artifacts: { ...artifacts, ...viewerArtifacts, ...viewerDocs },
      artifactIndex,
      uploads: viewerUploads,
      webImages,
      toolImages,
      deliveries: buildViewerDeliveries(savedDeliveries),
      heredocs: heredocFiles,
      docKey: claudeDocKey,
      widgetFile,
      widgetKey,
      published,
      flags: viewerFlags(errorCollector.warnings, errorCollector.notes),
      project: viewerProject(data, projectFiles, projectFileMapping, projectFilesPath, projectUploads, projectInstructions, CTViewer.TEXT_EMBED_LIMIT, projectMetadataJson)
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

  return { messages, artifacts, textAttachments, uploadedFiles: downloadedFiles, failedFiles, errorCollector, codeBlocks, urls, responseFiles, viewerChat, healthIssues, published };
}

// Create full zip export with progress callback
async function createZipExport(data, onProgress = null, fetchPublished = null) {
  const zip = new JSZip();
  const title = data.name || 'Claude Conversation';

  const report = (step, total, msg) => {
    if (onProgress) onProgress(step, total, msg);
  };

  report(5, 100, 'Analyzing conversation...');

  // Use shared helper to populate the zip
  const result = await populateConversationFolder(zip, data, onProgress, orgId, null, '', fetchPublished);

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
    hasErrors: !!(result.errorCollector && (result.errorCollector.hasErrors() || result.errorCollector.hasWarnings())),
    healthIssues: result.healthIssues || 0,
    viewerBuilt,
    size: zipBlob.size
  };
}

// ============================================================================
// Original functions (updated to use new helpers)
// ============================================================================


// getModelName is in export-core.js

// Convert conversation to Markdown
// options.artifacts, attachmentFiles, uploadNames and presentedNames come from
// populateConversationFolder in a ZIP: what was really saved, so the Markdown links
// to those files. A single Markdown file has none of them and embeds pasted text.
// Tools convertToMarkdown shows in a line of their own. Names may carry a connector prefix (mcp__visualize__...).
const isGuidanceTool = (name) => /(__|:)(read_me|guide|list_types)$/.test(String(name || ''));
const isImageSearchTool = (name) => /(^|__|:)image_search$/.test(String(name || ''));
const imagesOf = (result) => (Array.isArray(result && result.content) ? result.content : []).flatMap((c) => (c && Array.isArray(c.images) ? c.images.filter(Boolean) : []));
// A URL for (...) of a Markdown link: parentheses, angle brackets and spaces escaped (mdLinkText, export-core.js, is its text).
const mdUrl = (url) => String(url).replace(/[()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`).replace(/\s/g, (ch) => encodeURIComponent(ch));

// The file one show_widget call made in artefacts/ (the version it made, when there are several), or null.
function widgetFileName(input, block, msg, artifactIndex) {
  const entry = artifactIndex[widgetKey(input, block.id)];
  if (!entry) return null;
  const at = entry.versions.length > 1 ? entry.messages.indexOf(msg.uuid) : -1;
  return at >= 0 ? entry.versions[at] : entry.filename;
}

// Markdown for a diagram saved in artefacts/: a link, and the picture itself when it is an SVG.
// up: '../' from responses/, '' from the folder root.
function widgetLines(input, name, up = '') {
  const label = mdLinkText(input.title || 'Diagram');
  const href = `${up}artefacts/${encodeURIComponent(name)}`;
  const lines = [`\n**Diagram: ${label}** - [artefacts/${mdLinkText(name)}](${href})\n`];
  if (name.endsWith('.svg')) lines.push(`![${label}](${href})`, '');
  return lines;
}

// An image_search result as a numbered quote of links, each with the picture when the export saved it.
// saved: image URL -> 'images/<name>' (saveWebImages); up: '../' from responses/, '' from the folder root.
function imageSearchLines(block, saved = {}, up = '') {
  const lines = [];
  imagesOf(block).forEach((img, i) => {
    const title = mdLinkText(img.title || 'Image');
    const page = img.page_url ? `[${title}](${mdUrl(img.page_url)})` : title;
    const source = img.source ? ` (${mdLinkText(img.source)})` : '';
    lines.push(`> ${i + 1}. ${page}${source}${img.url ? ` · [image](${mdUrl(img.url)})` : ''}`);
    const file = img.url && Object.prototype.hasOwnProperty.call(saved, img.url) ? saved[img.url] : null;
    if (file) lines.push('>', `>    ![${title}](${up}${file.split('/').map(encodeURIComponent).join('/')})`, '>');
  });
  if (!lines.length) return lines;
  if (lines[lines.length - 1] === '>') lines.pop();
  // The result's own first line names the search ("Found and displayed 4 images for '...':"), so
  // results of searches run together can be told apart.
  const heading = resultText(block).split('\n')[0].trim();
  return [...(heading ? [`> ${heading.replace(/[\\`*_[\]<>]/g, '\\$&')}`, '>'] : []), ...lines, ''];
}

// Images from web searches: saved in images/ only when Chrome lets the extension fetch from other sites
// (the optional https permission). requestWebImages asks for it; call it straight from a click, before
// any await, because Chrome only asks during one.
const WEB_IMAGE_ORIGINS = { origins: ['https://*/*'] };
function requestWebImages() {
  try {
    return chrome.permissions && chrome.permissions.request ? chrome.permissions.request(WEB_IMAGE_ORIGINS).catch(() => false) : Promise.resolve(false);
  } catch (e) {
    return Promise.resolve(false);
  }
}
async function webImagesAllowed() {
  try {
    return !!(chrome.permissions && chrome.permissions.contains && await chrome.permissions.contains(WEB_IMAGE_ORIGINS));
  } catch (e) {
    return false;
  }
}
// Whether the permission is there, as last known (null: not known yet), so a click can decide without awaiting.
let webImagesGranted = null;
function noteWebImagesGrant() {
  webImagesAllowed().then((ok) => { webImagesGranted = ok; });
}
noteWebImagesGrant();
try {
  if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(noteWebImagesGrant);
  if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(noteWebImagesGrant);
} catch (e) { /* no permission events: the next check corrects it */ }
// Export Artifacts' card pictures need the same permission: asked in the click (call before any await),
// only when it isn't known to be granted. Returns the request's promise, or null when nothing was asked.
function askForCardPictures() {
  if (webImagesGranted === true) return null;
  return requestWebImages().then((ok) => { webImagesGranted = !!ok; return !!ok; });
}

// Images Claude looked at (a photo it opened with Read), which claude.ai keeps and only links: downloaded
// from claude.ai into images/. Returns file uuid -> 'images/<name>'. A failure is a tool_image warning.
async function saveToolImages(folder, data, errorCollector) {
  const saved = {};
  for (const img of toolImagesOf(data)) {
    try {
      const res = await fetch(`https://claude.ai${img.url}`, { credentials: 'include', headers: { Accept: 'image/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
      const blob = await res.blob();
      const ext = WEB_IMAGE_TYPES[type] || WEB_IMAGE_TYPES[String(blob.type || '').toLowerCase()];
      if (!ext) throw new Error(`not a PNG, JPEG, GIF or WebP image (${type || blob.type || 'no type'})`);
      const name = toolImageName(img, ext);
      folder.file(`images/${name}`, blob);
      saved[img.uuid] = `images/${name}`;
    } catch (err) {
      errorCollector.addWarning('tool_image', img.base || img.uuid, `Image Claude viewed not saved: ${err.message}`, { uuid: img.uuid, path: img.url });
    }
  }
  return saved;
}

// A tool result's images the export saved, as Markdown pictures. up: '../' from responses/.
function toolImageLines(block, saved = {}, up = '') {
  const out = [];
  for (const item of (Array.isArray(block && block.content) ? block.content : [])) {
    const file = item && item.type === 'image' && typeof item.file_uuid === 'string' && Object.prototype.hasOwnProperty.call(saved, item.file_uuid) ? saved[item.file_uuid] : null;
    if (file) out.push(`![${mdLinkText(file.split('/').pop())}](${up}${file.split('/').map(encodeURIComponent).join('/')})`, '');
  }
  return out;
}

const WEB_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const WEB_IMAGE_TIMEOUT = 20000;

// Downloads the chat's web images into images/, a few at a time. Returns image URL -> 'images/<name>' for
// the saved ones. Not allowed: one web_image warning. A failed image: a web_image warning naming it.
async function saveWebImages(folder, data, errorCollector, onProgress = null) {
  const images = webImagesOf(data);
  const saved = {};
  if (!images.length) return saved;
  if (!(await webImagesAllowed())) {
    errorCollector.addWarning('web_image', 'images/', `${images.length} image${images.length === 1 ? '' : 's'} from web searches ${images.length === 1 ? 'was' : 'were'} not saved: Claude Takeout may not fetch images from other sites.`,
      { note: 'No permission to fetch images from other sites' });
    return saved;
  }
  const fetchImage = async (url) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), WEB_IMAGE_TIMEOUT) : null;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller ? controller.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
      const blob = await res.blob();
      const ext = WEB_IMAGE_TYPES[type] || WEB_IMAGE_TYPES[String(blob.type || '').toLowerCase()];
      if (!ext) throw new Error(`not a PNG, JPEG, GIF or WebP image (${type || blob.type || 'no type'})`);
      if (blob.size > WEB_IMAGE_MAX_BYTES) throw new Error(`larger than ${WEB_IMAGE_MAX_BYTES / 1024 / 1024} MB`);
      return { blob, ext };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < images.length) {
      const img = images[next++];
      let got = null;
      let error = null;
      for (const url of [img.url, img.thumb].filter((u, i, all) => u && all.indexOf(u) === i)) {
        try { got = await fetchImage(url); break; } catch (e) { error = e; }
      }
      if (got) {
        const name = webImageName(img, got.ext);
        folder.file(`images/${name}`, got.blob);
        saved[img.url] = `images/${name}`;
      } else {
        errorCollector.addWarning('web_image', img.title || img.url, `Image not saved: ${error && error.name === 'AbortError' ? 'the site took too long' : (error ? error.message : 'unknown error')}`, { path: img.url, note: img.page ? `Found on ${img.page}` : '' });
      }
      done++;
      if (onProgress) onProgress(10 + Math.floor((done / images.length) * 5), 100, `Saving web images: ${done} of ${images.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, worker));
  return saved;
}

// claude.ai's display tools: product cards (carousel, featured), a comparison table, and multiple-choice
// questions, as Markdown. result: the call's tool_result, whose images (product_<n>_<m>) the export may have
// saved (webImages: URL -> path). up: '../' from responses/.
const isDisplayTool = (name) => /(^|__|:)(\w+_display_v\d+|ask_user_input_v\d+)$/.test(String(name || ''));
function displayLines(name, input, result, webImages = {}, up = '') {
  const i = input && typeof input === 'object' ? input : {};
  const cell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const lines = [];
  if (/ask_user_input/.test(name)) {
    for (const q of Array.isArray(i.questions) ? i.questions : []) {
      if (!q || typeof q !== 'object') continue;
      lines.push(`**${String(q.question || '').trim()}**`, '');
      for (const o of Array.isArray(q.options) ? q.options : []) lines.push(`- ${o}`);
      lines.push('');
    }
    return lines;
  }
  const products = (Array.isArray(i.products) ? i.products : []).filter((p) => p && typeof p === 'object');
  if (/comparison_card/.test(name)) {
    const rows = Math.max(0, ...products.map((p) => (Array.isArray(p.attributes) ? p.attributes.length : 0)));
    lines.push(`| | ${products.map((p) => `**${cell(p.name)}**${p.price ? ` (${cell(p.price)})` : ''}`).join(' | ')} |`, `|---|${products.map(() => '---').join('|')}|`);
    for (let r = 0; r < rows; r++) {
      const label = (products.map((p) => (p.attributes || [])[r]).find((a) => a && a.label) || {}).label || '';
      lines.push(`| ${cell(label)} | ${products.map((p) => cell(((p.attributes || [])[r] || {}).value)).join(' | ')} |`);
    }
    return [...lines, ''];
  }
  const images = (Array.isArray(result && result.content) ? result.content : []).flatMap((c) => (c && Array.isArray(c.images) ? c.images : []));
  products.forEach((p, n) => {
    lines.push(`#### ${String(p.name || '').trim()}${p.price ? ` (${p.price})` : ''}`, '');
    if (p.blurb) lines.push(String(p.blurb), '');
    const pics = images.filter((img) => img && new RegExp(`^product_${n}_`).test(String(img.id || '')))
      .map((img) => Object.prototype.hasOwnProperty.call(webImages, img.url) ? webImages[img.url] : null).filter(Boolean);
    if (pics.length) lines.push(pics.map((f) => `![${mdLinkText(p.name || 'Product')}](${up}${f.split('/').map(encodeURIComponent).join('/')})`).join(' '), '');
  });
  return lines;
}

// ============================================================================
// Published pages: the pages a chat published with publish_files or the Artifact tool
// ============================================================================
// content.js fetches them (publishedPageInfo, publishedPageFile); the asset token never reaches the popup.
// A version is "same" when every file of it equals, by SHA-256, the text this export already holds for its
// source as of the publishing message; then nothing is fetched. A single-chat export saves the others in
// published/<page>/<version>/ beside the chat, with published.json. Export All keeps every version in the one
// artifacts store (artifactStore), artifacts/<Title>_<id>/<ver>/ with artifact.json (format 2), shared with its
// artifact step: a same version of one file points at the chat's file (sameAs), one of several files is copied.

const PUBLISHED_MAX_FILE = 32 * 1024 * 1024;   // one file, raw bytes, checked from _files.json before fetching
const PUBLISHED_MAX_BYTES = 50 * 1024 * 1024;  // all files of one page version
const PUBLISHED_VER_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const PUBLISHED_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(\s*;\s*[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+)*$/;

// An error from content.js or chrome messaging as a short code, never free text that could hold a URL.
function publishedCode(r) {
  if (!r || typeof r !== 'object') return 'no response';
  if (r.connectionError) return 'no connection to the claude.ai tab';
  const e = String(r.error || '');
  return /^(HTTP [1-5]\d\d|[a-z][a-z ]{0,30})$/.test(e) ? e : 'bad response';
}

function publishedPathOk(p) {
  return typeof p === 'string' && p !== '' && p.charAt(0) !== '/' && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// content.js's publishedPageInfo reply, keeping only well-formed values: claude.ai's reply is passed through
// there unchecked, and nothing from it may carry a URL into published.json or errors.txt.
function cleanPublishedInfo(r) {
  if (!r || typeof r !== 'object' || r.error || r.connectionError) {
    return { error: publishedCode(r), status: r && Number.isInteger(r.status) ? r.status : null };
  }
  if (typeof r.ver !== 'string' || !PUBLISHED_VER_RE.test(r.ver) || !Array.isArray(r.files)) return { error: 'bad response', status: null };
  const files = [];
  const rejected = (Array.isArray(r.rejected) ? r.rejected : []).filter((p) => typeof p === 'string').map((p) => p.slice(0, 200));
  const seen = new Set();
  let runtimeSkipped = Number.isInteger(r.runtimeSkipped) && r.runtimeSkipped > 0 ? r.runtimeSkipped : 0;
  for (const f of r.files) {
    if (f && typeof f.path === 'string' && f.path.startsWith('artifact-type/')) { runtimeSkipped++; continue; }
    if (!f || typeof f.path !== 'string' || seen.has(f.path)) continue;
    if (!publishedPathOk(f.path)) { rejected.push(f.path.slice(0, 200)); continue; }
    seen.add(f.path);
    files.push({
      path: f.path,
      size: Number.isFinite(f.size) && f.size >= 0 ? f.size : null,
      contentType: typeof f.contentType === 'string' && PUBLISHED_TYPE_RE.test(f.contentType) ? f.contentType : null,
      sha256: typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(f.sha256) ? f.sha256.toLowerCase() : null,
    });
  }
  return {
    ver: r.ver,
    title: typeof r.title === 'string' ? r.title : '',
    history: (Array.isArray(r.history) ? r.history : []).filter((h) => typeof h === 'string' && PUBLISHED_VER_RE.test(h)),
    files, rejected, runtimeSkipped,
    // An older version whose list is the live version's (content.js): its files are fetched unverified.
    listFromLive: r.listFromLive === true,
  };
}

// Base64 to bytes, a piece at a time.
function base64ToBytes(b64) {
  const s = String(b64 || '');
  const STEP = 4 * 16384;
  const parts = [];
  let total = 0;
  for (let i = 0; i < s.length; i += STEP) {
    const bin = atob(s.slice(i, i + STEP));
    const part = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) part[j] = bin.charCodeAt(j);
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Saved names for a version's file paths, in listing order: each segment through publishedSegment, and a
// name that a file or folder already has, whatever the case, gets _2, _3, ... reserved: names at the top level
// that are taken already (artifact.json in Export Artifacts). Returns { names: Map, renames }.
function publishedSavedNames(paths, reserved = []) {
  const used = new Set(reserved.map((r) => String(r).toLowerCase()));
  const folders = new Map();
  const names = new Map();
  const renames = [];
  const free = (parent, seg, isFile) => {
    const dot = isFile ? seg.lastIndexOf('.') : -1;
    const base = dot > 0 ? seg.slice(0, dot) : seg;
    const ext = dot > 0 ? seg.slice(dot) : '';
    let name = seg;
    for (let n = 2; used.has((parent + name).toLowerCase()); n++) name = `${base}_${n}${ext}`;
    used.add((parent + name).toLowerCase());
    return parent + name;
  };
  for (const p of paths) {
    const segs = p.split('/');
    let parent = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const key = segs.slice(0, i + 1).join('/');
      if (!folders.has(key)) folders.set(key, free(parent, publishedSegment(segs[i]), false));
      parent = `${folders.get(key)}/`;
    }
    const saved = free(parent, publishedSegment(segs[segs.length - 1]), true);
    names.set(p, saved);
    if (saved !== p) renames.push(`${p} as ${saved}`);
  }
  return { names, renames };
}


// A version's label and place: v1, v2, ... by its index in the page's history (oldest first); 'current'
// for a publish that named no version, last.
function publishedLabel(rec, v) {
  if (v.key === '') return { label: 'current', order: rec.history.length + 1 };
  const i = rec.history.indexOf(v.ver);
  return i >= 0 ? { label: `v${i + 1}`, order: i } : { label: v.ver, order: rec.history.length };
}

function publishedJson(rec) {
  const versions = {};
  const list = [...rec.versions.values()].filter((v) => v.ver).sort((a, b) => publishedLabel(rec, a).order - publishedLabel(rec, b).order);
  for (const v of list) {
    const { label, order } = publishedLabel(rec, v);
    versions[v.folderName] = {
      ver: v.ver, label, order, saved: v.saved, files: v.files, start: v.start, startSaved: v.startSaved,
      incomplete: v.incomplete, needsRuntime: v.needsRuntime, missing: v.missing, publishedIn: v.publishedIn,
    };
  }
  return { format: 1, title: rec.title, url: rec.url, shortId: rec.shortId, uuid: rec.uuid, versions };
}

// Export All: whether a published version's preview is worth keeping in memory for the artifact step, i.e. it is
// the listed live version of an artifact the step will save and need not fetch again (plain, non-Docs; see saveArtifact).
// artifacts: the included list; empty when the step won't run, so nothing is kept.
function publishedPreviewWanted(artifacts) {
  const wanted = new Set();
  for (const a of Array.isArray(artifacts) ? artifacts : []) {
    if (!a || artifactText(a.typeSlug) !== '' || isClaudeDocsArtifact(a)) continue;
    if (typeof a.live !== 'string' || !PUBLISHED_VER_RE.test(a.live)) continue;
    wanted.add(`${String(a.slug).toLowerCase()} ${a.live}`);
  }
  return (uuid, ver) => wanted.has(`${String(uuid).toLowerCase()} ${ver}`);
}

const publishedSignedOutReply = (r) => !!(r && (r.status === 401 || r.error === 'HTTP 401'));

// Fetch one page version's files (from cleanPublishedInfo) through content.js and write each to
// target at prefix + its saved name (names: path -> saved name). Each file is checked against the listing:
// size caps (PUBLISHED_MAX_FILE each, PUBLISHED_MAX_BYTES in all) and SHA-256. A file listed with neither size
// nor SHA-256 (claude.ai's frame info, as for Cowork and Claude Code pages) is saved unchecked, its real size counted against
// the total, and noted in unverified (path -> SHA-256 of the saved bytes, null when not saved). A 401 sets
// state.publishedSignedOut, calls onSignedOut once, and every later file is skipped. Returns { saved,
// missing: [path], problems: ['path (why)'], incomplete, start, startSaved, startSize, startText, needsRuntime, unverified,
// texts, images }. With collect (Export Artifacts' viewer), texts (path -> text) and images (path -> { bytes, type })
// hold the saved files a preview can use, within PREVIEW_ITEM_MAX each and PREVIEW_TOTAL_MAX in all of each kind
// (see previewKind); otherwise both are empty. Chat exports ignore them. With zip ({ date }: the current version of an
// artifact in the store), two or more saved files are also written as <version folder>.zip beside the folder
// (versionZip); zipped says whether it was.
async function fetchPublishedFiles({ target, prefix = '', uuid, ver, files, names, state = {}, onSignedOut = null, fetchPublished, collect = false, zip = null }) {
  const start = publishedStart(files);
  const missing = [];
  const problems = [];
  let total = 0;
  let written = 0;
  let startText = null;
  let startSize = null;
  const unverified = new Map();
  const texts = new Map();
  const images = new Map();
  let textBytes = 0;
  let imageBytes = 0;
  // Preview candidates, kept after the loop: the start file first, so other files never crowd it out.
  const candidates = [];
  const zipped = [];
  const keep = (f, bytes) => {
    const kind = previewKind(f.path);
    if (!kind || bytes.length > PREVIEW_ITEM_MAX) return;
    if (kind === 'text') {
      if (textBytes + bytes.length > PREVIEW_TOTAL_MAX) return;
      textBytes += bytes.length;
      texts.set(f.path, new TextDecoder().decode(bytes));
    } else {
      if (imageBytes + bytes.length > PREVIEW_TOTAL_MAX) return;
      imageBytes += bytes.length;
      images.set(f.path, { bytes, type: kind });
    }
  };
  for (const f of files) {
    const fail = (why) => { missing.push(f.path); if (why) problems.push(`${f.path} (${why})`); };
    // Unverified only when the listing has neither size nor checksum (claude.ai's frame info list).
    const checked = !(f.size == null && !f.sha256);
    if (!checked) unverified.set(f.path, null);
    if (state.publishedSignedOut) { fail(null); continue; }
    if (checked && (f.size == null || !f.sha256)) { fail('bad listing'); continue; }
    if (f.size != null) {
      if (f.size > PUBLISHED_MAX_FILE) { fail('too large'); continue; }
      if (total + f.size > PUBLISHED_MAX_BYTES) { fail('page over 50 MB'); continue; }
      total += f.size;
    }
    const reply = await fetchPublished({ action: 'publishedPageFile', uuid, ver, path: f.path, size: f.size });
    if (publishedSignedOutReply(reply)) {
      if (!state.publishedSignedOut && typeof onSignedOut === 'function') onSignedOut();
      state.publishedSignedOut = true;
      fail(null);
      continue;
    }
    if (!reply || reply.error || reply.connectionError || typeof reply.base64 !== 'string') { fail(publishedCode(reply)); continue; }
    let bytes;
    try { bytes = base64ToBytes(reply.base64); } catch (e) { fail('bad response'); continue; }
    if (bytes.length > PUBLISHED_MAX_FILE) { fail('too large'); continue; }
    if (checked) {
      if (await sha256Hex(bytes) !== f.sha256) { fail('checksum does not match'); continue; }
    } else {
      if (f.size == null) {
        if (total + bytes.length > PUBLISHED_MAX_BYTES) { fail('page over 50 MB'); continue; }
        total += bytes.length;
      }
      unverified.set(f.path, { sha256: await sha256Hex(bytes), size: bytes.length });
    }
    target.file(`${prefix}${names.get(f.path)}`, bytes);
    if (zip) zipped.push([names.get(f.path), bytes]);
    written++;
    if (f === start) startSize = bytes.length;
    if (f === start && isPublishedText(f)) startText = new TextDecoder().decode(bytes);
    if (collect && previewKind(f.path) && bytes.length <= PREVIEW_ITEM_MAX) candidates.push([f, bytes]);
  }
  // The start file first, then a Design canvas's layout (project/canvas.json) and its boards, then the rest.
  for (const [f, bytes] of candidates.slice().sort((a, b) => previewRank(a[0].path, start && start.path) - previewRank(b[0].path, start && start.path))) keep(f, bytes);
  const startOk = !!start && !missing.includes(start.path);
  // zip.whole: only a version saved whole (a chat's fetch in Export All, which the artifact step fetches again when
  // it isn't, so a ZIP of a part would be left beside the step's own files).
  const wroteZip = zip && !(zip.whole && missing.length) ? await writeVersionZip(target, prefix, zipped, zip.date) : false;
  return {
    saved: written > 0, zipped: wroteZip, missing, problems, incomplete: missing.length > 0,
    start: startOk ? start.path : null, startSaved: startOk ? names.get(start.path) : null, startSize: startOk ? startSize : null,
    startText, needsRuntime: publishedNeedsRuntime(startText), unverified, texts, images,
  };
}


// A version's files as one ZIP: entries in the order given ([saved name, bytes or text]), DEFLATE, each dated date
// (an ISO time; empty or not a date: 1980-01-01), so the same files and date always give the same bytes.
async function versionZip(entries, date) {
  let when = new Date(typeof date === 'string' ? date : '');
  if (!date || Number.isNaN(when.getTime())) when = new Date('1980-01-01T00:00:00Z');
  const zip = new JSZip();
  for (const [name, data] of entries) zip.file(name, data, { date: when, binary: typeof data !== 'string' });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// Writes <prefix without its trailing />.zip when entries has two or more files. True when written; a ZIP that can't
// be built is left out (the version's files are all saved, and artifact.json then names no ZIP).
async function writeVersionZip(target, prefix, entries, date) {
  if (entries.length < 2 || !prefix.endsWith('/')) return false;
  try {
    target.file(`${prefix.slice(0, -1)}.zip`, await versionZip(entries, date));
    return true;
  } catch (e) {
    return false;
  }
}

// File entries (for published.json or artifact.json) of files saved unchecked: sha256 and size of the saved
// bytes and verified: false.
function markUnverified(files, unverified) {
  for (const f of files) {
    if (!unverified.has(f.path)) continue;
    const got = unverified.get(f.path);
    Object.assign(f, got ? { sha256: got.sha256, size: got.size, verified: false } : { sha256: null, verified: false });
  }
}

// Export All: the store record (artifactStore) of a page a chat published. A page in claude.ai's list
// (shared.listedArtifacts: uuid -> artifactsFromList entry) is named and described from the list; any other by the
// publish's title, until page info renames it (artifactStore's retitle).
function publishedStoreRecord(shared, first) {
  const key = String(first.uuid).toLowerCase();
  const item = shared.listedArtifacts instanceof Map ? shared.listedArtifacts.get(key) : null;
  const rec = shared.store.record(key, { title: item ? item.title : first.title });
  if (item && !rec.listed) listedArtifactRecord(rec, item);
  return rec;
}

// Save the pages a chat published. ctx: { errorCollector, artifacts (the text as on disk, inlined), artifactIndex,
// attached (extractAttachedFiles entries saved by this export), fetchPublished(message) -> Promise<response>,
// shared (Export All: the shared object with store (artifactStore, prefix artifacts/), listedArtifacts, root,
// previewWanted), chatFolder (the chat's folder in Export All) }. In a chat export, each page goes to published/<dir>/
// with published.json. In Export All, each version goes into the store, in its record's version folder, with the
// publish in its publishedIn; a version the chat wrote the same is not fetched: one file is pointed at (sameAs, from
// the first chat), several are copied from the chat's text. Returns one PublishedEntry per page: { uuid, shortId,
// title, url, current, dir (relative to the chat folder), versions: [{ ver, folderName, label, order, start,
// startSaved, same, writtenAs, incomplete, needsRuntime, text, publishes }] }.
async function savePublishedPages(folder, data, ctx = {}) {
  const { errorCollector = null, artifacts = {}, artifactIndex = {}, attached = [], fetchPublished = null, shared = null } = ctx;
  const found = publishedPagesOf(data);
  if (!found.length) return [];
  const exportAll = !!(shared && shared.store);
  const store = exportAll ? shared.store : null;
  // Export All: page records (infos, history) kept across chats; their versions are the store record's.
  const pages = exportAll ? (shared.pages || (shared.pages = new Map())) : new Map();
  const dirs = new Set();
  const state = exportAll ? shared : {};  // publishedSignedOut: one 401 stops fetching for the whole export
  const target = exportAll ? shared.root : folder;
  // Export All: (uuid, ver) -> keep that version's preview for the artifact step (publishedPreviewWanted).
  const wanted = exportAll && typeof shared.previewWanted === 'function' ? shared.previewWanted : () => false;
  const chain = getMessageChain(data);
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const limit = typeof CTViewer !== 'undefined' && CTViewer.TEXT_EMBED_LIMIT ? CTViewer.TEXT_EMBED_LIMIT : 2 * 1024 * 1024;
  const warn = (filename, message, note = null) => { if (errorCollector) errorCollector.addWarning('published_page', filename, message, { note }); };
  const openNote = (rec) => (rec.url ? `Open it on claude.ai: ${rec.url}` : null);

  const byUuid = new Map();
  for (const p of found) {
    if (!byUuid.has(p.uuid)) byUuid.set(p.uuid, []);
    byUuid.get(p.uuid).push(p);
  }

  // One record per page for the export: its folder is chosen once, as titles change.
  const pageDir = (title, id) => {
    const name = `${safeFileTitle(title) || 'page'}_${id}`;
    let dir = name;
    for (let n = 2; dirs.has(dir.toLowerCase()); n++) dir = `${name}_${n}`;
    dirs.add(dir.toLowerCase());
    return dir;
  };
  const pageRecord = (first) => {
    if (pages.has(first.uuid)) return pages.get(first.uuid);
    const shortId = /^[A-Za-z0-9_-]{1,64}$/.test(first.shortId || '') ? first.shortId : '';
    const kept = exportAll ? publishedStoreRecord(shared, first) : null;
    const rec = {
      uuid: first.uuid, shortId, url: shortId ? `https://claude.ai/artifact/${shortId}` : '', title: String(first.title || ''),
      dir: kept ? kept.dir : pageDir(first.title, shortId || first.uuid), titleFromFile: !!first.titleFromFile && !(kept && kept.listed),
      history: [], infos: new Map(), versions: kept ? kept.versions : new Map(), folders: new Set(['published.json']), store: kept,
    };
    pages.set(first.uuid, rec);
    return rec;
  };
  const dirOf = (rec) => (exportAll ? `../${store.prefix}${rec.store.dir}` : `published/${rec.dir}`);

  if (typeof fetchPublished !== 'function') {
    const links = [...byUuid.values()].map((g) => pageRecord(g[0]).url).filter(Boolean);
    warn('published pages', `Published page not fetched: no claude.ai tab. ${byUuid.size} page${byUuid.size === 1 ? '' : 's'} this chat published ${byUuid.size === 1 ? 'is' : 'are'} not in the export.`,
      links.length ? `Open ${links.length === 1 ? 'it' : 'them'} on claude.ai: ${links.join(', ')}` : null);
    return [...byUuid.values()].map((group) => {
      const rec = pageRecord(group[0]);
      return {
        uuid: rec.uuid, shortId: rec.shortId, title: rec.title, url: rec.url, current: group.some((p) => p.current), dir: dirOf(rec),
        versions: group.map((p, i) => ({
          ver: p.ver, folderName: p.ver ? publishedSegment(p.ver) : 'current', label: p.ver || 'current', order: i, start: null, startSaved: null,
          same: false, writtenAs: null, incomplete: true, needsRuntime: false, text: null, publishes: p.publishes.slice(),
        })),
      };
    });
  }

  const noted = new Set();
  const storeDirs = new Set();  // Export All: the artifacts-store folders this chat's pages went into
  let signedOutHere = false;
  // A chat after the one that met the 401 says once why its pages were not fetched.
  let skipWarned = false;
  const noteSkipped = () => {
    if (signedOutHere || skipWarned) return;
    skipWarned = true;
    warn('published pages', 'Published pages not fetched: an earlier request in this export was answered HTTP 401, as if you were signed out.',
      'Sign in to claude.ai in this tab and export again.');
  };
  const markSignedOut = () => {
    if (state.publishedSignedOut) return;
    signedOutHere = true;
    state.publishedSignedOut = true;
    warn('published pages', 'Published pages not fetched: claude.ai answered HTTP 401, as if you were signed out. Pages after this one in the export were skipped.',
      'Sign in to claude.ai in this tab and export again.');
  };

  const getInfo = async (rec, ver) => {
    if (rec.infos.has(ver)) return rec.infos.get(ver);
    if (state.publishedSignedOut) return { error: 'signed out', skipped: true };
    const reply = await fetchPublished({ action: 'publishedPageInfo', uuid: rec.uuid, ver });
    if (publishedSignedOutReply(reply)) { markSignedOut(); return { error: 'signed out', skipped: true }; }
    const info = cleanPublishedInfo(reply);
    rec.infos.set(ver, info);
    if (!info.error) {
      if (!rec.infos.has(info.ver)) rec.infos.set(info.ver, info);
      if (info.history.length >= rec.history.length) rec.history = info.history;
      if (info.title) rec.title = info.title;
      // A page named after its file (an Artifact tool publish) takes claude.ai's title for its folder too. Nothing
      // is written before the first page info, so the folder can still be renamed.
      if (info.title && rec.titleFromFile) {
        rec.titleFromFile = false;
        if (exportAll) {
          store.retitle(rec.store, info.title);
          rec.dir = rec.store.dir;
        } else {
          dirs.delete(rec.dir.toLowerCase());
          rec.dir = pageDir(info.title, rec.shortId || rec.uuid);
        }
      }
      if (exportAll) {
        // The list's title stays for a listed page; any other takes claude.ai's.
        if (info.title && !rec.store.listed) rec.store.title = artifactText(info.title);
        if (info.history.length >= rec.store.history.length) rec.store.history = info.history;
      }
    }
    return info;
  };

  // A version's record. In Export All it is the store record's version (key: its id), and its folder the store's.
  const folderFor = (rec, key) => {
    if (rec.versions.has(key)) return rec.versions.get(key);
    let name;
    if (exportAll) {
      name = store.folderName(rec.store, key);
    } else {
      const want = key === '' ? 'current' : publishedSegment(key);
      name = want;
      for (let n = 2; rec.folders.has(name.toLowerCase()); n++) name = `${want}_${n}`;
      rec.folders.add(name.toLowerCase());
    }
    const v = {
      key, folderName: name, ver: null, files: [], names: null, renames: [], rejected: [], saved: false, attempted: false,
      start: null, startSaved: null, incomplete: false, needsRuntime: false, missing: [], text: null, publishedIn: [],
      ...(exportAll ? { folder: null } : {}),
    };
    rec.versions.set(key, v);
    return v;
  };

  // The text this export holds for a source file as of a publishing message: the artefact version then (on the
  // active branch only), or a file claude.ai attached to that message and this export downloaded.
  const hashes = new Map();
  const hashText = async (text) => {
    if (!hashes.has(text)) hashes.set(text, await sha256Hex(new TextEncoder().encode(text)));
    return hashes.get(text);
  };
  const candidates = (src, messageUuid) => {
    const out = [];
    const textOf = (name) => (name && isTextFile(name) && has(artifacts, name) && typeof artifacts[name] === 'string' ? artifacts[name] : null);
    const entry = has(artifactIndex, src.path) ? artifactIndex[src.path] : null;
    if (entry) {
      const i = versionAsOf(entry, chain, messageUuid);
      const name = i >= 0 ? entry.versions[i] : null;
      if (textOf(name) !== null) out.push({ name, text: textOf(name) });
    }
    const base = zipSafeName(src.path.split('/').pop()).normalize('NFC');
    for (const a of attached) {
      if (a && !a.existing && a.messageUuid === messageUuid && a.filename === base && textOf(a.filename) !== null) out.push({ name: a.filename, text: textOf(a.filename) });
    }
    return out;
  };
  // path -> { name, text } when every file matches for one publish, else null.
  const judge = async (files, publishes, sources) => {
    if (!files.length) return null;
    for (const pub of publishes) {
      const matched = new Map();
      for (const f of files) {
        // A one-file publish (the Artifact tool) names no published path: its one file is the one source.
        const src = !f.sha256 ? null : sources.find((s) => (s.as || s.path.split('/').pop()) === f.path)
          || (files.length === 1 && sources.length === 1 && !sources[0].as ? sources[0] : null);
        let hit = null;
        for (const c of src ? candidates(src, pub.messageUuid) : []) {
          if (await hashText(c.text) === f.sha256) { hit = c; break; }
        }
        if (!hit) break;
        matched.set(f.path, hit);
      }
      if (matched.size === files.length) return matched;
    }
    return null;
  };

  // Export All: the version's preview texts and images, for the artifact step (a version the store has whole is not
  // fetched again), only for an included artifact's listed version; not part of artifact.json.
  const keepPreview = (v, payload) => Object.defineProperty(v, 'preview', { value: payload, writable: true, configurable: true });
  const fetchVersion = async (rec, v) => {
    v.attempted = true;
    const outBefore = !!state.publishedSignedOut;
    const got = await fetchPublishedFiles({
      target, prefix: exportAll ? store.versionFolder(rec.store, v.key) : `published/${rec.dir}/${v.folderName}/`, uuid: rec.uuid, ver: v.ver, files: v.files, names: v.names,
      state, onSignedOut: markSignedOut, fetchPublished, collect: wanted(rec.uuid, v.ver),
      zip: exportAll && wanted(rec.uuid, v.ver) ? { date: rec.store.meta.updatedAt, whole: true } : null,
    });
    // A 401 that cut this fetch short (not part of artifact.json): later chats blame it, not their own cause.
    if (!outBefore && state.publishedSignedOut) Object.defineProperty(v, 'signedOutGap', { value: true, configurable: true });
    // Export All: a version the store points at a chat's file for (sameAs) stays as it was when no copy was saved.
    const keptSame = exportAll && !got.saved && !!v.sameAs;
    if (!keptSame) {
      if (wanted(rec.uuid, v.ver)) keepPreview(v, artifactPayload(got));
      v.saved = got.saved;
      if (exportAll) {
        v.folder = got.saved ? v.folderName : null;
        // A copy saved: the version no longer points at a chat's file.
        if (got.saved) delete v.sameAs;
        if (got.zipped) v.zip = `${v.folderName}.zip`; else delete v.zip;
      }
      markUnverified(v.files, got.unverified);
      v.missing = got.missing;
      v.incomplete = got.incomplete;
      v.start = got.start;
      v.startSaved = got.startSaved;
      v.needsRuntime = got.needsRuntime;
      v.text = got.startText !== null && got.startText.length <= limit ? got.startText : null;
    }
    if (got.problems.length) {
      noted.add(rec.uuid);
      warn(rec.title || rec.dir, `Published page "${rec.title || rec.dir}" (${v.ver}): ${got.problems.length} file${got.problems.length === 1 ? '' : 's'} could not be saved: ${got.problems.join(', ')}.`, openNote(rec));
    }
  };

  // Export All: a version this chat wrote the same (matched: path -> { name, text }) that the store has no copy of.
  // One file: the store points at this chat's file (sameAs), unless another chat's already is. Several: the chat's
  // texts are copied into its version folder; claude.ai's checksums matched them, so nothing is fetched.
  const keepSame = async (rec, v, matched) => {
    if (v.saved) return;
    if (v.files.length === 1) {
      const f = v.files[0];
      const own = matched.get(f.path);
      if (!v.sameAs && own && ctx.chatFolder) {
        v.sameAs = { [f.path]: `${ctx.chatFolder}/artefacts/${own.name}` };
        // An earlier chat's fetch of it failed: the version is now this chat's file, whole, not what that fetch left.
        if (v.attempted) {
          const ownText = typeof own.text === 'string' ? own.text : null;
          Object.assign(v, { start: f.path, startSaved: v.names ? v.names.get(f.path) || null : null, missing: [], incomplete: false,
            needsRuntime: publishedNeedsRuntime(ownText), text: ownText !== null && ownText.length <= limit ? ownText : null });
        }
      }
      if (!v.preview && wanted(rec.uuid, v.ver) && own && typeof own.text === 'string') {
        keepPreview(v, previewKind(f.path) === 'text' && own.text.length <= PREVIEW_ITEM_MAX ? { texts: [[f.path, own.text]], images: [] } : null);
      }
      return;
    }
    const at = store.versionFolder(rec.store, v.key);
    for (const f of v.files) target.file(`${at}${v.names.get(f.path)}`, matched.get(f.path).text);
    Object.assign(v, { saved: true, attempted: true, folder: v.folderName, missing: [], incomplete: false });
    if (wanted(rec.uuid, v.ver) && await writeVersionZip(target, at, v.files.map((f) => [v.names.get(f.path), matched.get(f.path).text]), rec.store.meta.updatedAt)) {
      v.zip = `${v.folderName}.zip`;
    }
    const startText = v.start && matched.has(v.start) ? matched.get(v.start).text : null;
    v.needsRuntime = publishedNeedsRuntime(startText);
    v.text = typeof startText === 'string' && startText.length <= limit ? startText : null;
    if (wanted(rec.uuid, v.ver)) {
      const texts = v.files.filter((f) => previewKind(f.path) === 'text').map((f) => [f.path, matched.get(f.path).text]);
      const ordered = [...texts.filter((t) => t[0] === v.start), ...texts.filter((t) => t[0] !== v.start)];
      keepPreview(v, ordered.length ? { texts: ordered, images: [] } : null);
    }
  };

  const entries = [];
  const warned = new Set();
  for (const [uuid, group] of byUuid) {
    const rec = pageRecord(group[0]);
    // This chat's versions of the page. A publish that named no version joins the version it resolves to
    // when this chat published that one by name.
    const mine = new Map();
    for (const p of [...group.filter((g) => !g.current), ...group.filter((g) => g.current)]) {
      const info = await getInfo(rec, p.ver);
      const key = p.current ? (!info.error && (mine.has(info.ver) || rec.versions.has(info.ver)) ? info.ver : '') : p.ver;
      if (!mine.has(key)) mine.set(key, { key, info, publishes: [], sources: p.sources });
      mine.get(key).publishes.push(...p.publishes);
    }

    const versions = [];
    for (const m of mine.values()) {
      const { info } = m;
      if (info.error) {
        if (exportAll) rec.store.incomplete = true;
        if (info.skipped) noteSkipped();
        noted.add(rec.uuid);
        if (!info.skipped && !warned.has(`${uuid} ${info.error}`)) {
          warned.add(`${uuid} ${info.error}`);
          warn(rec.title || rec.dir, `Published page "${rec.title || rec.dir}"${m.key ? ` (${m.key})` : ''} could not be fetched: ${info.error}.`, openNote(rec));
        }
        versions.push({
          ver: m.key, folderName: m.key ? publishedSegment(m.key) : 'current', ...publishedLabel(rec, { key: m.key, ver: m.key }), start: null, startSaved: null,
          same: false, writtenAs: null, incomplete: true, needsRuntime: false, text: null, publishes: m.publishes.slice(),
        });
        continue;
      }
      // In Export All a publish that named no version is kept as the version it is (no version stored twice).
      const v = folderFor(rec, exportAll ? m.key || info.ver : m.key);
      if (!v.ver) {
        v.ver = info.ver;
        const { names, renames } = publishedSavedNames(info.files.map((f) => f.path));
        v.files = info.files.map((f) => ({ path: f.path, savedAs: names.get(f.path), size: f.size, contentType: f.contentType, sha256: f.sha256 }));
        v.names = names;
        const start = publishedStart(v.files);
        v.start = start ? start.path : null;
        v.startSaved = start ? names.get(start.path) : null;
        if (renames.length || info.rejected.length) {
          const parts = [];
          if (renames.length) parts.push(`saved ${renames.join(', ')}`);
          if (info.rejected.length) parts.push(`not fetched, unsafe: ${info.rejected.join(', ')}`);
          noted.add(rec.uuid);
          warn(rec.title || rec.dir, `Published page "${rec.title || rec.dir}" (${v.ver}): file names changed to stay inside its folder: ${parts.join('; ')}.`, openNote(rec));
        }
      }
      const matched = await judge(v.files, m.publishes, m.sources);
      const same = !!matched;
      if (same && exportAll) await keepSame(rec, v, matched);
      if (!same && !v.attempted && !state.publishedSignedOut) await fetchVersion(rec, v);
      // A version the store points at a chat's file for (sameAs) stays complete when this chat's fetch fails.
      if (!same && !v.saved && !v.sameAs) v.incomplete = true;
      const startFile = publishedStart(v.files);
      const own = same && startFile ? matched.get(startFile.path) : null;
      for (const pub of m.publishes) {
        v.publishedIn.push({ chat: data.uuid, messageUuid: pub.messageUuid, toolUseId: pub.toolUseId, same, writtenAs: own ? own.name : null });
      }
      if (same && !v.saved && !v.attempted) v.needsRuntime = v.needsRuntime || publishedNeedsRuntime(own && own.text);
      const usable = same || v.saved;
      versions.push({
        // Its label: current for a publish that named no version, else by its place in the page's history.
        ver: v.ver, folderName: v.folderName, ...(m.key === '' ? { label: 'current', order: rec.history.length + 1 } : publishedLabel(rec, v)),
        start: same ? (startFile ? startFile.path : null) : (usable ? v.start : null),
        startSaved: same ? (startFile ? v.names.get(startFile.path) : null) : (usable ? v.startSaved : null),
        same, writtenAs: own ? own.name : null,
        incomplete: same ? false : (usable ? v.incomplete : true),
        needsRuntime: same ? publishedNeedsRuntime(own && own.text) : v.needsRuntime,
        text: same ? (own && own.text.length <= limit ? own.text : null) : (usable ? v.text : null),
        publishes: m.publishes.slice(),
      });
      // Left incomplete by the 401 (cut short by it, or never fetched after it): say why (retry below). A version
      // that failed for its own reason before the 401 keeps that reason, warned in the chat that fetched it.
      if (state.publishedSignedOut && versions[versions.length - 1].incomplete
        && (v.signedOutGap === true || (!same && !v.attempted && !v.saved && !v.sameAs))) { noteSkipped(); noted.add(rec.uuid); }
    }
    versions.sort((a, b) => a.order - b.order);
    const entry = { uuid: rec.uuid, shortId: rec.shortId, title: rec.title, url: rec.url, current: group.some((p) => p.current), dir: dirOf(rec), versions };
    if (exportAll) storeDirs.add(`${store.prefix}${rec.store.dir}`);
    // Whether this chat's errors.txt has something about the page; not part of the entry's data.
    Object.defineProperty(entry, 'noted', { value: noted.has(rec.uuid) });
    entries.push(entry);
  }

  if (!exportAll) {
    for (const rec of pages.values()) {
      if ([...rec.versions.values()].some((v) => v.ver)) target.file(`published/${rec.dir}/published.json`, JSON.stringify(publishedJson(rec), null, 2));
    }
  }
  // Versions left unsaved because claude.ai answered 401 (here or in an earlier chat): the chat must be exported
  // again, so Export All leaves it out of its record (retry); noteSkipped told a later chat why.
  const retry = !!state.publishedSignedOut && entries.some((e) => e.versions.some((v) => v.incomplete));
  Object.defineProperty(entries, 'retry', { value: retry });
  Object.defineProperty(entries, 'storeDirs', { value: [...storeDirs] });
  return entries;
}

// Where a publish's saved copy is, relative to the chat folder, by tool_use id: the written artefact when the
// version is the same, else the start file under published/. Versions with nothing to open are left out.
function publishedLinks(entries) {
  const links = {};
  for (const e of entries || []) {
    for (const v of e.versions) {
      const href = v.same && v.writtenAs ? `artefacts/${encodePath(v.writtenAs)}`
        : v.startSaved ? `${encodePath(e.dir)}/${encodePath(v.folderName)}/${encodePath(v.startSaved)}` : null;
      if (href) for (const p of v.publishes) links[p.toolUseId] = href;
    }
  }
  return links;
}

// README.md's "Published pages" section.
function publishedReadmeLines(entries) {
  if (!entries || !entries.length) return [];
  const lines = ['', '---', '', `## Published pages (${entries.length})`, ''];
  for (const e of entries) {
    const name = escapeMarkdown(e.title || 'Page');
    lines.push(e.url ? `- **${name}** - [claude.ai](${mdUrl(e.url)})` : `- **${name}**`);
    for (const v of e.versions) {
      if (v.same && v.writtenAs) lines.push(`  - ${v.label}: same as [${escapeMarkdown(v.writtenAs)}](artefacts/${encodePath(v.writtenAs)})`);
      else if (v.startSaved) lines.push(`  - ${v.label}: [${escapeMarkdown(v.startSaved)}](${encodePath(e.dir)}/${encodePath(v.folderName)}/${encodePath(v.startSaved)})${v.incomplete ? ' *(incomplete, see errors.txt)*' : ''}`);
      else lines.push(`  - ${v.label}: not saved${e.noted ? ' (see errors.txt)' : ''}`);
    }
  }
  return lines;
}

// The tab content.js answers in, for savePublishedPages: injected once if needed, then messaged directly.
function tabPublishedFetcher(tabId) {
  if (tabId == null) return null;
  let first = true;
  return async (message) => {
    const send = first ? sendToTab : sendOnce;
    first = false;
    return (await send(tabId, message)) || {};
  };
}

// The page a publish_files or Artifact call put on claude.ai, as a quoted link, with a link to the export's copy when
// links (publishedLinks) has one for this call; [] when there is neither.
function publishedLines(block, links = null, up = '') {
  const reply = publishedReply(block && block.name, block) || {};
  const local = links && block && Object.prototype.hasOwnProperty.call(links, block.tool_use_id) ? `${up}${links[block.tool_use_id]}` : null;
  if (!reply.url) return local ? [`> **Published page:** [saved copy](${local})`, ''] : [];
  return [`> **Published on claude.ai:** [${mdLinkText(reply.title || reply.url)}](${mdUrl(reply.url)})${local ? ` · [saved copy](${local})` : ''}`, ''];
}

function convertToMarkdown(data, options = {}) {
  const { embedArtifacts = false, seamlessMd = false, includeThinking = true,
    attachmentFiles = null, uploadNames = null, presentedNames = {}, webImages = {}, toolImages = {}, publishedLinks: pageLinks = null } = options;
  const lines = [];
  const title = data.name || 'Claude Conversation';

  // Extract artifacts for embedding or reference. In a ZIP these include the
  // presented and delivered files that were downloaded.
  const inZip = !!options.artifacts;
  const artifactIndex = options.artifactIndex || {};
  const artifacts = options.artifacts || extractArtifacts(data, null, artifactIndex);
  // Tool results by call id, so a Claude Docs call can be matched to the document it made.
  const resultsById = new Map();
  for (const m of (data.chat_messages || [])) {
    for (const b of (m.content || [])) if (b && b.type === 'tool_result' && b.tool_use_id) resultsById.set(b.tool_use_id, b);
  }
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

          } else if (toolName === 'view' || toolName === 'read_file' || toolName === 'Read') {
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

          } else if (isWidgetTool(toolName)) {
            // A diagram claude.ai drew in the chat. A ZIP saves it in artefacts/ (extractArtifacts).
            const file = widgetFile(input);
            const name = inZip ? widgetFileName(input, block, msg, artifactIndex) : null;
            if (file && name) {
              lines.push(...widgetLines(input, name));
            } else if (file && embedArtifacts) {
              const fence = getCodeFence(input.widget_code);
              lines.push(`\n**Diagram: ${mdLinkText(input.title || 'Diagram')}**\n`, `${fence}${file.name.endsWith('.svg') ? 'svg' : 'html'}`, input.widget_code, fence, '');
            } else {
              lines.push('```plaintext', `Diagram: ${input.title || 'untitled'} (drawn in the chat on claude.ai)`, '```', '');
            }

          } else if (isDisplayTool(toolName)) {
            // Product cards, a comparison or questions, as claude.ai shows them; their results are left out.
            lines.push(...displayLines(toolName, input, resultsById.get(block.id), webImages));

          } else if (isGuidanceTool(toolName)) {
            // Instructions a tool gives Claude; its result is left out.
            lines.push('```plaintext', `Loading tool guidance: ${toolName}`, '```', '');

          } else if (isImageSearchTool(toolName)) {
            lines.push('```plaintext', `Image search: ${input.query || ''}`, '```', '');

          } else if (isPublishTool(toolName) || isArtifactPublish(toolName, input)) {
            const sent = isPublishTool(toolName)
              ? (Array.isArray(input.files) ? input.files : []).map((f) => (f && f.path ? f.path.split('/').pop() : '')).filter(Boolean)
              : [input.file_path.split('/').pop()];
            lines.push('```plaintext', `Publishing on claude.ai: ${input.title || 'page'}${sent.length ? ` (${sent.join(', ')})` : ''}`, '```', '');

          } else if (claudeDocsAction(toolName)) {
            // Claude Docs: the document itself, not its tool calls.
            const action = claudeDocsAction(toolName);
            const made = action === 'batch' ? claudeDocCreated(input, resultsById.get(block.id), block.id) : null;
            if (made) {
              const title = made.title;
              const entry = artifactIndex[made.key];
              const filename = entry ? entry.filename : `${safeFileTitle(title) || 'Document'}.md`;
              // A ZIP has the file; a single Markdown file links the live document instead.
              const where = inZip ? `[artefacts/${filename}](artefacts/${encodeURIComponent(filename)})` : (made.url ? `<${made.url}>` : 'on claude.ai');
              lines.push(`\n**Document: ${title}** (Claude Docs; ${where})\n`);
              const content = artifacts[filename];
              if (embedArtifacts && typeof content === 'string') {
                if (seamlessMd) {
                  // A diagram's screenshot is linked from artefacts/ (docDiagramPictures); this file is a folder up.
                  lines.push('\n---\n', content.replace(/\]\(\.\.\/images\//g, '](images/'), '\n---\n');
                } else {
                  const fence = getCodeFence(content);
                  lines.push(`${fence}markdown`, content, fence, '');
                }
              }
            } else if (action === 'create') {
              const payload = (() => { try { return typeof input.payload === 'string' ? JSON.parse(input.payload) : input.payload; } catch (e) { return null; } })();
              const body = payload && payload.value && payload.value.body;
              // Every line quoted, so a comment of several paragraphs stays one quote.
              if (body) lines.push(String(body).split('\n').map((line, i) => (i === 0 ? `> **Comment on the document:** ${line}` : line ? `> ${line}` : '>')).join('\n'), '');
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

          if (claudeDocsAction(toolName)) {
            // Claude Docs results are acknowledgements for Claude, not part of the conversation.
          } else if (isWidgetTool(toolName) || isGuidanceTool(toolName) || isDisplayTool(toolName)) {
            // A diagram's acknowledgement, or a tool's instructions for Claude: nothing for the reader.
          } else if (toolImageLines(block, toolImages).length) {
            // Pictures Claude looked at, saved in images/, instead of their claude.ai links.
            lines.push(...toolImageLines(block, toolImages));
          } else if (isImageSearchTool(toolName) && imagesOf(block).length) {
            lines.push(...imageSearchLines(block, webImages));
          } else if ((isPublishTool(toolName) || isArtifactTool(toolName)) && publishedLines(block, pageLinks).length) {
            lines.push(...publishedLines(block, pageLinks));
          } else if (toolName === 'web_search' && Array.isArray(block.content)) {
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

// The This chat card. state, when there is no chat to export: 'nochat' (on claude.ai, no chat in the URL),
// 'offsite' (not on claude.ai), 'loading', or 'failed' (detail: what went wrong, shown in the card's result line).
// preserveStatus leaves the result line and its tone alone, so a refresh that was deferred until an export
// finished doesn't overwrite that export's result.
const CHAT_CARD_TEXT = {
  ready: 'Ready to export',
  nochat: 'Open a chat to export it',
  offsite: 'Open claude.ai to export.',
  loading: 'Loading this chat…',
  failed: "Couldn't load this chat",
};
const CHAT_BUTTONS = ['exportZip', 'exportMd', 'exportMdEmbed', 'exportJson'];
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

function updateUI(data, org, { preserveStatus = false, state = null, detail = '' } = {}) {
  const $ = (id) => document.getElementById(id);
  if (org) {
    orgId = org;
  }
  const ready = !!(data && data.chat_messages);
  // Without a chat, drop the old conversation so nothing can export it by mistake.
  conversationData = ready ? data : null;
  const which = ready ? 'ready' : (state && CHAT_CARD_TEXT[state] ? state : (org ? 'nochat' : 'offsite'));
  const card = $('chatCard');
  const title = $('chatTitle');
  const meta = $('chatMeta');
  $('chatState').textContent = CHAT_CARD_TEXT[which];
  if (ready) {
    const name = data.name || 'Untitled';
    title.textContent = name;
    title.title = name;
    // "Files" are what extractArtifacts finds in the chat; "artifacts" stays the word for claude.ai's artifacts.
    meta.textContent = `${getModelName(data)} · ${plural(getMessageChain(data).length, 'message')} · ${plural(Object.keys(extractArtifacts(data)).length, 'file')}`;
  } else {
    title.textContent = '';
    title.title = '';
    meta.textContent = '';
  }
  title.hidden = !ready;
  meta.hidden = !ready;
  $('chatRetry').hidden = which !== 'failed';
  for (const id of CHAT_BUTTONS) $(id).disabled = !ready || exportRunning;
  const status = $('status');
  if (!preserveStatus) {
    status.textContent = which === 'failed' ? detail : '';
    status.title = '';
    card.dataset.tone = ready ? 'ready' : 'idle';
  } else if (!ready) {
    card.dataset.tone = 'idle';
  } else if (card.dataset.tone !== 'warn' && card.dataset.tone !== 'error') {
    card.dataset.tone = 'ready';
  }
  panel.onClaude = which !== 'offsite';
  loadEverything();
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
}

// Runs once an export has ended: a tab change that came in meanwhile is followed now.
// The export buttons come back as the choices and the loaded chat now stand, not as they were at the click.
function finishRun() {
  if (typeof document !== 'undefined') {
    for (const id of CHAT_BUTTONS) document.getElementById(id).disabled = !conversationData || exportRunning;
    renderEverything();
  }
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
// Only a tab still on claude.ai gets content.js: a tab that moved to another site (where the optional https
// permission would let the injection through) answers as unreachable.
async function sendToTab(tabId, message) {
  const response = await sendOnce(tabId, message);
  if (!response.connectionError) return response;

  if (chrome.tabs && typeof chrome.tabs.get === 'function') {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { tab = null; }
    if (!tab || !/^https:\/\/claude\.ai\//.test(String(tab.url || ''))) return { connectionError: 'not a claude.ai tab' };
  }
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
// The tab the popup or panel was opened over, so the popup can open the side panel on it.
let currentTabId = null;

async function requestData({ preserveStatus = false } = {}) {
  // Off the main screen (Done, Export stopped, Settings) nothing is repainted; going back asks again.
  if (currentScreen !== 'main') {
    refreshSkipped = true;
    return;
  }
  refreshSkipped = false;
  const refreshId = ++latestRefreshId;
  const isStale = () => refreshId !== latestRefreshId;
  const show = (data, org, state = null, detail = '') => updateUI(data, org, { preserveStatus, state, detail });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab ? tab.id : null;
    if (isStale()) return;

    // tab.url is undefined for sites outside the extension's host permissions.
    const url = tab?.url || '';
    if (!url.includes('claude.ai')) {
      show(null, null, 'offsite');
      return;
    }

    const response = await sendToTab(tab.id, { action: 'getOrgId' });
    if (isStale()) return;

    if (response.connectionError) {
      console.log('Error:', response.connectionError);
      show(null, null, 'failed', `Can't reach this tab: ${response.connectionError}`);
      return;
    }

    const org = response.orgId;
    const chatId = getChatIdFromUrl(url);

    if (!chatId) {
      show(null, org);
      return;
    }

    // Export stays disabled until a different chat has loaded.
    if (conversationData?.uuid !== chatId) {
      show(null, org, 'loading');
    }

    const result = await sendToTab(tab.id, { action: 'fetchConversation', conversationId: chatId, orgId: org });
    if (isStale()) return;

    if (result.data?.chat_messages) {
      show(result.data, org);
    } else {
      show(null, org, 'failed', `Could not load this conversation: ${result.error || result.connectionError || 'no data returned'}`);
    }
  } catch (e) {
    console.error(e);
    if (!isStale()) {
      show(null, null, 'failed', `Could not load this conversation: ${e.message}`);
    }
  }
}

// Fetch the selected chat for an export, so it includes messages added since
// the panel last loaded it. Throws rather than exporting an older copy.
async function loadConversationForExport({ withTab = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const chatId = getChatIdFromUrl(tab?.url || '');
  if (!chatId) throw new Error('No conversation selected.');

  const result = await sendToTab(tab.id, { action: 'fetchConversation', conversationId: chatId, orgId });
  if (!result.data?.chat_messages) {
    throw new Error(`Could not load the latest copy: ${result.error || result.connectionError || 'no data returned'}`);
  }

  latestRefreshId++;
  updateUI(result.data, orgId, { preserveStatus: true });
  return withTab ? { data: result.data, tabId: tab.id } : result.data;
}

// Coalesce bursts of tab events. While an export runs (exportRunning), wait for it to finish rather than change chats underneath it.
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (exportRunning) {
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

// ---- Incremental export ----
// chrome.storage.local.exportRecord: { <org id>: { at, chats: { <chat uuid>: updated_at as the chat list gave it },
// artifacts: { <artifact uuid>: its live version as claude.ai listed it } } }, written after each mega-ZIP for the
// chats and artifacts it holds. "Export changes" takes the listed chats whose updated_at differs from the record,
// or that it doesn't have, and the listed artifacts whose version differs (changedArtifacts). Every mega-ZIP also carries
// export-manifest.json, so the archive says what it holds without the browser.
const EXPORT_RECORD_KEY = 'exportRecord';

function changedSince(conversations, recorded) {
  const known = recorded && typeof recorded === 'object' ? recorded : {};
  return (conversations || []).filter((c) => c && (!Object.prototype.hasOwnProperty.call(known, c.uuid) || known[c.uuid] !== c.updated_at));
}

// The live version an artifact was listed with, as the record keeps it. One found only by paging has no listed
// version: its update time stands in ('paged:<updatedAt>'), or '' when it has none (then it is not recorded).
const listedArtifactVer = (a) => {
  if (a && a.paged === true) return typeof a.updatedAt === 'string' && a.updatedAt ? `paged:${a.updatedAt}` : '';
  return a && typeof a.live === 'string' ? a.live : '';
};

// Artifacts (artifactsFromList) new or with another version since the record; all of them with no record.
// versions: the record's artifactVersions (v1.21). A record without it (from before v1.21) says nothing about older
// versions, so every artifact with a live version is included once to fetch them; with it, one whose live version
// isn't among its recorded versions is included too.
function changedArtifacts(list, recorded, versions) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!recorded || typeof recorded !== 'object') return items;
  const known = versions && typeof versions === 'object' && !Array.isArray(versions) ? versions : null;
  return items.filter((a) => {
    const uuid = String(a.slug).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(recorded, uuid) || recorded[uuid] !== listedArtifactVer(a)) return true;
    if (a.paged === true || typeof a.live !== 'string' || !a.live) return false;
    return !known || !(Array.isArray(known[uuid]) && known[uuid].includes(a.live));
  });
}

async function loadExportRecord(org) {
  try {
    const stored = await chrome.storage.local.get([EXPORT_RECORD_KEY]);
    const all = stored && stored[EXPORT_RECORD_KEY];
    const mine = all && typeof all === 'object' ? all[org] : null;
    return mine && typeof mine === 'object' && mine.chats && typeof mine.chats === 'object' ? mine : null;
  } catch (e) {
    return null;
  }
}

// Adds the exported chats and artifacts ([{ uuid, ver }]) to the record; those not in this export keep what they had.
// What Export All may record as exported: not a chat that must be fetched again (retry: published pages skipped
// after a 401), nor a chat or artifact with a file that could not be written to the folder (writeFailures from
// the folder writer, paths from the export root; a chat's stores are the artifacts-store folders its published
// pages went into). Otherwise Export Changes would skip them for good.
function recordableExport(chats, artifacts, writeFailures = [], versions = []) {
  const failed = (Array.isArray(writeFailures) ? writeFailures : []).map((f) => String(f && f.path || ''));
  const hit = (folder) => typeof folder === 'string' && folder !== '' && failed.some((p) => p.startsWith(`${folder}/`));
  return {
    chats: (chats || []).filter((c) => c && c.retry !== true && !hit(c.folder) && !(Array.isArray(c.stores) && c.stores.some(hit))),
    artifacts: (artifacts || []).filter((a) => a && !hit(a.folder)),
    // { uuid, folder, versions }: an artifact's saved versions, left out with a write failure under its folder.
    versions: (versions || []).filter((a) => a && !hit(a.folder)),
  };
}

// ============================================================================
// Run results: what Export All and Export Artifacts resolve to, for the Done / Export stopped screens
// ============================================================================
// { outcome: 'done' | 'stopped' | 'failed', reason ('' when done), target: { kind: 'folder' | 'zip', name },
//   saved: { chats, artifacts, versions }, warnings, warningList: [{ type, text, chat? }], errorFiles, startedAt, endedAt }.
// warnings is warningList.length: every chat collector's warnings and errors, chats that failed outright, files that
// could not be written, the artifacts collector's warnings and errors, and viewer.html when it could not be built.

// One line of a warning for the panel: the first line, with links and tokens left out, at most 300 characters.
function runWarningText(text) {
  const line = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const clean = line
    .replace(/\b(?:https?|wss?|file|blob|data|chrome-extension):[^\s)"'<>]*/gi, '[link]')
    .replace(/__frame_t=[^\s&)"'<>]*/gi, '[token]')
    .replace(/\s+/g, ' ');
  return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}

// A collector's errors and warnings as warningList entries; chat names the chat they belong to, if any.
function collectorRunWarnings(collector, chat = '') {
  if (!collector) return [];
  return [...(collector.errors || []), ...(collector.warnings || [])].map((w) => ({
    type: String(w && w.type || 'unknown'),
    text: runWarningText(w && w.error),
    ...(chat ? { chat: String(chat) } : {}),
  }));
}

// notes: plain sentences beyond the counts ("Nothing changed since …"), shown on the Done screen.
function runResult({ outcome = 'done', reason = '', target = null, saved = null, warningList = [], errorFiles = [], notes = [], fileNotes = 0, startedAt = null } = {}) {
  const list = Array.isArray(warningList) ? warningList : [];
  return {
    outcome,
    reason: outcome === 'done' ? '' : String(reason || ''),
    target: { kind: target && target.kind === 'folder' ? 'folder' : 'zip', name: String(target && target.name || '') },
    saved: { chats: 0, artifacts: 0, versions: 0, ...(saved || {}) },
    warnings: list.length,
    warningList: list,
    errorFiles: [...new Set(errorFiles)],
    notes: (Array.isArray(notes) ? notes : []).map(String),
    fileNotes: Number(fileNotes) || 0,
    startedAt: startedAt || new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
}

// warnings: the run's warning count (runResult), kept on the entry for the panel's footer.
async function saveExportRecord(org, at, exportedChats, exportedArtifacts = [], exportedVersions = [], warnings = null) {
  try {
    const stored = await chrome.storage.local.get([EXPORT_RECORD_KEY]);
    const all = stored && stored[EXPORT_RECORD_KEY] && typeof stored[EXPORT_RECORD_KEY] === 'object' ? stored[EXPORT_RECORD_KEY] : {};
    const mine = all[org] && typeof all[org] === 'object' ? all[org] : {};
    const chats = { ...(mine.chats && typeof mine.chats === 'object' ? mine.chats : {}) };
    for (const c of exportedChats) chats[c.uuid] = c.updated_at;
    const hadArtifacts = mine.artifacts && typeof mine.artifacts === 'object';
    const artifacts = { ...(hadArtifacts ? mine.artifacts : {}) };
    for (const a of exportedArtifacts || []) artifacts[a.uuid] = a.ver;
    // artifactVersions (v1.21): per artifact, every version an export saved whole or found gone; joined with the old.
    const hadVersions = mine.artifactVersions && typeof mine.artifactVersions === 'object' && !Array.isArray(mine.artifactVersions);
    const artifactVersions = { ...(hadVersions ? mine.artifactVersions : {}) };
    for (const a of exportedVersions || []) {
      const old = Array.isArray(artifactVersions[a.uuid]) ? artifactVersions[a.uuid] : [];
      artifactVersions[a.uuid] = [...new Set([...old, ...a.versions])];
    }
    const withArtifacts = hadArtifacts || (exportedArtifacts && exportedArtifacts.length);
    const withVersions = hadVersions || (exportedVersions && exportedVersions.length);
    const entry = { at, chats, ...(withArtifacts ? { artifacts } : {}), ...(withVersions ? { artifactVersions } : {}),
      ...(Number.isFinite(warnings) && warnings >= 0 ? { warnings } : {}) };
    await chrome.storage.local.set({ [EXPORT_RECORD_KEY]: { ...all, [org]: entry } });
  } catch (e) {
    console.warn('Could not save the export record:', e);
  }
}

// claude-takeout-[<display name>-][changes-]<date>.zip. The name keeps letters and digits from any
// script; anything else becomes _, and it is left out when claude.ai didn't give one.
// ============================================================================
// Export All into a folder: the JSZip calls the export makes, written to disk
// ============================================================================

// A folder chosen with showDirectoryPicker, taking the calls the export makes on a JSZip folder:
// file(path, content, { base64 }) and folder(name). Writes run in the background, in order per path
// (a later write of a path wins, as in a ZIP); flush() waits for them and returns the paths that
// failed, with why, since the last flush. A failed file never stops the rest.
function createDiskFolder(root) {
  const shared = { dirs: new Map(), chains: new Map(), pending: new Set(), failed: [] };
  shared.dirs.set('', Promise.resolve(root));
  const dirFor = (parts) => {
    const key = parts.join('/');
    if (!shared.dirs.has(key)) {
      shared.dirs.set(key, dirFor(parts.slice(0, -1)).then((parent) => parent.getDirectoryHandle(parts[parts.length - 1], { create: true })));
    }
    return shared.dirs.get(key);
  };
  const bytes = (content, options) => {
    if (options && options.base64) return Uint8Array.from(atob(String(content)), (c) => c.charCodeAt(0));
    return content;
  };
  const write = async (path, content, options) => {
    const parts = path.split('/').filter(Boolean);
    const dir = await dirFor(parts.slice(0, -1));
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    // createWritable writes a temporary file, so a failure leaves nothing half written.
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes(content, options));
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  };
  const view = (prefix) => ({
    file(path, content, options) {
      const full = [prefix, path].filter(Boolean).join('/');
      const job = (shared.chains.get(full) || Promise.resolve())
        .then(() => write(full, content, options))
        .catch((err) => { shared.failed.push({ path: full, error: (err && err.message) || String(err) }); });
      shared.chains.set(full, job);
      shared.pending.add(job);
      job.then(() => shared.pending.delete(job));
      return this;
    },
    folder(name) { return view([prefix, name].filter(Boolean).join('/')); },
    async flush() {
      while (shared.pending.size) await Promise.all([...shared.pending]);
      shared.chains.clear();
      return shared.failed.splice(0);
    },
  });
  return view('');
}

// A new folder inside the picked one for this export, named like the ZIP would be, never an existing one.
async function makeRunFolder(directory, zipName) {
  const base = zipName.replace(/\.zip$/, '');
  const taken = async (name) => {
    try { await directory.getDirectoryHandle(name); return true; } catch (e) { return false; }
  };
  let name = base;
  for (let n = 2; await taken(name); n++) name = `${base}_${n}`;
  return { name, handle: await directory.getDirectoryHandle(name, { create: true }) };
}

// The local date and time an export started, as 2026-11-15_2142, as Grok and Gemini Takeout name theirs.
function exportStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// claude-takeout-<display name>-[changes-]<stamp>.zip, all lowercase. The folder export uses it without .zip.
// Export Artifacts (kind 'artifacts') puts its kind first: claude-takeout-artifacts-<display name>-<stamp>.zip.
function megaZipName(accountName, kind, dateStr) {
  const name = typeof accountName === 'string'
    ? Array.from(accountName.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '_').replace(/^_+|_+$/g, '')).slice(0, 40).join('')
    : '';
  return `claude-takeout-${kind === 'artifacts' ? 'artifacts-' : ''}${name ? `${name}-` : ''}${kind === 'changes' ? 'changes-' : ''}${dateStr}.zip`;
}

// One progress event to options.onProgress, for the Exporting screen: { phase: 'chats' | 'artifacts' | 'viewer',
// done, total, sub (a chat or artifact title, or "<title> · version i of n"; frame URLs and tokens removed), warnings (so far)}.
// A listener that throws doesn't stop the export.
// Where the run goes, once known (the run folder made, or the ZIP's name), to options.onTarget({ kind, name }).
function exportTarget(options, kind, name) {
  if (!options || typeof options.onTarget !== 'function') return;
  try {
    options.onTarget({ kind, name: String(name || '') });
  } catch (e) { /* the screen keeps its placeholder */ }
}

function exportProgress(options, { phase, done, total, sub = '', warnings = 0 }) {
  const listener = options && typeof options.onProgress === 'function' ? options.onProgress : null;
  if (!listener) return;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  try {
    listener({ phase, done: n(done), total: n(total), sub: artifactText(String(sub || '')), warnings: n(warnings) });
  } catch (e) { /* the screen misses one update */ }
}

// Bulk export all conversations as a single mega-zip.
// options.changesOnly: only chats new or updated since the last mega-ZIP from this browser. Without it,
// the main screen's All / Changes only choice decides (settings.megaZipScope: 'all', the default, or 'changes').
// options.directory: a folder from showDirectoryPicker; the export goes into a new folder inside it
// instead of a ZIP download. options.withArtifacts: whether to save claude.ai's artifacts too (default: the
// Artifacts checkbox, settings.exportAllArtifacts). options.onProgress: progress events (exportProgress). options.signal:
// { stopped }, checked before each chat, artifact and older version; when set, the run ends as 'stopped' (stoppedRun).
// Resolves to a run result (runResult); never throws.
// Export All's warning when the claude.ai tab stopped answering (closed, or navigated off claude.ai).
const TAB_GONE_REASON = 'The claude.ai tab closed or stopped answering';

async function bulkExportZip(options = {}) {
  const changesOnly = options && typeof options.changesOnly === 'boolean' ? options.changesOnly : settings.megaZipScope === 'changes';
  const directory = options && options.directory ? options.directory : null;
  const runStartedAt = new Date().toISOString();
  const target = { kind: directory ? 'folder' : 'zip', name: '' };
  const saved = { chats: 0, artifacts: 0, versions: 0 };
  const warningList = [];
  const errorFiles = [];
  const notes = [];  // sentences the Done screen adds to its counts (runResult)
  let fileNotes = 0;  // the chats' README notes (draft and helper files), shown but never counted as warnings
  const result = (outcome, reason = '') => runResult({ outcome, reason, target, saved, warningList, errorFiles, notes, fileNotes, startedAt: runStartedAt });
  // The Exporting screen's events (exportProgress) and its Stop button (options.signal.stopped).
  const signal = options && options.signal && typeof options.signal === 'object' ? options.signal : null;
  const stopRequested = () => !!(signal && signal.stopped);
  // Warnings not yet in warningList: the artifact list's failure and the artifact step's, added at the end.
  let pendingWarnings = () => 0;
  const emit = (phase, done, total, sub) => exportProgress(options, { phase, done, total, sub, warnings: warningList.length + pendingWarnings() });
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { tab = null; }

  if (!(tab?.url || '').includes('claude.ai')) {
    return result('failed', 'Please navigate to claude.ai first');
  }

  // Get all conversations
  // Awaited to the end, so the export lock holds until every file is written.
  try {
  const response = await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { action: 'fetchAllConversations', withAccountName: true },
    (r) => resolve(chrome.runtime && chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)));
  return await (async () => {
    if (!response || response.error) {
      return result('failed', runWarningText((response && response.error) || 'Could not fetch the conversation list.'));
    }

    const listedChats = Array.isArray(response.data) ? response.data : [];
    const listedCount = listedChats.length;
    const org = response.orgId || orgId || '';
    const startedAt = new Date().toISOString();
    // Export changes: only what is new or updated since the record. With no record, everything.
    const record = changesOnly ? await loadExportRecord(org) : null;
    const since = record && record.at ? record.at : null;
    const conversations = since ? changedSince(listedChats, record.chats) : listedChats;
    const kind = since ? 'changes' : 'full';
    if (changesOnly && !since) notes.push('There is no earlier export from this browser, so every chat is exported.');
    // The first call injects content.js if the tab needs it; the rest message it directly.
    const fetchPublished = tabPublishedFetcher(tab.id);
    // claude.ai's artifacts, listed before the chats so a changes run knows whether any changed. A failed list
    // only leaves the artifacts out (listError: its code); the chats export as usual.
    const withArtifacts = options && typeof options.withArtifacts === 'boolean' ? options.withArtifacts : settings.exportAllArtifacts !== false;
    let artifactList = null;
    let listError = null;
    if (withArtifacts) {
      try {
        const reply = await fetchPublished({ action: 'listArtifacts' });
        if (!reply || reply.error || reply.connectionError || !Array.isArray(reply.frames)) {
          listError = !reply || reply.error || reply.connectionError ? publishedCode(reply) : 'bad response';
        } else {
          artifactList = artifactsFromList(reply);
        }
      } catch (e) {
        listError = 'unexpected error';
      }
    }
    // The artifact step's warnings go to artifacts/errors.txt.
    const artifactCollector = new ExportErrorCollector(null, null, { label: 'Export Artifacts' });
    pendingWarnings = () => (listError ? 1 : 0) + artifactCollector.warnings.length + artifactCollector.errors.length;
    const includedArtifacts = artifactList ? (since ? changedArtifacts(artifactList.artifacts, record.artifacts, record.artifactVersions) : artifactList.artifacts) : [];
    if (since && !conversations.length && !includedArtifacts.length) {
      notes.push(`Nothing changed since the last Export All, ${formatStamp(since)}.`);
      if (listError) warningList.push({ type: 'artifact_export', text: runWarningText(`Artifact list could not be loaded (${listError})`) });
      return result('done');
    }
    const total = conversations.length;

    const dateStr = exportStamp();
    let run = null;
    if (directory) {
      try {
        run = await makeRunFolder(directory, megaZipName(response.accountName, kind, dateStr));
      } catch (e) {
        return result('failed', runWarningText(`Could not make a folder there: ${e && e.message}`));
      }
      target.name = run.name;
    }
    exportTarget(options, target.kind, run ? run.name : megaZipName(response.accountName, kind, dateStr));

    // A ZIP, or a folder on disk taking the same calls.
    const megaZip = run ? createDiskFolder(run.handle) : new JSZip();
    const writeFailures = [];  // folder export: files that couldn't be written
    const indexEntries = [];
    let exported = 0;
    let errors = [];  // Conversation-level errors (failed to fetch/process entire conversation)
    let totalFileErrors = 0;  // File-level errors across all conversations
    let totalFileWarnings = 0;  // File-level warnings across all conversations
    let incomplete = 0;  // chats whose data looks incomplete (export_health)
    // `projects` holds the files chats share, and `artifacts` the pages they published and claude.ai's artifacts, so no
    // chat may take those names; `published` stays reserved, as it was the shared pages' folder before v1.18.
    const usedFolderNames = new Set(['projects', 'published', 'artifacts']);
    // One store for every page the chats publish and every artifact claude.ai lists: artifacts/<Title>_<id>/<ver>/.
    // A listed artifact is named from the list (listedArtifacts) from the first chat that publishes it. previewWanted:
    // only an included artifact's listed version keeps its preview in memory for the artifact step.
    const store = artifactStore(megaZip, { prefix: 'artifacts/' });
    const listedArtifacts = new Map((artifactList ? artifactList.artifacts : []).map((a) => [String(a.slug).toLowerCase(), a]));
    const sharedProjects = { root: megaZip, byUuid: new Map(), usedDirs: new Set(), store, listedArtifacts, previewWanted: publishedPreviewWanted(includedArtifacts) };
    // A Claude Docs artifact's uuid -> the chat in this export that rebuilt its text (the latest), for its artifact.json note.
    const docChats = new Map();
    const viewerChats = [];
    const exportedChats = [];  // { uuid, name, updated_at (as listed), folder, retry?, stores? }, for the manifest and the record (recordableExport)
    let step = null;
    const addWriteFailures = (list) => {
      for (const f of list) warningList.push({ type: 'write', text: runWarningText(`${f && f.path}: ${f && f.error}`) });
      if (list.length) errorFiles.push('write-errors.txt');
    };
    // Stop: what is on disk stays, with its artifact.json and error files; no index, manifest or viewer is written
    // and nothing is recorded, so the next Changes only export takes it all again. A ZIP is discarded.
    const stoppedRun = async () => {
      if (listError) warningList.push({ type: 'artifact_export', text: runWarningText(`Artifact list could not be loaded (${listError})`) });
      pendingWarnings = () => 0;
      warningList.push(...collectorRunWarnings(artifactCollector));
      if (run) {
        for (const rec of store.records()) {
          if (store.written(rec) || !rec.versions.size) continue;
          try { store.write(rec); } catch (e) { /* the chats' links and errors.txt still say what was saved */ }
        }
        if (artifactCollector.hasAny()) {
          megaZip.file('artifacts/errors.txt', artifactCollector.generateErrorReport());
          errorFiles.push('artifacts/errors.txt');
        }
        writeFailures.push(...await megaZip.flush());
        if (writeFailures.length) {
          megaZip.file('write-errors.txt', ['These files could not be written to the folder:', '', ...writeFailures.map((f) => `${f.path}: ${f.error}`), ''].join('\n'));
          await megaZip.flush();
        }
        addWriteFailures(writeFailures);
      } else {
        Object.assign(saved, { chats: 0, artifacts: 0, versions: 0 });
      }
      return result('stopped', 'You stopped it');
    };

    let tabGone = false;
    for (let ci = 0; ci < conversations.length; ci++) {
      const conv = conversations[ci];
      if (stopRequested()) break;
      emit('chats', exported + errors.length, total, conv.name || 'Untitled');
      try {
        // Fetch full conversation. sendToTab injects content.js again into a tab that lost it; a tab that still
        // doesn't answer is gone (closed, or moved off claude.ai): no more chats are asked for, the artifact step is
        // skipped, and the export ends with what it has, warned, so only the chats saved are recorded.
        const result = await sendToTab(tab.id, { action: 'fetchConversation', conversationId: conv.uuid });
        if (result.connectionError) { tabGone = true; break; }

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
        const folderResult = await populateConversationFolder(folder, data, null, orgId, sharedProjects, folderName, fetchPublished);
        if (folderResult.viewerChat) viewerChats.push(folderResult.viewerChat);
        try {
          const at = String(data.updated_at || '');
          for (const link of artifactLinksOf(data)) {
            if (link.how !== 'made' || (docChats.has(link.uuid) && docChats.get(link.uuid).at > at)) continue;
            docChats.set(link.uuid, { at, title: artifactText(data.name || '') || 'Untitled' });
          }
        } catch (e) { /* the note stays the general one */ }

        // Track file-level errors/warnings
        if (folderResult.errorCollector) {
          totalFileErrors += folderResult.errorCollector.errors?.length || 0;
          totalFileWarnings += folderResult.errorCollector.warnings?.length || 0;
          fileNotes += folderResult.errorCollector.notes?.length || 0;
          const chatWarnings = collectorRunWarnings(folderResult.errorCollector, data.name || conv.name || 'Untitled');
          warningList.push(...chatWarnings);
          if (chatWarnings.length) errorFiles.push('errors.txt');
        }
        if (folderResult.healthIssues) incomplete++;

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
        exportedChats.push({ uuid: conv.uuid, name: data.name || conv.name || '', updated_at: conv.updated_at || data.updated_at || null, folder: folderName,
          ...(folderResult.published && folderResult.published.retry ? { retry: true } : {}),
          ...(folderResult.published && folderResult.published.storeDirs && folderResult.published.storeDirs.length ? { stores: folderResult.published.storeDirs } : {}) });

        exported++;

      } catch (e) {
        errors.push(`${conv.name || conv.uuid}: ${e.message}`);
        warningList.push({ type: 'chat', text: runWarningText(e && e.message || 'unexpected error'), chat: String(conv.name || conv.uuid || '') });
      }
      // On disk, each chat is written before the next, which keeps memory down; the run result counts it now.
      if (run) {
        writeFailures.push(...await megaZip.flush());
        saved.chats = exported;
      }

      emit('chats', exported + errors.length, total, conv.name || 'Untitled');

      // Small delay to avoid overwhelming
      await new Promise(r => setTimeout(r, 200));
    }

    // claude.ai's artifacts into the store, after the chats: a version a chat saved is not fetched again. Card
    // pictures only when the optional permission is already there: Export All never asks. The step never throws,
    // and its warnings go to artifacts/errors.txt.
    if (stopRequested()) return await stoppedRun();
    if (tabGone) {
      const left = conversations.length - exported - errors.length;
      const text = `${TAB_GONE_REASON}: ${left} chat${left === 1 ? '' : 's'} not exported${includedArtifacts.length ? ', and no artifacts' : ''}`;
      errors.push(text);
      warningList.push({ type: 'chat', text: runWarningText(text) });
    }
    let picturesAllowed = false;
    let parts = null;
    if (includedArtifacts.length && !tabGone) {
      const count = includedArtifacts.length;
      emit('artifacts', 0, count, '');
      try { picturesAllowed = await webImagesAllowed(); } catch (e) { picturesAllowed = false; }
      try {
        parts = CTViewer.artifactViewParts({ partLimit: CTViewer.PART_LIMIT, budget: CTViewer.ARTIFACT_PARTS_BUDGET });
      } catch (e) { /* no previews; the export goes on */ }
      step = await runArtifactStep(megaZip, {
        store, artifacts: includedArtifacts, paging: artifactList.paging, listed: artifactList.listed, fetchPublished, picturesAllowed,
        // Export Changes: the versions an earlier Export All saved are not fetched again (a full export takes them all).
        skipVersions: since && record && record.artifactVersions && typeof record.artifactVersions === 'object'
          ? new Map(Object.entries(record.artifactVersions).filter(([, l]) => Array.isArray(l)).map(([uuid, l]) => [uuid, new Set(l.filter((x) => typeof x === 'string'))]))
          : null,
        docChats: new Map([...docChats].map(([uuid, d]) => [uuid, d.title])), parts, run: !!run,
        collector: artifactCollector, signal,
        onProgress: (done, n, info = {}) => {
          // On disk, each artifact is written as it is done: the run result counts it now.
          if (run && info.versions !== undefined) Object.assign(saved, { artifacts: info.saved, versions: info.versions });
          emit('artifacts', done, n, info.sub || '');
        },
      });
      writeFailures.push(...step.writeFailures);
    }
    if (stopRequested()) return await stoppedRun();
    emit('viewer', 0, 1, 'Viewer and index');
    // artifact.json of every other page the chats saved something of (the step wrote its own), and their index rows.
    const chatRows = [];
    for (const rec of store.records()) {
      if (store.written(rec) || !rec.versions.size) continue;
      try {
        store.write(rec);
        chatRows.push(storeRecordRow(rec));
      } catch (e) { /* the chats' links and errors.txt still say what was saved */ }
    }
    const artifactRows = [...(step ? step.rows : []), ...chatRows];
    const artifactWarnings = step ? step.collector.warnings.length + step.collector.errors.length : 0;
    const savedArtifacts = step ? step.views.filter((v) => !v.notExported).length : 0;
    // Recorded with the chats after the write: artifacts saved whole (one with a missing file is tried again next time).
    // One found only by paging is recorded by its update time; with none, it is left out and included next time too.
    const exportedArtifacts = step ? includedArtifacts
      .map((a, i) => ({ a, i }))
      .filter(({ a, i }) => step.whole[i] === true && !(a.paged === true && !listedArtifactVer(a)))
      .map(({ a, i }) => ({ uuid: String(a.slug).toLowerCase(), ver: listedArtifactVer(a), folder: `artifacts/${step.entries[i].folder}` })) : [];
    // Every included artifact's versions saved whole or settled now, whole or not (Export Changes skips them next time).
    const exportedVersions = step ? includedArtifacts
      .map((a, i) => ({ a, i }))
      .filter(({ i }) => step.entries[i] && Array.isArray(step.versionsSaved[i]))  // a step that stopped early has fewer
      .map(({ a, i }) => ({ uuid: String(a.slug).toLowerCase(), folder: `artifacts/${step.entries[i].folder}`, versions: step.versionsSaved[i] }))
      .filter((x) => x.versions.length) : [];

    // Create index.md at root
    const indexLines = [
      since ? `# Claude Takeout - Changes since ${formatTimestamp(since)}` : '# Claude Takeout - All Conversations',
      '',
      `**Exported:** ${formatTimestamp(new Date().toISOString())}`,
      `**Total Conversations:** ${exported}`,
    ];
    if (since) indexLines.push('This archive holds only the chats that are new or changed since that export. Keep it with the earlier archives.');

    // Add summary of file-level issues
    if (totalFileErrors > 0 || totalFileWarnings > 0) {
      const issueParts = [];
      if (totalFileErrors > 0) issueParts.push(`${totalFileErrors} file error${totalFileErrors > 1 ? 's' : ''}`);
      if (totalFileWarnings > 0) issueParts.push(`${totalFileWarnings} warning${totalFileWarnings > 1 ? 's' : ''}`);
      indexLines.push(`**Issues:** ${issueParts.join(', ')} (see errors.txt in affected folders)`);
    }
    if (incomplete) {
      indexLines.push(`**Looks incomplete:** ${incomplete} chat${incomplete === 1 ? '' : 's'}; claude.ai's data may have changed (see errors.txt in those folders)`);
    }
    // Chats listed against chats exported, so a list that came back short or a chat that failed shows.
    indexLines.push(`**Listed by claude.ai:** ${total}`);

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

    if (withArtifacts) {
      indexLines.push('', '## Artifacts', '');
      if (listError) {
        indexLines.push(`Artifacts: not exported (${listError})`);
      } else {
        if (since) indexLines.push(artifactsChangedLine(since, includedArtifacts.length, artifactList.listed), '');
        indexLines.push(`- Listed by claude.ai: ${artifactList.listed}`, `- Saved: ${step ? step.views.filter((v) => !v.notExported).length : 0}`);
        if (artifactWarnings) indexLines.push(`- Issues: ${artifactCount(artifactWarnings, 'warning')} (see artifacts/errors.txt)`);
      }
    } else if (artifactRows.length) {
      indexLines.push('', '## Artifacts', '');
    }
    if (artifactRows.length) {
      if (chatRows.length) indexLines.push(`- Published from chats only: ${chatRows.length}`);
      indexLines.push('- Index: [artifacts/index.md](artifacts/index.md)');
    }

    addFileWithBOM(megaZip, 'index.md', indexLines.join('\n'));
    // What this archive holds, readable without the browser that made it.
    megaZip.file('export-manifest.json', JSON.stringify({
      format: 1, exported_at: startedAt, kind, since, listed: listedCount,
      chats: exportedChats.map(({ uuid, name, updated_at, folder }) => ({ uuid, name, updated_at, folder })),
      ...(step ? { artifacts: { listed: artifactList.listed, thumbs: step.thumbs, items: step.entries } } : {}),
    }, null, 2));

    // The combined viewer also needs each artifact's current version (to tell it from older ones chats published)
    // and where claude.ai says it was made (its card's source line); views, entries and rows are one per artifact.
    const combinedViews = step ? step.views.map((v, i) => ({ ...v, ver: (step.entries[i] && step.entries[i].ver) || '', sourceSurface: (step.rows[i] && step.rows[i].sourceSurface) || '' })) : [];
    // records (every artifact.json written, with its folder) and listFetched (whether claude.ai's list is in this
    // export) are for the viewer's artifact screens (viewerStoreRecord).
    const storeRecords = store.records().filter((rec) => store.written(rec)).map((rec) => viewerStoreRecord(store, rec));
    const viewerOpts = step
      // Every part the artifact step numbered, even one an error kept from being counted in partCount.
      ? { artifacts: { views: combinedViews, listed: artifactList.listed, exported: startedAt, since, listFetched: true, records: storeRecords }, firstPart: (parts ? Number(parts.count) || 0 : 0) + 1 }
      : { artifacts: { views: [], listed: artifactList ? artifactList.listed : null, exported: startedAt, since, listFetched: !!artifactList, records: storeRecords } };
    // Chats or artifacts to show: an Export Changes run where only artifacts changed still gets a viewer.
    const viewerWanted = exported > 0 || !!(viewerOpts.artifacts && viewerOpts.artifacts.views.length);
    const viewerWritten = viewerWanted && await writeViewer(megaZip, viewerChats, viewerOpts);
    const viewerBuilt = !viewerWanted || viewerWritten;
    viewerChats.length = 0;  // viewer.html holds them now, and compressing needs the memory
    // The run result's counts and warnings, in the order the panel lists them: chats (above), artifacts, viewer.
    saved.chats = exported;
    saved.artifacts = savedArtifacts;
    saved.versions = step ? Number(step.versionCount) || 0 : 0;
    if (listError) warningList.push({ type: 'artifact_export', text: runWarningText(`Artifact list could not be loaded (${listError})`) });
    if (step) {
      warningList.push(...collectorRunWarnings(step.collector));
      if (step.collector.hasErrors() || step.collector.hasWarnings()) errorFiles.push('artifacts/errors.txt');
    }
    if (!viewerBuilt) warningList.push({ type: 'viewer', text: 'viewer.html could not be built.' });
    pendingWarnings = () => 0;

    if (artifactRows.length) {
      const indexOpts = {
        listed: artifactList ? artifactList.listed : null, exportedAt: startedAt, warnings: artifactWarnings, thumbs: step ? step.thumbs : 0, viewer: viewerWritten,
        thumbsNeedPermission: !picturesAllowed, base: 'artifacts/', since,
      };
      addFileWithBOM(megaZip, 'artifacts/index.md', artifactsIndexMd(artifactRows, indexOpts));
      megaZip.file('artifacts/index.html', artifactsIndexHtml(artifactRows, indexOpts));
    }
    if (step && step.collector.hasAny()) megaZip.file('artifacts/errors.txt', step.collector.generateErrorReport());
    emit('viewer', 1, 1, 'Viewer and index');

    if (run) {
      writeFailures.push(...await megaZip.flush());
      if (writeFailures.length) {
        megaZip.file('write-errors.txt', ['These files could not be written to the folder:', '', ...writeFailures.map((f) => `${f.path}: ${f.error}`), ''].join('\n'));
        await megaZip.flush();
      }
      addWriteFailures(writeFailures);
      const recordable = recordableExport(exportedChats, exportedArtifacts, writeFailures, exportedVersions);
      if (org && (recordable.chats.length || recordable.artifacts.length || recordable.versions.length)) await saveExportRecord(org, startedAt, recordable.chats, recordable.artifacts, recordable.versions, warningList.length);
      return result('done');
    }

    // Generate and download

    try {
      const zipBlob = await megaZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      target.name = megaZipName(response.accountName, kind, dateStr);
      download(zipBlob, target.name, 'application/zip');
      addWriteFailures(writeFailures);
      // Only chats and artifacts really in the archive are recorded, so one that failed is tried again next time.
      const recordable = recordableExport(exportedChats, exportedArtifacts, writeFailures, exportedVersions);
      if (org && (recordable.chats.length || recordable.artifacts.length || recordable.versions.length)) await saveExportRecord(org, startedAt, recordable.chats, recordable.artifacts, recordable.versions, warningList.length);
      if (errors.length) console.error('Export errors:', errors);
    } catch (e) {
      // Nothing reached disk: a ZIP is written only when the export finishes.
      Object.assign(saved, { chats: 0, artifacts: 0, versions: 0 });
      return result('failed', runWarningText(`Zip generation failed: ${e && e.message}`));
    }
    return result('done');
  })();
  } catch (e) {
    console.error('Export All failed:', e);
    // A ZIP reaches disk only at the end; a folder keeps what was written (saved counts it as it goes).
    if (!directory) Object.assign(saved, { chats: 0, artifacts: 0, versions: 0 });
    return result('failed', runWarningText(`Export All failed: ${e && e.message ? e.message : e}`));
  }
}

// ============================================================================
// Export Artifacts: the current version of every artifact claude.ai lists, one folder each
// ============================================================================
// content.js lists them (listArtifacts) and fetches their files (publishedPageInfo, publishedPageFile); the
// asset token never reaches the popup. Each artifact gets <title>_<shortId>/ with artifact.json (format 2) and
// one folder per version saved, <ver>/ (artifactStore); the root has index.md, index.html, export-manifest.json and
// errors.txt when needed. Export All uses the same store under artifacts/, shared with the pages its chats published.
// Claude Docs are listed, not fetched: their text is in no file. The export record is never read or written.

const DOCS_ARTIFACT_NOTE = "Claude Docs text isn't available as a file; export the chat that made it to get the document.";
// Root names an artifact folder may not take, matched without case.
const ARTIFACT_ROOT_NAMES = ['index.md', 'index.html', 'export-manifest.json', 'errors.txt', 'write-errors.txt', 'viewer.html', 'viewer-check.gif', 'viewer-files'];

// A string from claude.ai's list, safe to write: anything shaped like a frame URL or its token is dropped.
const artifactText = (v) => String(typeof v === 'string' ? v : '').replace(/\S*(?:claudeusercontent\.com|__frame_t)\S*/gi, '[link removed]').slice(0, 500);

// text cut to at most max bytes of UTF-8, at a code point boundary.
function capUtf8(text, max) {
  let out = '';
  let bytes = 0;
  for (const ch of String(text || '')) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}
// base, or base_2, base_3, ... when taken; folder names are compared without case.
function claimArtifactFolder(base, usedFolders) {
  let folder = base;
  for (let n = 2; usedFolders.has(folder.toLowerCase()); n++) folder = `${base}_${n}`;
  usedFolders.add(folder.toLowerCase());
  return folder;
}
const ARTIFACT_UNEXPECTED_NOTE = 'not exported: unexpected error (see errors.txt)';

// Bytes to base64, a piece at a time.
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

// A preview payload ({ texts: [[path, text]], images: [[path, dataUri]] }) from fetchPublishedFiles' texts and
// images, or null when there is nothing to show.
function artifactPayload(got) {
  if (!got) return null;
  const texts = [...got.texts.entries()];
  const images = [...got.images.entries()].map(([p, img]) => [p, `data:${img.type};base64,${bytesToBase64(img.bytes)}`]);
  return texts.length || images.length ? { texts, images } : null;
}

// claude.ai's card picture for one artifact, saved at viewer-files/thumbs/<id>.<ext>. content.js gives the
// picture URL it checked when listing (artifactThumbUrl); the popup fetches it, which needs the optional https
// permission (the frame host sends no CORS header for claude.ai). The URL is used for that fetch only: it is
// never stored, logged, shown or written. On a 403 (an expired token), content.js is asked once per export
// (state.thumbRefreshed) for a fresh URL, and the picture is tried once more. Returns the saved path, or null:
// a picture that isn't there, fails or isn't a PNG, JPEG or WebP is just left out, with no warning.
const ARTIFACT_THUMB_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ARTIFACT_THUMB_MAX = 2 * 1024 * 1024;
// The type, from the leading bytes only.
function artifactThumbType(b) {
  const at = (i, list) => b.length >= i + list.length && list.every((v, j) => b[i + j] === v);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}
// A body read up to max bytes while it streams; null when it passes max or can't be read.
async function readCapped(res, max) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    return ab.byteLength > max ? null : new Uint8Array(ab);
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { reader.cancel().catch(() => {}); } catch (e) { /* stopped anyway */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
// The picture's bytes and type, or null. uuid is lowercased.
async function fetchArtifactThumb(uuid, fetchPublished, state) {
  let reply = await fetchPublished({ action: 'artifactThumbUrl', uuid });
  for (;;) {
    if (!reply || reply.error || typeof reply.url !== 'string') return null;
    // content.js checked the URL; this only makes sure it is that artifact's picture on the frame host.
    if (reply.url.indexOf(`https://${uuid}.frame.claudeusercontent.com/_f/`) !== 0) return null;
    let res;
    try {
      res = await fetch(reply.url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
    } catch (e) { return null; }
    reply = null;
    if (res.status === 403 && !state.thumbRefreshed) {
      state.thumbRefreshed = true;
      reply = await fetchPublished({ action: 'artifactThumbUrl', uuid, refresh: true });
      continue;
    }
    if (!res.ok) return null;
    const ct = String((res.headers && res.headers.get ? res.headers.get('Content-Type') : '') || '').toLowerCase().trim();
    if (ct.indexOf('text/') === 0 || ct.indexOf('svg') !== -1) return null;
    let bytes;
    try { bytes = await readCapped(res, ARTIFACT_THUMB_MAX); } catch (e) { return null; }
    const type = bytes && bytes.length ? artifactThumbType(bytes) : null;
    return type ? { bytes, type } : null;
  }
}
async function saveArtifactThumb(root, uuid, id, fetchPublished, state = {}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$|^[0-9a-f-]{36}$/.test(id)) return null;
  const got = await fetchArtifactThumb(uuid, fetchPublished, state);
  if (!got || !Object.prototype.hasOwnProperty.call(ARTIFACT_THUMB_TYPES, got.type)) return null;
  const path = `viewer-files/thumbs/${id}.${ARTIFACT_THUMB_TYPES[got.type]}`;
  root.file(path, got.bytes);
  return path;
}

// Export Artifacts' viewer.html and viewer-check.gif at the root. The page holds only the views
// ({ exported, listed, artifacts }); artifact texts and images are in viewer-files/ parts, written before.
// opts.fileScripts: parts were written, so the page may load them. Returns whether viewer.html was written;
// any failure writes nothing and returns false, because the export must still finish.
// A store record as the viewer data takes it (takeout-viewer.js recordVersions): artifact.json's content, its folder
// root-relative, the version order, and versionPlaces (each older version's folder and preview part).
// versionOrder: artifact.json's version keys in claude.ai's order, which the object's own key order loses for a
// numeric-looking id.
function viewerStoreRecord(store, rec) {
  const json = artifactJsonV2(rec);
  return { ...json, dir: `${store.prefix}${rec.dir}`, versionOrder: json.order.slice(), versionPlaces: rec.versionPlaces || {} };
}

async function writeArtifactsViewer(root, views, opts = {}) {
  try {
    const [template, logic, app, marked, artifactsCss] = await Promise.all(CTViewer.ARTIFACTS_VIEWER_ASSETS.map(async (asset) => {
      const response = await fetch(chrome.runtime.getURL(asset));
      if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
      return response.text();
    }));
    const data = { exported: opts.exported || null, listed: opts.listed == null ? null : opts.listed, artifacts: views };
    const html = CTViewer.assembleViewer({ template, css: '', artifactsCss, marked, katex: '', highlight: '', logic, app, data, fileScripts: !!opts.fileScripts });
    root.file('viewer.html', html);
    root.file(CTViewer.VIEWER_CHECK_FILE, CTViewer.VIEWER_CHECK_BASE64, { base64: true });
    return true;
  } catch (e) {
    console.error('Could not build viewer.html:', e);
    return false;
  }
}

// The artifacts store: one folder per artifact (by uuid), one subfolder per version saved, and artifact.json
// (format 2) beside them. root: a JSZip or a disk folder; prefix: where the artifact folders go in root ('' for
// Export Artifacts, 'artifacts/' for Export All). Folder names never repeat, compared without case, and never take
// a root name (ARTIFACT_ROOT_NAMES). A record: { uuid, shortId, dir, title, listed, current, meta: { url, typeTitle,
// sourceSurface, rel, public, createdAt, updatedAt, note, start, needsRuntime, thumb? }, versions: Map<ver, VersionRec> }
// where VersionRec is artifact.json's per-version object (see artifactJsonV2), with the preview payload kept as a
// non-enumerable preview. The version with no id ('') is saved in current/. A record also keeps history (claude.ai's
// version ids, oldest first, when known: the order of its versions) and incomplete (a fetch of it failed).
function artifactStore(root, { prefix = '' } = {}) {
  const used = new Set(ARTIFACT_ROOT_NAMES);
  const recs = new Map();
  const folders = new Map();  // rec -> Map<ver, folder name>
  const written = new Set();  // records whose artifact.json was written
  // record(uuid, { title }): the record, made on first use. Its folder is <Title>_<shortId>, or artifact_<shortId>
  // without a title; the first caller names it.
  const record = (uuid, init = {}) => {
    const key = String(uuid).toLowerCase();
    if (recs.has(key)) return recs.get(key);
    let shortId = '';
    try { shortId = uuidToBase58(key); } catch (e) { /* the uuid names it instead */ }
    const title = artifactText(init.title);
    const dir = claimArtifactFolder(`${capUtf8(safeFileTitle(title), 200) || 'artifact'}_${shortId || key}`, used);
    const rec = {
      uuid: key, shortId, dir, title, listed: false, current: null, history: [], incomplete: false,
      meta: { url: `https://claude.ai/artifact/${shortId || key}`, typeTitle: '', sourceSurface: '', rel: '', public: false, createdAt: '', updatedAt: '', note: '', start: null, needsRuntime: false },
      versions: new Map(),
    };
    folders.set(rec, new Map());
    recs.set(key, rec);
    return rec;
  };
  // The version's folder name inside the artifact folder: publishedSegment(ver), or current for no id; _2, _3, ...
  // when another version or artifact.json has it.
  const folderName = (rec, ver) => {
    const names = folders.get(rec);
    const v = ver || '';
    if (names.has(v)) return names.get(v);
    const want = v ? publishedSegment(v) : 'current';
    const taken = new Set(['artifact.json', ...[...names.values()].map((n) => n.toLowerCase())]);
    let name = want;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${want}_${n}`;
    names.set(v, name);
    return name;
  };
  // A new title names the folder again, only while nothing of the record has a place yet (no version folder named,
  // no artifact.json written): the v1.16.1 rule for a page named after its file.
  const retitle = (rec, title) => {
    const t = artifactText(title);
    if (!t || folders.get(rec).size || written.has(rec)) return false;
    used.delete(rec.dir.toLowerCase());
    rec.dir = claimArtifactFolder(`${capUtf8(safeFileTitle(t), 200) || 'artifact'}_${rec.shortId || rec.uuid}`, used);
    rec.title = t;
    return true;
  };
  return {
    prefix,
    record,
    retitle,
    has: (uuid, ver) => {
      const rec = recs.get(String(uuid).toLowerCase());
      return !!rec && rec.versions.has(ver || '');
    },
    folderName,
    versionFolder: (rec, ver) => `${prefix}${rec.dir}/${folderName(rec, ver)}/`,
    write: (rec) => { written.add(rec); root.file(`${prefix}${rec.dir}/artifact.json`, JSON.stringify(artifactJsonV2(rec), null, 2)); },
    written: (rec) => written.has(rec),
    records: () => [...recs.values()],
  };
}

// artifact.json, format 2, from a store record: claude.ai's metadata, listed (claude.ai's list had it), current
// (the current version id, or null), order (the versions' keys in claude.ai's order, storeVersionList's: JSON keeps
// no key order for a numeric-looking id), and every version saved or recorded: { folder (inside the artifact folder;
// null when no copy was saved), files: [{ path, savedAs, size, contentType, sha256, verified }], start, startSaved,
// incomplete, missing, saved, sameAs? ({ <published path>: <root-relative chat file> }, only for a version not
// copied because a chat wrote it the same), publishedIn: [{ chat, messageUuid, toolUseId, same, writtenAs }] }.
function artifactJsonV2(rec) {
  const meta = rec.meta || {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const versions = {};
  const list = storeVersionList(rec);
  const noId = storeNoIdKey(list);
  for (const [ver, v] of list) {
    // A version with no folder has no saved names (a sameAs one names the chat's file in sameAs).
    const folder = typeof v.folder === 'string' && v.folder ? v.folder : null;
    const out = {
      folder,
      files: (Array.isArray(v.files) ? v.files : []).map((f) => ({
        path: f.path, savedAs: folder && typeof f.savedAs === 'string' ? f.savedAs : null, size: Number.isFinite(f.size) ? f.size : null,
        contentType: typeof f.contentType === 'string' ? f.contentType : null, sha256: typeof f.sha256 === 'string' ? f.sha256 : null, verified: f.verified !== false,
      })),
      start: v.start || null, startSaved: (folder && v.startSaved) || null, incomplete: !!v.incomplete,
      missing: Array.isArray(v.missing) ? v.missing.slice() : [], saved: !!folder && !!v.saved,
      // The version's ZIP beside its folder (only the current version with two or more saved files has one).
      ...(folder && typeof v.zip === 'string' && v.zip === `${folder}.zip` ? { zip: v.zip } : {}),
    };
    if (v.sameAs && typeof v.sameAs === 'object' && Object.keys(v.sameAs).length) out.sameAs = { ...v.sameAs };
    out.publishedIn = (Array.isArray(v.publishedIn) ? v.publishedIn : []).map((p) => ({
      chat: p.chat, messageUuid: p.messageUuid, toolUseId: p.toolUseId, same: !!p.same, writtenAs: typeof p.writtenAs === 'string' ? p.writtenAs : null,
    }));
    versions[ver || noId] = out;
  }
  return {
    format: 2, uuid: rec.uuid, shortId: rec.shortId, url: str(meta.url), title: str(rec.title), typeTitle: str(meta.typeTitle),
    sourceSurface: str(meta.sourceSurface), rel: str(meta.rel), public: meta.public === true, createdAt: str(meta.createdAt), updatedAt: str(meta.updatedAt),
    listed: rec.listed === true, current: typeof rec.current === 'string' && rec.current ? rec.current : null,
    start: meta.start || null, needsRuntime: !!meta.needsRuntime, note: str(meta.note),
    ...(typeof meta.thumb === 'string' && meta.thumb ? { thumb: meta.thumb } : {}),
    ...(rec.incomplete ? { incomplete: true } : {}),
    order: list.map(([ver]) => ver || noId),
    versions,
  };
}


// A store version that can stand for the current version without a fetch: saved in its folder, nothing missing,
// every file with a saved name.
const storeVersionWhole = (v) => !!(v && v.folder && v.saved && !v.incomplete && !(v.missing && v.missing.length)
  && Array.isArray(v.files) && v.files.length && v.files.every((f) => typeof f.savedAs === 'string' && f.savedAs));

// claude.ai's list entry on a store record: listed, its title, current version and the rest of its card.
function listedArtifactRecord(rec, a) {
  const rel = artifactText(a.rel);
  rec.title = artifactText(a.title);
  rec.listed = true;
  rec.current = typeof a.live === 'string' && PUBLISHED_VER_RE.test(a.live) ? a.live : null;
  Object.assign(rec.meta, {
    url: `https://claude.ai/artifact/${rec.shortId || rec.uuid}`, typeTitle: artifactText(a.typeTitle), sourceSurface: artifactText(a.sourceSurface), rel,
    public: a.public === true, createdAt: artifactText(a.createdAt), updatedAt: artifactText(a.updatedAt),
  });
  if (!rec.meta.note && isSharedArtifact(rel)) rec.meta.note = 'shared with you';
  return rec;
}


// Save one listed artifact (from artifactsFromList) into its store record. ctx: { fetchPublished, state
// (publishedSignedOut: one 401 stops fetching the rest), warn(filename, message, note), store (artifactStore), docChats
// (optional Map: a Claude Docs artifact's uuid -> the title of the chat in this export that rebuilt its text) }. The
// current version goes into its version folder, unless the store has it already: whole in its folder, or (one file)
// the same as a file a chat wrote (sameAs); either way only when the viewer's preview of its start file is at hand.
// artifact.json is left to the caller (store.write). Returns { row (for the indexes), entry (for
// export-manifest.json), meta ({ incomplete, missing }), view, payload }.
async function saveArtifact(root, a, ctx) {
  const { fetchPublished, state, warn, store } = ctx;
  const prefix = store.prefix;
  const uuid = String(a.slug).toLowerCase();
  const typeSlug = artifactText(a.typeSlug);
  const rec = listedArtifactRecord(store.record(uuid, { title: artifactText(a.title) }), a);
  const { shortId, title, dir: folder } = rec;
  const { url, typeTitle, rel, sourceSurface, createdAt, updatedAt } = rec.meta;
  const shared = isSharedArtifact(rel);
  const docs = isClaudeDocsArtifact(a);
  const name = title || folder;
  const openNote = `Open it on claude.ai: ${url}`;

  const meta = { ver: rec.current || '', files: [], missing: [], incomplete: false, needsRuntime: false };
  const notes = [];
  let startSaved = null;
  let got = null;
  let gotPayload = null;
  let failed = false;
  // saveHistory's result, for the record and the viewer; null when no history was fetched.
  let history = null;
  const signOut = () => {
    if (state.publishedSignedOut) return;
    state.publishedSignedOut = true;
    warn('artifacts', `Artifacts not exported: claude.ai answered HTTP 401, as if you were signed out. "${name}" and the artifacts after it were not saved.`,
      'Sign in to claude.ai in this tab and run Export Artifacts again.');
  };
  const notExported = (why) => { meta.incomplete = true; failed = true; rec.incomplete = true; notes.push(`not exported: ${why}`); };
  // The version folder (inside the artifact folder) the current version is in.
  let verFolder = null;

  // A version the store already has (plain, non-Docs only): no fetch. Its preview must hold the start file when the
  // viewer would show it; otherwise it is fetched again, into its own folder. A start file over PREVIEW_ITEM_MAX is
  // never in a preview: the version is kept as it is, and the view says the start is too large to preview.
  let kept = null;
  let same = null;
  // A version the chats saved whole that a failing fetch left as it was.
  let keptOnFail = null;
  if (!docs && meta.ver && typeSlug === '' && store.has(uuid, meta.ver)) {
    const v = rec.versions.get(meta.ver);
    const preview = v && v.preview && typeof v.preview === 'object' ? v.preview : null;
    const kind = v && v.start ? previewKind(v.start) : null;
    const inPreview = (list) => !!(preview && Array.isArray(list) && list.some((t) => t[0] === v.start));
    const startSize = v && v.start && Array.isArray(v.files) ? keptStartSize(v) : null;
    const shown = !kind || inPreview(kind === 'text' ? preview && preview.texts : preview && preview.images) || (startSize != null && startSize > PREVIEW_ITEM_MAX);
    if (shown && storeVersionWhole(v)) kept = v;
    else if (shown && storeVersionSame(v)) same = v;
  }
  const startTextOf = (v) => {
    const t = v.preview && Array.isArray(v.preview.texts) ? v.preview.texts.find((x) => x[0] === v.start) : null;
    return t ? t[1] : null;
  };

  if (kept) {
    verFolder = kept.folder;
    meta.files = kept.files;
    startSaved = kept.startSaved;
    meta.needsRuntime = publishedNeedsRuntime(startTextOf(kept));
    if (kept.files.some((f) => f.verified === false)) notes.push("files not checked against claude.ai's checksum");
  } else if (same) {
    // startSaved and the file's savedAs are root-relative: the chat's own file.
    meta.files = same.files.map((f) => ({ ...f, savedAs: same.sameAs[f.path] }));
    startSaved = same.start ? same.sameAs[same.start] || null : null;
    meta.needsRuntime = publishedNeedsRuntime(startTextOf(same));
    notes.push('files saved with the chats');
  } else if (docs) {
    const madeBy = ctx.docChats instanceof Map ? ctx.docChats.get(uuid) : null;
    notes.push(madeBy ? `Text rebuilt from the chat ${madeBy}.` : DOCS_ARTIFACT_NOTE);
  } else if (!meta.ver && a.paged !== true) {
    notes.push('no published version');
  } else if (state.publishedSignedOut) {
    notExported('signed out of claude.ai (see errors.txt)');
  } else try {
    const reply = await fetchPublished({ action: 'publishedPageInfo', uuid, ver: meta.ver });
    const info = publishedSignedOutReply(reply) ? (signOut(), null) : cleanPublishedInfo(reply);
    if (!info) {
      notExported('signed out of claude.ai (see errors.txt)');
    } else if (a.paged === true && (info.error === 'bad response' || info.status === 404)) {
      // Found only by paging, with no version claude.ai serves (a draft, say): as a listed one with no live version.
      notes.push('no published version');
    } else if (info.error) {
      notExported(`${info.error} (see errors.txt)`);
      warn(name, `Artifact "${name}" could not be fetched: ${info.error}.`, openNote);
    } else {
      meta.ver = info.ver;
      rec.current = info.ver;
      if (info.history.length >= rec.history.length) rec.history = info.history;
      // In a version folder no saved name can meet artifact.json.
      const { names, renames } = publishedSavedNames(info.files.map((f) => f.path));
      const files = info.files.map((f) => ({ path: f.path, savedAs: names.get(f.path), size: f.size, contentType: f.contentType, sha256: f.sha256 }));
      meta.files = files;
      // Rejected paths are only counted: they come from claude.ai and may hold anything.
      if (renames.length || info.rejected.length) {
        const parts = [];
        if (renames.length) parts.push(`saved ${renames.join(', ')}`);
        if (info.rejected.length) parts.push(`${artifactCount(info.rejected.length, 'file')} with unsafe paths not fetched`);
        warn(name, `Artifact "${name}": file names changed to stay inside its folder: ${parts.join('; ')}.`, openNote);
      }
      got = await fetchPublishedFiles({ target: root, prefix: store.versionFolder(rec, info.ver), uuid, ver: info.ver, files, names, state, onSignedOut: signOut, fetchPublished, collect: true,
        zip: { date: rec.meta.updatedAt } });
      meta.missing = got.missing;
      meta.incomplete = got.incomplete;
      markUnverified(files, got.unverified);
      startSaved = got.startSaved;
      if (files.length) {
        // Publishes the chats recorded for this version stay with it, and a version the chats saved whole stays saved
        // when this fetch saves nothing.
        const prev = rec.versions.get(info.ver);
        const v = !got.saved && storeVersionWhole(prev) ? null : {
          folder: got.saved ? store.folderName(rec, info.ver) : null, files, start: got.start, startSaved: got.startSaved,
          incomplete: got.incomplete, missing: got.missing, saved: got.saved, publishedIn: prev && Array.isArray(prev.publishedIn) ? prev.publishedIn : [],
        };
        if (v) {
          // A copy that didn't save keeps pointing at the chat's file.
          if (!got.saved && prev && prev.sameAs) v.sameAs = prev.sameAs;
          if (got.zipped) v.zip = `${v.folder}.zip`;
          gotPayload = artifactPayload(got);
          Object.defineProperty(v, 'preview', { value: gotPayload, writable: true, configurable: true });
          rec.versions.set(info.ver, v);
        } else {
          // The row and the view show the version kept, not this fetch.
          keptOnFail = prev;
          Object.assign(meta, { files: prev.files, missing: Array.isArray(prev.missing) ? prev.missing.slice() : [], incomplete: !!prev.incomplete });
          startSaved = prev.startSaved || null;
        }
        verFolder = v ? v.folder : prev.folder;
      }
      meta.needsRuntime = info.runtimeSkipped > 0 || typeSlug !== '' || got.needsRuntime;
      if (!files.length) notes.push(typeSlug || info.runtimeSkipped > 0 ? 'open on claude.ai' : 'no files; open on claude.ai');
      if (got.problems.length) {
        warn(name, `Artifact "${name}" (${info.ver}): ${artifactCount(got.problems.length, 'file')} could not be saved: ${got.problems.join(', ')}.`, openNote);
      }
      if (meta.missing.length) notes.push(`${artifactCount(meta.missing.length, 'file')} not saved (see errors.txt)`);
      if ([...got.unverified.values()].some(Boolean)) notes.push("files not checked against claude.ai's checksum");
    }
  } catch (e) {
    // Not a refusal from claude.ai (those are replies, not throws): the artifact is listed as not exported.
    warn(name, `Artifact "${name}" could not be exported: unexpected error.`, openNote);
    notes.splice(0, notes.length, ARTIFACT_UNEXPECTED_NOTE);
    Object.assign(meta, { ver: '', files: [], missing: [], incomplete: true, needsRuntime: false });
    rec.incomplete = true;
    startSaved = null;
    got = null;
    failed = true;
  }
  // Every older version claude.ai keeps (v1.21), after the current one, oldest to newest, whichever way the current
  // one was saved (fetched, kept whole from the store, or a chat's own file). A failure here leaves the current
  // version saved: only the older versions count as not saved.
  if (!docs && !failed && rec.current) {
    try {
      if (!state.publishedSignedOut && !rec.history.includes(rec.current)) {
        const reply = await fetchPublished({ action: 'publishedPageInfo', uuid, ver: rec.current });
        const info = publishedSignedOutReply(reply) ? (signOut(), null) : cleanPublishedInfo(reply);
        if (info && !info.error && info.history.length >= rec.history.length) rec.history = info.history;
      }
      const skip = ctx.skipVersions instanceof Map && ctx.skipVersions.get(uuid) instanceof Set ? ctx.skipVersions.get(uuid) : new Set();
      history = await saveHistory(root, rec, { ...ctx, signOut }, { skip, name, openNote });
      if (history.settled.length) notes.push(`${artifactCount(history.settled.length, 'older version')} no longer on claude.ai`);
    } catch (e) {
      warn(name, `Artifact "${name}": its older versions could not be saved: unexpected error.`, openNote);
      history = { settled: [], saved: [], failed: ['unexpected error'] };
    }
  }
  const note = [...(shared ? ['shared with you'] : []), ...notes].join('; ');
  const start = kept ? kept.start : same ? same.start || null : keptOnFail ? keptOnFail.start || null : got ? got.start : null;
  Object.assign(rec.meta, { note, start, needsRuntime: meta.needsRuntime });
  // Where the current version's files are, relative to prefix.
  const filesAt = verFolder ? `${folder}/${verFolder}` : folder;
  // The indexes link the current version's start file, else the newest version saved with one.
  let rowAt = filesAt;
  let rowStart = startSaved;
  let rowReused = !!same;
  if (!rowStart) {
    const older = artifactRowVersions(rec).filter((v) => v.startSaved).pop();
    if (older) { rowAt = older.folder || folder; rowStart = older.startSaved; rowReused = !!older.reused; }
  }
  const payload = kept ? kept.preview || null : same ? same.preview || null : keptOnFail ? keptOnFail.preview || null : got && !failed ? gotPayload || artifactPayload(got) : null;
  const view = artifactView({
    uuid, shortId, url, title, typeSlug, typeTitle, shared, foreign: artifactForeign(rel, true), public: a.public === true, docs,
    createdAt, updatedAt, folder: `${prefix}${filesAt}`, files: meta.files, missing: meta.missing,
    start, startSaved, startSize: kept || same || keptOnFail ? keptStartSize(kept || same || keptOnFail) : got ? got.startSize : null, needsRuntime: meta.needsRuntime, notExported: failed, note: notes.join('; '),
    inPayload: kept || same || keptOnFail ? !!(start && payload && (payload.texts.some((t) => t[0] === start) || payload.images.some((t) => t[0] === start)))
      : !!(got && !failed && start && (got.texts.has(start) || got.images.has(start))),
    reused: !!same, zip: zipHref(prefix, rec, meta.ver),
  });
  return {
    row: {
      title, typeTitle, sourceSurface, rel, folder: rowAt, startSaved: rowStart, url, note: notes.join('; '),
      needsRuntime: meta.needsRuntime, fileCount: meta.files.length - meta.missing.length, missingCount: meta.missing.length,
      ...(rowReused ? { reused: true } : {}), listed: true, versions: artifactRowVersions(rec),
    },
    entry: { uuid, title, folder, ver: meta.ver },
    meta, view, payload, history,
  };
}

// The older versions of an artifact (rec.history, oldest first, the current one left out) into the store, each in
// its own version folder as the current one is saved. Not fetched: a version in skip (an earlier export recorded it),
// one the store has whole or as a chat's file (sameAs). claude.ai answering 404 or listing no files: settled (gone,
// not retried). Any other failure, or a version saved short of a file: failed, warned once per artifact (codes
// only). An older Cowork/Claude Code version listed from the live version (listFromLive) is unverified, and a file it
// lacks is missing without failing it. A 401 stops (ctx.signOut): every version not yet tried is unfetched, and
// the artifact is not whole (runArtifactStep), so the next Export Changes fetches them. Each saved version's preview goes to
// ctx.placeOlder(rec, ver, payload) at once. ctx.onVersion(i, n) (optional) is told before each version is fetched,
// i counting from 1 in rec.history (n long); ctx.stopped() (optional) true ends the loop before the next version.
// Returns { settled, saved, failed, unfetched }.
async function saveHistory(root, rec, ctx, { skip = new Set(), name = '', openNote = '' } = {}) {
  const { fetchPublished, state, warn, store } = ctx;
  const out = { settled: [], saved: [], failed: [], unfetched: [] };
  const problems = [];
  for (let i = 0; i < rec.history.length; i++) {
    const ver = rec.history[i];
    if (ver === rec.current || skip.has(ver)) continue;
    const prev = rec.versions.get(ver);
    if (storeVersionWhole(prev) || (prev && prev.sameAs)) { out.saved.push(ver); continue; }
    if (state.publishedSignedOut) { out.unfetched.push(ver); continue; }
    // Stop (ctx.stopped): the versions saved so far stay.
    if (typeof ctx.stopped === 'function' && ctx.stopped()) break;
    if (typeof ctx.onVersion === 'function') ctx.onVersion(i + 1, rec.history.length);
    const reply = await fetchPublished({ action: 'publishedPageInfo', uuid: rec.uuid, ver });
    if (publishedSignedOutReply(reply)) { ctx.signOut(); out.unfetched.push(ver); continue; }
    const info = cleanPublishedInfo(reply);
    if (info.error) {
      if (info.status === 404) out.settled.push(ver);
      else { out.failed.push(ver); problems.push(info.error); }
      continue;
    }
    if (!info.files.length) { out.settled.push(ver); continue; }
    const { names } = publishedSavedNames(info.files.map((f) => f.path));
    const files = info.files.map((f) => ({ path: f.path, savedAs: names.get(f.path), size: f.size, contentType: f.contentType, sha256: f.sha256 }));
    const got = await fetchPublishedFiles({ target: root, prefix: store.versionFolder(rec, ver), uuid: rec.uuid, ver, files, names, state,
      onSignedOut: ctx.signOut, fetchPublished, collect: true });
    markUnverified(files, got.unverified);
    if (info.listFromLive) for (const f of files) f.verified = false;
    const v = {
      folder: got.saved ? store.folderName(rec, ver) : null, files, start: got.start, startSaved: got.startSaved,
      incomplete: info.listFromLive ? !got.saved : got.incomplete, missing: got.missing, saved: got.saved,
      publishedIn: prev && Array.isArray(prev.publishedIn) ? prev.publishedIn : [],
    };
    rec.versions.set(ver, v);
    // Its preview goes into a part now (runArtifactStep's placeOlder), so no artifact holds all its versions' previews.
    if (got.saved && typeof ctx.placeOlder === 'function') ctx.placeOlder(rec, ver, artifactPayload(got));
    if (got.saved && !v.incomplete && (info.listFromLive || !got.missing.length)) out.saved.push(ver);
    else { out.failed.push(ver); problems.push(...(got.problems.length ? got.problems : ['not saved'])); }
  }
  if (out.failed.length) {
    warn(name, `Artifact "${name}": ${artifactCount(out.failed.length, 'older version')} could not be saved: ${[...new Set(problems)].join(', ')}.`, openNote);
  }
  return out;
}

// The root-relative href of a version's ZIP (store record rec, version ver), or null when it has none.
function zipHref(prefix, rec, ver) {
  const v = rec && rec.versions instanceof Map ? rec.versions.get(ver || '') : null;
  return v && typeof v.zip === 'string' && v.zip ? `${prefix}${rec.dir}/${v.zip}` : null;
}

// The size of a kept version's start file, from its listing (claude.ai's or, unchecked, the saved bytes').
function keptStartSize(v) {
  const f = v.start ? v.files.find((x) => x.path === v.start) : null;
  return f && Number.isFinite(f.size) ? f.size : null;
}


// An artifact whose saveArtifact threw before it could say so itself: a row, a manifest entry and a warning, all
// naming it not exported; its store record (artifact.json) says so too.
function unexpectedArtifactRow(root, a, ctx) {
  const uuid = String(a.slug).toLowerCase();
  const title = artifactText(a.title);
  const rel = artifactText(a.rel);
  let shortId = '';
  try { shortId = uuidToBase58(uuid); } catch (e) { /* the uuid names it instead */ }
  const url = `https://claude.ai/artifact/${shortId || uuid}`;
  // The record saveArtifact may have made already, else a new one named artifact_<id>.
  const rec = ctx.store.record(uuid, { title: '' });
  const folder = rec.dir;
  ctx.warn(title || folder, `Artifact "${title || folder}" could not be exported: unexpected error.`, `Open it on claude.ai: ${url}`);
  const typeTitle = artifactText(a.typeTitle);
  const sourceSurface = artifactText(a.sourceSurface);
  const note = [...(isSharedArtifact(rel) ? ['shared with you'] : []), ARTIFACT_UNEXPECTED_NOTE].join('; ');
  rec.listed = true;
  rec.incomplete = true;
  rec.current = typeof a.live === 'string' && PUBLISHED_VER_RE.test(a.live) ? a.live : null;
  Object.assign(rec.meta, { url, typeTitle, sourceSurface, rel, public: a.public === true, createdAt: artifactText(a.createdAt), updatedAt: artifactText(a.updatedAt), note, start: null, needsRuntime: false });
  if (!rec.title) rec.title = title;
  const prefix = ctx.store.prefix;
  let view;
  try {
    view = artifactView({
      uuid, shortId, url, title, typeSlug: artifactText(a.typeSlug), typeTitle, shared: isSharedArtifact(rel), foreign: artifactForeign(rel, true), public: a.public === true,
      docs: isClaudeDocsArtifact(a), createdAt: rec.meta.createdAt, updatedAt: rec.meta.updatedAt, folder: `${prefix}${folder}`, files: [], missing: [], start: null,
      startSaved: null, startSize: null, needsRuntime: false, notExported: true, note: ARTIFACT_UNEXPECTED_NOTE,
    });
  } catch (e) {
    view = { id: shortId || uuid, title, kind: 'Page', typed: false, docs: false, shared: false, public: false, createdAt: '', updatedAt: '', folder: `${prefix}${folder}`, start: null,
      startSaved: null, startKind: null, startSize: null, tooLarge: false, startMissing: false, missingCount: 0, files: [], needsRuntime: false, notExported: true, note: ARTIFACT_UNEXPECTED_NOTE, url, thumb: null };
  }
  return {
    row: { title, typeTitle, sourceSurface, rel, folder, startSaved: null, url, note: ARTIFACT_UNEXPECTED_NOTE, needsRuntime: false, fileCount: 0, missingCount: 0, listed: true },
    entry: { uuid, title, folder, ver: '' },
    meta: { incomplete: true, missing: [] }, view, payload: null,
  };
}


// The Export Artifacts loop: saves every listed artifact (artifactsFromList) into a store (artifactStore, its prefix
// '' or 'artifacts/') in root and returns what the indexes, manifest and viewer are built from. Folder, artifact.json
// and view paths carry the prefix, so a viewer at the root finds them; card pictures and preview parts stay in the
// root's viewer-files/. opts: { store (optional: a new one at opts.prefix otherwise), artifacts, paging (artifactsFromList: how claude.ai's full list was paged; warns when it failed, was capped or found more), listed,
// fetchPublished, picturesAllowed, docChats (see saveArtifact), parts (CTViewer.artifactViewParts or null),
// onProgress(done, total, { sub, saved?, versions? }): before each artifact and each older version (sub: its title,
// or "<title> · version i of n") and after each artifact (saved: artifacts saved so far, versions: versionCount so far),
// run (truthy on disk: flush per artifact), collector (optional; otherwise one labelled 'Export Artifacts'),
// signal ({ stopped }: checked before each artifact and each older version; the artifact in hand is finished) }.
// Each artifact's artifact.json is written through store.write once, after its picture. Never throws.
// Returns { views, rows, entries, whole (per artifact: saved with nothing missing), versionsSaved, versionCount, thumbs, collector, writeFailures, partCount, signedOut, stopped }; rows and entries name
// folders relative to prefix.
async function runArtifactStep(root, opts = {}) {
  const { artifacts = [], paging = null, listed = artifacts.length, fetchPublished, picturesAllowed = false, parts = null, onProgress = null, run = false } = opts;
  const store = opts.store || artifactStore(root, { prefix: opts.prefix || '' });
  const collector = opts.collector || new ExportErrorCollector(null, null, { label: 'Export Artifacts' });
  const warn = (filename, message, note = null) => collector.addWarning('artifact_export', filename, message, { note });
  const state = {};
  const signal = opts.signal && typeof opts.signal === 'object' ? opts.signal : null;
  const stopped = () => !!(signal && signal.stopped);
  // Reports before an artifact or a version: a listener that throws misses one update. The report after each artifact
  // is not guarded, as before: a throw there ends the step early (its collector says so).
  const report = (done, n, info) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(done, n, info); } catch (e) { /* the screen misses one update */ }
  };
  let current = { i: 0, title: '' };
  const ctx = { fetchPublished, state, warn, store, docChats: opts.docChats instanceof Map ? opts.docChats : null,
    skipVersions: opts.skipVersions instanceof Map ? opts.skipVersions : null, stopped,
    onVersion: (vi, vn) => report(current.i, total, { sub: `${current.title} · version ${vi} of ${vn}` }) };
  const rows = [];
  const entries = [];
  const views = [];
  const whole = [];  // per artifact: saved with nothing missing or incomplete (Export All records only those)
  // per artifact: the version ids now saved whole or settled (the current one when whole, its history's saved and
  // settled), which Export All adds to its record whether or not the artifact is whole.
  const versionsSaved = [];
  let versionCount = 0;  // versions saved whole: each current one and every older one saveHistory saved (the run result's count)
  const writeFailures = [];
  let thumbs = 0;
  let partCount = 0;
  let savedArtifacts = 0;
  let wasStopped = false;
  const total = artifacts.length;
  try {
    const compare = 'Compare index.md with claude.ai/artifacts.';
    if (paging && paging.status === 'failed') {
      warn('artifact list', `claude.ai's artifact list could not be read in full (${paging.code}), so this export has the ${listed} artifacts of its quick list and may be incomplete.`, compare);
    } else if (paging && paging.status === 'capped') {
      warn('artifact list', `claude.ai's artifact list is longer than this export reads, so this export may be incomplete.`, compare);
    }
    if (paging && paging.added > 0) {
      const n = paging.added;
      warn('artifact list', `claude.ai's quick list missed ${n} artifact${n === 1 ? '' : 's'}; ${n === 1 ? 'it was' : 'they were'} found by paging through its full list and saved without a card picture.`);
    }
    const thumbState = {};
    const writeParts = (list) => { for (const p of list) root.file(`viewer-files/${p.name}`, p.body); };
    // An older version saved by saveHistory: where it is, and its own preview part while the budget's reserve allows
    // (v1.21). Called as each is fetched, so its payload is let go at once.
    ctx.placeOlder = (rec, ver, payload) => {
      try {
        const v = rec.versions.get(ver);
        if (!v || !v.folder) return;
        const placed = parts ? parts.add({}, payload, { reserve: CTViewer.ARTIFACT_HISTORY_RESERVE }) : { part: null };
        if (!rec.versionPlaces) rec.versionPlaces = {};
        rec.versionPlaces[ver] = { folder: `${store.prefix}${rec.dir}/${v.folder}`,
          ...(placed.part != null ? { part: placed.part, key: placed.key, startKind: artifactStartKind(v.start) } : {}) };
        if (parts) writeParts(parts.drain());
      } catch (e) { /* the version keeps its folder; its preview is an extra */ }
    };
    for (let i = 0; i < total; i++) {
      if (stopped()) { wasStopped = true; break; }
      current = { i, title: artifactText(artifacts[i] && artifacts[i].title) || 'Untitled' };
      report(i, total, { sub: current.title });
      let saved;
      try {
        saved = await saveArtifact(root, artifacts[i], ctx);
      } catch (e) {
        saved = unexpectedArtifactRow(root, artifacts[i], ctx);
      }
      rows.push(saved.row);
      entries.push(saved.entry);
      whole.push(!!(saved.meta && !saved.meta.incomplete && !(saved.meta.missing && saved.meta.missing.length) && !saved.view.notExported
        && !(saved.history && (saved.history.failed.length || (saved.history.unfetched && saved.history.unfetched.length)))));
      {
        const m = saved.meta || {};
        const currentOk = !!(m.ver && !m.incomplete && !(m.missing && m.missing.length) && !saved.view.notExported);
        versionsSaved.push([...(currentOk ? [m.ver] : []), ...(saved.history ? [...saved.history.saved, ...saved.history.settled] : [])]);
        versionCount += (currentOk ? 1 : 0) + (saved.history ? saved.history.saved.length : 0);
      }
      let view = { ...saved.view, thumb: null, part: null, key: null };
      // The card picture and the preview part are extras: a failure leaves them out, with no warning.
      try {
        if (picturesAllowed && !state.publishedSignedOut) {
          const uuid = String(artifacts[i].slug).toLowerCase();
          const thumb = await saveArtifactThumb(root, uuid, view.id, fetchPublished, thumbState);
          if (thumb) {
            view.thumb = thumb;
            thumbs++;
            store.record(uuid).meta.thumb = thumb;
          }
        }
      } catch (e) { /* no picture */ }
      try { store.write(store.record(artifacts[i].slug)); } catch (e) { /* the row and errors.txt still say what happened */ }
      try {
        if (parts) {
          view = parts.add(view, saved.payload);
          writeParts(parts.drain());
        }
      } catch (e) { view = { ...view, part: null, key: null }; }

      // The previews this artifact kept in memory (its fetch, or a chat's for the artifact step) are in its part now,
      // or never will be: let them go, so a large account doesn't hold every one until the export ends.
      try {
        for (const v of store.record(artifacts[i].slug).versions.values()) if (v && v.preview) v.preview = null;
      } catch (e) { /* a preview that can't be cleared only costs memory */ }
      // A start file the preview would show that ended up in no part.
      if (view.part == null && view.start && !view.tooLarge && previewKind(view.start)) view = { ...view, startMissing: true };
      views.push(view);
      if (!view.notExported) savedArtifacts++;
      // On disk, each artifact is written before the next, which keeps memory down.
      if (run) writeFailures.push(...await root.flush());
      if (typeof onProgress === 'function') onProgress(i + 1, total, { sub: current.title, saved: savedArtifacts, versions: versionCount });
      if (i + 1 < total) await new Promise((r) => setTimeout(r, 200));
    }
    // A stop during the last artifact's versions ends the step as stopped too.
    if (stopped()) wasStopped = true;
    try {
      if (parts && !wasStopped) {
        writeParts(parts.flush());
        partCount = parts.count;
      }
    } catch (e) { /* the parts written so far stay */ }
  } catch (e) {
    console.error('Artifact step stopped early:', e);
    warn('artifacts', 'Artifact step stopped early: unexpected error. Artifacts after this one were not exported.');
  }
  return { views, rows, entries, whole, versionsSaved, versionCount, thumbs, collector, writeFailures, partCount, signedOut: state.publishedSignedOut === true, stopped: wasStopped };
}

// Export Artifacts. options.directory: a folder from showDirectoryPicker; the export goes into a new folder
// inside it instead of a ZIP download. The list is fetched first: nothing is made when it fails or is empty.
// options.onProgress and options.signal as for bulkExportZip. Resolves to a run result (runResult); never throws.
async function exportArtifacts(options = {}) {
  const directory = options && options.directory ? options.directory : null;
  const runStartedAt = new Date().toISOString();
  const target = { kind: directory ? 'folder' : 'zip', name: '' };
  const saved = { chats: 0, artifacts: 0, versions: 0 };
  const warningList = [];
  const errorFiles = [];
  const notes = [];  // sentences the Done screen adds to its counts (runResult)
  const result = (outcome, reason = '') => runResult({ outcome, reason, target, saved, warningList, errorFiles, notes, startedAt: runStartedAt });
  // The Exporting screen's events (exportProgress) and its Stop button (options.signal.stopped).
  const signal = options && options.signal && typeof options.signal === 'object' ? options.signal : null;
  let collector = null;
  const emit = (phase, done, total, sub) => exportProgress(options, { phase, done, total, sub,
    warnings: warningList.length + (collector ? collector.warnings.length + collector.errors.length : 0) });
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { tab = null; }
  if (!(tab?.url || '').includes('claude.ai')) {
    return result('failed', 'Please navigate to claude.ai first');
  }
  // The first call injects content.js if the tab needs it; the rest message it directly.
  const fetchPublished = tabPublishedFetcher(tab.id);
  let reply;
  try {
    reply = await fetchPublished({ action: 'listArtifacts', withAccountName: true });
  } catch (e) { reply = null; }
  if (!reply || reply.error || reply.connectionError || !Array.isArray(reply.frames)) {
    const code = !reply || reply.error || reply.connectionError ? publishedCode(reply) : 'bad response';
    return result('failed', runWarningText(publishedSignedOutReply(reply) ? 'Sign in to claude.ai, then try again.' : `Could not fetch the artifact list: ${code}.`));
  }
  const { artifacts, paging, listed } = artifactsFromList(reply);
  if (!artifacts.length) {
    notes.push('No artifacts on claude.ai.');
    return result('done');
  }
  const total = artifacts.length;
  const startedAt = new Date().toISOString();
  const zipName = megaZipName(reply.accountName, 'artifacts', exportStamp());
  let run = null;
  if (directory) {
    try {
      run = await makeRunFolder(directory, zipName);
    } catch (e) {
      return result('failed', runWarningText(`Could not make a folder there: ${e && e.message}`));
    }
    target.name = run.name;
  }
  exportTarget(options, target.kind, run ? run.name : zipName);
  try {
    const root = run ? createDiskFolder(run.handle) : new JSZip();
    collector = new ExportErrorCollector(null, null, { label: 'Export Artifacts' });
    // Card pictures only with the optional https permission (asked in a ZIP export's click: options.ask); without
    // it, tiles, and the status line and indexes say the permission is needed.
    let picturesAllowed = false;
    try {
      if (options && options.ask) await options.ask;
      picturesAllowed = await webImagesAllowed();
    } catch (e) { picturesAllowed = false; }
    let parts = null;
    try {
      parts = CTViewer.artifactViewParts({ partLimit: CTViewer.PART_LIMIT, budget: CTViewer.ARTIFACT_PARTS_BUDGET });
    } catch (e) { /* no previews; the export goes on */ }
    const store = artifactStore(root, { prefix: '' });
    emit('artifacts', 0, total, '');
    const { views, rows, entries, thumbs, writeFailures, partCount, versionCount } = await runArtifactStep(root, {
      store, artifacts, paging, listed, fetchPublished, picturesAllowed, parts, collector, run, signal,
      onProgress: (done, count, info = {}) => {
        // On disk, each artifact is written as it is done: the run result counts it now.
        if (run && info.versions !== undefined) Object.assign(saved, { artifacts: info.saved, versions: info.versions });
        emit('artifacts', done, count, info.sub || '');
      },
    });
    // Stop: the artifact folders written stay, with errors.txt and write-errors.txt; no viewer, index or manifest.
    // A ZIP is discarded. Export Artifacts records nothing either way.
    if (signal && signal.stopped) {
      warningList.push(...collectorRunWarnings(collector));
      if (run) {
        if (collector.hasErrors() || collector.hasWarnings()) {
          root.file('errors.txt', collector.generateErrorReport());
          errorFiles.push('errors.txt');
        }
        writeFailures.push(...await root.flush());
        if (writeFailures.length) {
          root.file('write-errors.txt', ['These files could not be written to the folder:', '', ...writeFailures.map((f) => `${f.path}: ${f.error}`), ''].join('\n'));
          await root.flush();
          errorFiles.push('write-errors.txt');
        }
        for (const f of writeFailures) warningList.push({ type: 'write', text: runWarningText(`${f && f.path}: ${f && f.error}`) });
      } else {
        Object.assign(saved, { chats: 0, artifacts: 0, versions: 0 });
      }
      return result('stopped', 'You stopped it');
    }
    emit('viewer', 0, 1, 'Viewer and index');
    // Each view's versions for the version menu, as Export All's viewer data has them (v1.21: every version).
    const recordOf = new Map(store.records().filter((rec) => store.written(rec)).map((rec) => [String(rec.shortId || rec.uuid), rec]));
    const viewsWithVersions = views.map((view) => {
      const rec = recordOf.get(String(view.id));
      try { return rec ? { ...view, versions: CTViewer.recordVersions(viewerStoreRecord(store, rec), new Map()) } : view; } catch (e) { return view; }
    });
    let viewerBuilt = false;
    try {
      viewerBuilt = await writeArtifactsViewer(root, viewsWithVersions, { exported: startedAt, listed, fileScripts: partCount > 0 }) === true;
    } catch (e) { viewerBuilt = false; }
    // On disk, written now, so index.html links viewer.html only when it is really there.
    if (run) {
      const failed = await root.flush();
      writeFailures.push(...failed);
      if (failed.some((f) => f.path === 'viewer.html' || f.path === CTViewer.VIEWER_CHECK_FILE)) viewerBuilt = false;
    }

    const warnings = collector.warnings.length + collector.errors.length;
    const indexOpts = { listed, exportedAt: startedAt, warnings, thumbs, viewer: viewerBuilt, thumbsNeedPermission: !picturesAllowed };
    addFileWithBOM(root, 'index.md', artifactsIndexMd(rows, indexOpts));
    root.file('index.html', artifactsIndexHtml(rows, indexOpts));
    root.file('export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', exported_at: startedAt, listed, thumbs, artifacts: entries }, null, 2));
    if (collector.hasAny()) root.file('errors.txt', collector.generateErrorReport());
    saved.artifacts = views.filter((v) => !v.notExported).length;
    saved.versions = Number(versionCount) || 0;
    warningList.push(...collectorRunWarnings(collector));
    if (collector.hasErrors() || collector.hasWarnings()) errorFiles.push('errors.txt');
    if (!viewerBuilt) warningList.push({ type: 'viewer', text: 'viewer.html could not be built.' });
    collector = null;  // its warnings are in warningList now
    emit('viewer', 1, 1, 'Viewer and index');

    const withoutFiles = rows.filter((r) => r.fileCount === 0).length;
    if (withoutFiles) notes.push(`${withoutFiles} without files (see index.md).`);
    if (!picturesAllowed) notes.push(ARTIFACT_THUMB_PERMISSION_STATUS);
    if (run) {
      writeFailures.push(...await root.flush());
      if (writeFailures.length) {
        root.file('write-errors.txt', ['These files could not be written to the folder:', '', ...writeFailures.map((f) => `${f.path}: ${f.error}`), ''].join('\n'));
        await root.flush();
        errorFiles.push('write-errors.txt');
      }
      for (const f of writeFailures) warningList.push({ type: 'write', text: runWarningText(`${f && f.path}: ${f && f.error}`) });
      return result('done');
    }
    let blob;
    try {
      blob = await root.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    } catch (e) {
      // Nothing reached disk: a ZIP is written only when the export finishes.
      Object.assign(saved, { chats: 0, artifacts: 0, versions: 0 });
      return result('failed', runWarningText(`Zip generation failed: ${e && e.message}`));
    }
    target.name = zipName;
    download(blob, zipName, 'application/zip');
    return result('done');
  } catch (e) {
    if (!run) Object.assign(saved, { chats: 0, artifacts: 0, versions: 0 });
    return result('failed', runWarningText(`Export Artifacts failed: ${e && e.message ? e.message : e}`));
  }
}

// ==== Panel screens
// Pure view-model functions: every sentence the panel's screens show. No DOM, no chrome.* calls.

// 'YYYY-MM-DD HH:MM' in local time.
function formatStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// What Export selected runs for the ticked parts. Changes only needs a record and Chats.
function exportPlan({ chats, artifacts, scope, hasRecord }) {
  const changesAllowed = !!(hasRecord && chats);
  return {
    run: chats ? 'bulk' : artifacts ? 'artifacts' : null,
    changesOnly: scope === 'changes' && changesAllowed,
    withArtifacts: !!artifacts,
    changesAllowed,
  };
}

// True when Changes only is chosen, the counts are in, and the ticked parts have nothing new.
function nothingChanged(plan, counts) {
  if (!plan.changesOnly || !counts) return false;
  return !counts.changedChats && !(plan.withArtifacts && counts.changedArtifacts);
}

// stale: counts older than the cache limit, which show their numbers but not "Nothing changed".
function everythingSummary({ plan, counts, format, since, isPopup, stale = false }) {
  if (!plan.run) return 'Tick Chats or Artifacts.';
  const parts = [];
  const chats = plan.run === 'bulk';
  if (counts) {
    const word = (n, one) => `${n} ${plan.changesOnly ? 'changed ' : ''}${one}${n === 1 ? '' : 's'}`;
    const items = [];
    if (chats) items.push(word(plan.changesOnly ? counts.changedChats : counts.chats, 'chat'));
    if (plan.withArtifacts) items.push(word(plan.changesOnly ? counts.changedArtifacts : counts.artifacts, 'artifact'));
    parts.push(`${items.join(' and ')}.`);
  }
  parts.push(plan.changesOnly ? `Only what changed since the last Export All, ${since}.` : 'Everything, whatever was exported before.');
  if (!chats && since) parts.push('Changes only needs Chats ticked.');
  if (!stale && nothingChanged(plan, counts)) parts.push(`Nothing changed since ${since}.`);
  parts.push(format === 'zip'
    ? 'One ZIP download when it finishes.'
    : `Into a new folder inside one you pick, written as it goes.${isPopup ? ' From the popup, this continues in the sidebar.' : ''}`);
  return parts.join(' ');
}

function exportDisabledReason(plan, counts, since) {
  if (!plan.run) return 'Tick Chats or Artifacts.';
  if (nothingChanged(plan, counts)) return since ? `Nothing changed since ${since}.` : 'Nothing changed since the last Export All.';
  return '';
}

// What the Done list calls each warning type, [one, more]; any other type is "<type> warning(s)".
const WARNING_NOUNS = {
  upload: ['upload could not be downloaded', 'uploads could not be downloaded'],
  published_page: ['artifact problem', 'artifact problems'],
  artifact_export: ['artifact problem', 'artifact problems'],
  export_health: ['chat looks incomplete', 'chats look incomplete'],
  str_replace_failed: ['edit could not be replayed', 'edits could not be replayed'],
  artifact_opaque_mutation: ["file changed by a command the export can't follow", "files changed by a command the export can't follow"],
  write: ['file could not be written', 'files could not be written'],
  chat: ['chat could not be exported', 'chats could not be exported'],
  viewer: ['viewer could not be built', 'viewer problems'],
  web_image: ['web image not saved', 'web images not saved'],
  tool_image: ['image Claude looked at not saved', 'images Claude looked at not saved'],
  presented_file: ['file Claude made could not be downloaded', 'files Claude made could not be downloaded'],
  delivered_file: ['file Claude made could not be downloaded', 'files Claude made could not be downloaded'],
  project_doc: ['project document not saved', 'project documents not saved'],
  doc_diagram: ['diagram not included', 'diagrams not included'],
  claude_doc_unreplayed: ['Claude Docs edit not rebuilt', 'Claude Docs edits not rebuilt'],
  artifact_basename_collision: ['file renamed', 'files renamed'],
};

// Warnings grouped by type, one line each: "<count> <noun phrase> (<example>)".
function warningGroups(list, max = 5) {
  const groups = new Map();
  for (const w of list || []) {
    if (!groups.has(w.type)) groups.set(w.type, { n: 0, example: w.chat || w.text });
    groups.get(w.type).n++;
  }
  const lines = [...groups].map(([type, g]) => {
    const s = g.n === 1 ? '' : 's';
    const words = WARNING_NOUNS[type];
    const noun = words ? words[g.n === 1 ? 0 : 1] : `${type} warning${s}`;
    return `${g.n} ${noun} (${g.example})`;
  });
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

function doneHeadline(result) {
  const n = result.warnings || 0;
  return n ? { tone: 'warn', text: `Done, with ${n} warning${n === 1 ? '' : 's'}` } : { tone: 'ok', text: 'Done' };
}

// The quiet line under the warnings: notes about drafts and renamed files are in each chat's README.
function doneNotesLine(result) {
  const n = (result && result.fileNotes) || 0;
  return n ? `${n} note${n === 1 ? '' : 's'} about drafts and renamed files ${n === 1 ? 'is' : 'are'} in each chat's README.` : '';
}

function doneTargetText(result) {
  return result.target.kind === 'folder'
    ? 'inside the folder you picked. Open viewer.html in it to browse.'
    : `Saved to Downloads as ${result.target.name}.`;
}

function runSteps(plan) {
  const steps = [];
  if (plan.run === 'bulk') steps.push('chats');
  if (plan.run === 'artifacts' || (plan.run === 'bulk' && plan.withArtifacts)) steps.push('artifacts');
  if (steps.length) steps.push('viewer');
  return steps;
}

// Bytes in what a single-chat export downloads: a Blob's size, or a string's UTF-8 length.
function byteSize(content) {
  if (content && typeof content.size === 'number') return content.size;
  return new TextEncoder().encode(String(content == null ? '' : content)).length;
}

// "84 B", "84 KB", "2.1 MB": one decimal below 10, none above.
function sizeText(bytes) {
  const n = Number(bytes) || 0;
  const round = (x) => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${round(n / 1024)} KB`;
  return `${round(n / (1024 * 1024))} MB`;
}

// The This chat card's result line: "Saved Markdown, 84 KB", amber with " · N warnings".
function chatSavedLine(label, bytes, warnings = 0) {
  const text = `Saved ${label}, ${sizeText(bytes)}`;
  return warnings ? { tone: 'warn', text: `${text} · ${warnings} warning${warnings === 1 ? '' : 's'}` } : { tone: 'ready', text };
}

// "Exporting 27 chats and 19 artifacts"; a part whose total isn't known yet goes without a number.
function runTitleText(plan, totals = {}) {
  const part = (key, one) => (Number.isFinite(totals[key]) ? `${totals[key]} ${one}${totals[key] === 1 ? '' : 's'}` : `${one}s`);
  const parts = [];
  if (plan.run === 'bulk') parts.push(part('chats', 'chat'));
  if (plan.run === 'artifacts' || (plan.run === 'bulk' && plan.withArtifacts)) parts.push(part('artifacts', 'artifact'));
  return `Exporting ${parts.join(' and ')}`;
}

// "27 chats and 19 artifacts (49 versions)", from a run result's saved counts.
function savedText(result, plan) {
  const s = result.saved || {};
  const n = (x) => Number(x) || 0;
  const items = [];
  if (plan.run === 'bulk') items.push(`${n(s.chats)} chat${n(s.chats) === 1 ? '' : 's'}`);
  if (plan.run === 'artifacts' || plan.withArtifacts || n(s.artifacts)) {
    const v = n(s.versions);
    items.push(`${n(s.artifacts)} artifact${n(s.artifacts) === 1 ? '' : 's'}${v ? ` (${v} version${v === 1 ? '' : 's'})` : ''}`);
  }
  return items.join(' and ');
}

// "Took 4 min 12 s" / "Took 12 s".
function durationText(startedAt, endedAt) {
  const secs = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) || 0;
  const m = Math.floor(secs / 60);
  return m ? `${m} min ${secs % 60} s` : `${secs} s`;
}

// Export stopped: the reason in words, with the code.
function stoppedReasonText(result, plan) {
  const r = String(result.reason || '').trim() || 'unknown error';
  let m;
  if (r === 'You stopped it') return r;
  if (/^Please navigate to claude\.ai/.test(r)) return 'This tab is not on claude.ai';
  if ((m = /^Could not make a folder there: (.*)$/.exec(r))) return `The folder could not be written (${m[1]})`;
  if ((m = /^Zip generation failed: (.*)$/.exec(r))) return `The ZIP could not be made (${m[1]})`;
  if ((m = /^Export (?:All|Artifacts) failed: (.*)$/.exec(r))) return `The export ran into an error (${m[1]})`;
  if (/^Sign in to claude\.ai/.test(r)) return 'claude.ai says you are signed out';
  if ((m = /^Could not fetch the artifact list: (.*?)\.?$/.exec(r))) return `claude.ai's artifact list could not be loaded (${m[1]})`;
  if (plan && plan.run === 'bulk') return `claude.ai's chat list could not be loaded (${r.replace(/\.$/, '')})`;
  return r;
}

function stoppedSavedText(result, plan) {
  if (result.target.kind === 'zip') return 'Nothing was saved. A ZIP is written only when the export finishes.';
  const s = result.saved || {};
  if (!result.target.name) return 'Nothing was saved.';
  if (!(Number(s.chats) || Number(s.artifacts))) return `Nothing was saved into ${result.target.name}.`;
  const one = (Number(s.chats) || 0) + (Number(s.artifacts) || 0) === 1;
  // Changes only needs Chats, so an artifacts-only run says nothing about it.
  const recorded = plan && plan.run === 'bulk' ? ' They are not recorded, so the next Changes only export takes them again.' : '';
  return `${savedText(result, plan)} ${one ? 'was' : 'were'} saved into ${result.target.name}.${recorded}`;
}

function stoppedFixText(result) {
  const r = String(result.reason || '');
  if (r === 'You stopped it') return 'Try again starts a new export with the same choices.';
  if (/^Could not make a folder there|write/i.test(r)) return 'Check the folder is still there and writable, then try again.';
  if (/^Please navigate to claude\.ai/.test(r)) return 'Open claude.ai in this tab, then try again.';
  if (/^Zip generation failed/.test(r)) return 'The export may be too large for one ZIP. Try Folder, or try again.';
  return 'Check you are signed in to claude.ai and keep its tab open, then try again.';
}

// Counts for the main screen's Count button. Asked for only on a click, never when the panel opens, and kept in
// chrome.storage.session for ten minutes: { [org]: { chats, artifacts, changedChats, changedArtifacts, at } }.
// artifacts and changedArtifacts are null when the artifacts were not counted.
const COUNTS_KEY = 'takeoutCounts';
const COUNTS_MAX_AGE = 600000;

async function readCountsCache() {
  try {
    const stored = await chrome.storage.session.get(COUNTS_KEY);
    const all = stored && stored[COUNTS_KEY];
    return all && typeof all === 'object' ? all : {};
  } catch (e) {
    return {};
  }
}

// True while counts are younger than the cache limit; older ones are still shown but disable nothing.
function countsFresh(c, now = Date.now()) {
  const age = c && typeof c.at === 'string' ? now - Date.parse(c.at) : NaN;
  return age >= 0 && age < COUNTS_MAX_AGE;
}

// A finished export changes what changed: the org's counts are dropped, shown and cached.
async function forgetCounts(org) {
  panel.counts = null;
  try {
    const all = await readCountsCache();
    if (org in all) {
      delete all[org];
      await chrome.storage.session.set({ [COUNTS_KEY]: all });
    }
  } catch (e) { /* nothing cached */ }
}

async function cachedCounts(org) {
  const c = (await readCountsCache())[org];
  const age = c && typeof c.at === 'string' ? Date.now() - Date.parse(c.at) : NaN;
  return age >= 0 && age < COUNTS_MAX_AGE ? c : null;
}

// force: a Count click, which always asks claude.ai; the cache only serves the panel opening.
async function countEverything({ org, tabId, withArtifacts, force = false }) {
  const hit = force ? null : await cachedCounts(org);
  if (hit && (!withArtifacts || hit.artifacts !== null)) return hit;
  const ask = async (message) => {
    let reply;
    try {
      reply = await sendToTab(tabId, message);
    } catch (e) {
      throw new Error('no connection to the claude.ai tab');
    }
    if (!reply || reply.error || reply.connectionError) throw new Error(publishedCode(reply));
    return reply;
  };
  const chatsReply = await ask({ action: 'fetchAllConversations' });
  if (!Array.isArray(chatsReply.data)) throw new Error('bad response');
  const record = await loadExportRecord(org);
  const counts = {
    chats: chatsReply.data.length,
    changedChats: changedSince(chatsReply.data, record && record.chats).length,
    artifacts: null,
    changedArtifacts: null,
    at: new Date().toISOString(),
  };
  if (withArtifacts) {
    const reply = await ask({ action: 'listArtifacts' });
    if (!Array.isArray(reply.frames)) throw new Error('bad response');
    const { artifacts } = artifactsFromList(reply);
    counts.artifacts = artifacts.length;
    counts.changedArtifacts = changedArtifacts(artifacts, record && record.artifacts, record && record.artifactVersions).length;
  }
  try {
    const all = await readCountsCache();
    await chrome.storage.session.set({ [COUNTS_KEY]: { ...all, [org]: counts } });
  } catch (e) { /* the count still counts without a cache */ }
  return counts;
}

// Event listeners with settings-aware filenames
// One export at a time: a second click, or a shortcut, while one runs does nothing,
// and the export buttons are disabled meanwhile.
const EXPORT_BUTTONS = ['exportMd', 'exportMdEmbed', 'exportZip', 'exportJson', 'exportSelected'];
let exportRunning = false;
function exclusiveExport(run) {
  return async (...args) => {
    if (exportRunning) return;
    exportRunning = true;
    const buttons = typeof document === 'undefined' ? [] : EXPORT_BUTTONS.map((id) => document.getElementById(id)).filter(Boolean);
    const before = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      return await run(...args);
    } finally {
      exportRunning = false;
      buttons.forEach((b, i) => { b.disabled = before[i]; });
      finishRun();
    }
  };
}
const onExport = (id, run) => document.getElementById(id).addEventListener('click', exclusiveExport(run));

// The result line in the This chat card, and the card's tone: 'ready' (green), 'warn' (amber), 'error' (red).
function chatResult(tone, text, detail = '') {
  const status = document.getElementById('status');
  status.textContent = text;
  status.title = detail;
  document.getElementById('chatCard').dataset.tone = tone;
}

// A single-chat Markdown or JSON export: its size, and amber when claude.ai's data looks incomplete (chatHealth).
function chatSaved(label, content, data) {
  const problems = chatHealth(data);
  const line = chatSavedLine(label, byteSize(content), problems.length);
  chatResult(line.tone, line.text, problems.map((p) => p.message).join('\n'));
}

async function exportSingle(label, make, errorLabel) {
  if (!conversationData) return;
  try {
    const data = await loadConversationForExport();
    await ensureProjectName(data, orgId);
    const { content, filename, type } = make(data);
    download(content, filename, type);
    chatSaved(label, content, data);
  } catch (e) {
    console.error(`${errorLabel} export error:`, e);
    chatResult('error', 'Export failed: ' + e.message);
  }
}

onExport('exportMd', () => exportSingle('Markdown', (data) => ({
  content: convertToMarkdown(data, { includeThinking: settings.includeThinking }),
  filename: generateFilename(data.name, 'md', data.project?.name),
  type: 'text/markdown',
}), 'Markdown'));

onExport('exportMdEmbed', () => exportSingle('Markdown + files', (data) => ({
  content: convertToMarkdown(data, { embedArtifacts: true, includeThinking: settings.includeThinking }),
  filename: generateFilename(data.name, 'md', data.project?.name, '_embedded'),
  type: 'text/markdown',
}), 'Embedded'));

onExport('exportJson', () => exportSingle('JSON', (data) => ({
  content: JSON.stringify(data, null, 2),
  filename: generateFilename(data.name, 'json', data.project?.name),
  type: 'application/json',
}), 'JSON'));

onExport('exportZip', async () => {
  if (!conversationData) return;
  // Chrome asks for the web-image permission only during a click, so before anything is awaited.
  const webAsk = webImagesOf(conversationData).length ? requestWebImages() : null;
  if (webAsk) await webAsk;

  showProgress(0, 100, 'Initializing...');
  try {
    document.getElementById('status').textContent = 'Creating ZIP…';
    const { data, tabId } = await loadConversationForExport({ withTab: true });
    await ensureProjectName(data, orgId);
    const result = await createZipExport(data, (step, total, message) => {
      showProgress(step, total, message);
    }, tabPublishedFetcher(tabId));
    hideProgress();
    // Warnings: errors.txt's entries (chatHealth's among them) and a viewer that could not be built.
    const warnings = (result.errorCount || 0) + (result.warningCount || 0) + (result.viewerBuilt ? 0 : 1);
    const line = chatSavedLine('ZIP', result.size || 0, warnings);
    const why = result.hasErrors ? ' (see errors.txt)' : warnings ? ' (viewer.html could not be built)' : '';
    chatResult(line.tone, line.text + why);
  } catch (e) {
    hideProgress();
    console.error('Zip export error:', e);
    chatResult('error', 'ZIP export failed: ' + e.message);
  }
});

// The page's width comes from where it runs: 340 px in the popup, the panel's width in the side panel.
const IS_POPUP = typeof location !== 'undefined' && /popup\.html$/.test(location.pathname);
if (typeof document !== 'undefined' && document.body && document.body.classList) document.body.classList.add(IS_POPUP ? 'popup' : 'sidebar');

// ============================================================================
// Screens: main, settings, exporting, done, stopped
// ============================================================================

const SCREENS = ['main', 'settings', 'exporting', 'done', 'stopped'];
function showScreen(name) {
  currentScreen = SCREENS.includes(name) ? name : 'main';
  for (const s of SCREENS) {
    const section = document.getElementById(`screen-${s}`);
    if (section) section.hidden = s !== currentScreen;
  }
  document.getElementById('appHeader').hidden = currentScreen === 'settings';
  // Refresh repaints only the main screen, so it is off wherever it would do nothing.
  document.getElementById('refresh').disabled = ['exporting', 'done', 'stopped'].includes(currentScreen);
  document.getElementById('settingsOpen').disabled = currentScreen === 'exporting';
}

// Back to the main screen; it asks for the tab's chat again (requestData skipped tab changes meanwhile).
function backToMain({ always = true } = {}) {
  showScreen('main');
  if (always || refreshSkipped) return requestData();
  return Promise.resolve();
}

// ---- Everything on claude.ai ----

function currentPlan() {
  return exportPlan({
    chats: settings.exportAllChats !== false,
    artifacts: settings.exportAllArtifacts !== false,
    scope: settings.megaZipScope,
    hasRecord: !!panel.record,
  });
}

// The counts for the summary: none until counted, and none when artifacts are ticked but were not counted.
function summaryCounts(plan) {
  const c = panel.counts;
  if (!c) return null;
  return plan.withArtifacts && c.artifacts === null ? null : c;
}

function setPressed(button, on) {
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function renderEverything() {
  const $ = (id) => document.getElementById(id);
  const plan = currentPlan();
  const since = panel.record && panel.record.at ? formatStamp(panel.record.at) : '';
  const counts = summaryCounts(plan);
  const artifactsOn = settings.exportAllArtifacts !== false;

  // Changes only: hidden with no record of an Export All here, disabled (struck through) with only Artifacts.
  const scopeChanges = $('scopeChanges');
  scopeChanges.hidden = !panel.record;
  scopeChanges.disabled = !!panel.record && !plan.changesAllowed;
  setPressed($('scopeAll'), !plan.changesOnly);
  setPressed(scopeChanges, plan.changesOnly);
  $('pickChats').checked = settings.exportAllChats !== false;
  $('pickArtifacts').checked = artifactsOn;
  $('chatsSub').textContent = artifactsOn ? 'With their files and pages' : 'Pages they published still go in artifacts/';
  const c = panel.counts;
  $('chatCount').textContent = c ? String(plan.changesOnly ? c.changedChats : c.chats) : '–';
  $('artifactCount').textContent = c && c.artifacts !== null ? String(plan.changesOnly ? c.changedArtifacts : c.artifacts) : '–';
  const zip = settings.megaFormat === 'zip';
  setPressed($('formatFolder'), !zip);
  setPressed($('formatZip'), zip);
  // Off claude.ai everything here is disabled.
  for (const id of ['scopeAll', 'pickChats', 'pickArtifacts', 'formatFolder', 'formatZip']) $(id).disabled = !panel.onClaude;
  if (!panel.onClaude) scopeChanges.disabled = true;

  const count = $('countBtn');
  count.disabled = !panel.onClaude || panel.counting;
  count.textContent = panel.counting ? 'Counting…' : c ? `Counted ${formatStamp(c.at).slice(11)}` : 'Count';
  count.className = c && !panel.counting ? 'small-btn counted' : 'small-btn';

  // Counts older than the cache limit still show their numbers, but no longer say Nothing changed or disable Export.
  const fresh = countsFresh(counts);
  const reason = panel.onClaude ? exportDisabledReason(plan, fresh ? counts : null, since) : 'Open claude.ai to export.';
  $('exportSelected').disabled = !!reason || exportRunning;
  const text = panel.onClaude ? everythingSummary({ plan, counts, format: zip ? 'zip' : 'folder', since, isPopup: IS_POPUP, stale: !fresh }) : reason;
  clearTimeout(panel.staleTimer);
  if (counts && fresh) {
    panel.staleTimer = setTimeout(renderEverything, Math.max(0, Date.parse(counts.at) + COUNTS_MAX_AGE - Date.now()) + 1000);
    // Under Node (the tests) the timer must not keep the process alive; browsers have no unref.
    if (panel.staleTimer && typeof panel.staleTimer.unref === 'function') panel.staleTimer.unref();
  }
  $('summary').textContent = panel.flash || (panel.countError ? `Couldn't count (${panel.countError}). ${text}` : text);

  const last = $('lastExport');
  const rec = panel.record;
  last.hidden = !rec || !rec.at;
  const n = rec && Number.isFinite(rec.warnings) ? rec.warnings : null;
  last.textContent = rec && rec.at ? `Last export ${since}${n === null ? '' : ` · ${n ? plural(n, 'warning') : 'no warnings'}`}` : '';
}

// The export record and any cached counts for the tab's org: storage only, never claude.ai.
async function loadEverything() {
  const org = orgId;
  if (org !== panel.countsOrg) {
    panel.counts = null;
    panel.countError = '';
  }
  if (org) {
    const [record, counts] = await Promise.all([loadExportRecord(org), cachedCounts(org)]);
    if (org !== orgId) return;
    panel.record = record;
    if (counts && !panel.counts) panel.counts = counts;
    panel.countsOrg = org;
  } else {
    panel.record = null;
  }
  renderEverything();
}

// A message in place of the summary for 5 seconds ("No folder picked.").
function flashSummary(text) {
  clearTimeout(panel.flashTimer);
  panel.flash = text;
  renderEverything();
  panel.flashTimer = setTimeout(() => {
    panel.flash = '';
    renderEverything();
  }, 5000);
}

document.getElementById('countBtn').addEventListener('click', async () => {
  if (panel.counting || !panel.onClaude || !orgId || currentTabId == null) return;
  const plan = currentPlan();
  panel.counting = true;
  panel.countError = '';
  renderEverything();
  try {
    panel.counts = await countEverything({ org: orgId, tabId: currentTabId, withArtifacts: plan.withArtifacts, force: true });
    panel.countsOrg = orgId;
  } catch (e) {
    panel.countError = (e && e.message) || 'unknown';
  } finally {
    panel.counting = false;
    renderEverything();
  }
});

const setChoice = (change) => {
  change();
  saveSettings();
  renderEverything();
};
document.getElementById('scopeAll').addEventListener('click', () => setChoice(() => { settings.megaZipScope = 'all'; }));
document.getElementById('scopeChanges').addEventListener('click', () => {
  if (document.getElementById('scopeChanges').disabled) return;
  setChoice(() => { settings.megaZipScope = 'changes'; });
});
document.getElementById('pickChats').addEventListener('change', (e) => setChoice(() => { settings.exportAllChats = !!e.target.checked; }));
document.getElementById('pickArtifacts').addEventListener('change', (e) => setChoice(() => { settings.exportAllArtifacts = !!e.target.checked; }));
document.getElementById('formatFolder').addEventListener('click', () => setChoice(() => { settings.megaFormat = 'folder'; }));
document.getElementById('formatZip').addEventListener('click', () => setChoice(() => { settings.megaFormat = 'zip'; }));

// ---- Exporting, Done and Export stopped ----

let activeRun = null;  // { plan, steps, totals, signal } while Export selected runs

function setStep(name, state) {
  document.getElementById(`step-${name}`).setAttribute('data-state', state);
}

function beginRunScreen(plan, directory) {
  const $ = (id) => document.getElementById(id);
  activeRun = { plan, steps: runSteps(plan), totals: {}, signal: { stopped: false }, zip: !directory };
  for (const name of ['chats', 'artifacts', 'viewer']) {
    $(`step-${name}`).hidden = !activeRun.steps.includes(name);
    setStep(name, 'pending');
    $(`step-${name}-count`).textContent = '';
    $(`step-${name}-sub`).textContent = '';
    $(`step-${name}-fill`).style.width = '0%';
  }
  $('runTitle').textContent = runTitleText(plan, activeRun.totals);
  $('runTarget').textContent = directory
    ? `Saving to a new folder in ${artifactText(String(directory.name || 'the folder you picked'))}`
    : 'Saving to one ZIP in Downloads when it finishes';
  $('runWarnings').hidden = true;
  $('runWarnings').textContent = '';
  $('stopBtn').disabled = false;
  $('stopBtn').textContent = 'Stop';
  $('runStarted').textContent = `Started ${formatStamp(new Date().toISOString()).slice(11)}`;
  showScreen('exporting');
  return activeRun;
}

function runProgress(ev) {
  const run = activeRun;
  if (!run || !ev) return;
  const $ = (id) => document.getElementById(id);
  const at = run.steps.indexOf(ev.phase);
  if (at < 0) return;
  if (ev.phase !== 'viewer') run.totals[ev.phase] = ev.total;
  const finished = ev.phase === 'viewer' && ev.done >= ev.total;
  run.steps.forEach((name, i) => setStep(name, i < at || (i === at && finished) ? 'done' : i === at ? 'current' : 'pending'));
  if (ev.phase !== 'viewer') $(`step-${ev.phase}-count`).textContent = `${ev.done} of ${ev.total}`;
  const bar = $(`step-${ev.phase}-bar`);
  bar.setAttribute('aria-valuemax', String(ev.total));
  bar.setAttribute('aria-valuenow', String(ev.done));
  $(`step-${ev.phase}-fill`).style.width = `${ev.total ? Math.min(100, (ev.done / ev.total) * 100) : 0}%`;
  // The last Stop check is passed when the viewer step starts: from here the run finishes, so Stop goes.
  if (ev.phase === 'viewer') $('stopBtn').disabled = true;
  $(`step-${ev.phase}-sub`).textContent = ev.phase === 'viewer' ? (run.zip ? 'Compressing…' : 'Writing the viewer…') : ev.sub || '';
  $('runTitle').textContent = runTitleText(run.plan, run.totals);
  const strip = $('runWarnings');
  strip.hidden = !ev.warnings;
  strip.textContent = ev.warnings ? `${plural(ev.warnings, 'warning')} so far` : '';
}

// The run folder or ZIP name, as soon as the export knows it.
function runTarget(target) {
  if (!activeRun || !target || !target.name) return;
  document.getElementById('runTarget').textContent = `Saving to ${artifactText(target.name)}`;
}

document.getElementById('stopBtn').addEventListener('click', () => {
  if (!activeRun) return;
  activeRun.signal.stopped = true;
  const stop = document.getElementById('stopBtn');
  stop.disabled = true;
  stop.textContent = 'Stopping…';
});

function fillList(list, lines) {
  list.replaceChildren(...lines.map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
}

function showDone(result, plan) {
  const $ = (id) => document.getElementById(id);
  const head = doneHeadline(result);
  $('doneCard').dataset.tone = head.tone;
  $('doneHeadline').textContent = head.text;
  const folder = result.target.kind === 'folder';
  const named = !!result.target.name;
  const what = savedText(result, plan);
  $('doneSummary').textContent = !named ? 'Nothing new to save.' : folder ? `${what} saved to` : `${what} saved.`;
  $('doneTarget').textContent = folder && named ? result.target.name : '';
  $('doneTarget').hidden = !(folder && named);
  $('doneWhere').textContent = named ? doneTargetText(result) : '';
  const groups = warningGroups(result.warningList);
  fillList($('doneWarnings'), [...groups.lines, ...(groups.more ? [`and ${groups.more} more`] : [])]);
  $('doneNotes').textContent = (result.notes || []).join(' ');
  $('doneFileNotes').textContent = doneNotesLine(result);
  const files = (result.errorFiles || []).filter((f) => f === 'errors.txt' || f === 'artifacts/errors.txt');
  // Export All writes a chat's errors.txt in that chat's folder; Export Artifacts writes one at the root.
  const where = plan.run === 'bulk' ? files.map((f) => (f === 'errors.txt' ? "errors.txt in each affected chat's folder" : f)) : files;
  $('doneErrorFiles').textContent = files.length && named ? `What to do about each is in ${where.join(' and in ')} in that ${folder ? 'folder' : 'ZIP'}.` : '';
  $('doneTook').textContent = `Took ${durationText(result.startedAt, result.endedAt)}`;
  showScreen('done');
}

function showStopped(result, plan) {
  const $ = (id) => document.getElementById(id);
  $('stoppedReason').textContent = stoppedReasonText(result, plan);
  $('stoppedSaved').textContent = stoppedSavedText(result, plan);
  $('stoppedFix').textContent = stoppedFixText(result);
  $('stoppedTook').textContent = `Ran ${durationText(result.startedAt, result.endedAt)}`;
  showScreen('stopped');
}

// Export selected: the plan from the main screen's choices, run with the Exporting screen, ending on Done or
// Export stopped. options: { directory } in folder mode, { ask } (card pictures) for an artifacts-only ZIP.
// One Export selected at a time across the popup and every sidebar: navigator.locks is shared by the extension's
// pages, so two runs never overwrite each other's export record. The in-page flag (exportRunning) can't see the others.
const EXPORT_LOCK = 'claude-takeout-export';
async function runSelected(options = {}) {
  const plan = currentPlan();
  if (!plan.run) return null;
  const locks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;
  if (!locks) return runSelectedNow(plan, options);
  return locks.request(EXPORT_LOCK, { ifAvailable: true }, (lock) => {
    if (!lock) {
      flashSummary('Another export is running in the popup or a sidebar. Try again when it ends.');
      return null;
    }
    return runSelectedNow(plan, options);
  });
}

async function runSelectedNow(plan, options) {
  endHandoff();
  const directory = options && options.directory ? options.directory : null;
  const run = beginRunScreen(plan, directory);
  let result;
  try {
    result = plan.run === 'bulk'
      ? await bulkExportZip({ changesOnly: plan.changesOnly, directory, withArtifacts: plan.withArtifacts, onProgress: runProgress, onTarget: runTarget, signal: run.signal })
      : await exportArtifacts({ directory, onProgress: runProgress, onTarget: runTarget, signal: run.signal, ask: options ? options.ask : null });
  } catch (e) {
    result = runResult({ outcome: 'failed', reason: runWarningText((e && e.message) || String(e)), target: { kind: directory ? 'folder' : 'zip', name: '' } });
  }
  activeRun = null;
  if (result && result.outcome === 'done') {
    forgetCounts(orgId);
    showDone(result, plan);
  }
  else showStopped(result || runResult({ outcome: 'failed', reason: 'unknown error' }), plan);
  return result;
}

// Export selected goes to a folder unless ZIP is chosen. The folder picker must open straight from the click.
// The popup closes when it opens, or when the claude.ai tab is clicked, which would end a run inside it, so from
// the popup the side panel opens instead, folder or ZIP, with a note saying what to click there. The note carries
// the choices: { scope, chats, artifacts, format: 'folder' | 'zip' }.
function handoffChoices(format) {
  const plan = currentPlan();
  return { scope: plan.changesOnly ? 'changes' : 'all', chats: plan.run === 'bulk', artifacts: plan.withArtifacts, format };
}
// ask(): optional, called in a ZIP export's click to start a permission request; its promise reaches run as
// options.ask. Folder mode never asks: showDirectoryPicker needs the click's activation, and a request would
// risk it (turn the permission on in Settings instead).
function folderExport(name, run, ask = null) {
  return async () => {
    const zip = settings.megaFormat === 'zip' || typeof window.showDirectoryPicker !== 'function';
    if (IS_POPUP && chrome.sidePanel && chrome.sidePanel.open && currentTabId != null) {
      // The note is stored before the panel opens, in the same click task (sidePanel.open needs the user
      // gesture, so nothing is awaited first). A panel that fails to open takes the note back, so a sidebar
      // opened later doesn't apply it unasked.
      const session = chrome.storage.session;
      if (session) session.set({ folderExportNote: { at: Date.now(), choices: handoffChoices(zip ? 'zip' : 'folder') } }).catch(() => {});
      chrome.sidePanel.open({ tabId: currentTabId }).then(() => window.close())
        .catch((e) => {
          if (session) session.remove('folderExportNote').catch(() => {});
          flashSummary(`Could not open the side panel: ${e.message}`);
        });
      return;
    }
    // A popup without the side panel API runs a ZIP here (it ends if the popup closes).
    if (zip) return ask ? run({ ask: ask() }) : run();
    if (IS_POPUP) {
      flashSummary(`${name} to a folder runs in the side panel. Open it, or choose ZIP.`);
      return;
    }
    let directory;
    try {
      directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'claude-takeout' });
    } catch (e) {
      flashSummary(e.name === 'AbortError' ? 'No folder picked.' : e.message);
      return;
    }
    return run({ directory });
  };
}
const exportSelectedClick = exclusiveExport(folderExport('Export selected', (options) => runSelected(options),
  () => (currentPlan().run === 'artifacts' ? askForCardPictures() : null)));
// The handoff note stays until a run starts (runSelected ends it): a cancelled picker leaves it up.
document.getElementById('exportSelected').addEventListener('click', () => exportSelectedClick());

document.getElementById('doneBack').addEventListener('click', () => backToMain());
document.getElementById('stoppedBack').addEventListener('click', () => backToMain());
// Try again: a new run with the same choices (folder mode opens the picker again, from this click).
// When no run starts (a cancelled picker), the main screen asks for the tab's chat if a tab change was skipped.
document.getElementById('tryAgain').addEventListener('click', async () => {
  showScreen('main');
  const result = await exportSelectedClick();
  if (currentScreen === 'main') await backToMain({ always: false });
  return result;
});

// Opened from the popup's Export selected: take over its choices and say what to do next.
function endHandoff() {
  document.body.classList.remove('handoff');
  document.getElementById('handoffNote').hidden = true;
}
document.getElementById('handoffDismiss').addEventListener('click', endHandoff);

// The note's choices, or null when its shape is wrong (a note from an older version has no choices).
function handoffFrom(note) {
  if (!note || typeof note !== 'object' || !Number.isFinite(note.at) || Date.now() - note.at > 60000) return null;
  const c = note.choices;
  if (!c || typeof c !== 'object' || (c.scope !== 'all' && c.scope !== 'changes') || (c.format !== 'folder' && c.format !== 'zip')) return null;
  if (typeof c.chats !== 'boolean' || typeof c.artifacts !== 'boolean' || (!c.chats && !c.artifacts)) return null;
  return { scope: c.scope, chats: c.chats, artifacts: c.artifacts, format: c.format };
}

// An open sidebar takes a note the popup writes later, the same way.
if (!IS_POPUP && chrome.storage && chrome.storage.session && chrome.storage.session.onChanged) {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes && changes.folderExportNote && changes.folderExportNote.newValue !== undefined) takeHandoff();
  });
}

async function takeHandoff() {
  if (IS_POPUP || !chrome.storage || !chrome.storage.session) return;
  try {
    const got = await chrome.storage.session.get('folderExportNote');
    const note = got && got.folderExportNote;
    if (note === undefined) return;
    chrome.storage.session.remove('folderExportNote').catch(() => {});
    const c = handoffFrom(note);
    if (!c) return;
    settings.megaZipScope = c.scope;
    settings.exportAllChats = c.chats;
    settings.exportAllArtifacts = c.artifacts;
    settings.megaFormat = c.format;
    saveSettings();
    const parts = c.chats && c.artifacts ? 'chats and artifacts' : c.chats ? 'chats' : 'artifacts';
    const choices = `Your choices came along: ${c.scope === 'changes' ? 'Changes only' : 'All'}, ${parts}, ${c.format === 'zip' ? 'ZIP' : 'Folder'}.`;
    document.getElementById('handoffText').textContent = c.format === 'zip'
      ? `Continued from the popup, which closes when you click elsewhere and would stop the export. ${choices} Click Export selected to start.`
      : `Continued from the popup. Chrome lets only the sidebar pick a folder. ${choices} Click Export selected to pick where it goes.`;
    document.getElementById('handoffNote').hidden = false;
    document.body.classList.add('handoff');
    renderEverything();
  } catch (e) { /* no note, no handoff */ }
}

document.getElementById('refresh').addEventListener('click', () => scheduleRefresh());
document.getElementById('chatRetry').addEventListener('click', () => scheduleRefresh());

// ============================================================================
// Settings
// ============================================================================

const defaultSettings = {
  filenameStyle: 'title',
  includeThinking: true,
  megaZipScope: 'all',  // 'all' | 'changes': what Export selected exports (main screen)
  megaFormat: 'folder',  // 'folder' | 'zip': where Export selected goes (main screen)
  exportAllChats: true,  // Export selected takes the chats (main screen)
  exportAllArtifacts: true,  // Export selected takes claude.ai's artifacts (main screen)
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
  renderEverything();
}

// Save web images and artifact card pictures: not a stored setting but Chrome's permission, shown as it stands.
const webImagesBox = document.getElementById('webImages');
if (webImagesBox) {
  webImagesAllowed().then((ok) => { webImagesBox.checked = ok; });
  webImagesBox.addEventListener('change', () => {
    if (webImagesBox.checked) {
      requestWebImages().then((ok) => { webImagesBox.checked = !!ok; });
    } else if (chrome.permissions && chrome.permissions.remove) {
      chrome.permissions.remove(WEB_IMAGE_ORIGINS).catch(() => {});
    }
  });
}

// The Settings screen
// Settings returns to the screen it was opened from: Done and Export stopped stay until Back to export.
let screenBeforeSettings = 'main';
document.getElementById('settingsOpen').addEventListener('click', () => {
  if (currentScreen !== 'settings') screenBeforeSettings = currentScreen;
  showScreen('settings');
});
document.getElementById('settingsBack').addEventListener('click', () => {
  if (screenBeforeSettings === 'done' || screenBeforeSettings === 'stopped') {
    showScreen(screenBeforeSettings);
    return Promise.resolve();
  }
  return backToMain({ always: false });
});
{
  const manifest = chrome.runtime && typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest() : null;
  document.getElementById('versionText').textContent = manifest && manifest.version ? `Version ${manifest.version}` : '';
}
document.getElementById('whatsNew').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/bearspear/claude-takeout#changelog' });
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

// Only on the main screen: the other screens' buttons are hidden.
const SHORTCUT_BUTTONS = { m: 'exportMd', e: 'exportMdEmbed', z: 'exportZip', j: 'exportJson', a: 'exportSelected', r: 'refresh' };
document.addEventListener('keydown', (e) => {
  if (!e.altKey || currentScreen !== 'main') return;
  // The letter typed (e.key) follows the keyboard layout (QWERTZ, AZERTY); on macOS Option+Z types 'Ω', so a key
  // that types no ASCII letter falls back to the key pressed (e.code).
  const typed = String(e.key || '');
  const physical = /^Key([A-Z])$/.exec(String(e.code || ''));
  const letter = /^[a-z]$/i.test(typed) ? typed.toLowerCase() : physical ? physical[1].toLowerCase() : typed.toLowerCase();
  const id = SHORTCUT_BUTTONS[letter];
  if (!id) return;
  document.getElementById(id).click();
  e.preventDefault();
});

// ============================================================================
// Filename Generation with Settings
// ============================================================================

// suffix (such as '_embedded') goes after the title is cut to length, so it is never cut off.
function generateFilename(name, ext, projectName = null, suffix = '') {
  const title = safeFilename(name) + suffix;
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

loadSettings().then(takeHandoff);
requestData();
