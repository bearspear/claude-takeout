// Popup script - handles export UI

let conversationData = null;
let orgId = null;

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

// Fix mojibake in text
function fixMojibake(text) {
  if (!text) return text;

  // Build map on first use
  if (!mojibakeMap) {
    mojibakeMap = buildMojibakeMap();
  }

  // Sort by length (longest first) to handle multi-char sequences properly
  const sortedKeys = Object.keys(mojibakeMap).sort((a, b) => b.length - a.length);

  for (const broken of sortedKeys) {
    text = text.split(broken).join(mojibakeMap[broken]);
  }

  return text;
}

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

// ============================================================================
// Priority 1 Fixes: Core improvements matching claude_json_to_md.py
// ============================================================================

// Get appropriate code fence based on content (uses 4 backticks if content has 3)
function getCodeFence(content) {
  if (content && content.includes('```')) {
    return '````';
  }
  return '```';
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
function extractArtifacts(data) {
  const artifacts = {};
  const messages = data.chat_messages || [];

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

  for (const msg of messages) {
    for (const block of (msg.content || [])) {
      if (block.type === 'tool_use') {
        const input = block.input || {};

        // Handle create_file tool
        if (block.name === 'create_file') {
          const path = input.path || '';
          const fileText = input.file_text || '';

          if (path && fileText) {
            const filename = path.split('/').pop();
            artifacts[filename] = fileText;
          }
        }

        // Handle artifacts tool (command: create/update)
        if (block.name === 'artifacts' && (input.command === 'create' || input.command === 'update')) {
          const content = input.content || '';
          const id = input.id || '';
          const title = input.title || '';
          const type = input.type || 'text/plain';

          if (content && (id || title)) {
            // Determine extension from type
            let ext = typeToExt[type] || '.txt';

            // Use title if available, otherwise id
            let baseName = title || id;
            // Sanitize filename
            baseName = baseName.replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_').substring(0, 60);

            // Add extension if not already present
            const filename = baseName.endsWith(ext) ? baseName : baseName + ext;
            artifacts[filename] = content;
          }
        }
      }
    }
  }

  return artifacts;
}

// Extract text attachments from messages (pasted files with extracted_content)
// Returns { attachments: { filename -> content }, idToFilename: { id -> filename } }
function extractTextAttachments(data) {
  const attachments = {};
  const idToFilename = {};  // Maps attachment id to final filename
  const messages = data.chat_messages || [];
  let unnamedCounter = 1;

  // Binary file extensions that should be changed to .txt when we only have extracted text
  const binaryExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'];

  for (const msg of messages) {
    for (const att of (msg.attachments || [])) {
      let filename = att.file_name || '';
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
    }
  }

  return { attachments, idToFilename };
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

// Extract uploaded file metadata from messages (PDFs, images, CSVs, etc. in files_v2)
function extractUploadedFiles(data, organizationId = null) {
  const files = [];
  const messages = data.chat_messages || [];

  for (const msg of messages) {
    for (const file of (msg.files_v2 || [])) {
      if (file.success && file.file_name) {
        const fileInfo = {
          filename: file.file_name,
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
  }

  return files;
}

// Fetch project metadata and documents list from API
// Returns { files: array of { uuid, filename, content }, docsJson: raw docs API response, projectJson: raw project API response }
async function fetchProjectDocs(data, organizationId) {
  const projectUuid = data.project_uuid || data.project?.uuid;
  if (!projectUuid || !organizationId) {
    return { files: [], docsJson: null, projectJson: null };
  }

  let projectJson = null;

  try {
    // Fetch project metadata
    const projectUrl = `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}`;
    const projectResponse = await fetch(projectUrl, { credentials: 'include' });
    if (projectResponse.ok) {
      projectJson = await projectResponse.json();
      console.log(`Fetched project metadata: ${projectJson.name || projectUuid}`);
    } else {
      console.log(`Failed to fetch project metadata: ${projectResponse.status}`);
    }
  } catch (e) {
    console.log(`Error fetching project metadata: ${e.message}`);
  }

  try {
    // Fetch list of project docs
    const listUrl = `https://claude.ai/api/organizations/${organizationId}/projects/${projectUuid}/docs`;
    const listResponse = await fetch(listUrl, { credentials: 'include' });
    if (!listResponse.ok) {
      console.log(`Failed to fetch project docs list: ${listResponse.status}`);
      return { files: [], docsJson: null, projectJson };
    }

    const docs = await listResponse.json();
    if (!Array.isArray(docs) || docs.length === 0) {
      return { files: [], docsJson: docs, projectJson };
    }

    console.log(`Found ${docs.length} project docs`);

    // Extract content from docs - check if already in list response first
    const projectFiles = [];
    for (const doc of docs) {
      const docUuid = doc.uuid;
      const filename = doc.file_name || doc.filename || doc.name || `doc_${docUuid}.txt`;

      // Check if content is already in the docs list response
      let content = doc.content || doc.text || doc.body || null;

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
              break;
            }
          } catch (e) {
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
      }
    }

    return { files: projectFiles, docsJson: docs, projectJson };
  } catch (e) {
    console.error('Error fetching project docs:', e);
    return { files: [], docsJson: null, projectJson };
  }
}

// Extract blob file content from view tool results in the conversation
// Blob files are ephemeral and can't be downloaded, but their content appears in tool results
function extractBlobContent(data, blobPath) {
  const messages = data.chat_messages || [];

  for (const msg of messages) {
    for (const item of (msg.content || [])) {
      // Look for tool_result from "view" that read this file
      if (item.type === 'tool_result' && item.name === 'view') {
        for (const content of (item.content || [])) {
          if (content.type === 'text' && content.text) {
            // Check if this tool result is for our file
            // The text starts with "Here's the content of {path} with line numbers:"
            if (content.text.includes(blobPath) ||
                content.text.includes(blobPath.replace(/ /g, '_'))) {
              // Extract the actual content (skip the header line and line numbers)
              const lines = content.text.split('\n');
              // Find where the actual content starts (after "Here's the content of...")
              let startIdx = 0;
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(/^\s*\d+\t/)) {
                  startIdx = i;
                  break;
                }
              }
              // Remove line number prefixes and reconstruct content
              const contentLines = lines.slice(startIdx).map(line => {
                // Format is "    123\tActual content here"
                const match = line.match(/^\s*\d+\t(.*)$/);
                return match ? match[1] : line;
              });
              // Apply mojibake fix to repair encoding issues
              return fixMojibake(contentLines.join('\n'));
            }
          }
        }
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

// Fetch a file from Claude's API with fallback URLs
// Returns { blob, fromApi: true } or throws if all API attempts fail
async function fetchUploadedFile(url, fileUuid = null, orgId = null, conversationId = null, filePath = null) {
  const urlsToTry = [];

  // Primary URL (if provided and not empty)
  if (url) {
    const fullUrl = url.startsWith('http') ? url : `https://claude.ai${url}`;
    urlsToTry.push(fullUrl);
  }

  // Wiggle endpoint using conversation ID and file path (works for blobs too!)
  if (orgId && conversationId && filePath) {
    const encodedPath = encodeURIComponent(filePath);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodedPath}`);
  }

  // Fallback URLs using file UUID if available
  if (fileUuid && orgId) {
    urlsToTry.push(`https://claude.ai/api/${orgId}/files/${fileUuid}/preview`);
    urlsToTry.push(`https://claude.ai/api/${orgId}/files/${fileUuid}/content`);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/files/${fileUuid}/content`);
    urlsToTry.push(`https://claude.ai/api/organizations/${orgId}/files/${fileUuid}`);
  }

  if (urlsToTry.length === 0) {
    throw new Error('No URL or path available to fetch file');
  }

  let lastError = null;
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
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Failed to fetch file (${lastStatus || lastError?.message || 'unknown error'}). Tried ${urlsToTry.length} URLs.`);
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
  clean = clean.replace(/[^\w\s-]/g, '').replace(/[\s-]+/g, '_');
  clean = clean.replace(/^_+|_+$/g, '').toLowerCase();
  return clean.substring(0, maxLen) || 'untitled';
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
function generateMeta(data, messages, artifacts, codeBlocks, urls, textAttachments = {}, projectFiles = {}, uploadedFiles = [], webSources = []) {
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
  if (settings.enabled_web_search) features.push('Web Search');
  if (settings.preview_feature_uses_artifacts) features.push('Artifacts');
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
    `| **Project Files** | ${Object.keys(projectFiles).length} |`,
    `| **Uploaded Files** | ${uploadedFiles.length} |`,
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
function generatePrompts(messages, responseFiles, attachmentIdMap = {}) {
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
        const filename = (attId && attachmentIdMap[attId]) ? attachmentIdMap[attId] : (att.file_name || 'unknown');
        lines.push(`- [${filename}](attachments/${encodeURIComponent(filename)})`);
      }
      lines.push('');
    }

    // Check for uploaded files (PDFs, images)
    const uploads = (msg.files_v2 || []).filter(f => f.success && f.file_name);
    if (uploads.length > 0) {
      lines.push('**Uploaded Files:**');
      for (const file of uploads) {
        const pageInfo = file.document_asset?.page_count ? ` (${file.document_asset.page_count} pages)` : '';
        lines.push(`- [${file.file_name}](uploads/${encodeURIComponent(file.file_name)})${pageInfo}`);
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
    lines.push(`## Snippet ${i + 1} (${block.lang})`);
    lines.push('');
    lines.push(`\`\`\`${block.lang}`);
    lines.push(block.code);
    lines.push('```');
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
async function populateConversationFolder(folder, data, onProgress = null, organizationId = null) {
  const title = data.name || 'Claude Conversation';
  const messages = getMessageChain(data);
  const artifacts = extractArtifacts(data);
  const { attachments: textAttachments, idToFilename: attachmentIdMap } = extractTextAttachments(data);
  const uploadedFiles = extractUploadedFiles(data, organizationId);
  const webSources = extractWebSources(data);

  // Fetch project files: try API first (full files), fall back to view tool results (truncated)
  let projectFiles = {};
  let projectFilesFromApi = false;
  let projectDocsJson = null;
  let projectMetadataJson = null;
  if (data.project_uuid || data.project?.uuid) {
    if (onProgress) onProgress('Fetching project files...');
    const { files: apiDocs, docsJson, projectJson } = await fetchProjectDocs(data, organizationId);
    projectDocsJson = docsJson;
    projectMetadataJson = projectJson;
    if (apiDocs.length > 0) {
      projectFilesFromApi = true;
      for (const doc of apiDocs) {
        projectFiles[doc.filename] = doc.content;
      }
      console.log(`Fetched ${apiDocs.length} project files from API`);
    }
  }
  // Fall back to extracted view tool results if API didn't return files
  if (Object.keys(projectFiles).length === 0) {
    projectFiles = extractProjectFiles(data);
  }

  // Collect all text for extraction
  let allText = '';
  for (const msg of messages) {
    allText += extractTextContent(msg.content) + '\n\n';
  }
  for (const content of Object.values(artifacts)) {
    allText += content + '\n\n';
  }

  const codeBlocks = extractCodeBlocks(allText);
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
        } else if (toolName === 'create_file') {
          const filename = (input.path || '').split('/').pop();
          const fileText = input.file_text || '';
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
        } else if (toolName === 'artifacts' && (input.command === 'create' || input.command === 'update')) {
          const title = input.title || input.id || 'Untitled';
          const action = input.command === 'update' ? 'Updating' : 'Creating';
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

  // Add artifacts
  for (const [filename, content] of Object.entries(artifacts)) {
    addFileWithBOM(folder, `artefacts/${filename}`, content);
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
  const failedFiles = [];
  const usedUploadNames = new Set();

  for (let i = 0; i < uploadedFiles.length; i++) {
    const file = uploadedFiles[i];
    if (onProgress) {
      onProgress(20 + Math.floor((i / uploadedFiles.length) * 40), 100, `Processing: ${file.filename}`);
    }

    // Handle duplicate filenames
    let finalName = file.filename;
    let counter = 1;
    while (usedUploadNames.has(finalName)) {
      const ext = file.filename.includes('.') ? file.filename.substring(file.filename.lastIndexOf('.')) : '';
      const base = file.filename.includes('.') ? file.filename.substring(0, file.filename.lastIndexOf('.')) : file.filename;
      finalName = `${base}_${counter}${ext}`;
      counter++;
    }
    usedUploadNames.add(finalName);

    try {
      const conversationId = data.uuid;

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
        downloadedFiles.push({ name: finalName, fromJson: false });
      } catch (apiErr) {
        // API failed - try JSON fallback for blob files
        if (file.isBlob && file.path) {
          const content = extractBlobContent(data, file.path);
          if (content) {
            folder.file(`uploads/${finalName}`, content);
            downloadedFiles.push({ name: finalName, fromJson: true });
          } else {
            throw new Error(`API failed (${apiErr.message}) and content not found in JSON`);
          }
        } else {
          throw apiErr;
        }
      }
    } catch (err) {
      console.error(`Failed to process ${file.filename}:`, err);
      failedFiles.push({ filename: file.filename, error: `${err.message} | UUID: ${file.uuid || 'none'} | Path: ${file.path || 'none'}` });
    }
  }

  // Generate all markdown files (with BOM for proper browser encoding)
  addFileWithBOM(folder, 'meta.md', generateMeta(data, messages, artifacts, codeBlocks, urls, textAttachments, projectFiles, downloadedFiles, webSources));
  addFileWithBOM(folder, 'prompts.md', generatePrompts(messages, responseFiles, attachmentIdMap));
  addFileWithBOM(folder, 'responses_text_only.md', generateResponsesTextOnly(messages, artifacts));

  if (codeBlocks.length > 0) {
    addFileWithBOM(folder, 'code_snippets.md', generateCodeSnippets(codeBlocks));
  }
  const linksAndSourcesContent = generateLinksAndSources(urls, webSources);
  if (linksAndSourcesContent) {
    addFileWithBOM(folder, 'links_and_sources.md', linksAndSourcesContent);
  }

  addFileWithBOM(folder, 'full_chat.md', convertToMarkdown(data, { embedArtifacts: true, includeThinking: settings.includeThinking }));
  addFileWithBOM(folder, 'integrated_chat.md', convertToMarkdown(data, { embedArtifacts: true, seamlessMd: true, includeThinking: settings.includeThinking }));
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
    const display = rf.heading.length > 50 ? rf.heading.substring(0, 47) + '...' : rf.heading;
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
  const hasProjectContent = Object.keys(projectFiles).length > 0 || projectMetadataJson || projectDocsJson;
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

  return { messages, artifacts, textAttachments, uploadedFiles: downloadedFiles, failedFiles, codeBlocks, urls, responseFiles };
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

  return { responseCount: result.responseFiles.length, artifactCount: Object.keys(result.artifacts).length };
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

// Convert conversation to Markdown
function convertToMarkdown(data, options = {}) {
  const { embedArtifacts = false, seamlessMd = false, includeThinking = true } = options;
  const lines = [];
  const title = data.name || 'Claude Conversation';

  // Extract artifacts for embedding or reference
  const artifacts = extractArtifacts(data);

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
      lines.push('');

    } else if (sender === 'assistant') {
      lines.push('## Response:');
      lines.push(timestamp);
      lines.push('');

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

          if (toolName === 'create_file') {
            // Artifact creation
            const path = input.path || '';
            const filename = path.split('/').pop();
            const desc = input.description || '';
            lines.push('```plaintext');
            lines.push(`Creating artifact: ${filename}`);
            if (desc) lines.push(`Description: ${desc}`);
            lines.push('```');
            lines.push('');

          } else if (toolName === 'present_files') {
            // Present files - embed or reference artifacts
            const filepaths = input.filepaths || [];
            for (const filepath of filepaths) {
              const filename = filepath.split('/').pop();
              if (artifacts[filename]) {
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
            const action = command === 'update' ? 'Updating' : 'Creating';

            if (command === 'create' || command === 'update') {
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
      if (msg.attachments && msg.attachments.length > 0) {
        for (const att of msg.attachments) {
          const filename = att.file_name || att.filename || 'file.md';
          lines.push('*Request*');
          lines.push('');
          lines.push('````javascript');
          lines.push(JSON.stringify({ filepaths: [`/mnt/user-data/outputs/${filename}`] }, null, 2));
          lines.push('````');
          lines.push('');
        }
      }

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
function safeFilename(name) {
  return (name || 'conversation').replace(/[^a-z0-9]/gi, '_').substring(0, 50);
}

// Update UI based on data availability
function updateUI(data, org) {
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

    status.className = 'status ready';
    status.textContent = 'Ready to export!';
    const artifactInfo = artifactCount > 0 ? `, ${artifactCount} artifacts` : '';
    info.textContent = `Current: "${title}" (${msgCount} messages${artifactInfo})`;

    exportMd.disabled = false;
    exportMdEmbed.disabled = false;
    exportZip.disabled = false;
    exportJson.disabled = false;
  } else {
    status.className = 'status waiting';
    status.textContent = org ? 'Navigate to a conversation to export current.' : 'Refresh page to capture data.';
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
}

// Request data from content script
async function requestData() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url.includes('claude.ai')) {
      const status = document.getElementById('status');
      status.className = 'status error';
      status.textContent = 'Please navigate to claude.ai';
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'getConversationData' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Error:', chrome.runtime.lastError);
        updateUI(null, null);
        return;
      }
      updateUI(response?.data, response?.orgId);
    });
  } catch (e) {
    console.error(e);
    updateUI(null, null);
  }
}

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
        const projectPrefix = data.project?.name ? `[${safeFilename(data.project.name)}-project]_` : '';
        const folderName = `${projectPrefix}${safeFilename(data.name || conv.uuid)}`;
        const folder = megaZip.folder(folderName);

        // Use shared helper to populate the folder (same structure as individual zip)
        const folderResult = await populateConversationFolder(folder, data, null, orgId);

        // Add to index
        indexEntries.push({
          name: data.name || 'Untitled',
          folder: folderName,
          messages: folderResult.messages.length,
          created: data.created_at ? formatTimestamp(data.created_at) : '',
          uuid: data.uuid
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
      '',
      '## Conversations',
      '',
      '| # | Conversation | Messages | Created |',
      '|---|--------------|----------|---------|'
    ];

    indexEntries.forEach((entry, i) => {
      indexLines.push(`| ${i + 1} | [${entry.name}](${entry.folder}/README.md) | ${entry.messages} | ${entry.created} |`);
    });

    if (errors.length > 0) {
      indexLines.push('', '## Errors', '');
      errors.forEach(err => indexLines.push(`- ${err}`));
    }

    addFileWithBOM(megaZip, 'index.md', indexLines.join('\n'));

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

      if (errors.length > 0) {
        status.className = 'status error';
        status.textContent = `Exported ${exported}/${total} to mega-zip. ${errors.length} failed.`;
        console.error('Export errors:', errors);
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
document.getElementById('exportMd').addEventListener('click', () => {
  if (!conversationData) return;
  const status = document.getElementById('status');
  try {
    const md = convertToMarkdown(conversationData, { includeThinking: settings.includeThinking });
    const filename = generateFilename(conversationData.name, 'md', conversationData.project?.name);
    download(md, filename, 'text/markdown');
    status.className = 'status ready';
    status.textContent = 'Markdown exported successfully!';
  } catch (e) {
    console.error('Markdown export error:', e);
    status.className = 'status error';
    status.textContent = 'Export failed: ' + e.message;
  }
});

document.getElementById('exportMdEmbed').addEventListener('click', () => {
  if (!conversationData) return;
  const status = document.getElementById('status');
  try {
    const md = convertToMarkdown(conversationData, {
      embedArtifacts: true,
      includeThinking: settings.includeThinking
    });
    const baseName = safeFilename(conversationData.name);
    const filename = generateFilename(baseName + '_embedded', 'md', conversationData.project?.name);
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

    const result = await createZipExport(conversationData, (step, total, message) => {
      showProgress(step, total, message);
    });

    hideProgress();
    status.className = 'status ready';
    status.textContent = `Exported zip (${result.responseCount} responses, ${result.artifactCount} artifacts)`;
  } catch (e) {
    hideProgress();
    console.error('Zip export error:', e);
    status.className = 'status error';
    status.textContent = 'Zip export failed: ' + e.message;
  }
});

document.getElementById('exportJson').addEventListener('click', () => {
  if (!conversationData) return;
  const status = document.getElementById('status');
  try {
    const json = JSON.stringify(conversationData, null, 2);
    const filename = generateFilename(conversationData.name, 'json', conversationData.project?.name);
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

document.getElementById('refresh').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.reload(tab.id);
  }
  window.close();
});

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
