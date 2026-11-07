// Builds a look-only viewer from one exported conversation, for checking the page by eye.
//   node tests/e2e/make-viewer.js <original.json> <out.html>
// Keep the output out of the repo: it holds the chat.
const fs = require('fs');
const path = require('path');
const { buildViewerChat, modelLabel, buildViewerData, assembleViewer, VIEWER_ASSETS } = require('../../takeout-viewer.js');
const { getModelName } = require('../../export-core.js');

const REPO = path.resolve(__dirname, '..', '..');

// conversations: claude.ai API payloads. ctxOf(conversation): extra buildViewerChat context, such as artifacts.
function buildHtml(conversations, exported = new Date().toISOString(), ctxOf = () => ({})) {
  const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
  const [template, logic, app, marked, katex, css, highlight] = VIEWER_ASSETS.map(read);
  const chats = conversations.map(c => buildViewerChat(c, { model: modelLabel(c.model, getModelName(c)), ...ctxOf(c) }));
  return assembleViewer({ template, css, marked, katex, highlight, logic, app, data: buildViewerData(chats, { exported }) });
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
