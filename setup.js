// setup.js

const PROFILE_FIELDS = [
  'firstName', 'lastName', 'email', 'phone',
  'city', 'state', 'country', 'zipCode',
  'linkedinUrl', 'websiteUrl', 'githubUrl',
  'currentTitle', 'currentCompany', 'yearsExperience',
  'desiredSalary', 'skills',
  'educationDegree', 'educationSchool', 'graduationYear',
  'workAuthorization', 'summary'
];

let currentStep = 1;
let selectedProvider = 'claude';

function sendBg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
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

function readProfile() {
  const profile = {};
  PROFILE_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (el && el.value.trim()) profile[k] = el.value.trim();
  });
  return profile;
}

function loadProfile(profile) {
  PROFILE_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (el && profile[k]) el.value = profile[k];
  });
}

async function testApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  const provider = selectedProvider;
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

  try {
    let ok = false;

    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      ok = res.status === 200;
      if (!ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      ok = res.status === 200;
      if (!ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
    }

    resultEl.textContent = '✓ Connection successful!';
    resultEl.className = 'test-result ok';
  } catch (err) {
    resultEl.textContent = `✗ ${err.message}`;
    resultEl.className = 'test-result fail';
  }

  resultEl.style.display = 'block';
  btn.textContent = 'Test Connection';
  btn.disabled = false;
}

async function init() {
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

  // Provider selection
  ['Claude', 'OpenAI'].forEach(name => {
    const id = `provider${name}`;
    document.getElementById(id).addEventListener('click', () => {
      selectedProvider = name === 'Claude' ? 'claude' : 'openai';
      updateProviderUI(selectedProvider);
    });
  });

  // Navigation
  document.getElementById('nextToStep2').addEventListener('click', () => {
    const profile = readProfile();
    if (!profile.firstName || !profile.lastName || !profile.email) {
      document.getElementById('profileError').style.display = 'block';
      return;
    }
    document.getElementById('profileError').style.display = 'none';
    setStep(2);
  });

  document.getElementById('backToStep1').addEventListener('click', () => setStep(1));

  document.getElementById('testApiBtn').addEventListener('click', testApiKey);

  document.getElementById('saveAndFinish').addEventListener('click', async () => {
    const key = document.getElementById('apiKey').value.trim();
    document.getElementById('apiError').style.display = 'none';

    if (!key) {
      document.getElementById('apiError').style.display = 'block';
      return;
    }

    const profile = readProfile();
    await sendBg({
      type: 'SAVE_SETTINGS',
      provider: selectedProvider,
      apiKey: key,
      profile: profile
    });

    setStep(3);
  });

  document.getElementById('closeSetup').addEventListener('click', () => {
    window.close();
  });

  // Settings updates
  document.getElementById('updateSettings').addEventListener('click', async () => {
    const provider = document.getElementById('settingsProvider').value;
    const key = document.getElementById('settingsApiKey').value.trim();
    const profile = settings.userProfile || {};
    await sendBg({
      type: 'SAVE_SETTINGS',
      provider: provider,
      apiKey: key || settings.aiApiKey,
      profile: profile
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

  // API key hint
  document.getElementById('apiKey').addEventListener('input', (e) => {
    updateApiKeyHint(e.target.value);
  });
}

function updateProviderUI(provider) {
  document.getElementById('providerClaude').classList.toggle('selected', provider === 'claude');
  document.getElementById('providerOpenAI').classList.toggle('selected', provider === 'openai');
  
  const hint = document.getElementById('apiKeyHint');
  if (provider === 'claude') {
    hint.innerHTML = 'Get your Claude API key at <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a>';
  } else {
    hint.innerHTML = 'Get your OpenAI API key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>';
  }
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

init();
