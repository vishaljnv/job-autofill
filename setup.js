// setup.js

// ─── Date helpers ─────────────────────────────────────────────────────────

// Convert any stored date string to YYYY-MM-DD for use as <input type="date"> value.
// Handles: YYYY-MM-DD (pass through), YYYY-MM (append -01), DD/MM/YYYY (reformat).
function toDateInputValue(stored) {
  if (!stored) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;                    // already YYYY-MM-DD
  if (/^\d{4}-\d{2}$/.test(stored))        return `${stored}-01`;            // YYYY-MM → YYYY-MM-01
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(stored)) {                               // DD/MM/YYYY
    const [d, m, y] = stored.split('/');
    return `${y}-${m}-${d}`;
  }
  return '';
}

// <input type="date"> always returns YYYY-MM-DD — just pass through.
function toStoredDate(val) {
  return val || '';
}

let currentStep = 1;
let selectedProvider = 'claude';
let workExperienceCount = 0;
let educationCount = 0;

function sendBg(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, resolve);
    } catch (e) {
      resolve({}); // fallback when running outside extension context
    }
  });
}

function setStep(n) {
  currentStep = n;
  document.querySelectorAll('.card').forEach(c => c.classList.remove('active'));
  document.getElementById(`step${n}`).classList.add('active');

  for (let i = 1; i <= 3; i++) {
    const ind = document.getElementById(`step${i}indicator`);
    ind.className = 'step';
    if (i < n) ind.classList.add('done');
    else if (i === n) ind.classList.add('active');
  }
}

// ─── Escape helpers ───────────────────────────────────────────────────────

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Preferred Name Toggle ────────────────────────────────────────────────

function togglePreferredName(show) {
  const fields = document.querySelectorAll('.preferred-name-field');
  fields.forEach(f => f.style.display = show ? 'flex' : 'none');
}

// ─── Work Experience ──────────────────────────────────────────────────────

function createWorkExperienceEntry(idx, data = {}) {
  const div = document.createElement('div');
  div.className = 'entry-card';
  div.dataset.weIndex = idx;
  div.innerHTML = `
    <div class="entry-card-header">
      <span class="entry-card-title">Experience #<span class="entry-num">${idx + 1}</span></span>
      <button type="button" class="btn-remove">Remove</button>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>Job Title</label>
        <input type="text" id="we-title-${idx}" placeholder="Senior Software Engineer" value="${escapeAttr(data.title)}" />
      </div>
      <div class="field">
        <label>Company Name</label>
        <input type="text" id="we-company-${idx}" placeholder="Acme Corp" value="${escapeAttr(data.company)}" />
      </div>
      <div class="field full">
        <label>Employer Address <span class="field-optional">(optional)</span></label>
        <input type="text" id="we-addressLine1-${idx}" placeholder="123 Corporate Blvd" value="${escapeAttr(data.addressLine1)}" />
      </div>
      <div class="field">
        <label>City</label>
        <input type="text" id="we-city-${idx}" placeholder="San Francisco" value="${escapeAttr(data.city)}" />
      </div>
      <div class="field">
        <label>State / Province</label>
        <input type="text" id="we-state-${idx}" placeholder="CA" value="${escapeAttr(data.state)}" />
      </div>
      <div class="field">
        <label>Country</label>
        <input type="text" id="we-country-${idx}" placeholder="United States" value="${escapeAttr(data.country)}" />
      </div>
      <div class="field">
        <label>ZIP / Postal Code <span class="field-optional">(optional)</span></label>
        <input type="text" id="we-zipCode-${idx}" placeholder="94105" value="${escapeAttr(data.zipCode)}" />
      </div>
      <div class="field">
        <label>Start Date</label>
        <input type="date" id="we-startDate-${idx}" value="${escapeAttr(toDateInputValue(data.startDate))}" />
      </div>
      <div class="field">
        <label>End Date</label>
        <input type="date" id="we-endDate-${idx}" value="${escapeAttr(toDateInputValue(data.endDate))}" ${data.isCurrent ? 'disabled' : ''} />
        <div class="checkbox-row" style="margin-top:7px;">
          <input type="checkbox" id="we-isCurrent-${idx}" ${data.isCurrent ? 'checked' : ''} />
          <label for="we-isCurrent-${idx}" class="checkbox-label">Current job</label>
        </div>
      </div>
      <div class="field full">
        <label>Description <span class="field-optional">(responsibilities &amp; achievements)</span></label>
        <textarea id="we-description-${idx}" rows="4" placeholder="Describe your role, key responsibilities and achievements...">${escapeAttr(data.description)}</textarea>
      </div>
    </div>
  `;

  const checkbox = div.querySelector(`#we-isCurrent-${idx}`);
  const endDateInput = div.querySelector(`#we-endDate-${idx}`);
  checkbox.addEventListener('change', () => {
    endDateInput.disabled = checkbox.checked;
    if (checkbox.checked) endDateInput.value = '';
  });

  div.querySelector('.btn-remove').addEventListener('click', () => {
    div.remove();
    renumberEntries('we');
  });

  return div;
}

function createEducationEntry(idx, data = {}) {
  const div = document.createElement('div');
  div.className = 'entry-card';
  div.dataset.eduIndex = idx;
  div.innerHTML = `
    <div class="entry-card-header">
      <span class="entry-card-title">Education #<span class="entry-num">${idx + 1}</span></span>
      <button type="button" class="btn-remove">Remove</button>
    </div>
    <div class="form-grid">
      <div class="field full">
        <label>Degree</label>
        <input type="text" id="edu-degree-${idx}" placeholder="B.S. Computer Science" value="${escapeAttr(data.degree)}" />
      </div>
      <div class="field full">
        <label>University / College</label>
        <input type="text" id="edu-university-${idx}" placeholder="University of California, Berkeley" value="${escapeAttr(data.university)}" />
      </div>
      <div class="field full">
        <label>Major / Field of Study</label>
        <input type="text" id="edu-major-${idx}" placeholder="Computer Science" value="${escapeAttr(data.major)}" />
      </div>
      <div class="field">
        <label>Location</label>
        <input type="text" id="edu-location-${idx}" placeholder="Berkeley, CA" value="${escapeAttr(data.location)}" />
      </div>
      <div class="field">
        <label>Country</label>
        <input type="text" id="edu-country-${idx}" placeholder="United States" value="${escapeAttr(data.country)}" />
      </div>
      <div class="field">
        <label>From Date</label>
        <input type="date" id="edu-fromDate-${idx}" value="${escapeAttr(toDateInputValue(data.fromDate))}" />
      </div>
      <div class="field">
        <label>To Date</label>
        <input type="date" id="edu-toDate-${idx}" value="${escapeAttr(toDateInputValue(data.toDate))}" ${data.isCurrentlyStudying ? 'disabled' : ''} />
        <div class="checkbox-row" style="margin-top:7px;">
          <input type="checkbox" id="edu-isCurrent-${idx}" ${data.isCurrentlyStudying ? 'checked' : ''} />
          <label for="edu-isCurrent-${idx}" class="checkbox-label">Currently studying</label>
        </div>
      </div>
    </div>
  `;

  const eduCheckbox = div.querySelector(`#edu-isCurrent-${idx}`);
  const toDateInput = div.querySelector(`#edu-toDate-${idx}`);
  eduCheckbox.addEventListener('change', () => {
    toDateInput.disabled = eduCheckbox.checked;
    if (eduCheckbox.checked) toDateInput.value = '';
  });

  div.querySelector('.btn-remove').addEventListener('click', () => {
    div.remove();
    renumberEntries('edu');
  });

  return div;
}

function renumberEntries(type) {
  const selector = type === 'we' ? '[data-we-index]' : '[data-edu-index]';
  document.querySelectorAll(selector).forEach((entry, i) => {
    const numEl = entry.querySelector('.entry-num');
    if (numEl) numEl.textContent = i + 1;
  });
}

// ─── Profile Read / Write ─────────────────────────────────────────────────

function readProfile() {
  const profile = {};

  const flatFields = [
    'firstName', 'lastName', 'email', 'phoneCountryCode', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'country', 'zipCode',
    'linkedinUrl', 'websiteUrl', 'githubUrl',
    'yearsExperience', 'desiredSalary', 'skills', 'summary',
    'gender', 'disabilityStatus', 'veteranStatus', 'requiresSponsorship', 'sponsorshipCountries',
    'hasWorkPermit', 'govtExperience', 'hasNonCompete', 'isGovtOfficial'
  ];

  flatFields.forEach(k => {
    const el = document.getElementById(k);
    if (el && el.value.trim()) profile[k] = el.value.trim();
  });

  // Preferred name
  if (document.getElementById('hasPreferredName')?.checked) {
    const pfn = document.getElementById('preferredFirstName')?.value.trim();
    const pln = document.getElementById('preferredLastName')?.value.trim();
    if (pfn) profile.preferredFirstName = pfn;
    if (pln) profile.preferredLastName = pln;
  }

  // Work experience
  const workExperience = [];
  document.querySelectorAll('[data-we-index]').forEach(entry => {
    const idx = entry.dataset.weIndex;
    const title = document.getElementById(`we-title-${idx}`)?.value.trim() || '';
    const company = document.getElementById(`we-company-${idx}`)?.value.trim() || '';
    if (!title && !company) return;
    workExperience.push({
      title,
      company,
      addressLine1: document.getElementById(`we-addressLine1-${idx}`)?.value.trim() || '',
      city:         document.getElementById(`we-city-${idx}`)?.value.trim() || '',
      state:        document.getElementById(`we-state-${idx}`)?.value.trim() || '',
      country:      document.getElementById(`we-country-${idx}`)?.value.trim() || '',
      zipCode:      document.getElementById(`we-zipCode-${idx}`)?.value.trim() || '',
      startDate: toStoredDate(document.getElementById(`we-startDate-${idx}`)?.value || ''),
      endDate:   toStoredDate(document.getElementById(`we-endDate-${idx}`)?.value   || ''),
      isCurrent: document.getElementById(`we-isCurrent-${idx}`)?.checked || false,
      description: document.getElementById(`we-description-${idx}`)?.value.trim() || ''
    });
  });
  if (workExperience.length > 0) profile.workExperience = workExperience;

  // Education
  const education = [];
  document.querySelectorAll('[data-edu-index]').forEach(entry => {
    const idx = entry.dataset.eduIndex;
    const degree = document.getElementById(`edu-degree-${idx}`)?.value.trim() || '';
    const university = document.getElementById(`edu-university-${idx}`)?.value.trim() || '';
    if (!degree && !university) return;
    education.push({
      degree,
      university,
      major: document.getElementById(`edu-major-${idx}`)?.value.trim() || '',
      location: document.getElementById(`edu-location-${idx}`)?.value.trim() || '',
      country: document.getElementById(`edu-country-${idx}`)?.value.trim() || '',
      fromDate: toStoredDate(document.getElementById(`edu-fromDate-${idx}`)?.value || ''),
      toDate:   toStoredDate(document.getElementById(`edu-toDate-${idx}`)?.value   || ''),
      isCurrentlyStudying: document.getElementById(`edu-isCurrent-${idx}`)?.checked || false
    });
  });
  if (education.length > 0) profile.education = education;

  return profile;
}

function loadProfile(profile) {
  const flatFields = [
    'firstName', 'lastName', 'email', 'phoneCountryCode', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'country', 'zipCode',
    'linkedinUrl', 'websiteUrl', 'githubUrl',
    'yearsExperience', 'desiredSalary', 'skills', 'summary',
    'gender', 'disabilityStatus', 'veteranStatus', 'requiresSponsorship', 'sponsorshipCountries',
    'hasWorkPermit', 'govtExperience', 'hasNonCompete', 'isGovtOfficial'
  ];

  flatFields.forEach(k => {
    const el = document.getElementById(k);
    if (el && profile[k] != null) el.value = profile[k];
  });

  // Preferred name
  if (profile.preferredFirstName || profile.preferredLastName) {
    const cb = document.getElementById('hasPreferredName');
    if (cb) { cb.checked = true; togglePreferredName(true); }
    if (profile.preferredFirstName) document.getElementById('preferredFirstName').value = profile.preferredFirstName;
    if (profile.preferredLastName) document.getElementById('preferredLastName').value = profile.preferredLastName;
  }

  // Show sponsorship countries field if needed
  if (profile.requiresSponsorship === 'Yes') {
    document.getElementById('sponsorshipCountriesField').style.display = '';
  }

  // Work experience
  const weContainer = document.getElementById('workExperienceContainer');
  if (weContainer && profile.workExperience && profile.workExperience.length > 0) {
    weContainer.innerHTML = '';
    workExperienceCount = 0;
    profile.workExperience.forEach(exp => {
      weContainer.appendChild(createWorkExperienceEntry(workExperienceCount++, exp));
    });
  }

  // Education
  const eduContainer = document.getElementById('educationContainer');
  if (eduContainer && profile.education && profile.education.length > 0) {
    eduContainer.innerHTML = '';
    educationCount = 0;
    profile.education.forEach(edu => {
      eduContainer.appendChild(createEducationEntry(educationCount++, edu));
    });
  }
}

// ─── Resume Import ────────────────────────────────────────────────────────

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder('utf-8');
  let text = '';

  let i = 0;
  while (i < bytes.length - 30) {
    // ZIP local file header: PK\x03\x04
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
      const compressionMethod = bytes[i+8] | (bytes[i+9] << 8);
      const compressedSize = bytes[i+18] | (bytes[i+19] << 8) | (bytes[i+20] << 16) | (bytes[i+21] << 24);
      const uncompressedSize = bytes[i+22] | (bytes[i+23] << 8) | (bytes[i+24] << 16) | (bytes[i+25] << 24);
      const filenameLen = bytes[i+26] | (bytes[i+27] << 8);
      const extraLen = bytes[i+28] | (bytes[i+29] << 8);
      const dataStart = i + 30 + filenameLen + extraLen;

      let filename = '';
      try { filename = decoder.decode(bytes.slice(i + 30, i + 30 + filenameLen)); } catch (e) { /* skip */ }

      if (filename === 'word/document.xml') {
        const compressedData = bytes.slice(dataStart, dataStart + compressedSize);
        if (compressionMethod === 0) {
          text = decoder.decode(compressedData);
        } else if (compressionMethod === 8) {
          try {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(compressedData);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
            text = decoder.decode(out);
          } catch (e) {
            console.error('[FormFill AI] DOCX decompression failed:', e);
          }
        }
        break;
      }

      const advance = dataStart + Math.max(compressedSize, 0) - i;
      i += advance > 0 ? advance : 1;
    } else {
      i++;
    }
  }

  if (text) {
    text = text
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<w:br[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  return text;
}

function populateFormFromResume(parsed) {
  if (!parsed) return;

  const flatFields = [
    'firstName', 'lastName', 'email', 'phoneCountryCode', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'country', 'zipCode',
    'linkedinUrl', 'websiteUrl', 'githubUrl',
    'yearsExperience', 'desiredSalary', 'skills', 'summary',
    'gender', 'disabilityStatus', 'veteranStatus', 'requiresSponsorship', 'sponsorshipCountries',
    'hasWorkPermit', 'govtExperience', 'hasNonCompete', 'isGovtOfficial'
  ];

  flatFields.forEach(k => {
    if (parsed[k] != null) {
      const el = document.getElementById(k);
      if (el) el.value = parsed[k];
    }
  });

  if (parsed.preferredFirstName || parsed.preferredLastName) {
    const cb = document.getElementById('hasPreferredName');
    if (cb) { cb.checked = true; togglePreferredName(true); }
    if (parsed.preferredFirstName) document.getElementById('preferredFirstName').value = parsed.preferredFirstName;
    if (parsed.preferredLastName) document.getElementById('preferredLastName').value = parsed.preferredLastName;
  }

  if (parsed.workExperience && parsed.workExperience.length > 0) {
    const container = document.getElementById('workExperienceContainer');
    container.innerHTML = '';
    workExperienceCount = 0;
    parsed.workExperience.forEach(exp => {
      container.appendChild(createWorkExperienceEntry(workExperienceCount++, exp));
    });
  }

  if (parsed.education && parsed.education.length > 0) {
    const container = document.getElementById('educationContainer');
    container.innerHTML = '';
    educationCount = 0;
    parsed.education.forEach(edu => {
      container.appendChild(createEducationEntry(educationCount++, edu));
    });
  }
}

async function handleResumeImport(file) {
  if (!file) return;

  const statusEl = document.getElementById('resumeStatus');
  const fileNameEl = document.getElementById('resumeFileName');

  fileNameEl.textContent = file.name;
  statusEl.textContent = 'Parsing resume with AI...';
  statusEl.className = 'resume-status loading';

  try {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isDocx = file.name.toLowerCase().endsWith('.docx') ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (!isPdf && !isDocx) {
      throw new Error('Unsupported file type. Please use a PDF or .docx file.');
    }

    let result;
    if (isPdf) {
      const base64 = await readFileAsBase64(file);
      result = await sendBg({ type: 'AI_PARSE_RESUME', fileType: 'pdf', fileData: base64 });
    } else {
      const arrayBuffer = await readFileAsArrayBuffer(file);
      const textContent = await extractDocxText(arrayBuffer);
      if (!textContent || textContent.length < 30) throw new Error('Could not extract text from document. Make sure it is a valid .docx file.');
      result = await sendBg({ type: 'AI_PARSE_RESUME', fileType: 'docx', textContent });
    }

    if (result.error) throw new Error(result.error);
    if (!result.profile) throw new Error('No data returned from AI.');

    populateFormFromResume(result.profile);
    statusEl.textContent = '✓ Resume imported! Review and edit the fields below.';
    statusEl.className = 'resume-status ok';

  } catch (err) {
    statusEl.textContent = `✗ ${err.message}`;
    statusEl.className = 'resume-status fail';
    console.error('[FormFill AI] Resume import error:', err);
  }
}

// ─── Provider UI ──────────────────────────────────────────────────────────

function updateProviderUI(provider) {
  document.getElementById('providerClaude').classList.toggle('selected', provider === 'claude');
  document.getElementById('providerOpenAI').classList.toggle('selected', provider === 'openai');
}

function updateApiKeyHint(key) {
  if (key.startsWith('sk-ant')) {
    selectedProvider = 'claude';
    updateProviderUI('claude');
  } else if (key.startsWith('sk-') && !key.startsWith('sk-ant')) {
    selectedProvider = 'openai';
    updateProviderUI('openai');
  }
}

// ─── API Key Test ─────────────────────────────────────────────────────────

async function testApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  const resultEl = document.getElementById('testResult');
  const btn = document.getElementById('testApiBtn');

  if (!key) {
    resultEl.textContent = '✗ Enter a key first';
    resultEl.className = 'test-result fail';
    resultEl.style.display = 'block';
    return;
  }

  btn.textContent = 'Testing...';
  btn.disabled = true;
  resultEl.style.display = 'none';

  // Route through background service worker to avoid CORS restrictions
  const { ok, error } = await sendBg({ type: 'TEST_CONNECTION', provider: selectedProvider, apiKey: key });

  if (ok) {
    resultEl.textContent = '✓ Connection successful!';
    resultEl.className = 'test-result ok';
  } else {
    resultEl.textContent = `✗ ${error || 'Connection failed'}`;
    resultEl.className = 'test-result fail';
  }

  resultEl.style.display = 'block';
  btn.textContent = 'Test Connection';
  btn.disabled = false;
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  // Seed default entries
  const weContainer = document.getElementById('workExperienceContainer');
  weContainer.appendChild(createWorkExperienceEntry(workExperienceCount++));

  const eduContainer = document.getElementById('educationContainer');
  eduContainer.appendChild(createEducationEntry(educationCount++));
  eduContainer.appendChild(createEducationEntry(educationCount++));

  // Load existing settings
  const settings = await sendBg({ type: 'GET_SETTINGS' });

  if (settings.userProfile) loadProfile(settings.userProfile);
  if (settings.aiApiKey) {
    document.getElementById('apiKey').value = settings.aiApiKey;
    document.getElementById('settingsApiKey').value = settings.aiApiKey;
  }
  if (settings.aiProvider) {
    selectedProvider = settings.aiProvider;
    updateProviderUI(selectedProvider);
    document.getElementById('settingsProvider').value = selectedProvider;
  }

  // If already set up, show step 3 (settings view)
  if (settings.setupComplete) {
    setStep(3);
  }

  // Preferred name toggle
  document.getElementById('hasPreferredName').addEventListener('change', e => {
    togglePreferredName(e.target.checked);
  });

  // Sponsorship countries conditional field
  document.getElementById('requiresSponsorship').addEventListener('change', e => {
    document.getElementById('sponsorshipCountriesField').style.display = e.target.value === 'Yes' ? '' : 'none';
  });

  // Add Work Experience
  document.getElementById('addWorkExperience').addEventListener('click', () => {
    weContainer.appendChild(createWorkExperienceEntry(workExperienceCount++));
  });

  // Add Education
  document.getElementById('addEducation').addEventListener('click', () => {
    eduContainer.appendChild(createEducationEntry(educationCount++));
  });

  // Resume import
  const resumeInput = document.getElementById('resumeFileInput');
  document.getElementById('chooseResumeBtn').addEventListener('click', () => resumeInput.click());
  resumeInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleResumeImport(file);
  });

  // Provider selection + update console button link
  function updateConsoleBtn() {
    const btn = document.getElementById('openConsoleBtn');
    const desc = document.getElementById('keyStepDesc');
    if (selectedProvider === 'claude') {
      btn.textContent = 'Open Anthropic Console →';
      btn.onclick = () => window.open('https://console.anthropic.com/settings/keys', '_blank');
      desc.textContent = 'Sign into the Anthropic Console, create a new API key, and copy it. It only takes a minute.';
    } else {
      btn.textContent = 'Open OpenAI Platform →';
      btn.onclick = () => window.open('https://platform.openai.com/api-keys', '_blank');
      desc.textContent = 'Sign into the OpenAI Platform, create a new secret key, and copy it. It only takes a minute.';
    }
  }
  updateConsoleBtn();

  ['Claude', 'OpenAI'].forEach(name => {
    document.getElementById(`provider${name}`).addEventListener('click', () => {
      selectedProvider = name === 'Claude' ? 'claude' : 'openai';
      updateProviderUI(selectedProvider);
      updateConsoleBtn();
    });
  });

  // Step 1 → Step 2: validate + save API key, then show profile
  document.getElementById('connectAndContinue').addEventListener('click', async () => {
    const key = document.getElementById('apiKey').value.trim();
    document.getElementById('apiError').style.display = 'none';
    if (!key) {
      document.getElementById('apiError').style.display = 'block';
      return;
    }
    // Save API key immediately so resume import works on step 2
    await sendBg({ type: 'SAVE_SETTINGS', provider: selectedProvider, apiKey: key, profile: settings.userProfile || {} });
    setStep(2);
  });

  document.getElementById('backToStep1').addEventListener('click', () => setStep(1));
  document.getElementById('editProfileBtn').addEventListener('click', () => setStep(2));

  document.getElementById('testApiBtn').addEventListener('click', testApiKey);

  // Step 2 → Step 3: validate profile + save
  document.getElementById('saveAndFinish').addEventListener('click', async () => {
    const profile = readProfile();
    if (!profile.firstName || !profile.lastName || !profile.email) {
      document.getElementById('profileError').style.display = 'block';
      document.getElementById('profileError').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    document.getElementById('profileError').style.display = 'none';
    const key = document.getElementById('apiKey').value.trim() || settings.aiApiKey;
    await sendBg({ type: 'SAVE_SETTINGS', provider: selectedProvider, apiKey: key, profile });
    setStep(3);
  });

  document.getElementById('closeSetup').addEventListener('click', () => window.close());

  // Settings updates
  document.getElementById('updateSettings').addEventListener('click', async () => {
    const provider = document.getElementById('settingsProvider').value;
    const key = document.getElementById('settingsApiKey').value.trim();
    const profile = readProfile();
    await sendBg({
      type: 'SAVE_SETTINGS',
      provider,
      apiKey: key || settings.aiApiKey,
      profile: Object.keys(profile).length > 0 ? profile : (settings.userProfile || {})
    });
    alert('Settings saved!');
  });

  // Clear data
  document.getElementById('clearDataBtn').addEventListener('click', async () => {
    if (confirm('Are you sure? This will delete your entire profile and all learned form data.')) {
      await sendBg({ type: 'CLEAR_DATA' });
      window.location.reload();
    }
  });

  // API key hint auto-detect
  document.getElementById('apiKey').addEventListener('input', e => updateApiKeyHint(e.target.value));
}

init();
