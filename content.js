// Content script - runs in isolated world
// Injects script into page context and relays messages

(function() {
  'use strict';

  // Inject the fetch interceptor into the page
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  // Store captured data
  let conversationData = null;
  let orgId = null;

  // Listen for messages from injected script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;

    if (event.data.type === 'CLAUDE_CONVERSATION_DATA') {
      conversationData = event.data.data;
      chrome.storage.local.set({ conversationData: conversationData });
    }

    if (event.data.type === 'CLAUDE_ORG_ID') {
      orgId = event.data.orgId;
      chrome.storage.local.set({ orgId: orgId });
    }
  });

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

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === 'getConversationData') {
      chrome.storage.local.get(['conversationData', 'orgId'], (result) => {
        sendResponse({
          data: conversationData || result.conversationData,
          orgId: orgId || result.orgId
        });
      });
      return true;
    }

    if (request.action === 'getOrgId') {
      chrome.storage.local.get(['orgId'], (result) => {
        sendResponse({ orgId: orgId || result.orgId });
      });
      return true;
    }

    if (request.action === 'triggerRefresh') {
      window.location.reload();
      sendResponse({ status: 'refreshing' });
    }

    if (request.action === 'fetchAllConversations') {
      chrome.storage.local.get(['orgId'], async (result) => {
        const id = orgId || result.orgId || request.orgId;
        if (!id) {
          sendResponse({ error: 'No org ID available. Refresh the page first.' });
          return;
        }
        try {
          const conversations = await fetchAllConversations(id);
          sendResponse({ data: conversations, orgId: id });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    if (request.action === 'fetchConversation') {
      chrome.storage.local.get(['orgId'], async (result) => {
        const id = orgId || result.orgId || request.orgId;
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
