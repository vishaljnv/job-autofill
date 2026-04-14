// formDetector.js — Smart form field extraction
// Finds all fillable fields on the page and gathers rich context about each

const FormDetector = (() => {

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio']);
  const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

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

  // Walk up the DOM tree to find the nearest section/group heading.
  // Returns e.g. "Education", "Professional Experience", "Work Experience"
  function getSectionContext(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      // Check preceding siblings at this level for headings
      let prev = node.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/.test(prev.tagName) || prev.tagName === 'LEGEND' || prev.getAttribute('role') === 'heading') {
          const text = prev.innerText.trim();
          if (text.length > 0 && text.length < 100) return text;
        }
        // Heading nested inside a sibling container
        const inner = prev.querySelector('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
        if (inner) {
          const text = inner.innerText.trim();
          if (text.length > 0 && text.length < 100) return text;
        }
        prev = prev.previousElementSibling;
      }
      // Check if this node itself starts with a heading as first child
      const firstChild = node.firstElementChild;
      if (firstChild && /^H[1-6]$/.test(firstChild.tagName) && !firstChild.contains(el)) {
        const text = firstChild.innerText.trim();
        if (text.length > 0 && text.length < 100) return text;
      }
      node = node.parentElement;
    }
    return '';
  }

  // Detect whether a select is a date component: 'month', 'day', or 'year'
  function getDateRole(el) {
    if (el.tagName !== 'SELECT') return null;
    const options = Array.from(el.options).map(o => o.text.trim());
    const lowerTexts = options.map(o => o.toLowerCase());
    const nums = options.map(o => parseInt(o.replace(/\D/g, ''))).filter(n => !isNaN(n) && n > 0);

    // Month: contains full month names
    if (lowerTexts.some(t => MONTH_NAMES.includes(t))) return 'month';

    // Year: numbers all in year range
    if (nums.length >= 5 && nums.every(n => n >= 1950 && n <= 2050)) return 'year';

    // Day: numbers 1–31, at least 28 options
    if (nums.length >= 28 && nums.every(n => n >= 1 && n <= 31)) return 'day';

    return null;
  }

  // Get surrounding label context — include the row/group label above the date triplet
  function getSurroundingText(el) {
    // Try to find a label row above this element (common in forms like iCIMS)
    let node = el.parentElement;
    for (let i = 0; i < 4; i++) {
      if (!node) break;
      // Look for a label/div sibling just before this container
      let prev = node.previousElementSibling;
      if (prev) {
        const text = prev.innerText.trim().replace(/\s+/g, ' ');
        if (text && text.length < 150) return text;
      }
      node = node.parentElement;
    }
    const parent = el.closest('div, fieldset, section, form') || el.parentElement;
    if (!parent) return '';
    return parent.innerText.replace(/\s+/g, ' ').trim().substring(0, 200);
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

      const label         = getLabel(el);
      const surrounding   = getSurroundingText(el);
      const sectionContext = getSectionContext(el);
      const dateRole      = getDateRole(el);

      fields.push({
        element: el,
        id:             el.id || '',
        name:           el.name || '',
        key:            key,
        type:           el.tagName === 'SELECT' ? 'select' : (el.type || 'text'),
        placeholder:    el.placeholder || '',
        label:          label,
        surroundingText: surrounding,
        sectionContext:  sectionContext,
        dateRole:        dateRole,        // 'month' | 'day' | 'year' | null
        value:          el.value || '',
        options:        el.tagName === 'SELECT'
          ? Array.from(el.options).map(o => ({ value: o.value, text: o.text }))
          : []
      });
    });

    return fields;
  }

  // Degree abbreviation → canonical keyword for fuzzy matching
  const DEGREE_ALIASES = {
    'phd': 'doctor', 'ph.d': 'doctor', 'doctorate': 'doctor', 'd.phil': 'doctor',
    'mba': 'business administration',
    'ms':  'master', 'm.s':  'master', 'msc': 'master', 'm.sc': 'master',
    'ma':  'master', 'm.a':  'master',
    'me':  'master', 'm.e':  'master', 'meng': 'master',
    'bs':  'bachelor', 'b.s': 'bachelor', 'bsc': 'bachelor', 'b.sc': 'bachelor',
    'ba':  'bachelor', 'b.a': 'bachelor',
    'be':  'bachelor', 'b.e': 'bachelor', 'beng': 'bachelor',
    'aa':  'associate', 'a.a': 'associate', 'aas': 'associate',
  };

  function normalizeDegree(str) {
    const clean = str.toLowerCase().replace(/[.\s]+/g, '').replace(/[^a-z]/g, '');
    return DEGREE_ALIASES[clean] || DEGREE_ALIASES[str.toLowerCase().trim()] || str.toLowerCase();
  }

  // Fill a field with a value, dispatching proper events so React/Vue/Angular detect it
  function fillField(el, value) {
    if (!value && value !== 0) return false;

    const strValue = String(value);

    if (el.tagName === 'SELECT') {
      const lower = strValue.toLowerCase().trim();

      // 1. Exact match on value or text
      let matched = false;
      for (const option of el.options) {
        if (option.value === strValue || option.text.toLowerCase() === lower) {
          el.value = option.value;
          matched = true;
          break;
        }
      }

      // 2. Degree-aware fuzzy match (handles MS → Master of Science, BS → Bachelor of Arts, etc.)
      if (!matched) {
        const normalized = normalizeDegree(strValue);
        for (const option of el.options) {
          const optLower = option.text.toLowerCase();
          if (optLower.includes(normalized) || normalized.includes(optLower)) {
            el.value = option.value;
            matched = true;
            break;
          }
        }
      }

      // 3. General substring fuzzy match
      if (!matched) {
        for (const option of el.options) {
          const optLower = option.text.toLowerCase();
          if (optLower.includes(lower) || lower.includes(optLower)) {
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
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
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
