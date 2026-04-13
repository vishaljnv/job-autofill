// background.js — Service worker
// Handles AI API calls (avoids CORS issues by calling from background)
// and acts as a message broker for storage operations

// ─── Message Router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    console.error('[FormFill BG]', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep message channel open for async response
});

async function handleMessage(msg) {
  switch (msg.type) {

    case 'GET_CONTEXT': {
      const profile = await getProfile();
      const learnedMappings = await getMappingsForHost(msg.hostname);
      return { profile, learnedMappings };
    }

    case 'CHECK_API_KEY': {
      const { aiApiKey } = await chromeGet(['aiApiKey']);
      return { hasApiKey: !!(aiApiKey && aiApiKey.trim()) };
    }

    case 'UPDATE_PROFILE_FIELD': {
      const profile = await getProfile();
      profile[msg.key] = msg.value;
      await chromeSet({ userProfile: profile });
      return { ok: true };
    }

    case 'LEARN_MAPPING': {
      await learnMapping(msg.hostname, msg.fieldKey, msg.profileKey);
      return { ok: true };
    }

    case 'AI_MAP_FIELDS': {
      try {
        const mappings = await aiMapFields(msg.fields, msg.profile);
        return { mappings };
      } catch (err) {
        return { error: err.message };
      }
    }

    case 'AI_INFER_FIELD': {
      try {
        const inference = await aiInferField(msg.fieldContext, msg.profile);
        return { inference };
      } catch (err) {
        return { inference: null, error: err.message };
      }
    }

    case 'OPEN_SETUP': {
      chrome.runtime.openOptionsPage();
      return { ok: true };
    }

    case 'SAVE_SETTINGS': {
      await chromeSet({
        aiProvider: msg.provider,
        aiApiKey: msg.apiKey,
        userProfile: msg.profile,
        setupComplete: true
      });
      return { ok: true };
    }

    case 'GET_SETTINGS': {
      const data = await chromeGet(['aiProvider', 'aiApiKey', 'userProfile', 'setupComplete']);
      return data;
    }

    case 'EXPORT_DATA': {
      const data = await chromeGetAll();
      return { data };
    }

    case 'CLEAR_DATA': {
      await chromeClear();
      return { ok: true };
    }

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ─── AI Calls ────────────────────────────────────────────────────────────

async function getAIConfig() {
  const { aiProvider, aiApiKey } = await chromeGet(['aiProvider', 'aiApiKey']);
  return { provider: aiProvider || 'claude', apiKey: aiApiKey || '' };
}

async function aiMapFields(fields, profile) {
  const { provider, apiKey } = await getAIConfig();
  if (!apiKey) throw new Error('No API key configured');

  const fieldDescriptions = fields.map(f => {
    let desc = `key="${f.key}"`;
    if (f.id) desc += ` id="${f.id}"`;
    if (f.name) desc += ` name="${f.name}"`;
    if (f.label) desc += ` label="${f.label}"`;
    if (f.placeholder) desc += ` placeholder="${f.placeholder}"`;
    if (f.type) desc += ` type="${f.type}"`;
    if (f.options && f.options.length > 0) {
      desc += ` options=[${f.options.slice(0, 8).map(o => `"${o.text}"`).join(', ')}]`;
    }
    return `- ${desc}`;
  }).join('\n');

  // Build a concise profile summary
  const profileSummary = Object.entries(profile)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const prompt = `You are a job application autofill assistant.

Form fields to fill:
${fieldDescriptions}

User profile data:
${profileSummary}

Map each field to the best matching profile value. Use the field's "key" attribute as the JSON key.
For select fields, use the exact option value or text that best matches.
If no profile data matches a field, use null.

Return ONLY raw JSON. No markdown, no explanation. Example:
{"firstName": "John", "email": "john@example.com", "resume_upload": null}`;

  return await callAI(provider, apiKey, prompt);
}

async function aiInferField(fieldContext, profile) {
  const { provider, apiKey } = await getAIConfig();
  if (!apiKey) throw new Error('No API key configured');

  const prompt = `A job application form has a field that needs user input.

Field info:
- Label: "${fieldContext.label}"
- Placeholder: "${fieldContext.placeholder}"
- Type: "${fieldContext.type}"
- Context: "${fieldContext.surroundingText?.substring(0, 150)}"

Existing profile keys: ${Object.keys(profile).join(', ')}

What profile key should store this value, and what question should we ask the user?
Return raw JSON only:
{"profileKey": "camelCaseKey", "question": "Friendly question for the user?"}`;

  return await callAI(provider, apiKey, prompt);
}

async function callAI(provider, apiKey, prompt) {
  if (provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0
      })
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `OpenAI error ${response.status}`);
    }
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
  } else {
    // Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `Claude error ${response.status}`);
    }
    const data = await response.json();
    const text = data.content[0].text.trim()
      .replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(text);
  }
}

// ─── Storage Helpers ──────────────────────────────────────────────────────

function chromeGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function chromeSet(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

function chromeGetAll() {
  return new Promise(resolve => chrome.storage.local.get(null, resolve));
}

function chromeClear() {
  return new Promise(resolve => chrome.storage.local.clear(resolve));
}

async function getProfile() {
  const { userProfile } = await chromeGet(['userProfile']);
  return userProfile || {};
}

async function getMappingsForHost(hostname) {
  const { learnedMappings } = await chromeGet(['learnedMappings']);
  const all = learnedMappings || {};
  return all[hostname] || {};
}

async function learnMapping(hostname, fieldKey, profileKey) {
  const { learnedMappings } = await chromeGet(['learnedMappings']);
  const all = learnedMappings || {};
  if (!all[hostname]) all[hostname] = {};
  all[hostname][fieldKey] = profileKey;
  await chromeSet({ learnedMappings: all });
}

// ─── Install handler ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
