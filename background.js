// Background service worker for side panel support

// Check if Side Panel API is available (Chrome 114+)
const hasSidePanel = typeof chrome.sidePanel !== 'undefined';

// Apply stored side panel preference
async function applySidePanelPreference() {
  if (!hasSidePanel) return;

  try {
    const result = await chrome.storage.local.get(['useSidePanel']);
    const shouldOpenOnClick = result.useSidePanel === true;
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: shouldOpenOnClick });
    console.log('Side panel behavior set:', shouldOpenOnClick ? 'open on click' : 'popup on click');
  } catch (error) {
    console.error('Failed to set side panel behavior:', error);
  }
}

// Apply preference when service worker starts
applySidePanelPreference();

// Listen for messages to toggle side panel mode
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!hasSidePanel) {
    if (message.action === 'openSidePanel' ||
        message.action === 'enableSidePanelMode' ||
        message.action === 'disableSidePanelMode' ||
        message.action === 'checkSidePanelStatus') {
      sendResponse({ status: 'unsupported', error: 'Side Panel requires Chrome 114+' });
      return true;
    }
  }

  if (message.action === 'openSidePanel') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        try {
          await chrome.sidePanel.open({ tabId: tabs[0].id });
          sendResponse({ status: 'opened' });
        } catch (error) {
          sendResponse({ status: 'error', error: error.message });
        }
      }
    });
    return true; // Keep channel open for async response
  }

  if (message.action === 'enableSidePanelMode') {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .then(() => sendResponse({ status: 'enabled' }))
      .catch((error) => sendResponse({ status: 'error', error: error.message }));
    return true;
  }

  if (message.action === 'disableSidePanelMode') {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .then(() => sendResponse({ status: 'disabled' }))
      .catch((error) => sendResponse({ status: 'error', error: error.message }));
    return true;
  }

  if (message.action === 'checkSidePanelStatus') {
    // Re-apply preference and respond with current status
    applySidePanelPreference().then(() => {
      chrome.storage.local.get(['useSidePanel'], (result) => {
        sendResponse({ status: 'ok', useSidePanel: result.useSidePanel === true });
      });
    });
    return true;
  }

  return true;
});

// On install/update, apply stored preference
chrome.runtime.onInstalled.addListener(() => {
  applySidePanelPreference();
});

// On startup, apply stored preference
chrome.runtime.onStartup.addListener(() => {
  applySidePanelPreference();
});

// Listen for storage changes to immediately apply preference changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.useSidePanel) {
    applySidePanelPreference();
  }
});
