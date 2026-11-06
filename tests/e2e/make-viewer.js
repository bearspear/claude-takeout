// Builds a look-only viewer from one exported conversation, for checking the page by eye.
//   node tests/e2e/make-viewer.js <original.json> <out.html>
// Keep the output out of the repo: it holds the chat.
const fs = require('fs');
const path = require('path');
const { buildViewerChat, buildViewerData, assembleViewer, VIEWER_ASSETS } = require('../../takeout-viewer.js');

const REPO = path.resolve(__dirname, '..', '..');

function modelName(model) {
  const s = String(model || '').toLowerCase();
  const variant = (/opus|sonnet|haiku/.exec(s) || [''])[0];
  const version = /(\d+)-(\d+)/.exec(s);
  if (!variant) return model || '';
  return `${variant[0].toUpperCase()}${variant.slice(1)}${version ? ` ${version[1]}.${version[2]}` : ''}`;
}

// conversations: claude.ai API payloads.
function buildHtml(conversations, exported = new Date().toISOString()) {
  const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
  const [template, logic, app, marked, katex, css] = VIEWER_ASSETS.map(read);
  const chats = conversations.map(c => buildViewerChat(c, { model: modelName(c.model) }));
  return assembleViewer({ template, css, marked, katex, logic, app, data: buildViewerData(chats, { exported }) });
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.log('Usage: node tests/e2e/make-viewer.js <original.json> <out.html>');
    process.exit(0);
  }
  fs.writeFileSync(output, buildHtml([JSON.parse(fs.readFileSync(input, 'utf8'))]));
  console.log(`Wrote ${output}`);
}

module.exports = { buildHtml };
