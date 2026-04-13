# FormFill AI — Chrome Extension

An intelligent Chrome extension that autofills job application forms using AI. It learns your data over time and requires progressively less manual input with each use.

---

## How It Works

1. **One-time setup**: Enter your profile data (name, email, experience, etc.) and link your Claude or ChatGPT API key.
2. **Autofill button**: A floating `✦ Autofill` button appears on every webpage.
3. **AI mapping**: When you click Autofill, the extension detects all form fields and uses AI to map them to your profile.
4. **Learning**: Fields the AI fills are remembered per-site. Next visit, those fields are filled instantly without an AI call.
5. **Missing fields**: If a field can't be filled, it's highlighted in amber and you're prompted to enter the value. Your answer is saved for next time.

**Result**: After filling a form type once, future applications on the same site are fully automatic.

---

## Installation

### Step 1 — Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `formfill-extension` folder
5. The extension icon (✦) will appear in your toolbar

### Step 2 — Complete Setup

The setup wizard opens automatically on first install. You can also open it via:
- Click the extension icon → click the ⚙ button → or "Setup Wizard"

In the wizard:
1. **Profile**: Fill in your details (name, email, job title, experience, etc.)
2. **AI Setup**: Choose Claude or ChatGPT and enter your API key
   - **Claude**: Get key at [console.anthropic.com](https://console.anthropic.com) → API Keys
   - **ChatGPT**: Get key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
3. Click **Save & Finish**

---

## Usage

1. Navigate to a job application page (Greenhouse, Lever, Workday, LinkedIn, Indeed, etc.)
2. Click the **✦ Autofill** button in the bottom-right corner of the page
3. The AI analyzes the form and fills what it knows
4. For any unknown fields, a small prompt appears near the field asking you to fill it in
5. Check "Remember this for next time" to save the answer to your profile

---

## AI Provider Details

| Feature | Claude (Anthropic) | ChatGPT (OpenAI) |
|---|---|---|
| Model used | `claude-haiku-4-5-20251001` | `gpt-4o-mini` |
| Speed | Very fast | Fast |
| Cost | ~$0.001 per form | ~$0.001 per form |
| JSON output | Reliable | Reliable (json_object mode) |

Both are **extremely cheap** for this use case — filling a typical 20-field form costs fractions of a cent.

> **Privacy**: Your API key and profile data are stored **only in your browser's local storage** (`chrome.storage.local`). They are never sent to any server other than the AI provider you choose.

---

## Architecture

```
formfill-extension/
├── manifest.json          # Chrome Extension Manifest v3
├── background.js          # Service worker: AI API calls, storage broker
├── content.js             # Injected into every page: UI, form interaction
├── content.css            # Styles for injected UI (button, prompts, toasts)
├── formDetector.js        # Smart form field extraction & filling
├── popup.html / popup.js  # Extension popup (toolbar button)
├── setup.html / setup.js  # One-time setup wizard & settings page
├── ai.js                  # AI provider abstraction (reference, not used directly)
├── storage.js             # Storage helpers (reference, not used directly)
└── icons/                 # Extension icons (16, 48, 128px)
```

### Data flow

```
User clicks Autofill
       ↓
content.js detects fields on page
       ↓
Checks learnedMappings for this hostname (instant, no AI)
       ↓
Remaining fields → background.js → AI API (Claude/OpenAI)
       ↓
Fields filled; missing fields highlighted amber
       ↓
User fills missing fields via prompt dialog
       ↓
Answers saved to profile + learnedMappings
       ↓
Next visit: all previously-seen fields fill instantly
```

---

## Local Data Storage

Your data is stored in `chrome.storage.local` with these keys:

- `userProfile` — your profile JSON (name, email, experience, etc.)
- `learnedMappings` — per-hostname field→profileKey mappings
- `aiProvider` — `"claude"` or `"openai"`
- `aiApiKey` — your API key (stored locally only)
- `setupComplete` — boolean

You can export all data as JSON via the popup → "Export Data".

---

## Adding More Profile Data

Your profile grows over time as you fill forms. You can also:
1. Open the extension popup → click ⚙ Settings
2. Or go directly to `chrome-extension://[ID]/setup.html`
3. Edit your profile directly in the Profile step

---

## Supported Form Types

Tested and works well on:
- **Greenhouse** (greenhouse.io)
- **Lever** (lever.co)
- **Workday** (myworkdayjobs.com)
- **LinkedIn Easy Apply**
- **Indeed**
- **Ashby** (ashbyhq.com)
- **BambooHR**
- Any standard HTML form with `<input>`, `<select>`, `<textarea>` elements

---

## Troubleshooting

**Button doesn't appear:**
- Refresh the page
- Check that the extension is enabled at `chrome://extensions/`

**"No fillable fields found":**
- Some fields may load dynamically. Try clicking after the form fully renders.
- Some sites use shadow DOM or iframes — these may require scrolling to the form first.

**API errors:**
- Verify your API key in Settings
- Use "Test Connection" in the setup wizard
- Check your API key has remaining quota

**Fields not filling correctly:**
- The AI mapping isn't perfect for every field name. Fill manually when prompted — it will remember for next time.

---

## Why Not AutoGPT?

AutoGPT adds a heavy server dependency, complex orchestration infrastructure, and requires running a backend. For a Chrome extension that fills forms, it's overkill. This extension achieves the same learning behavior with:

- Direct API calls (no backend server)
- `chrome.storage.local` for learning (no database)
- One focused prompt per form (not an agent loop)
- Zero operational overhead

---

## Extending the Extension

**Add a new profile field**: Add it to `PROFILE_FIELDS` in `setup.js` and add an `<input>` with the same `id` in `setup.html`.

**Support more AI providers**: Edit `background.js` — add a new branch in `callAI()`.

**Improve field detection**: Edit `formDetector.js` — the `getLabel()` function handles label resolution.
