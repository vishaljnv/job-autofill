// content.js — Main content script
// Injected into every page. Handles the Autofill button and form interaction flow.

(() => {
  // ─── State ────────────────────────────────────────────────────────────────
  let isAutofilling = false;
  let pendingFields = []; // Fields that need user input
  let overlay = null;
  let autofillBtn = null;
  let promptDialog = null;
  
  // ─── Inject Autofill Button ───────────────────────────────────────────────
  function injectAutofillButton() {
    if (document.getElementById('formfill-ai-btn')) return;

    autofillBtn = document.createElement('div');
    autofillBtn.id = 'formfill-ai-btn';
    autofillBtn.innerHTML = `
      <div class="ffai-icon">✦</div>
      <span class="ffai-label">Autofill</span>
    `;
    autofillBtn.title = 'FormFill AI — Click to autofill this page';
    autofillBtn.addEventListener('click', handleAutofillClick);
    document.body.appendChild(autofillBtn);
  }

  // ─── Main Autofill Flow ───────────────────────────────────────────────────
  async function handleAutofillClick() {
    if (isAutofilling) return;
    isAutofilling = true;
    setButtonState('loading');

    try {
      const fields = FormDetector.detectFields();
      if (fields.length === 0) {
        showToast('No fillable form fields found on this page.', 'info');
        isAutofilling = false;
        setButtonState('idle');
        return;
      }

      // Get profile and learned mappings from background
      const { profile, learnedMappings } = await sendMessage({ type: 'GET_CONTEXT', hostname: location.hostname });

      if (!profile || Object.keys(profile).length === 0) {
        showToast('Please complete your profile setup first.', 'warn');
        sendMessage({ type: 'OPEN_SETUP' });
        isAutofilling = false;
        setButtonState('idle');
        return;
      }

      // Check API key
      const { hasApiKey } = await sendMessage({ type: 'CHECK_API_KEY' });
      if (!hasApiKey) {
        showToast('Please add your API key in settings first.', 'warn');
        sendMessage({ type: 'OPEN_SETUP' });
        isAutofilling = false;
        setButtonState('idle');
        return;
      }

      showOverlay('Analyzing form fields with AI...');

      // Serialize fields (without element refs) for AI
      const fieldData = fields.map(f => ({
        id: f.id, name: f.name, key: f.key,
        type: f.type, placeholder: f.placeholder,
        label: f.label, surroundingText: f.surroundingText,
        options: f.options
      }));

      // First: apply learned mappings immediately (no AI needed)
      let aiNeededFields = [];
      let prefillCount = 0;
      
      for (const field of fields) {
        const learned = learnedMappings[field.key] || learnedMappings[field.name] || learnedMappings[field.label];
        if (learned && profile[learned]) {
          const success = FormDetector.fillField(field.element, profile[learned]);
          if (success) {
            FormDetector.highlightField(field.element, 'filled');
            prefillCount++;
          }
        } else {
          aiNeededFields.push(field);
        }
      }

      // Then: use AI to map remaining fields
      if (aiNeededFields.length > 0) {
        updateOverlay(`AI mapping ${aiNeededFields.length} fields...`);
        
        const aiFieldData = aiNeededFields.map(f => ({
          id: f.id, name: f.name, key: f.key,
          type: f.type, placeholder: f.placeholder,
          label: f.label, surroundingText: f.surroundingText,
          options: f.options
        }));

        const { mappings, error } = await sendMessage({
          type: 'AI_MAP_FIELDS',
          fields: aiFieldData,
          profile: profile
        });

        if (error) {
          hideOverlay();
          showToast(`AI error: ${error}`, 'error');
          isAutofilling = false;
          setButtonState('idle');
          return;
        }

        // Apply AI mappings
        const missingFields = [];
        
        for (const field of aiNeededFields) {
          const value = mappings[field.key] || mappings[field.id] || mappings[field.name];
          
          if (value !== null && value !== undefined && value !== '') {
            const success = FormDetector.fillField(field.element, value);
            if (success) {
              FormDetector.highlightField(field.element, 'filled');
              prefillCount++;
              // Learn this mapping for next time
              const profileKey = Object.keys(profile).find(k => 
                String(profile[k]).toLowerCase() === String(value).toLowerCase()
              );
              if (profileKey) {
                sendMessage({
                  type: 'LEARN_MAPPING',
                  hostname: location.hostname,
                  fieldKey: field.key,
                  profileKey: profileKey
                });
              }
            }
          } else {
            missingFields.push(field);
          }
        }

        hideOverlay();

        if (missingFields.length > 0) {
          showToast(`Filled ${prefillCount} fields. ${missingFields.length} need your input.`, 'info');
          pendingFields = missingFields;
          // Highlight missing fields
          missingFields.forEach(f => FormDetector.highlightField(f.element, 'missing'));
          // Start prompting for missing fields one by one
          setTimeout(() => promptForNextField(), 500);
        } else {
          showToast(`✓ Filled all ${prefillCount} fields!`, 'success');
          isAutofilling = false;
          setButtonState('done');
          setTimeout(() => setButtonState('idle'), 3000);
        }
      } else {
        hideOverlay();
        showToast(`✓ Filled ${prefillCount} fields using learned data!`, 'success');
        isAutofilling = false;
        setButtonState('done');
        setTimeout(() => setButtonState('idle'), 3000);
      }

    } catch (err) {
      hideOverlay();
      showToast(`Error: ${err.message}`, 'error');
      console.error('[FormFill AI]', err);
      isAutofilling = false;
      setButtonState('idle');
    }
  }

  // ─── Prompt User for Missing Fields ──────────────────────────────────────
  async function promptForNextField() {
    if (pendingFields.length === 0) {
      showToast('All fields filled! ✓', 'success');
      isAutofilling = false;
      setButtonState('done');
      setTimeout(() => setButtonState('idle'), 3000);
      return;
    }

    const field = pendingFields[0];
    
    // Scroll the field into view
    field.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Ask AI what this field is (to get a friendly question)
    const { profile } = await sendMessage({ type: 'GET_CONTEXT', hostname: location.hostname });
    const { inference, error } = await sendMessage({
      type: 'AI_INFER_FIELD',
      fieldContext: {
        label: field.label,
        placeholder: field.placeholder,
        type: field.type,
        surroundingText: field.surroundingText
      },
      profile: profile
    });

    const question = inference?.question || `What is your ${field.label || field.placeholder || field.name}?`;
    const profileKey = inference?.profileKey || field.key;

    showFieldPrompt(field, question, profileKey);
  }

  function showFieldPrompt(field, question, profileKey) {
    // Remove existing prompt
    if (promptDialog) promptDialog.remove();

    const rect = field.element.getBoundingClientRect();
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    promptDialog = document.createElement('div');
    promptDialog.id = 'formfill-prompt';
    promptDialog.innerHTML = `
      <div class="ffprompt-header">
        <span class="ffprompt-icon">✦</span>
        <span>FormFill AI needs your input</span>
        <button class="ffprompt-skip" title="Skip this field">Skip</button>
      </div>
      <p class="ffprompt-question">${escapeHtml(question)}</p>
      <div class="ffprompt-input-row">
        ${field.type === 'select' && field.options.length > 0
          ? `<select class="ffprompt-input">
               <option value="">Choose...</option>
               ${field.options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.text)}</option>`).join('')}
             </select>`
          : `<input type="text" class="ffprompt-input" placeholder="Type your answer..." />`
        }
        <button class="ffprompt-submit">Fill ↵</button>
      </div>
      <label class="ffprompt-remember">
        <input type="checkbox" class="ffprompt-save" checked />
        Remember this for next time
      </label>
    `;

    // Position near the field
    const top = Math.min(rect.bottom + scrollY + 8, scrollY + window.innerHeight - 180);
    const left = Math.max(scrollX + 8, Math.min(rect.left + scrollX, scrollX + window.innerWidth - 360));
    promptDialog.style.top = top + 'px';
    promptDialog.style.left = left + 'px';

    document.body.appendChild(promptDialog);

    // Focus the input
    const inputEl = promptDialog.querySelector('.ffprompt-input');
    setTimeout(() => inputEl?.focus(), 100);

    // Handle submit
    const handleSubmit = async () => {
      const value = inputEl.value;
      if (!value) return;

      const shouldSave = promptDialog.querySelector('.ffprompt-save').checked;

      FormDetector.clearHighlight(field.element);
      FormDetector.fillField(field.element, value);
      FormDetector.highlightField(field.element, 'filled');

      if (shouldSave) {
        // Save to profile and learn mapping
        await sendMessage({ type: 'UPDATE_PROFILE_FIELD', key: profileKey, value: value });
        await sendMessage({
          type: 'LEARN_MAPPING',
          hostname: location.hostname,
          fieldKey: field.key,
          profileKey: profileKey
        });
      }

      promptDialog.remove();
      promptDialog = null;
      pendingFields.shift();
      setTimeout(() => promptForNextField(), 300);
    };

    promptDialog.querySelector('.ffprompt-submit').addEventListener('click', handleSubmit);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });

    // Skip
    promptDialog.querySelector('.ffprompt-skip').addEventListener('click', () => {
      FormDetector.clearHighlight(field.element);
      promptDialog.remove();
      promptDialog = null;
      pendingFields.shift();
      setTimeout(() => promptForNextField(), 300);
    });
  }

  // ─── UI Helpers ───────────────────────────────────────────────────────────
  function setButtonState(state) {
    if (!autofillBtn) return;
    autofillBtn.className = '';
    autofillBtn.classList.add(`ffai-state-${state}`);
    const label = autofillBtn.querySelector('.ffai-label');
    const icon = autofillBtn.querySelector('.ffai-icon');
    
    switch (state) {
      case 'loading':
        label.textContent = 'Thinking...';
        icon.textContent = '◌';
        icon.style.animation = 'ffai-spin 1s linear infinite';
        break;
      case 'done':
        label.textContent = 'Done!';
        icon.textContent = '✓';
        icon.style.animation = '';
        break;
      default:
        label.textContent = 'Autofill';
        icon.textContent = '✦';
        icon.style.animation = '';
    }
  }

  function showOverlay(message) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'formfill-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="ffoverlay-box">
        <div class="ffoverlay-spinner"></div>
        <p class="ffoverlay-msg">${message}</p>
      </div>
    `;
    overlay.style.display = 'flex';
  }

  function updateOverlay(message) {
    if (overlay) {
      const msg = overlay.querySelector('.ffoverlay-msg');
      if (msg) msg.textContent = message;
    }
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  let toastTimeout;
  function showToast(message, type = 'info') {
    let toast = document.getElementById('formfill-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'formfill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `fftoast-${type}`;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
    }, 3500);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ─── Message Passing to Background ───────────────────────────────────────
  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response || {});
      });
    });
  }

  // ─── Listen for messages from popup ──────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'TRIGGER_AUTOFILL') {
      handleAutofillClick();
      sendResponse({ ok: true });
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  // Wait a bit for the page to stabilize before injecting
  if (document.readyState === 'complete') {
    injectAutofillButton();
  } else {
    window.addEventListener('load', injectAutofillButton);
  }

})();
