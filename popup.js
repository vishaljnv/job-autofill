// popup.js

async function sendBg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function init() {
  const settings = await sendBg({ type: 'GET_SETTINGS' });
  const profile = settings.userProfile || {};
  const hasApiKey = !!(settings.aiApiKey && settings.aiApiKey.trim());
  const isSetup = !!settings.setupComplete;

  // Status
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const warning = document.getElementById('warningBanner');
  const warningText = document.getElementById('warningText');

  if (!isSetup || Object.keys(profile).length === 0) {
    dot.className = 'status-dot warn';
    statusText.textContent = 'Setup required';
    warning.classList.add('visible');
    warningText.innerHTML = 'Complete <a id="warnSetupLink">setup</a> to start autofilling.';
    document.getElementById('warnSetupLink')?.addEventListener('click', openSetup);
    document.getElementById('autofillBtn').disabled = true;
  } else if (!hasApiKey) {
    dot.className = 'status-dot warn';
    statusText.textContent = 'API key missing';
    warning.classList.add('visible');
    warningText.innerHTML = 'Add your API key in <a id="warnSetupLink">settings</a>.';
    document.getElementById('warnSetupLink')?.addEventListener('click', openSetup);
    document.getElementById('autofillBtn').disabled = true;
  } else {
    dot.className = 'status-dot ok';
    statusText.textContent = `Active · ${settings.aiProvider === 'openai' ? 'OpenAI GPT-4o' : 'Claude Haiku'}`;
  }

  // Profile chips
  const grid = document.getElementById('profileGrid');
  const profileKeys = Object.keys(profile);
  if (profileKeys.length > 0) {
    grid.innerHTML = profileKeys.slice(0, 6).map(k => `
      <div class="profile-chip">
        <strong>${formatKey(k)}</strong>
        ${escapeHtml(String(profile[k]).substring(0, 22))}
      </div>
    `).join('');
  }

  // Stats
  document.getElementById('statProfile').textContent = profileKeys.length;
  const { data } = await sendBg({ type: 'EXPORT_DATA' });
  const learned = data.learnedMappings || {};
  const sites = Object.keys(learned).length;
  const totalFields = Object.values(learned).reduce((acc, v) => acc + Object.keys(v).length, 0);
  document.getElementById('statSites').textContent = sites;
  document.getElementById('statFields').textContent = totalFields;

  // Autofill button
  document.getElementById('autofillBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_AUTOFILL' });
      window.close();
    }
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSetup);
  document.getElementById('setupLink').addEventListener('click', openSetup);

  // Export
  document.getElementById('exportLink').addEventListener('click', async () => {
    const { data } = await sendBg({ type: 'EXPORT_DATA' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formfill-ai-data.json';
    a.click();
    URL.revokeObjectURL(url);
  });
}

function openSetup() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function formatKey(key) {
  return key.replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

init();
