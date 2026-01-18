# Claude Takeout - Usage Guide

## Quick Start

```
1. Install extension (chrome://extensions → Load unpacked)
2. Go to claude.ai
3. Refresh the page
4. Click extension icon → Export
```

## Detailed Instructions

### First-Time Setup

1. **Install the Extension**
   - Open Chrome
   - Go to `chrome://extensions/`
   - Enable "Developer mode" (top right toggle)
   - Click "Load unpacked"
   - Navigate to and select the `claude-takeout` folder
   - You should see "Claude Takeout" appear in your extensions

2. **Pin the Extension** (optional but recommended)
   - Click the puzzle piece icon in Chrome toolbar
   - Find "Claude Takeout"
   - Click the pin icon

### Exporting a Single Conversation

1. Go to [claude.ai](https://claude.ai)
2. Open the conversation you want to export
3. **Refresh the page** (Ctrl+R / Cmd+R)
   - This is required for the extension to capture the conversation data
4. Click the Claude Takeout icon in your toolbar
5. You should see:
   - Status: "Ready to export!"
   - Info: Conversation title and message count
6. Click one of:
   - **Export Current (Markdown)** - Human-readable format
   - **Export Current (JSON)** - Raw data format
7. File downloads to your default downloads folder

### Exporting All Conversations (Bulk Export)

1. Go to [claude.ai](https://claude.ai) - any page works
2. Refresh the page once
   - This captures your organization ID needed for API access
3. Click the Claude Takeout icon
4. Click one of:
   - **Export All (Markdown)** - Downloads each conversation as a .md file
   - **Export All (JSON)** - Downloads each conversation as a .json file
5. Watch the progress bar
   - Shows: "X / Y" conversations exported
6. Wait for all downloads to complete
   - ~300ms delay between each to avoid rate limits
   - 100 conversations ≈ 30 seconds

### Understanding the Popup

```
┌─────────────────────────────────┐
│ Claude Takeout                 │
├─────────────────────────────────┤
│ [Status Message]                │  ← Ready/Waiting/Error
│ [Info: conversation details]    │
├─────────────────────────────────┤
│ [Export Current (Markdown)]     │  ← Single conversation
│ [Export Current (JSON)]         │
├─────────────────────────────────┤
│ [Export All (Markdown)]         │  ← Bulk export
│ [Export All (JSON)]             │
├─────────────────────────────────┤
│ [Refresh Page to Capture]       │  ← Reloads the page
├─────────────────────────────────┤
│ [████████░░] 45 / 100           │  ← Progress (bulk only)
└─────────────────────────────────┘
```

### Status Messages

| Status | Meaning |
|--------|---------|
| "Ready to export!" | Conversation data captured, ready to export |
| "Checking for conversation data..." | Loading, please wait |
| "Navigate to a conversation to export current." | On claude.ai but not viewing a conversation |
| "Refresh page to capture data." | Need to refresh to capture API data |
| "Please navigate to claude.ai" | Not on claude.ai website |
| "Found X conversations. Exporting..." | Bulk export in progress |
| "Exported X conversations!" | Bulk export complete |

## Output Examples

### Markdown Format

The exported markdown includes:

**Header:**
```markdown
# My Conversation Title

**Created:** 12/30/2025, 3:23:17 PM
**Updated:** 12/30/2025, 4:42:21 PM
**Exported:** 12/31/2025, 10:00:00 AM
**Link:** [https://claude.ai/chat/abc-123](https://claude.ai/chat/abc-123)
```

**User Messages:**
```markdown
## Prompt:
12/30/2025, 3:23:17 PM

What is the capital of France?
```

**Claude Responses (with thinking):**
```markdown
## Response:
12/30/2025, 3:23:26 PM

````plaintext
Thought process: The user is asking a straightforward geography question...

I should provide a direct answer about France's capital city.
````

The capital of France is **Paris**.
```

**File Attachments:**
```markdown
**present_files**

*Request*

````javascript
{
  "filepaths": [
    "/mnt/user-data/outputs/my_document.md"
  ]
}
````
```

### JSON Format

Raw API response - useful for:
- Custom processing
- Importing to other tools
- Backup with full fidelity

## Tips

### Naming Convention
Exported files are named based on conversation title:
- `My_Conversation_Title.md`
- `My_Conversation_Title.json`

Special characters are replaced with underscores, limited to 50 characters.

### Working with Artifacts
The markdown export includes artifact references but not the actual content (that's stored separately by Claude). Use these references to match with downloaded artifacts.

### Large Export
For accounts with many conversations:
- Consider exporting in batches
- Check your downloads folder capacity
- Browser may ask permission for multiple downloads

### Combining with Other Tools
The JSON export is compatible with:
- Custom scripts for analysis
- Database imports
- Other conversion tools

## Keyboard Shortcuts

No built-in shortcuts, but you can:
1. Press Ctrl+Shift+E (or Cmd+Shift+E on Mac) to open Chrome extensions
2. Or assign a custom shortcut in `chrome://extensions/shortcuts`

## Updating the Extension

1. Make changes to the extension files
2. Go to `chrome://extensions/`
3. Find "Claude Takeout"
4. Click the refresh icon (circular arrow)
5. Changes take effect immediately (may need to refresh claude.ai tab)
