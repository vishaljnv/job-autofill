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

    case 'TEST_CONNECTION': {
      try {
        await testConnection(msg.provider, msg.apiKey);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'AI_PARSE_RESUME': {
      try {
        const parsed = await aiParseResume(msg.fileType, msg.fileData, msg.textContent);
        return { profile: parsed };
      } catch (err) {
        return { error: err.message };
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

// ─── Profile Summary Builder ──────────────────────────────────────────────

function buildProfileSummary(profile) {
  const lines = [];

  // Flat fields
  const flatKeys = [
    'firstName', 'lastName', 'preferredFirstName', 'preferredLastName',
    'email', 'phoneCountryCode', 'phone',
    'city', 'state', 'country', 'zipCode',
    'linkedinUrl', 'websiteUrl', 'githubUrl',
    'yearsExperience', 'desiredSalary', 'skills', 'summary',
    'gender', 'disabilityStatus', 'veteranStatus', 'requiresSponsorship', 'sponsorshipCountries',
    'hasWorkPermit', 'govtExperience', 'hasNonCompete', 'isGovtOfficial'
  ];
  for (const key of flatKeys) {
    if (profile[key]) lines.push(`${key}: ${profile[key]}`);
  }

  // Compose full phone number
  if (profile.phoneCountryCode && profile.phone) {
    lines.push(`fullPhone: ${profile.phoneCountryCode} ${profile.phone}`);
  } else if (profile.phone) {
    lines.push(`fullPhone: ${profile.phone}`);
  }

  // Work experience (new array schema)
  if (profile.workExperience && profile.workExperience.length > 0) {
    const current = profile.workExperience.find(e => e.isCurrent) || profile.workExperience[0];
    if (current.title) lines.push(`currentTitle: ${current.title}`);
    if (current.company) lines.push(`currentCompany: ${current.company}`);

    profile.workExperience.forEach((exp, i) => {
      const parts = [];
      if (exp.title) parts.push(exp.title);
      if (exp.company) parts.push(`at ${exp.company}`);
      if (exp.location) parts.push(`in ${exp.location}`);
      const dateRange = `${exp.startDate || '?'} to ${exp.isCurrent ? 'present' : (exp.endDate || '?')}`;
      lines.push(`workExperience[${i}]: ${parts.join(' ')} (${dateRange})`);
    });
  } else {
    // Legacy flat fields (backwards compatibility)
    if (profile.currentTitle) lines.push(`currentTitle: ${profile.currentTitle}`);
    if (profile.currentCompany) lines.push(`currentCompany: ${profile.currentCompany}`);
  }

  // Education (new array schema)
  if (profile.education && profile.education.length > 0) {
    // Expose legacy-compatible aliases from first entry
    const first = profile.education[0];
    if (first.degree) lines.push(`educationDegree: ${first.degree}`);
    if (first.university) lines.push(`educationSchool: ${first.university}`);

    profile.education.forEach((edu, i) => {
      const parts = [];
      if (edu.degree) parts.push(edu.degree);
      if (edu.university) parts.push(`at ${edu.university}`);
      if (edu.location) parts.push(`in ${edu.location}`);
      if (edu.country) parts.push(`, ${edu.country}`);
      const dateRange = `${edu.fromDate || '?'} to ${edu.toDate || '?'}`;
      lines.push(`education[${i}]: ${parts.join(' ')} (${dateRange})`);
    });
  } else {
    // Legacy flat fields (backwards compatibility)
    if (profile.educationDegree) lines.push(`educationDegree: ${profile.educationDegree}`);
    if (profile.educationSchool) lines.push(`educationSchool: ${profile.educationSchool}`);
    if (profile.graduationYear) lines.push(`graduationYear: ${profile.graduationYear}`);
  }

  return lines.join('\n');
}

// ─── AI Calls ────────────────────────────────────────────────────────────

async function testConnection(provider, apiKey) {
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || `HTTP ${res.status}`); }
  } else {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || `HTTP ${res.status}`); }
  }
}

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

  const profileSummary = buildProfileSummary(profile);

  const prompt = `You are a job application autofill assistant. Fill form fields with the best-matching profile data.

FLEXIBLE FIELD NAME MATCHING — treat these as equivalent when mapping:
- "First Name", "Given Name", "Forename", "First" → firstName
- "Last Name", "Surname", "Family Name", "Last" → lastName
- "Preferred Name", "Preferred First Name", "Goes By", "Nickname" → preferredFirstName
- "Preferred Last Name", "Preferred Surname" → preferredLastName
- "Mobile", "Cell", "Cell Phone", "Telephone", "Tel", "Phone Number" → fullPhone or phone
- "Country Code", "Phone Code", "Dialling Code" → phoneCountryCode
- "Current Title", "Job Title", "Position", "Role", "Current Position", "Current Role" → currentTitle
- "Current Employer", "Employer", "Organization", "Current Company", "Company Name" → currentCompany
- "School", "Institution", "University", "College", "Attended" → educationSchool
- "Degree", "Qualification", "Credential", "Highest Education" → educationDegree
- "Graduation", "Grad Year", "Year Completed" → graduationYear
- "Profile", "Bio", "About Me", "Objective", "Cover Note" → summary
- "Gender", "Gender Identity", "Sex" → gender
- "Disability", "Disabled", "Person with a disability", "Disability Status" → disabilityStatus
- "Veteran", "Military", "Military Status", "Armed Forces", "Active duty" → veteranStatus
- "Sponsorship", "Visa Sponsorship", "Require sponsorship", "Work Authorization Sponsorship" → requiresSponsorship
- "Which countries require sponsorship", "Countries needing sponsorship" → sponsorshipCountries
- "Work Permit", "Valid work permit", "Authorized to work", "Work Authorization", "Employment authorization" → hasWorkPermit
- "Government experience", "Public sector experience", "Federal employment", "Government employee" → govtExperience
- "Non-compete", "Non-solicitation", "NDA", "Restrictive agreement", "Employment restrictions" → hasNonCompete
- "Government official", "Public body", "Regulatory authority", "Government or public body role" → isGovtOfficial
- "LinkedIn", "LinkedIn Profile" → linkedinUrl
- "Website", "Portfolio", "Personal Site" → websiteUrl
- "GitHub", "Github Profile" → githubUrl
- "Postal Code", "Post Code", "Pin Code" → zipCode

Form fields to fill:
${fieldDescriptions}

User profile data:
${profileSummary}

Map each field's "key" to the best matching profile value. Use the field's "key" as the JSON key.
For select fields, use the exact option value or text that best matches.
If no profile data matches a field, use null.

Return ONLY raw JSON. No markdown, no explanation. Example:
{"firstName": "Jane", "email": "jane@example.com", "fieldXYZ": null}`;

  return await callAI(provider, apiKey, prompt);
}

async function aiInferField(fieldContext, profile) {
  const { provider, apiKey } = await getAIConfig();
  if (!apiKey) throw new Error('No API key configured');

  const profileSummary = buildProfileSummary(profile);

  const prompt = `A job application form has a field that needs user input.

Field info:
- Label: "${fieldContext.label}"
- Placeholder: "${fieldContext.placeholder}"
- Type: "${fieldContext.type}"
- Context: "${fieldContext.surroundingText?.substring(0, 150)}"

Existing profile data:
${profileSummary}

What profile key should store this value, and what friendly question should we ask the user?
Use flexible matching: "Given Name" = firstName, "Surname" = lastName, etc.
Return raw JSON only:
{"profileKey": "camelCaseKey", "question": "Friendly question for the user?"}`;

  return await callAI(provider, apiKey, prompt);
}

async function aiParseResume(fileType, fileData, textContent) {
  const { provider, apiKey } = await getAIConfig();
  if (!apiKey) throw new Error('No API key configured');

  const extractionPrompt = `Extract information from this resume and return it as a JSON object.

Extract these fields (use null if not found, use empty array [] for empty lists):
{
  "firstName": "first name",
  "lastName": "last name",
  "email": "email address",
  "phoneCountryCode": "phone country code like +1, +44 etc.",
  "phone": "phone number without country code",
  "city": "city",
  "state": "state or province",
  "country": "country",
  "zipCode": "zip or postal code",
  "linkedinUrl": "LinkedIn profile URL",
  "websiteUrl": "personal website or portfolio URL",
  "githubUrl": "GitHub profile URL",
  "yearsExperience": "total years of professional experience as a number string",
  "skills": "comma-separated list of skills and technologies",
  "workAuthorization": "country or region authorized to work in",
  "summary": "professional summary or objective statement",
  "workExperience": [
    {
      "title": "job title",
      "company": "company name",
      "location": "city and state/country",
      "startDate": "YYYY-MM format, estimate if only year given",
      "endDate": "YYYY-MM format or empty string if current",
      "isCurrent": true or false
    }
  ],
  "education": [
    {
      "degree": "full degree name e.g. B.S. Computer Science",
      "university": "university or college name",
      "location": "city and state",
      "country": "country",
      "fromDate": "YYYY-MM format, estimate if only year",
      "toDate": "YYYY-MM format, estimate if only year"
    }
  ]
}

Return ONLY raw JSON. No markdown, no explanation, no code fences.`;

  if (fileType === 'pdf' && provider === 'claude') {
    // Use Claude's native PDF document support
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: fileData
              }
            },
            {
              type: 'text',
              text: extractionPrompt
            }
          ]
        }]
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

  } else if (fileType === 'pdf' && provider === 'openai') {
    // OpenAI doesn't support PDF natively — try basic text extraction
    const extractedText = extractTextFromPdfBase64(fileData);
    if (!extractedText || extractedText.length < 30) {
      throw new Error('PDF parsing works best with Claude. Please switch to Claude in AI Setup, or upload a .docx file instead.');
    }
    const fullPrompt = `${extractionPrompt}\n\nResume text:\n${extractedText}`;
    return await callAI(provider, apiKey, fullPrompt);

  } else {
    // DOCX (or any text-based) — use extracted text content
    const fullPrompt = `${extractionPrompt}\n\nResume text:\n${textContent || ''}`;
    return await callAI(provider, apiKey, fullPrompt);
  }
}

// Basic PDF text extraction by scanning content streams (works for uncompressed text PDFs)
function extractTextFromPdfBase64(base64) {
  try {
    const binary = atob(base64);
    const texts = [];
    // Find text between parentheses in BT...ET blocks
    const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
    let match;
    while ((match = btRegex.exec(binary)) !== null) {
      const strRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let strMatch;
      while ((strMatch = strRegex.exec(match[1])) !== null) {
        const t = strMatch[1].replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\\\/g, '\\').replace(/\\[()]/g, '');
        if (t.trim()) texts.push(t.trim());
      }
    }
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return '';
  }
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
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
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
