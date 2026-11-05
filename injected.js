// Injected into page context to learn the org ID from the page's own requests.
// content.js uses this as a fallback when the lastActiveOrg cookie is missing.
(function() {
  'use strict';

  window.__CLAUDE_ORG_ID__ = null;

  const originalFetch = window.fetch;

  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const orgMatch = url.match(/\/organizations\/([a-f0-9-]+)\//);
    if (orgMatch && !window.__CLAUDE_ORG_ID__) {
      window.__CLAUDE_ORG_ID__ = orgMatch[1];
      window.postMessage({ type: 'CLAUDE_ORG_ID', orgId: orgMatch[1] }, '*');
    }
    return originalFetch.apply(this, args);
  };
})();
