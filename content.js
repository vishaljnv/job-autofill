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
      let fields = FormDetector.detectFields();

      // If no fields found in top frame, try broadcasting to child frames
      if (fields.length === 0 && window.self === window.top) {
        const frames = document.querySelectorAll('iframe');
        if (frames.length > 0) {
          // Send trigger to all child frames via chrome.tabs.sendMessage won't work here;
          // use window.postMessage to reach same-origin frames, and rely on
          // the TRIGGER_AUTOFILL runtime message for cross-origin frames via background.
          chrome.runtime.sendMessage({ type: 'TRIGGER_AUTOFILL_FRAMES' });
          showToast('Autofilling form in embedded frame...', 'info');
          isAutofilling = false;
          setButtonState('idle');
        } else {
          showToast('No fillable form fields found on this page.', 'info');
          isAutofilling = false;
          setButtonState('idle');
        }
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
        sectionContext: f.sectionContext, dateRole: f.dateRole,
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
          sectionContext: f.sectionContext, dateRole: f.dateRole,
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

        // ── Deterministic post-processing of AI mappings ──────────────────
        // These rules run AFTER the AI returns, catching mistakes the AI makes
        // regardless of what the prompt says.

        const workSectionRe   = /experience|employer|professional|work/i;
        const personalAddrKeys = ['addressLine1','addressLine2','city','state','country','zipCode'];
        const personalAddrVals = new Set(
          personalAddrKeys.map(k => (profile[k] || '')).filter(Boolean).map(v => v.toLowerCase())
        );

        for (const field of aiNeededFields) {
          const mapKey  = field.key  in mappings ? field.key
                        : field.id   in mappings ? field.id
                        : field.name in mappings ? field.name : null;
          if (!mapKey) continue;
          const val = mappings[mapKey];
          if (val === null || val === undefined || val === '') continue;

          const section   = (field.sectionContext || '').toLowerCase();
          const labelText = (field.label || '').toLowerCase();
          const isWorkSection = workSectionRe.test(section);

          // 1. Never put personal address values into a work-experience section field
          if (isWorkSection && personalAddrVals.has(String(val).toLowerCase())) {
            mappings[mapKey] = null;
            continue;
          }

          // 2. "Legal First/Last Name" must use firstName/lastName, never preferred variants
          if (/legal/.test(labelText)) {
            if (/first|given|forename/.test(labelText) && val === profile.preferredFirstName) {
              mappings[mapKey] = profile.firstName || val;
            }
            if (/last|surname|family/.test(labelText) && val === profile.preferredLastName) {
              mappings[mapKey] = profile.lastName || val;
            }
          }
        }
        // ── End post-processing ────────────────────────────────────────────

        // Apply AI mappings
        const missingFields = [];

        for (const field of aiNeededFields) {
          const value = mappings[field.key] ?? mappings[field.id] ?? mappings[field.name];
          
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

  // Month name → zero-padded number e.g. "May" → "05"
  const MONTH_MAP = {
    january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
    july:'07', august:'08', september:'09', october:'10', november:'11', december:'12'
  };

  // Classify a date field's role from label/surrounding text
  function classifyDateRole(f) {
    const text = (f.surroundingText || f.label || '').toLowerCase();
    if (/start\s*date|\bfrom\s*date|\bbegin/i.test(text)) return 'startDate';
    if (/end\s*date|\bto\s*date|\buntil/i.test(text))     return 'endDate';
    if (/graduation|date\s*received|completed|expected/i.test(text)) return 'toDate';
    return 'date';
  }

  function friendlyDateLabel(role) {
    return { startDate: 'Start Date', endDate: 'End Date', toDate: 'Graduation / Completion Date', date: 'Date' }[role] || 'Date';
  }

  function sectionEntryIndex(section) {
    const m = (section || '').match(/\((\d+)\)/);
    return m ? parseInt(m[1]) - 1 : 0;
  }

  // Group ALL pending date-role fields into section buckets.
  // Each bucket = {section, subGroups: [{role, label, monthField, dayField, yearField, allFields}]}
  function buildDateSectionGroups() {
    const dateFields = pendingFields.filter(f => f.dateRole);
    if (!dateFields.length) return null;

    // Step 1: split into M/D/Y triplets by context signature
    const triplets = [];
    let cur = null, lastSig = null;
    for (const f of dateFields) {
      const sig = (f.sectionContext || '') + '|' + (f.surroundingText || '').substring(0, 80);
      if (sig !== lastSig) {
        cur = { section: f.sectionContext || '', fields: [], rep: f };
        triplets.push(cur);
        lastSig = sig;
      }
      cur.fields.push(f);
    }

    // Step 2: label each triplet and extract M/D/Y
    const subGroups = triplets.map(t => {
      const role = classifyDateRole(t.rep);
      return {
        section:    t.section,
        role,
        label:      friendlyDateLabel(role),
        monthField: t.fields.find(f => f.dateRole === 'month') || null,
        dayField:   t.fields.find(f => f.dateRole === 'day')   || null,
        yearField:  t.fields.find(f => f.dateRole === 'year')  || null,
        allFields:  t.fields
      };
    });

    // Step 3: group by section
    const sectionMap = new Map();
    for (const sg of subGroups) {
      const key = sg.section || '_';
      if (!sectionMap.has(key)) sectionMap.set(key, { section: sg.section, subGroups: [] });
      sectionMap.get(key).subGroups.push(sg);
    }
    return [...sectionMap.values()];
  }

  async function promptForNextField() {
    if (pendingFields.length === 0) {
      showToast('All fields filled! ✓', 'success');
      isAutofilling = false;
      setButtonState('done');
      setTimeout(() => setButtonState('idle'), 3000);
      return;
    }

    // If next pending field is a date component → show section-level date prompt
    if (pendingFields[0].dateRole) {
      const sectionGroups = buildDateSectionGroups();
      if (sectionGroups && sectionGroups.length > 0) {
        const sg = sectionGroups[0];
        sg.subGroups[0].allFields[0].element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showDateSectionPrompt(sg);
        return;
      }
    }

    const field = pendingFields[0];
    field.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const { profile } = await sendMessage({ type: 'GET_CONTEXT', hostname: location.hostname });
    const { inference } = await sendMessage({
      type: 'AI_INFER_FIELD',
      fieldContext: {
        label: field.label,
        placeholder: field.placeholder,
        type: field.type,
        surroundingText: field.surroundingText,
        sectionContext: field.sectionContext
      },
      profile: profile
    });

    const question   = inference?.question  || `What is your ${field.label || field.placeholder || field.name}?`;
    const profileKey = inference?.profileKey || field.key;
    showFieldPrompt(field, question, profileKey);
  }

  // One prompt per section — shows all date sub-groups (Start Date + End Date, etc.) together
  function showDateSectionPrompt(sectionGroup) {
    if (promptDialog) promptDialog.remove();

    const anchor  = sectionGroup.subGroups[0].allFields[0];
    const rect    = anchor.element.getBoundingClientRect();
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    const buildSelect = (field, cls, placeholder) => {
      if (!field) return '';
      const opts = field.options || [];
      if (!opts.length) return `<input type="text" class="${cls} ffpd-inp" placeholder="${placeholder}" />`;
      return `<select class="${cls} ffpd-inp">
        <option value="">${placeholder}</option>
        ${opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.text)}</option>`).join('')}
      </select>`;
    };

    const dateRows = sectionGroup.subGroups.map((sg, i) => `
      <div class="ffprompt-date-row">
        <span class="ffprompt-date-lbl">${escapeHtml(sg.label)}</span>
        <div class="ffprompt-date-fields">
          ${buildSelect(sg.monthField, `ffpd-month-${i}`, 'Month')}
          ${buildSelect(sg.dayField,   `ffpd-day-${i}`,   'Day')}
          ${buildSelect(sg.yearField,  `ffpd-year-${i}`,  'Year')}
        </div>
      </div>
    `).join('');

    promptDialog = document.createElement('div');
    promptDialog.id = 'formfill-prompt';
    promptDialog.style.width = '380px';
    promptDialog.innerHTML = `
      <div class="ffprompt-header">
        <span class="ffprompt-icon">✦</span>
        <span>${escapeHtml(sectionGroup.section || 'Dates needed')}</span>
        <button class="ffprompt-skip">Skip</button>
      </div>
      ${dateRows}
      <div class="ffprompt-date-footer">
        <button class="ffprompt-submit">Fill ↵</button>
      </div>
    `;

    const top  = Math.min(rect.bottom + scrollY + 8, scrollY + window.innerHeight - 300);
    const left = Math.max(scrollX + 8, Math.min(rect.left + scrollX, scrollX + window.innerWidth - 400));
    promptDialog.style.top  = top  + 'px';
    promptDialog.style.left = left + 'px';
    document.body.appendChild(promptDialog);
    setTimeout(() => promptDialog.querySelector('.ffpd-inp')?.focus(), 100);

    const removeSectionPending = () => {
      const toRemove = new Set(sectionGroup.subGroups.flatMap(sg => sg.allFields.map(f => f.key)));
      for (let i = pendingFields.length - 1; i >= 0; i--) {
        if (toRemove.has(pendingFields[i].key)) pendingFields.splice(i, 1);
      }
    };

    const handleSubmit = async () => {
      const filled = {};
      sectionGroup.subGroups.forEach((sg, i) => {
        const mv = promptDialog.querySelector(`.ffpd-month-${i}`)?.value;
        const dv = promptDialog.querySelector(`.ffpd-day-${i}`)?.value;
        const yv = promptDialog.querySelector(`.ffpd-year-${i}`)?.value;
        if (sg.monthField && mv) { FormDetector.fillField(sg.monthField.element, mv); FormDetector.highlightField(sg.monthField.element, 'filled'); }
        if (sg.dayField   && dv) { FormDetector.fillField(sg.dayField.element,   dv); FormDetector.highlightField(sg.dayField.element,   'filled'); }
        if (sg.yearField  && yv) { FormDetector.fillField(sg.yearField.element,  yv); FormDetector.highlightField(sg.yearField.element,  'filled'); }
        filled[i] = { month: mv, day: dv, year: yv, role: sg.role };
      });

      // Persist dates to profile so next autofill uses them automatically
      await saveSectionDatesToProfile(sectionGroup.section, filled);

      removeSectionPending();
      promptDialog.remove();
      promptDialog = null;
      setTimeout(() => promptForNextField(), 300);
    };

    promptDialog.querySelector('.ffprompt-submit').addEventListener('click', handleSubmit);
    promptDialog.querySelectorAll('.ffpd-inp').forEach(el =>
      el.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); })
    );
    promptDialog.querySelector('.ffprompt-skip').addEventListener('click', () => {
      sectionGroup.subGroups.forEach(sg => sg.allFields.forEach(f => FormDetector.clearHighlight(f.element)));
      removeSectionPending();
      promptDialog.remove();
      promptDialog = null;
      setTimeout(() => promptForNextField(), 300);
    });
  }

  // Save filled date values into profile.education[N] or profile.workExperience[N]
  async function saveSectionDatesToProfile(section, filled) {
    const { profile } = await sendMessage({ type: 'GET_CONTEXT', hostname: location.hostname });
    const idx    = sectionEntryIndex(section);
    const isEdu  = /education|school|degree/i.test(section);
    const isWork = /experience|employer|professional/i.test(section);

    Object.values(filled).forEach(({ month, day, year, role }) => {
      if (!year && !month) return;
      const monthNum = MONTH_MAP[(month || '').toLowerCase()] || '01';
      const dayPad   = String(parseInt(day) || 1).padStart(2, '0');
      const dateStr  = `${year || '????'}-${monthNum}-${dayPad}`;

      if (isEdu) {
        if (!profile.education) profile.education = [];
        if (!profile.education[idx]) profile.education[idx] = {};
        profile.education[idx][(role === 'startDate') ? 'fromDate' : 'toDate'] = dateStr;
      } else if (isWork) {
        if (!profile.workExperience) profile.workExperience = [];
        if (!profile.workExperience[idx]) profile.workExperience[idx] = {};
        profile.workExperience[idx][(role === 'startDate') ? 'startDate' : 'endDate'] = dateStr;
      }
    });

    await sendMessage({ type: 'UPDATE_PROFILE', profile });
  }

  function showFieldPrompt(field, question, profileKey) {
    // Remove existing prompt
    if (promptDialog) promptDialog.remove();

    const rect    = field.element.getBoundingClientRect();
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

    const top  = Math.min(rect.bottom + scrollY + 8, scrollY + window.innerHeight - 180);
    const left = Math.max(scrollX + 8, Math.min(rect.left + scrollX, scrollX + window.innerWidth - 360));
    promptDialog.style.top  = top  + 'px';
    promptDialog.style.left = left + 'px';

    document.body.appendChild(promptDialog);

    const inputEl = promptDialog.querySelector('.ffprompt-input');
    setTimeout(() => inputEl?.focus(), 100);

    const handleSubmit = async () => {
      const value = inputEl.value;
      if (!value) return;

      const shouldSave = promptDialog.querySelector('.ffprompt-save').checked;

      FormDetector.clearHighlight(field.element);
      FormDetector.fillField(field.element, value);
      FormDetector.highlightField(field.element, 'filled');

      if (shouldSave) {
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

  // ─── Learn from Form on Next / Save / Continue ───────────────────────────
  const SUBMIT_KEYWORDS = /\b(next|continue|save|submit|update|proceed|apply|finish|done)\b/i;
  let learnDebounce = null;

  function watchFormButtons() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, input[type="submit"], a[role="button"], [role="button"]');
      if (!btn) return;
      const label = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
      if (!SUBMIT_KEYWORDS.test(label)) return;

      // Debounce — only run once per navigation event
      clearTimeout(learnDebounce);
      learnDebounce = setTimeout(() => captureFormIntoProfile(label), 200);
    }, true); // capture phase so we run before the page's own handlers
  }

  async function captureFormIntoProfile(triggerLabel) {
    const fields = FormDetector.detectFields();
    const filled = fields.filter(f => f.value && f.value.trim() !== '' && f.value !== 'undefined');
    if (!filled.length) return;

    const fieldData = filled.map(f => ({
      key: f.key, id: f.id, name: f.name,
      label: f.label, value: f.value,
      type: f.type, sectionContext: f.sectionContext,
      dateRole: f.dateRole, surroundingText: f.surroundingText,
      options: f.options
    }));

    const result = await sendMessage({
      type: 'LEARN_FROM_FORM',
      fields: fieldData,
      hostname: location.hostname
    });

    if (result?.ok) {
      showToast('✦ Profile updated from form', 'success');
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  // Only inject the floating button on the top-level frame, not inside iframes.
  // But always be ready to detect/fill fields in any frame (including iframes).
  if (window.self === window.top) {
    if (document.readyState === 'complete') {
      injectAutofillButton();
    } else {
      window.addEventListener('load', injectAutofillButton);
    }
  }

  // Watch for form navigation buttons in ALL frames (including iCIMS iframe)
  if (document.readyState === 'complete') {
    watchFormButtons();
  } else {
    window.addEventListener('load', watchFormButtons);
  }

})();
