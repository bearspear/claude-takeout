# Claude Takeout - Technical Documentation

This document provides a comprehensive technical writeup of how Claude Takeout extracts and processes conversation data from Claude.ai.

## Table of Contents

1. [Data Capture Methods](#data-capture-methods)
2. [JSON Structure Overview](#json-structure-overview)
3. [Message Chain Resolution](#message-chain-resolution)
4. [Content Block Types](#content-block-types)
5. [Artifact Extraction](#artifact-extraction)
6. [File Handling](#file-handling)
7. [Web Search & Citations](#web-search--citations)
8. [Metadata Extraction](#metadata-extraction)

---

## Data Capture Methods

The extension uses two complementary methods to capture conversation data:

### 1. Fetch Interception (Real-time Capture)

**File:** `injected.js`

The extension injects a script into the Claude.ai page that hooks into `window.fetch`:

```javascript
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args);

  // Clone response to read body without consuming it
  const clone = response.clone();
  const url = args[0]?.url || args[0];

  // Intercept conversation data responses
  if (url.includes('/chat_conversations/') && !url.includes('/conversations/')) {
    const data = await clone.json();
    // Post to content script
    window.postMessage({ type: 'CLAUDE_CONVERSATION_DATA', data }, '*');
  }

  return response;
};
```

This captures:
- Full conversation loads (`GET /api/organizations/{orgId}/chat_conversations/{uuid}`)
- Real-time updates as messages stream in

### 2. Direct API Calls (Bulk Export)

**File:** `popup.js`

For bulk export, the extension makes authenticated requests using the user's session cookies:

```javascript
// List all conversations
const listUrl = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;
const response = await fetch(listUrl, { credentials: 'include' });
const conversations = await response.json();

// Fetch each conversation's full data
for (const conv of conversations) {
  const fullUrl = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conv.uuid}`;
  const data = await fetch(fullUrl, { credentials: 'include' }).then(r => r.json());
}
```

---

## JSON Structure Overview

A Claude conversation JSON has this top-level structure:

```javascript
{
  "uuid": "7cdf01ac-dda9-4910-982c-fd498973a1c6",
  "name": "Conversation Title",
  "model": "claude-sonnet-4-5-20250929",           // May be absent
  "created_at": "2025-11-28T17:05:46.423148+00:00",
  "updated_at": "2025-11-28T17:11:07.540785+00:00",
  "current_leaf_message_uuid": "019acb72-5e3e-77e7-97b9-edd3e3040574",
  "is_starred": false,
  "settings": {
    "enabled_web_search": true,
    "paprika_mode": "extended",      // "extended" = extended thinking, "normal" = thinking
    "preview_feature_uses_artifacts": true,
    // ... other feature flags
  },
  "chat_messages": [
    // Array of all messages (including branches)
  ]
}
```

### Key Fields

| Field | Description |
|-------|-------------|
| `uuid` | Unique conversation identifier |
| `name` | Auto-generated or user-set title |
| `model` | Model identifier (e.g., `claude-sonnet-4-5-20250929`) |
| `current_leaf_message_uuid` | Points to the last message in the active branch |
| `settings.paprika_mode` | Thinking mode: `"extended"`, `"normal"`, or absent |
| `chat_messages` | Flat array of ALL messages, including regenerated/branched ones |

---

## Message Chain Resolution

### The Problem

Claude supports message regeneration and conversation branching. The `chat_messages` array contains ALL messages ever created, including abandoned branches. Simply iterating through the array would include orphaned messages.

### The Solution: Tree Traversal

Each message has a `parent_message_uuid` field forming a tree structure:

```javascript
{
  "uuid": "019acb6d-93d9-74b9-836a-d7a259c0d110",
  "parent_message_uuid": "019acb6d-93d9-74b9-836a-d7a11344302d",
  "sender": "assistant",
  // ...
}
```

The `current_leaf_message_uuid` at the conversation level points to the active branch's final message.

**Algorithm:**

```javascript
function getMessageChain(data) {
  const messages = data.chat_messages || [];
  const leafUuid = data.current_leaf_message_uuid;

  // Build lookup maps
  const byUuid = new Map();
  const byParent = new Map();

  for (const msg of messages) {
    byUuid.set(msg.uuid, msg);
    if (!byParent.has(msg.parent_message_uuid)) {
      byParent.set(msg.parent_message_uuid, []);
    }
    byParent.get(msg.parent_message_uuid).push(msg);
  }

  // Find leaf message
  let leaf = byUuid.get(leafUuid);
  if (!leaf) {
    // Fallback: find message with highest index
    leaf = messages.reduce((a, b) => (b.index > a.index ? b : a), messages[0]);
  }

  // Walk backwards to root
  const chain = [];
  let current = leaf;
  while (current) {
    chain.unshift(current);
    current = byUuid.get(current.parent_message_uuid);
  }

  return chain;
}
```

**Root Message Detection:**

The root's parent is always `"00000000-0000-4000-8000-000000000000"` (nil UUID with version 4 marker).

---

## Content Block Types

Each message has a `content` array containing typed blocks:

```javascript
{
  "uuid": "...",
  "sender": "assistant",
  "content": [
    { "type": "thinking", "thinking": "...", "summaries": [...] },
    { "type": "text", "text": "...", "citations": [...] },
    { "type": "tool_use", "name": "web_search", "input": {...} },
    { "type": "tool_result", "name": "web_search", "content": [...] }
  ]
}
```

### Content Block Types Reference

| Type | Description | Key Fields |
|------|-------------|------------|
| `text` | Regular text response | `text`, `citations` |
| `thinking` | Extended thinking block | `thinking`, `summaries`, `cut_off` |
| `tool_use` | Tool invocation | `name`, `input`, `id` |
| `tool_result` | Tool output | `name`, `content`, `tool_use_id` |

### Thinking Blocks

```javascript
{
  "type": "thinking",
  "thinking": "Let me analyze this step by step...",
  "summaries": [
    { "summary": "Analyzing the problem structure" },
    { "summary": "Considering edge cases" }
  ],
  "cut_off": false  // true if thinking was truncated
}
```

The `summaries` array provides Claude's own summarization of the thinking process. The extension uses the last summary for display.

### Tool Use Blocks

Common tools and their input structures:

**Web Search:**
```javascript
{
  "type": "tool_use",
  "name": "web_search",
  "input": { "query": "search terms here" }
}
```

**Artifacts (create/update):**
```javascript
{
  "type": "tool_use",
  "name": "artifacts",
  "input": {
    "command": "create",  // or "update"
    "id": "artifact-id",
    "title": "Document Title",
    "type": "text/markdown",
    "content": "# Markdown content..."
  }
}
```

**File Creation:**
```javascript
{
  "type": "tool_use",
  "name": "create_file",
  "input": {
    "filename": "script.py",
    "content": "print('hello')"
  }
}
```

### Tool Result Blocks

Tool results contain nested content arrays:

```javascript
{
  "type": "tool_result",
  "name": "web_search",
  "content": [
    {
      "type": "knowledge",
      "title": "Page Title",
      "url": "https://example.com/page",
      "text": "Extracted content...",
      "is_citable": true,
      "metadata": {
        "site_domain": "example.com",
        "site_name": "Example Site"
      }
    }
  ]
}
```

---

## Artifact Extraction

Artifacts can come from two tool types:

### 1. `artifacts` Tool (Newer)

```javascript
function extractArtifacts(data) {
  const artifacts = {};

  for (const msg of data.chat_messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'artifacts') {
        const input = block.input || {};
        if (input.content && (input.id || input.title)) {
          // Map content type to file extension
          const ext = contentTypeToExt[input.type] || '.txt';
          const filename = sanitize(input.title || input.id) + ext;
          artifacts[filename] = input.content;
        }
      }
    }
  }

  return artifacts;
}
```

### 2. `create_file` Tool (Older)

```javascript
if (block.type === 'tool_use' && block.name === 'create_file') {
  const filename = block.input?.filename;
  const content = block.input?.content;
  if (filename && content) {
    artifacts[filename] = content;
  }
}
```

### Content Type Mapping

```javascript
const typeToExt = {
  'text/markdown': '.md',
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/json': '.json',
  'text/x-python': '.py',
  'text/x-typescript': '.ts',
  'image/svg+xml': '.svg',
  // ... 24+ mappings
};
```

---

## File Handling

Claude conversations can contain four types of files:

### 1. Text Attachments (`msg.attachments`)

Pasted text files with extracted content:

```javascript
{
  "attachments": [
    {
      "file_name": "notes.txt",
      "extracted_content": "The full text content...",
      "file_size": 1234
    }
  ]
}
```

**Extraction:**

```javascript
function extractTextAttachments(data) {
  const attachments = {};
  const binaryExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', ...];

  for (const msg of data.chat_messages) {
    for (const att of msg.attachments || []) {
      let filename = att.file_name;
      const content = att.extracted_content;

      // Binary files only have extracted text - save as .txt
      const ext = path.extname(filename).toLowerCase();
      if (binaryExtensions.includes(ext)) {
        filename = filename.replace(/\.[^.]+$/, '.txt');
      }

      attachments[filename] = content;
    }
  }

  return attachments;
}
```

### 2. Uploaded Files (`msg.files_v2`)

Files uploaded via drag-drop or file picker:

```javascript
{
  "files_v2": [
    {
      "file_name": "image.png",
      "file_uuid": "d1c813c4-0661-4353-a8af-d103ce4d914a",
      "file_kind": "image",  // "image", "document", "blob"
      "success": true,
      "created_at": "2026-01-04T02:08:30.812633+00:00",
      "image_asset": {
        "url": "https://..."  // May be absent!
      },
      "document_asset": {
        "url": "https://...",
        "page_count": 5
      }
    }
  ]
}
```

**URL Resolution Strategy:**

The `image_asset.url` or `document_asset.url` may be:
- Present and valid (signed URL)
- Present but expired
- Completely absent

**Download Strategy (Priority Order):**

```javascript
async function fetchUploadedFile(url, fileUuid, orgId, conversationId, filePath) {
  const urlsToTry = [];

  // 1. Primary URL from JSON (if present)
  if (url) urlsToTry.push(url);

  // 2. Wiggle endpoint - works for ALL file types including blobs!
  if (orgId && conversationId && filePath) {
    const encodedPath = encodeURIComponent(filePath);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodedPath}`);
  }

  // 3. File UUID-based endpoints
  if (fileUuid && orgId) {
    urlsToTry.push(`https://claude.ai/api/${orgId}/files/${fileUuid}/preview`);
    urlsToTry.push(`https://claude.ai/api/${orgId}/files/${fileUuid}/content`);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/files/${fileUuid}/content`);
  }

  for (const tryUrl of urlsToTry) {
    const response = await fetch(tryUrl, { credentials: 'include' });
    if (response.ok) return await response.blob();
  }

  throw new Error('All API URLs failed');
}
```

**Final Fallback - JSON Extraction:**

If all API endpoints fail for blob files, the extension falls back to extracting content from the JSON (tool results where Claude read the file).

### 3. Blob Files (Ephemeral)

CSV, text files, and other "blob" types are **ephemeral** - they exist only during the active session:

```javascript
{
  "file_kind": "blob",
  "path": "/mnt/user-data/uploads/data.csv"
  // No URL available - file is deleted after session
}
```

**Content Recovery from Tool Results:**

When Claude reads a blob file, the content appears in tool results:

```javascript
{
  "type": "tool_result",
  "name": "view",
  "content": [
    {
      "type": "text",
      "text": "Here's the content of /mnt/user-data/uploads/data.csv:\n     1\tname,value\n     2\tfoo,123\n..."
    }
  ]
}
```

**Extraction Algorithm:**

```javascript
function extractBlobContent(data, blobPath) {
  for (const msg of data.chat_messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.name === 'view') {
        for (const content of block.content) {
          if (content.text?.includes(blobPath)) {
            // Parse out line numbers and extract raw content
            const lines = content.text.split('\n');
            return lines
              .filter(l => l.match(/^\s*\d+\t/))
              .map(l => l.replace(/^\s*\d+\t/, ''))
              .join('\n');
          }
        }
      }
    }
  }
  return null;
}
```

### 4. Project Files (`/mnt/project/`)

When a conversation is part of a Claude Project, project files may be accessed during the conversation. These are stored at `/mnt/project/` and accessed via the `view` tool:

```javascript
// Tool use to read project file
{
  "type": "tool_use",
  "name": "view",
  "input": { "path": "/mnt/project/research_notes.md" }
}

// Tool result with file content
{
  "type": "tool_result",
  "name": "view",
  "content": [
    {
      "type": "text",
      "text": "Here's the content of /mnt/project/research_notes.md with line numbers:\n     1\t# Research Notes\n     2\t\n     3\tKey findings..."
    }
  ]
}
```

**Key Differences from Blob Files:**

| Aspect | Blob Files | Project Files |
|--------|------------|---------------|
| Path | `/mnt/user-data/uploads/` | `/mnt/project/` |
| Persistence | Ephemeral (session only) | Persistent (project lifetime) |
| API Access | Wiggle endpoint works | Not downloadable via API |
| Recovery | API or JSON fallback | JSON only (tool results) |

**Extraction Algorithm:**

```javascript
function extractProjectFiles(data) {
  const projectFiles = {};

  for (const msg of data.chat_messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.name === 'view') {
        for (const content of block.content) {
          // Match project file content header
          const match = content.text?.match(
            /^Here's the content of (\/mnt\/project\/[^\s]+) with line numbers:/
          );

          if (match) {
            const filePath = match[1];
            const filename = filePath.split('/').pop();

            // Extract content by parsing line numbers
            const lines = content.text.split('\n');
            const contentLines = lines
              .filter(l => l.match(/^\s*\d+\t/))
              .map(l => l.replace(/^\s*\d+\t/, ''));

            projectFiles[filename] = contentLines.join('\n');
          }
        }
      }
    }
  }

  return projectFiles;
}
```

**Note:** Only project files that Claude actually read during the conversation are recoverable. Files that exist in the project but weren't accessed won't appear in the export.

---

## Web Search & Citations

### Web Search Results

Web search tool results contain `knowledge` blocks:

```javascript
{
  "type": "tool_result",
  "name": "web_search",
  "content": [
    {
      "type": "knowledge",
      "title": "Article Title",
      "url": "https://example.com/article",
      "text": "Relevant excerpt...",
      "is_citable": true,
      "is_missing": false,
      "metadata": {
        "site_domain": "example.com",
        "site_name": "Example News"
      }
    }
  ]
}
```

**Source Extraction:**

```javascript
function extractWebSources(data) {
  const sources = [];
  const seenUrls = new Set();

  for (const msg of data.chat_messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.name === 'web_search') {
        for (const item of block.content) {
          if (item.type === 'knowledge' && item.url && !seenUrls.has(item.url)) {
            seenUrls.add(item.url);
            sources.push({
              title: item.title,
              url: item.url,
              domain: item.metadata?.site_domain,
              siteName: item.metadata?.site_name,
              isCitable: item.is_citable !== false,
              isMissing: item.is_missing === true
            });
          }
        }
      }
    }
  }

  return sources;
}
```

### Citation Processing

Text blocks may contain citations referencing web search results:

```javascript
{
  "type": "text",
  "text": "According to research, the sky is blue.",
  "citations": [
    {
      "start": 24,
      "end": 42,
      "url": "https://example.com/sky",
      "title": "Why is the Sky Blue?"
    }
  ]
}
```

**Citation Conversion to Footnotes:**

```javascript
function processTextWithCitations(text, citations) {
  // Sort citations by position (reverse order for safe replacement)
  const sorted = [...citations].sort((a, b) => b.start - a.start);

  const references = [];
  let processedText = text;

  for (const cite of sorted) {
    const refNum = references.length + 1;

    // Insert footnote marker after cited text
    const before = processedText.slice(0, cite.end);
    const after = processedText.slice(cite.end);
    processedText = `${before}[[${refNum}]](#ref-${refNum})${after}`;

    references.push({
      num: refNum,
      url: cite.url,
      title: cite.title
    });
  }

  return { text: processedText, references };
}
```

---

## Metadata Extraction

### Model Name Parsing

The `model` field contains raw identifiers like `claude-sonnet-4-5-20250929`:

```javascript
function getModelName(data) {
  if (data.model) {
    const model = data.model.toLowerCase();

    // Extract variant
    let variant = '';
    if (model.includes('opus')) variant = 'Opus';
    else if (model.includes('sonnet')) variant = 'Sonnet';
    else if (model.includes('haiku')) variant = 'Haiku';

    // Extract version (e.g., "4-5" -> "4.5")
    const versionMatch = model.match(/(\d+)-(\d+)/);
    const version = versionMatch ? ` ${versionMatch[1]}.${versionMatch[2]}` : '';

    if (variant) return `Claude${version} ${variant}`;
    return data.model;
  }

  // Fallback to settings-based detection
  const paprika = data.settings?.paprika_mode;
  if (paprika === 'extended') return 'Claude (extended thinking)';
  if (paprika === 'normal') return 'Claude (thinking)';

  return 'Claude';
}
```

### Feature Detection

```javascript
function getFeatures(data) {
  const features = [];

  if (data.settings?.enabled_web_search) {
    features.push('Web Search');
  }

  if (data.settings?.preview_feature_uses_artifacts) {
    features.push('Artifacts');
  }

  if (data.settings?.paprika_mode === 'extended') {
    features.push('Extended Thinking');
  } else if (data.settings?.paprika_mode === 'normal') {
    features.push('Thinking');
  }

  return features;
}
```

### Duration Calculation

```javascript
function getDuration(messages) {
  if (messages.length < 2) return null;

  const first = messages[0];
  const last = messages[messages.length - 1];

  const start = new Date(first.created_at);
  const end = new Date(last.created_at);
  const diffMs = end - start;

  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
```

---

## File Generation Pipeline

### ZIP Export Structure

```
conversation_claude-chat.zip
├── README.md              <- Table of contents with links
├── meta.md                <- Statistics and metadata table
├── prompts.md             <- All user messages with anchor links
├── responses_text_only.md <- Pure text responses (no thinking/tools)
├── full_chat.md           <- Complete conversation
├── integrated_chat.md     <- Markdown artifacts inline (no code blocks)
├── code_snippets.md       <- Extracted code blocks
├── links_and_sources.md   <- URLs and web sources by domain
├── original.json          <- Raw API response
├── responses/
│   ├── 001_title_response.md      <- Pure text
│   └── 001_title_response.full.md <- With thinking/tools/artifacts
├── artefacts/
│   └── {extracted artifacts}
├── attachments/
│   └── {pasted text files}
├── project/
│   └── {project files viewed during conversation}
└── uploads/
    └── {downloaded PDFs/images}
```

### Processing Order

1. **Parse JSON** - Load and validate structure
2. **Resolve message chain** - Follow `parent_message_uuid` from leaf
3. **Extract artifacts** - From `artifacts` and `create_file` tool uses
4. **Extract attachments** - From `msg.attachments` with `extracted_content`
5. **Extract project files** - From `view` tool results for `/mnt/project/` paths
6. **Extract uploaded files** - From `msg.files_v2`, download via API
7. **Extract web sources** - From `web_search` tool results
8. **Process content** - Convert each block type to markdown
9. **Generate files** - Create all markdown files and ZIP

---

## Security Considerations

### Authentication

The extension uses the user's existing Claude.ai session:
- No API keys stored
- `credentials: 'include'` sends session cookies
- Only works when logged into claude.ai

### Data Handling

- All processing happens locally in the browser
- No external servers contacted
- Downloaded files go directly to user's downloads folder
- Original JSON preserved for verification

### Content Security

- File content is escaped for markdown code blocks
- Dynamic fence selection (``` vs ````) prevents injection
- Filenames are sanitized before use in paths

---

## Limitations

1. **Blob files** - Only recoverable if Claude read them during the conversation
2. **Project files** - Only files that Claude read during the conversation are exported (not all project files)
3. **Expired URLs** - Signed URLs for images/PDFs may expire; fallback URLs attempted
4. **Rate limiting** - Bulk export adds 300ms delay between requests
5. **Large conversations** - Very long conversations may be slow to process
6. **Branched content** - Only the active branch is exported; other branches are ignored

---

## API Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/organizations/{orgId}/chat_conversations` | GET | List all conversations |
| `/api/organizations/{orgId}/chat_conversations/{uuid}` | GET | Get full conversation |
| `/api/organizations/{orgId}/conversations/{convId}/wiggle/download-file?path={path}` | GET | Download any file by path (including blobs) |
| `/api/{orgId}/files/{uuid}/preview` | GET | Download file (images) |
| `/api/{orgId}/files/{uuid}/content` | GET | Download file (alternative) |
| `/api/organizations/{orgId}/files/{uuid}/content` | GET | Download file (PDFs) |

All endpoints require session authentication via cookies.

### Wiggle Endpoint

The `wiggle/download-file` endpoint is particularly useful as it:
- Works with the file's path (e.g., `/mnt/user-data/uploads/file.csv`)
- Can download blob files that other endpoints cannot access
- Requires both the organization ID and conversation UUID
- Path must be URL-encoded
