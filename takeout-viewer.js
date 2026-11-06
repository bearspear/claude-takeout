// Claude Takeout - offline viewer data builder
// Classic script. Exposes globalThis.CTViewer (and module.exports for tests):
//   buildViewerChat(data, ctx)         one conversation as the viewer's compact Chat (see the data contract).
//                                      ctx: { folder, model, fixText, artifacts, artifactIndex, uploads,
//                                      deliveries, project }, all optional. data is never mutated.
//   buildViewerData(chats, {exported}) { exported, chats }, newest update first
//   relHref(...parts)                  URL-encoded relative link, or null when a part escapes upward
//   joinPath(folder, rel)              folder + rel with '..' resolved
//   escapeJson(data)                   JSON that is safe inside a <script> tag
//   assembleViewer({template, css, marked, katex, logic, app, data})  one self-contained HTML string
//   VIEWER_ASSETS                      paths of the six viewer files
//   TOOL_TEXT_LIMIT                    longest tool result text kept
(function (root) {
  'use strict';

  const TOOL_TEXT_LIMIT = 20000;
  const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

  const VIEWER_ASSETS = [
    'viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js',
    'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css'
  ];

  function cut(text) {
    const s = String(text == null ? '' : text);
    return s.length > TOOL_TEXT_LIMIT
      ? s.slice(0, TOOL_TEXT_LIMIT) + `\n[... truncated: ${s.length - TOOL_TEXT_LIMIT} more characters]`
      : s;
  }

  // Tool input with long strings cut, so a whole file body in create_file does not bloat the page.
  function compactInput(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (const k of Object.keys(input)) out[k] = typeof input[k] === 'string' ? cut(input[k]) : input[k];
    return out;
  }

  function toolLabel(name, input) {
    const i = input && typeof input === 'object' ? input : {};
    const p = i.path || i.file_path || '';
    switch (name) {
      case 'web_search': return i.query ? `Searched the web: ${i.query}` : 'Searched the web';
      case 'web_fetch': return i.url ? `Fetched ${i.url}` : 'Fetched a page';
      case 'bash_tool': case 'Bash': return 'Ran a command';
      case 'create_file': case 'Write': return p ? `Created ${p}` : 'Created a file';
      case 'str_replace': case 'Edit': case 'str_replace_based_edit_tool': return p ? `Edited ${p}` : 'Edited a file';
      case 'view': case 'read_file': case 'Read': return p ? `Viewed ${p}` : 'Viewed a file';
      case 'present_files': return 'Presented files';
      case 'artifacts': return i.title ? `Artifact: ${i.title}` : 'Artifact';
      default: return `Used ${name || 'a tool'}`;
    }
  }

  function resultParts(content) {
    const items = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    const texts = [];
    const images = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'text' && typeof it.text === 'string') texts.push(it.text);
      else if (it.type === 'image' && it.source && it.source.type === 'base64' &&
               SAFE_IMAGE.test(String(it.source.media_type)) && /^[A-Za-z0-9+/=\s]*$/.test(String(it.source.data))) {
        images.push(`data:${it.source.media_type};base64,${it.source.data}`);
      }
    }
    return { text: cut(texts.join('\n')), images };
  }

  function buildCites(citations) {
    if (!Array.isArray(citations)) return [];
    return citations
      .filter(c => c && /^https?:\/\//i.test(String(c.url)))
      .map(c => ({ end: c.end_index, url: String(c.url), title: c.title || 'Source' }))
      .sort((a, b) => a.end - b.end);
  }

  // Same rule as getThinkingSummary in popup.js.
  function thinkingSummary(block) {
    const s = Array.isArray(block.summaries) ? block.summaries : [];
    if (s.length && s[s.length - 1].summary) return s[s.length - 1].summary;
    const first = String(block.thinking || '').split('\n')[0];
    return first.length > 80 ? first.substring(0, 77) + '...' : first;
  }

  function buildViewerChat(data, ctx) {
    const c = ctx || {};
    const fix = typeof c.fixText === 'function' ? c.fixText : (s => s);
    const source = Array.isArray(data.chat_messages) ? data.chat_messages : [];

    // tool_use_id -> tool block, across every message, so a result can land in an earlier message's block.
    const toolById = new Map();
    const messages = source.map(m => {
      const blocks = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === 'text') blocks.push({ t: 'text', text: String(b.text || ''), cites: buildCites(b.citations) });
        else if (b.type === 'thinking') blocks.push({ t: 'thinking', text: String(b.thinking || ''), summary: thinkingSummary(b) });
        else if (b.type === 'tool_use') {
          const input = compactInput(b.input);
          const tool = { t: 'tool', name: b.name || '', label: toolLabel(b.name, b.input), input, result: '', error: false, images: [] };
          blocks.push(tool);
          if (b.id != null) toolById.set(b.id, tool);
        }
      }
      return {
        id: m.uuid, parent: m.parent_message_uuid || null, sender: m.sender, at: m.created_at,
        blocks, uploads: [],
        attachments: (m.attachments || []).map(a => ({ name: a.file_name || '', text: fix(a.extracted_content || '') }))
      };
    });

    // Second pass: results may precede nothing, follow in the same message, or arrive in a later one.
    for (const m of source) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== 'tool_result') continue;
        const tool = toolById.get(b.tool_use_id);
        if (!tool) continue;
        const { text, images } = resultParts(b.content);
        tool.result = text;
        tool.images = images;
        tool.error = !!b.is_error;
      }
    }

    return {
      id: data.uuid, title: data.name || '', model: c.model || data.model || '',
      created: data.created_at, updated: data.updated_at, leaf: data.current_leaf_message_uuid || null,
      messages, files: {}, project: null
    };
  }

  function buildViewerData(chats, { exported } = {}) {
    return { exported, chats: chats.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))) };
  }

  // Each '/'-separated part is encoded per segment. '..' or '.' anywhere: null (never leave the export).
  function relHref(...parts) {
    const segs = [];
    for (const p of parts) {
      if (p == null) return null;
      for (const s of String(p).split('/')) {
        if (s === '') continue;
        if (s === '.' || s === '..') return null;
        segs.push(encodeURIComponent(s));
      }
    }
    return segs.length ? segs.join('/') : null;
  }

  function joinPath(folder, rel) {
    const out = [];
    for (const s of `${folder || ''}/${rel || ''}`.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return out.join('/');
  }

  function escapeJson(data) {
    return JSON.stringify(data)
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '\\u003c!--')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  // One pass with function replacers: '$&' or a placeholder inside a value stays literal.
  // data: object (escaped here) or an already-escaped JSON string.
  function assembleViewer({ template, css, marked, katex, logic, app, data }) {
    const script = code => String(code).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
    const values = {
      KATEX_CSS: () => String(css).replace(/<\/style/gi, '<\\/style'),
      DATA_JSON: () => (typeof data === 'string' ? data : escapeJson(data)),
      MARKED_JS: () => script(marked),
      KATEX_JS: () => script(katex),
      LOGIC_JS: () => script(logic),
      APP_JS: () => script(app)
    };
    return String(template).replace(/\/\*(KATEX_CSS|DATA_JSON|MARKED_JS|KATEX_JS|LOGIC_JS|APP_JS)\*\//g, (m, k) => values[k]());
  }

  const api = { buildViewerChat, buildViewerData, relHref, joinPath, escapeJson, assembleViewer, VIEWER_ASSETS, TOOL_TEXT_LIMIT };
  root.CTViewer = Object.assign(root.CTViewer || {}, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
