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

// The popup's side panel checkbox asks for the new behaviour at once; the
// storage listener below applies it too. Any other message is not ours.
const SIDE_PANEL_MODES = { enableSidePanelMode: true, disableSidePanelMode: false };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action;
  if (!Object.prototype.hasOwnProperty.call(SIDE_PANEL_MODES, action)) return false;
  if (!hasSidePanel) {
    sendResponse({ status: 'unsupported', error: 'Side Panel requires Chrome 114+' });
    return false;
  }
  const open = SIDE_PANEL_MODES[action];
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: open })
    .then(() => sendResponse({ status: open ? 'enabled' : 'disabled' }))
    .catch((error) => sendResponse({ status: 'error', error: error.message }));
  return true; // answered after setPanelBehavior settles
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
