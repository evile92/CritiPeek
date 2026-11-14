'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STORAGE_KEYS = {
    API_KEY: 'omdbApiKey',
    ENABLED: 'extensionEnabled'
  };

  const extensionToggle = document.getElementById('extensionToggle');
  const toggleStateText = document.getElementById('toggleStateText');
  const apiKeyForm = document.getElementById('apiKeyForm');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleVisibilityBtn = document.getElementById('toggleVisibilityBtn');
  const eyeIcon = document.getElementById('eyeIcon');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const apiStatusRow = document.getElementById('apiStatusRow');
  const apiStatusText = document.getElementById('apiStatusText');
  const cacheCountEl = document.getElementById('cacheCount');
  const clearCacheBtn = document.getElementById('clearCacheBtn');

  /**
   * Sends a message to the background service worker safely.
   * @param {object} payload
   * @returns {Promise<object>}
   */
  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: 'Background service unavailable.' });
          return;
        }
        resolve(response);
      });
    });
  }

  /**
   * Updates the API key status indicator row.
   * @param {'idle'|'checking'|'valid'|'invalid'} state
   * @param {string} message
   */
  function setApiStatus(state, message) {
    apiStatusRow.dataset.state = state;
    apiStatusText.textContent = message;
  }

  /**
   * Updates the global toggle text label.
   * @param {boolean} enabled
   */
  function updateToggleLabel(enabled) {
    toggleStateText.textContent = enabled ? 'On' : 'Off';
  }

  /**
   * Updates the cached title count display and Clear button state.
   * @param {number} count
   */
  function updateCacheCount(count) {
    const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
    cacheCountEl.textContent = String(safeCount);
    clearCacheBtn.disabled = safeCount === 0;
  }

  /**
   * Tests the provided OMDb API key via background.js (pings tt3896198).
   * @param {string} apiKey
   */
  async function verifyApiKey(apiKey) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setApiStatus('idle', 'Not configured');
      return;
    }

    setApiStatus('checking', 'Verifying API key...');
    const response = await sendMessage({
      type: 'VALIDATE_API_KEY',
      apiKey: trimmed
    });

    if (response.ok && response.valid) {
      setApiStatus('valid', 'Valid API key');
    } else {
      setApiStatus('invalid', response.error || 'Invalid API key');
    }
  }

  /**
   * Refreshes cached title count from background.js.
   */
  async function refreshCacheStats() {
    const response = await sendMessage({ type: 'GET_CACHE_STATS' });
    if (response && response.ok) {
      updateCacheCount(response.count);
    }
  }

  /**
   * Switches the visibility icon paths between visible (eye-off) and hidden (eye).
   * @param {boolean} visible
   */
  function renderVisibilityIcon(visible) {
    while (eyeIcon.firstChild) {
      eyeIcon.removeChild(eyeIcon.firstChild);
    }

    if (visible) {
      const paths = [
        'M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94',
        'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.75 21.75 0 0 1-3.17 4.35',
        'M1 1l22 22'
      ];
      for (const d of paths) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        eyeIcon.appendChild(path);
      }
    } else {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z');
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '3');
      eyeIcon.appendChild(path);
      eyeIcon.appendChild(circle);
    }
  }

  toggleVisibilityBtn.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    toggleVisibilityBtn.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
    renderVisibilityIcon(show);
  });

  extensionToggle.addEventListener('change', async () => {
    const enabled = extensionToggle.checked;
    updateToggleLabel(enabled);
    await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: enabled });
  });

  apiKeyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    apiKeyInput.value = apiKey;

    saveKeyBtn.disabled = true;
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: apiKey });
      await verifyApiKey(apiKey);
    } finally {
      saveKeyBtn.disabled = false;
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    const response = await sendMessage({ type: 'CLEAR_CACHE' });
    if (response && response.ok) {
      updateCacheCount(0);
    } else {
      await refreshCacheStats();
    }
  });

  async function init() {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.API_KEY,
      STORAGE_KEYS.ENABLED
    ]);

    const enabled = stored[STORAGE_KEYS.ENABLED] !== false;
    extensionToggle.checked = enabled;
    updateToggleLabel(enabled);

    const savedKey = typeof stored[STORAGE_KEYS.API_KEY] === 'string'
      ? stored[STORAGE_KEYS.API_KEY].trim()
      : '';
    apiKeyInput.value = savedKey;

    await Promise.all([
      verifyApiKey(savedKey),
      refreshCacheStats()
    ]);
  }

  init();
});
