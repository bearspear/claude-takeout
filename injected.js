// Injected into page context to intercept fetch requests
(function() {
  'use strict';

  // Store data
  window.__CLAUDE_EXPORT_DATA__ = null;
  window.__CLAUDE_ORG_ID__ = null;

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // Extract org ID from any API call
    const orgMatch = url.match(/\/organizations\/([a-f0-9-]+)\//);
    if (orgMatch && !window.__CLAUDE_ORG_ID__) {
      window.__CLAUDE_ORG_ID__ = orgMatch[1];
      window.postMessage({ type: 'CLAUDE_ORG_ID', orgId: orgMatch[1] }, '*');
      console.log('[Claude Takeout] Captured org ID:', orgMatch[1]);
    }

    // Intercept conversation API calls
    if (url.includes('/chat_conversations/') && !url.includes('/chat_conversations/search')) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        if (data && data.chat_messages) {
          window.__CLAUDE_EXPORT_DATA__ = data;
          window.postMessage({ type: 'CLAUDE_CONVERSATION_DATA', data: data }, '*');
          console.log('[Claude Takeout] Captured conversation data');
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    // Intercept conversations list
    if (url.includes('/chat_conversations') && !url.includes('/chat_conversations/')) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        if (Array.isArray(data)) {
          window.postMessage({ type: 'CLAUDE_CONVERSATIONS_LIST', data: data }, '*');
          console.log('[Claude Takeout] Captured conversations list:', data.length);
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    return response;
  };

  console.log('[Claude Takeout] Fetch interceptor installed');
})();
