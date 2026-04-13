// formDetector.js — Smart form field extraction
// Finds all fillable fields on the page and gathers rich context about each

const FormDetector = (() => {

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio']);

  // Get the best label text for an element
  function getLabel(el) {
    // 1. aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

    // 2. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.innerText.trim();
    }

    // 3. <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.innerText.trim();
    }

    // 4. Wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.innerText.trim();

    // 5. Previous sibling text
    const prev = el.previousElementSibling;
    if (prev && prev.innerText) return prev.innerText.trim();

    // 6. Parent's text before the input
    const parent = el.parentElement;
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll('input,select,textarea').forEach(e => e.remove());
      const text = clone.innerText.trim();
      if (text && text.length < 100) return text;
    }

    return '';
  }

  // Get surrounding context text
  function getSurroundingText(el) {
    const parent = el.closest('div, fieldset, section, form') || el.parentElement;
    if (!parent) return '';
    const text = parent.innerText.replace(/\s+/g, ' ').trim();
    return text.substring(0, 200);
  }

  // Generate a unique key for a field
  function getFieldKey(el) {
    return el.id || el.name || el.getAttribute('data-field') || `field_${Math.random().toString(36).substr(2,6)}`;
  }

  // Find all visible, fillable fields on the page
  function detectFields() {
    const fields = [];
    const seen = new Set();

    const inputs = document.querySelectorAll('input, select, textarea');

    inputs.forEach(el => {
      // Skip hidden/non-interactive
      if (el.type && SKIP_TYPES.has(el.type)) return;
      if (el.type === 'hidden') return;
      
      // Skip invisible elements
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (el.disabled || el.readOnly) return;

      const key = getFieldKey(el);
      if (seen.has(key)) return;
      seen.add(key);

      const label = getLabel(el);
      const surrounding = getSurroundingText(el);

      fields.push({
        element: el,
        id: el.id || '',
        name: el.name || '',
        key: key,
        type: el.tagName === 'SELECT' ? 'select' : (el.type || 'text'),
        placeholder: el.placeholder || '',
        label: label,
        surroundingText: surrounding,
        value: el.value || '',
        // For selects, gather options
        options: el.tagName === 'SELECT' 
          ? Array.from(el.options).map(o => ({ value: o.value, text: o.text }))
          : []
      });
    });

    return fields;
  }

  // Fill a field with a value, dispatching proper events so React/Vue/Angular detect it
  function fillField(el, value) {
    if (!value && value !== 0) return false;
    
    const strValue = String(value);

    if (el.tagName === 'SELECT') {
      // Try to match by value, then by text
      let matched = false;
      for (const option of el.options) {
        if (option.value === strValue || option.text.toLowerCase() === strValue.toLowerCase()) {
          el.value = option.value;
          matched = true;
          break;
        }
      }
      // Fuzzy match
      if (!matched) {
        const lower = strValue.toLowerCase();
        for (const option of el.options) {
          if (option.text.toLowerCase().includes(lower) || lower.includes(option.text.toLowerCase())) {
            el.value = option.value;
            matched = true;
            break;
          }
        }
      }
      if (!matched) return false;
    } else {
      // Use native input value setter to work with React controlled inputs
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, strValue);
      } else {
        el.value = strValue;
      }
    }

    // Fire all the events frameworks listen to
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    return true;
  }

  // Highlight a field to draw user attention
  function highlightField(el, type = 'missing') {
    el.style.transition = 'box-shadow 0.3s, background 0.3s';
    if (type === 'filled') {
      el.style.boxShadow = '0 0 0 2px #22c55e';
      el.style.background = '#f0fdf4';
      setTimeout(() => {
        el.style.boxShadow = '';
        el.style.background = '';
      }, 2000);
    } else if (type === 'missing') {
      el.style.boxShadow = '0 0 0 2px #f59e0b';
      el.style.background = '#fffbeb';
    } else if (type === 'error') {
      el.style.boxShadow = '0 0 0 2px #ef4444';
    }
  }

  function clearHighlight(el) {
    el.style.boxShadow = '';
    el.style.background = '';
  }

  return {
    detectFields,
    fillField,
    highlightField,
    clearHighlight,
    getLabel,
    getFieldKey
  };
})();
