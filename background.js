// background.js — Service worker
// Handles AI API calls (avoids CORS issues by calling from background)
// and acts as a message broker for storage operations

// ─── Message Router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Attach sender tab ID so handlers can use it
  const msgWithMeta = { ...msg, _tabId: sender.tab?.id };
  handleMessage(msgWithMeta).then(sendResponse).catch(err => {
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

    case 'UPDATE_PROFILE': {
      await chromeSet({ userProfile: msg.profile });
      return { ok: true };
    }

    case 'LEARN_FROM_FORM': {
      try {
        await learnFromForm(msg.fields, msg.hostname);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
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

    case 'TRIGGER_AUTOFILL_FRAMES': {
      // Broadcast autofill trigger to every frame on the sender's tab
      const tabId = msg._tabId;
      if (tabId) {
        // Get all frames and send to each (skip frame 0 = top frame, it already tried)
        chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
          if (!frames) return;
          frames.forEach(frame => {
            if (frame.frameId === 0) return; // skip top frame
            chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_AUTOFILL' }, { frameId: frame.frameId });
          });
        });
      }
      return { ok: true };
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
    'addressLine1', 'addressLine2', 'city', 'state', 'country', 'zipCode',
    'linkedinUrl', 'websiteUrl', 'githubUrl',
    'yearsExperience', 'desiredSalary', 'skills', 'summary',
    'gender', 'disabilityStatus', 'veteranStatus', 'requiresSponsorship', 'sponsorshipCountries',
    'hasWorkPermit', 'govtExperience', 'hasNonCompete', 'isGovtOfficial',
    'educationMajor'
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
      // Expose employer address sub-fields so AI can fill work experience address fields
      if (exp.addressLine1) lines.push(`workExperience[${i}].location: ${exp.addressLine1}`);
      if (exp.city)    lines.push(`workExperience[${i}].city: ${exp.city}`);
      if (exp.state)   lines.push(`workExperience[${i}].state: ${exp.state}`);
      if (exp.country) lines.push(`workExperience[${i}].country: ${exp.country}`);
      if (exp.zipCode) lines.push(`workExperience[${i}].zipCode: ${exp.zipCode}`);
      if (exp.description) lines.push(`workExperience[${i}].description: ${exp.description}`);
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
    if (first.major) lines.push(`educationMajor: ${first.major}`);

    profile.education.forEach((edu, i) => {
      const parts = [];
      if (edu.degree) parts.push(edu.degree);
      if (edu.university) parts.push(`at ${edu.university}`);
      if (edu.location) parts.push(`in ${edu.location}`);
      if (edu.country) parts.push(`, ${edu.country}`);
      const dateRange = `${edu.fromDate || '?'} to ${edu.toDate || '?'}`;
      lines.push(`education[${i}]: ${parts.join(' ')} (${dateRange})`);
      if (edu.major) lines.push(`education[${i}].major: ${edu.major}`);
      lines.push(`education[${i}].isCurrentlyStudying: ${edu.isCurrentlyStudying ? 'true' : 'false'}`);
    });
  } else {
    // Legacy flat fields (backwards compatibility)
    if (profile.educationDegree) lines.push(`educationDegree: ${profile.educationDegree}`);
    if (profile.educationSchool) lines.push(`educationSchool: ${profile.educationSchool}`);
    if (profile.graduationYear) lines.push(`graduationYear: ${profile.graduationYear}`);
  }

  return lines.join('\n');
}

// ─── Learn From Form ─────────────────────────────────────────────────────

async function learnFromForm(fields, hostname) {
  const { provider, apiKey } = await getAIConfig();
  if (!apiKey) return; // silently skip if not configured

  const profile = await getProfile();

  // Separate date-role fields from regular fields
  const dateFields  = fields.filter(f => f.dateRole && f.value);
  const plainFields = fields.filter(f => !f.dateRole && f.value);

  // ── Step 1: process date triplets back into YYYY-MM-DD strings ──────────
  const MONTH_MAP = {
    january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'
  };

  // Group date fields by (section, surroundingText) — same triplet shares both
  const dateTriplets = new Map();
  for (const f of dateFields) {
    const key = (f.sectionContext || '') + '|' + (f.surroundingText || '').substring(0, 80);
    if (!dateTriplets.has(key)) dateTriplets.set(key, { section: f.sectionContext || '', fields: [] });
    dateTriplets.get(key).fields.push(f);
  }

  for (const { section, fields: tFields } of dateTriplets.values()) {
    const monthF = tFields.find(f => f.dateRole === 'month');
    const dayF   = tFields.find(f => f.dateRole === 'day');
    const yearF  = tFields.find(f => f.dateRole === 'year');
    const mv = monthF?.value || ''; const dv = dayF?.value || ''; const yv = yearF?.value || '';
    if (!yv && !mv) continue;

    const monthNum = MONTH_MAP[mv.toLowerCase()] || mv.padStart(2, '0');
    const dayPad   = String(parseInt(dv) || 1).padStart(2, '0');
    const dateStr  = `${yv || '????'}-${monthNum}-${dayPad}`;

    // Determine date role from surrounding text
    const text = (tFields[0].surroundingText || '').toLowerCase();
    const role = /start|from|\bbegin/i.test(text) ? 'start'
               : /end|to\b|until/i.test(text)     ? 'end'
               : 'graduation';

    const idx = parseInt((section.match(/\((\d+)\)/) || ['','1'])[1]) - 1;
    const isEdu  = /education|school|degree/i.test(section);
    const isWork = /experience|employer|professional/i.test(section);

    if (isEdu) {
      if (!profile.education) profile.education = [];
      if (!profile.education[idx]) profile.education[idx] = {};
      profile.education[idx][role === 'start' ? 'fromDate' : 'toDate'] = dateStr;
    } else if (isWork) {
      if (!profile.workExperience) profile.workExperience = [];
      if (!profile.workExperience[idx]) profile.workExperience[idx] = {};
      profile.workExperience[idx][role === 'start' ? 'startDate' : 'endDate'] = dateStr;
    }
  }

  // ── Step 2: use AI to map plain fields → profile keys ───────────────────
  if (plainFields.length > 0) {
    const fieldDesc = plainFields.map(f => {
      let d = `label="${f.label}" value="${f.value}"`;
      if (f.sectionContext) d += ` section="${f.sectionContext}"`;
      if (f.surroundingText) d += ` context="${f.surroundingText.substring(0, 80)}"`;
      return `- ${d}`;
    }).join('\n');

    const prompt = `A user has filled out a job application form. Extract the data and map it to profile fields.

Filled form fields:
${fieldDesc}

Map each field to the correct profile key and return the user's data as a flat JSON object.
Use these profile keys where appropriate:
firstName, lastName, preferredFirstName, preferredLastName,
email, phoneCountryCode, phone, city, state, country, zipCode,
linkedinUrl, websiteUrl, githubUrl, yearsExperience, desiredSalary, skills, summary,
gender, disabilityStatus, veteranStatus, requiresSponsorship, hasWorkPermit,
govtExperience, hasNonCompete, isGovtOfficial.

IMPORTANT:
- "Legal first name", "Legal name", "Given name" → firstName (NOT preferredFirstName)
- "Legal last name", "Surname" → lastName (NOT preferredLastName)
- "Preferred name", "Goes by" → preferredFirstName
- Only include fields where the value is clearly meaningful (not empty, not placeholder text).
- For work experience employer/title/location fields, use keys like workExperience_0_company, workExperience_0_title, workExperience_1_company etc.
- For education fields: education_0_university, education_0_degree etc.

Return ONLY raw JSON. No markdown.`;

    try {
      const mapped = await callAI(provider, apiKey, prompt);

      // Merge flat keys into profile, handle workExperience_N_* and education_N_* specially
      for (const [key, val] of Object.entries(mapped)) {
        if (!val) continue;
        const weMatch  = key.match(/^workExperience_(\d+)_(.+)$/);
        const eduMatch = key.match(/^education_(\d+)_(.+)$/);
        if (weMatch) {
          const [, idx, field] = weMatch;
          if (!profile.workExperience) profile.workExperience = [];
          if (!profile.workExperience[idx]) profile.workExperience[idx] = {};
          profile.workExperience[idx][field] = val;
        } else if (eduMatch) {
          const [, idx, field] = eduMatch;
          if (!profile.education) profile.education = [];
          if (!profile.education[idx]) profile.education[idx] = {};
          profile.education[idx][field] = val;
        } else {
          profile[key] = val;
        }
      }

      // Learn field→profileKey mappings for this hostname
      for (const f of plainFields) {
        const matchKey = Object.keys(mapped).find(k => {
          const v = mapped[k];
          return v && String(v).toLowerCase() === String(f.value).toLowerCase();
        });
        if (matchKey && !matchKey.includes('_')) {
          await learnMapping(hostname, f.key, matchKey);
        }
      }
    } catch (e) {
      // AI mapping failed — save what we have from dates at least
    }
  }

  await chromeSet({ userProfile: profile });
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
    if (f.sectionContext) desc += ` section="${f.sectionContext}"`;
    if (f.dateRole) desc += ` dateRole="${f.dateRole}"`;
    if (f.options && f.options.length > 0) {
      desc += ` options=[${f.options.slice(0, 8).map(o => `"${o.text}"`).join(', ')}]`;
    }
    return `- ${desc}`;
  }).join('\n');

  const profileSummary = buildProfileSummary(profile);

  const prompt = `You are a job application autofill assistant. Fill form fields with the best-matching profile data.

DATE COMPONENT FIELDS — critical rules:
Fields with dateRole="month", dateRole="day", or dateRole="year" are parts of a single date.
Use the field's section="" attribute to identify WHICH date to use:

- section contains "Education" or "School" or "Degree":
    Look at education[N] entries. Identify the date by surrounding label context:
    - "graduation", "date received", "completed", "toDate" → use education[N].toDate
    - "from", "start", "enrolled", "fromDate" → use education[N].fromDate
    Then extract the component:
    - dateRole="month" → full month name, e.g. "2019-05" → "May"
    - dateRole="day"   → day number as string — BUT if the stored date ends in "-01" (meaning the day was never explicitly set, just defaulted), return null. Only fill a day field when the date has a non-01 day component (e.g. "2019-05-15" → "15").
    - dateRole="year"  → 4-digit year string, e.g. "2019"

- section contains "Experience" or "Employer" or "Work" or "Professional":
    Look at workExperience[N] entries. Identify by label context:
    - "start", "from", "begin" → workExperience[N].startDate
    - "end", "to", "until" → workExperience[N].endDate
    Then extract the same way (month name / day number / year).
    For dateRole="day": same rule — if the date ends in "-01", return null.

Month name mapping: 01→January, 02→February, 03→March, 04→April, 05→May, 06→June,
  07→July, 08→August, 09→September, 10→October, 11→November, 12→December

NEVER map date components to "dateOfBirth" or personal birth date unless the section/label explicitly says "Date of Birth".

FLEXIBLE FIELD NAME MATCHING — treat these as equivalent when mapping:
- "First Name", "Given Name", "Forename", "First", "Legal First Name", "Legal Name", "Legal Given Name" → firstName
- "Last Name", "Surname", "Family Name", "Last", "Legal Last Name", "Legal Surname", "Legal Family Name" → lastName
- ONLY use preferredFirstName for fields explicitly labelled "Preferred Name", "Preferred First Name", "Goes By", "Nickname" — never for "Legal" fields
- ONLY use preferredLastName for fields explicitly labelled "Preferred Last Name", "Preferred Surname"
- When in doubt between firstName and preferredFirstName, always choose firstName
- "Address", "Street Address", "Address Line 1", "Street", "Street Line 1" → addressLine1 (ONLY when section is blank or refers to applicant/personal/contact info)
- "Address Line 2", "Apt", "Suite", "Unit", "Floor", "Street Line 2" → addressLine2 (same condition as above)
- "Highest Degree", "Degree Earned", "Highest Level of Education", "Degree (Completed or Not Completed)" → educationDegree (use education[0].degree)
- "Major", "Major / Program of Study", "Field of Study", "Program", "Concentration", "Specialization" → educationMajor (use education[0].major)
- "Description", "Job Description", "Responsibilities", "Duties", "What did you do", "Role Description" in a Work Experience section → use workExperience[N].description (NOT the profile summary field)

GRADUATION STATUS MAPPING:
- "Did You Graduate?", "Graduation Status", "Have you graduated?" → check education[N].isCurrentlyStudying:
  - If isCurrentlyStudying is true → map to the option meaning "No" / "In Progress" / "Currently Enrolled"
  - If isCurrentlyStudying is false and a graduation/toDate exists → map to the option meaning "Yes" / "Received" / "Completed"

"NOT LISTED" TEXT FIELD RULE:
- Fields labelled like "If your school is not listed, enter it here", "If your employer is not listed, enter it here", "Not listed? Enter here", or similar patterns — these are fallback text fields adjacent to a School/Employer select dropdown.
  - First check whether the adjacent select field's options (provided in the options=[...] of another field in the same section) already contain the user's school/employer value.
  - If the school/employer IS present in the dropdown options → return null for this text field (the select handles it).
  - Only fill this text field when the school/employer is NOT found in any dropdown options in the same section.

ABSOLUTE RULE — NEVER use the user's personal addressLine1, addressLine2, city, state, zipCode, or country for ANY field that has a section= attribute containing "Experience", "Employer", "Professional", or "Work". These fields MUST use workExperience[N] sub-fields or return null. This overrides all other mapping rules.

SECTION-AWARE ADDRESS RULE:
- If a field has section containing "Work Experience", "Professional Experience", "Employer", or any work/job section:
  - "Address", "Street" fields → use workExperience[N].location (employer street address), NOT addressLine1
  - "City" → use workExperience[N].city or extract from workExperience[N].location
  - "State", "Region", "Province" → use workExperience[N].state or extract from workExperience[N].location
  - "Postal Code", "Zip" → use workExperience[N].zipCode if available, else null
  - "Country" → use workExperience[N].country if available, else null
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
- "Postal Code", "Post Code", "Pin Code" → zipCode (only for personal/contact section fields — see ABSOLUTE RULE above)

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
      "isCurrent": true or false,
      "description": "job responsibilities and achievements as a paragraph or bullet points"
    }
  ],
  "education": [
    {
      "degree": "full degree name e.g. B.S. Computer Science",
      "university": "university or college name",
      "location": "city and state",
      "country": "country",
      "fromDate": "YYYY-MM format, estimate if only year",
      "toDate": "YYYY-MM format, estimate if only year",
      "major": "field of study / major / program name (separate from degree type)"
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
