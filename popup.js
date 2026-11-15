'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STORAGE_KEYS = {
    API_KEY: 'omdbApiKey',
    ENABLED: 'extensionEnabled',
    BADGE_POSITION: 'badgePosition',
    SHOW_IMDB: 'showImdb',
    SHOW_RT: 'showRt',
    SHOW_MC: 'showMetacritic',
    QUOTA_EXCEEDED: 'omdbQuotaExceeded'
  };

  const extensionToggle = document.getElementById('extensionToggle');
  const toggleStateText = document.getElementById('toggleStateText');
  const quotaAlertBanner = document.getElementById('quotaAlertBanner');
  const apiKeyForm = document.getElementById('apiKeyForm');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleVisibilityBtn = document.getElementById('toggleVisibilityBtn');
  const eyeIcon = document.getElementById('eyeIcon');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const apiStatusRow = document.getElementById('apiStatusRow');
  const apiStatusText = document.getElementById('apiStatusText');

  const posTopLeftBtn = document.getElementById('posTopLeftBtn');
  const posTopRightBtn = document.getElementById('posTopRightBtn');
  const toggleImdbBtn = document.getElementById('toggleImdbBtn');
  const toggleRtBtn = document.getElementById('toggleRtBtn');
  const toggleMcBtn = document.getElementById('toggleMcBtn');

  const cacheCountEl = document.getElementById('cacheCount');
  const clearCacheBtn = document.getElementById('clearCacheBtn');

  const prefs = {
    badgePosition: 'top-left',
    showImdb: true,
    showRt: true,
    showMetacritic: true
  };

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
   * Shows or hides the 1,000/day quota exhaustion alert banner.
   * @param {boolean} exceeded
   */
  function setQuotaAlert(exceeded) {
    quotaAlertBanner.hidden = !exceeded;
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
   * Syncs customization button states with current preferences.
   */
  function syncCustomizationUI() {
    const isTopRight = prefs.badgePosition === 'top-right';
    posTopLeftBtn.setAttribute('aria-pressed', String(!isTopRight));
    posTopRightBtn.setAttribute('aria-pressed', String(isTopRight));

    toggleImdbBtn.setAttribute('aria-pressed', String(prefs.showImdb));
    toggleRtBtn.setAttribute('aria-pressed', String(prefs.showRt));
    toggleMcBtn.setAttribute('aria-pressed', String(prefs.showMetacritic));
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
      setQuotaAlert(false);
      setApiStatus('valid', 'Valid API key');
    } else if (response.quotaExceeded) {
      setQuotaAlert(true);
      setApiStatus('invalid', 'Daily limit reached (1,000/day)');
    } else {
      setApiStatus('invalid', response.error || 'Invalid API key');
    }
  }

  /**
   * Refreshes cached title count and quota status from background.js.
   */
  async function refreshCacheStats() {
    const response = await sendMessage({ type: 'GET_CACHE_STATS' });
    if (response && response.ok) {
      updateCacheCount(response.count);
      if (typeof response.quotaExceeded === 'boolean') {
        setQuotaAlert(response.quotaExceeded);
      }
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

  posTopLeftBtn.addEventListener('click', async () => {
    if (prefs.badgePosition === 'top-left') return;
    prefs.badgePosition = 'top-left';
    syncCustomizationUI();
    await chrome.storage.local.set({ [STORAGE_KEYS.BADGE_POSITION]: 'top-left' });
  });

  posTopRightBtn.addEventListener('click', async () => {
    if (prefs.badgePosition === 'top-right') return;
    prefs.badgePosition = 'top-right';
    syncCustomizationUI();
    await chrome.storage.local.set({ [STORAGE_KEYS.BADGE_POSITION]: 'top-right' });
  });

  async function toggleRatingSource(key, storageKey) {
    const nextValue = !prefs[key];
    const activeCount =
      (prefs.showImdb ? 1 : 0) +
      (prefs.showRt ? 1 : 0) +
      (prefs.showMetacritic ? 1 : 0);

    // Keep at least one rating source enabled
    if (!nextValue && activeCount <= 1) {
      return;
    }

    prefs[key] = nextValue;
    syncCustomizationUI();
    await chrome.storage.local.set({ [storageKey]: nextValue });
  }

  toggleImdbBtn.addEventListener('click', () => {
    toggleRatingSource('showImdb', STORAGE_KEYS.SHOW_IMDB);
  });

  toggleRtBtn.addEventListener('click', () => {
    toggleRatingSource('showRt', STORAGE_KEYS.SHOW_RT);
  });

  toggleMcBtn.addEventListener('click', () => {
    toggleRatingSource('showMetacritic', STORAGE_KEYS.SHOW_MC);
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.QUOTA_EXCEEDED)) {
      const info = changes[STORAGE_KEYS.QUOTA_EXCEEDED].newValue;
      setQuotaAlert(Boolean(info && info.timestamp));
    }
  });

  async function init() {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.API_KEY,
      STORAGE_KEYS.ENABLED,
      STORAGE_KEYS.BADGE_POSITION,
      STORAGE_KEYS.SHOW_IMDB,
      STORAGE_KEYS.SHOW_RT,
      STORAGE_KEYS.SHOW_MC,
      STORAGE_KEYS.QUOTA_EXCEEDED
    ]);

    const enabled = stored[STORAGE_KEYS.ENABLED] !== false;
    extensionToggle.checked = enabled;
    updateToggleLabel(enabled);

    prefs.badgePosition = stored[STORAGE_KEYS.BADGE_POSITION] === 'top-right' ? 'top-right' : 'top-left';
    prefs.showImdb = stored[STORAGE_KEYS.SHOW_IMDB] !== false;
    prefs.showRt = stored[STORAGE_KEYS.SHOW_RT] !== false;
    prefs.showMetacritic = stored[STORAGE_KEYS.SHOW_MC] !== false;
    syncCustomizationUI();

    const quotaInfo = stored[STORAGE_KEYS.QUOTA_EXCEEDED];
    if (quotaInfo && typeof quotaInfo.timestamp === 'number') {
      setQuotaAlert(Date.now() - quotaInfo.timestamp < 24 * 60 * 60 * 1000);
    }

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
