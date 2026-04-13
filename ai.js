// ai.js — AI provider abstraction layer
// Supports Claude (Anthropic) and OpenAI (ChatGPT)
// User brings their own API key, stored locally via chrome.storage.local

const AI = (() => {

  async function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['aiProvider', 'aiApiKey'], (result) => {
        resolve({
          provider: result.aiProvider || 'claude',
          apiKey: result.aiApiKey || ''
        });
      });
    });
  }

  // Ask the AI to map form fields to user profile data
  // Returns a JSON object: { fieldId: value, ... }
  async function mapFieldsToProfile(fields, profile) {
    const { provider, apiKey } = await getConfig();
    if (!apiKey) throw new Error('NO_API_KEY');

    const fieldDescriptions = fields.map(f =>
      `- id="${f.id}" name="${f.name}" placeholder="${f.placeholder}" label="${f.label}" type="${f.type}"`
    ).join('\n');

    const profileJson = JSON.stringify(profile, null, 2);

    const prompt = `You are a job application autofill assistant. 

Given these HTML form fields:
${fieldDescriptions}

And this user profile:
${profileJson}

Return ONLY a valid JSON object mapping each field's unique key to the best matching value from the profile.
Use the field's "id" as the key if non-empty, else use "name". 
If no profile data matches a field, use null for that field.
Do NOT include any explanation, markdown, or code fences. Return raw JSON only.

Example output:
{"firstName": "John", "email": "john@example.com", "phone": null}`;

    if (provider === 'claude') {
      return await callClaude(apiKey, prompt);
    } else {
      return await callOpenAI(apiKey, prompt);
    }
  }

  // Ask AI to extract structured data from a single field's context
  async function inferMissingField(fieldContext, profile) {
    const { provider, apiKey } = await getConfig();
    if (!apiKey) throw new Error('NO_API_KEY');

    const prompt = `You are a job application assistant. The user is filling a form.

Field context:
- Label: "${fieldContext.label}"
- Placeholder: "${fieldContext.placeholder}"  
- Field type: "${fieldContext.type}"
- Surrounding text: "${fieldContext.surroundingText}"

Current user profile:
${JSON.stringify(profile, null, 2)}

What profile key name best describes what this field is asking for?
Return ONLY a JSON object with two keys:
- "profileKey": a camelCase key name that should be added to the profile (e.g. "linkedinUrl", "yearsOfExperience")
- "question": a short, friendly question to ask the user to get this value

Return raw JSON only, no markdown.`;

    if (provider === 'claude') {
      return await callClaude(apiKey, prompt);
    } else {
      return await callOpenAI(apiKey, prompt);
    }
  }

  async function callClaude(apiKey, prompt) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`Claude API error: ${err.error?.message || response.status}`);
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    return JSON.parse(text);
  }

  async function callOpenAI(apiKey, prompt) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`OpenAI API error: ${err.error?.message || response.status}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content.trim();
    return JSON.parse(text);
  }

  return { mapFieldsToProfile, inferMissingField, getConfig };
})();
