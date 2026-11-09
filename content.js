// Content script - runs in isolated world
// Injects script into page context and relays messages

(function() {
  'use strict';

  // Inject the fetch interceptor into the page
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  let orgId = null;

  // Older versions cached a full conversation here, which is no longer used.
  chrome.storage.local.remove('conversationData');

  // Listen for messages from injected script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;

    if (event.data.type === 'CLAUDE_ORG_ID') {
      orgId = event.data.orgId;
      chrome.storage.local.set({ orgId: orgId });
    }
  });

  // The org claude.ai is using right now. The captured ID can be missing if the
  // page's first requests beat the interceptor, and the stored one can be from
  // another org, so the cookie comes first.
  function getActiveOrgId() {
    const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  }

  // Fetch a single conversation
  async function fetchConversation(orgId, conversationId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch conversation: ${response.status}`);
    }

    return await response.json();
  }

  // Fetch all conversations list
  async function fetchAllConversations(orgId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;

    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch conversations: ${response.status}`);
    }

    return await response.json();
  }

  // The account's display name, for the mega-ZIP's file name. Only that one field leaves this function.
  async function fetchAccountName() {
    try {
      const response = await fetch('https://claude.ai/api/account', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) return null;
      const account = await response.json();
      const name = account && (account.display_name || account.full_name);
      return typeof name === 'string' && name.trim() ? name.trim() : null;
    } catch (e) {
      return null;
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === 'getOrgId') {
      chrome.storage.local.get(['orgId'], (result) => {
        sendResponse({ orgId: getActiveOrgId() || orgId || result.orgId });
      });
      return true;
    }

    if (request.action === 'fetchAllConversations') {
      chrome.storage.local.get(['orgId'], async (result) => {
        const id = getActiveOrgId() || orgId || result.orgId || request.orgId;
        if (!id) {
          sendResponse({ error: 'No org ID available. Refresh the page first.' });
          return;
        }
        try {
          const conversations = await fetchAllConversations(id);
          const accountName = request.withAccountName ? await fetchAccountName() : null;
          sendResponse({ data: conversations, orgId: id, accountName });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    if (request.action === 'fetchConversation') {
      chrome.storage.local.get(['orgId'], async (result) => {
        const id = getActiveOrgId() || orgId || result.orgId || request.orgId;
        if (!id) {
          sendResponse({ error: 'No org ID available.' });
          return;
        }
        try {
          const data = await fetchConversation(id, request.conversationId);
          sendResponse({ data: data });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }
  });

  console.log('[Claude Takeout] Content script loaded');
})();
