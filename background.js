'use strict';

const OMDB_BASE_URL = 'https://www.omdbapi.com/';
const CACHE_PREFIX = 'rating_cache:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const QUOTA_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 8000;

const STORAGE_KEYS = {
  API_KEY: 'omdbApiKey',
  ENABLED: 'extensionEnabled',
  QUOTA_EXCEEDED: 'omdbQuotaExceeded'
};

/** @type {Map<string, { found: boolean, imdbRating: string|null, imdbID: string|null, rottenTomatoes: string|null, metacritic: string|null, cachedAt: number }>} */
const memoryCache = new Map();

/** @type {Map<string, Promise<object>>} */
const inFlightRequests = new Map();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const normalizedKey = key.slice(CACHE_PREFIX.length);
    if (change.newValue === undefined) {
      memoryCache.delete(normalizedKey);
    } else {
      memoryCache.set(normalizedKey, change.newValue);
    }
  }
});

/**
 * Normalizes a title into a deterministic cache key.
 * @param {string} title
 * @returns {string}
 */
function normalizeTitleKey(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Checks whether a cached entry is within the 7-day TTL and has the current v1.1 schema.
 * @param {{ cachedAt?: number, metacritic?: string|null } | null | undefined} entry
 * @returns {boolean}
 */
function isCacheFresh(entry) {
  return Boolean(
    entry &&
    typeof entry.cachedAt === 'number' &&
    Date.now() - entry.cachedAt < CACHE_TTL_MS &&
    Object.prototype.hasOwnProperty.call(entry, 'metacritic')
  );
}

/**
 * Reads extension settings from chrome.storage.local.
 * @returns {Promise<{ apiKey: string, enabled: boolean }>}
 */
async function getSettings() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ENABLED
  ]);
  return {
    apiKey: typeof result[STORAGE_KEYS.API_KEY] === 'string'
      ? result[STORAGE_KEYS.API_KEY].trim()
      : '',
    enabled: result[STORAGE_KEYS.ENABLED] !== false
  };
}

/**
 * Checks if an OMDb error specifically indicates the 1,000/day request limit was reached.
 * @param {string} errorMessage
 * @returns {boolean}
 */
function isQuotaLimitError(errorMessage) {
  return /request limit reached/i.test(String(errorMessage || ''));
}

/**
 * Identifies OMDb responses caused by missing/invalid API keys or quota exhaustion.
 * @param {string} errorMessage
 * @param {number} statusCode
 * @returns {boolean}
 */
function isAuthOrLimitError(errorMessage, statusCode) {
  if (statusCode === 401 || statusCode === 403) return true;
  return /invalid api key|no api key|request limit/i.test(String(errorMessage || ''));
}

/**
 * Persists daily quota exhaustion state so the popup can alert the user clearly.
 * @param {string} errorMessage
 */
async function recordQuotaExceeded(errorMessage) {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.QUOTA_EXCEEDED]: {
        timestamp: Date.now(),
        message: errorMessage || 'Request limit reached!'
      }
    });
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Clears the daily quota exhaustion flag when an OMDb call succeeds.
 */
async function clearQuotaExceeded() {
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.QUOTA_EXCEEDED);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Reads current daily quota exhaustion state, auto-expiring after 24 hours.
 * @returns {Promise<boolean>}
 */
async function getQuotaExceededStatus() {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEYS.QUOTA_EXCEEDED);
    const info = res[STORAGE_KEYS.QUOTA_EXCEEDED];
    if (!info || typeof info.timestamp !== 'number') return false;
    if (Date.now() - info.timestamp < QUOTA_TTL_MS) {
      return true;
    }
    await chrome.storage.local.remove(STORAGE_KEYS.QUOTA_EXCEEDED);
    return false;
  } catch {
    return false;
  }
}

/**
 * Executes a single OMDb fetch with timeout protection.
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, data?: object, error?: string, isAuthOrLimit?: boolean, isQuotaLimit?: boolean }>}
 */
async function fetchOmdbJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const apiError = data && typeof data.Error === 'string'
        ? data.Error
        : `HTTP ${response.status}`;
      return {
        ok: false,
        status: response.status,
        error: apiError,
        isAuthOrLimit: isAuthOrLimitError(apiError, response.status),
        isQuotaLimit: isQuotaLimitError(apiError)
      };
    }

    if (!data || typeof data !== 'object') {
      return { ok: false, status: response.status, error: 'Invalid JSON response from OMDb.' };
    }

    return { ok: true, status: response.status, data };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? 'OMDb request timed out.'
      : 'Network error reaching OMDb.';
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extracts IMDb, Rotten Tomatoes, and Metacritic metrics from an OMDb title payload.
 * @param {object} data
 * @returns {{ found: boolean, imdbRating: string|null, imdbID: string|null, rottenTomatoes: string|null, metacritic: string|null }}
 */
function extractRatingsFromOmdb(data) {
  const rawImdb = typeof data.imdbRating === 'string' ? data.imdbRating.trim() : '';
  const imdbRating = rawImdb && rawImdb !== 'N/A' ? rawImdb : null;

  const rawImdbId = typeof data.imdbID === 'string' ? data.imdbID.trim() : '';
  const imdbID = /^tt\d+$/i.test(rawImdbId) ? rawImdbId : null;

  const rawMeta = typeof data.Metascore === 'string' ? data.Metascore.trim() : '';
  let metacritic = rawMeta && rawMeta !== 'N/A' && /^\d+$/.test(rawMeta) ? rawMeta : null;

  let rottenTomatoes = null;
  if (Array.isArray(data.Ratings)) {
    for (const item of data.Ratings) {
      if (!item || typeof item.Source !== 'string') continue;

      if (item.Source === 'Rotten Tomatoes') {
        const value = typeof item.Value === 'string' ? item.Value.trim() : '';
        if (value && value !== 'N/A') {
          rottenTomatoes = value;
        }
      } else if (!metacritic && item.Source === 'Metacritic') {
        const value = typeof item.Value === 'string' ? item.Value.trim() : '';
        const match = value.match(/^(\d{1,3})\b/);
        if (match) {
          metacritic = match[1];
        }
      }
    }
  }

  return {
    found: Boolean(imdbRating || rottenTomatoes || metacritic),
    imdbRating,
    imdbID,
    rottenTomatoes,
    metacritic
  };
}

/**
 * Fetches ratings from OMDb using title + year, falling back to title-only on failure or Response: "False".
 * @param {string} title
 * @param {string|null|undefined} year
 * @param {string} apiKey
 */
async function fetchRatingsWithFallback(title, year, apiKey) {
  const cleanYear = year && /^(19|20)\d{2}$/.test(String(year).trim())
    ? String(year).trim()
    : null;

  if (cleanYear) {
    const yearUrl = `${OMDB_BASE_URL}?t=${encodeURIComponent(title)}&y=${encodeURIComponent(cleanYear)}&apikey=${encodeURIComponent(apiKey)}`;
    const yearResult = await fetchOmdbJson(yearUrl);

    if (yearResult.ok && yearResult.data.Response === 'True') {
      await clearQuotaExceeded();
      return { ok: true, payload: extractRatingsFromOmdb(yearResult.data) };
    }

    const yearError = yearResult.data && yearResult.data.Error
      ? yearResult.data.Error
      : yearResult.error;

    if (yearResult.isQuotaLimit || isQuotaLimitError(yearError)) {
      await recordQuotaExceeded(yearError);
      return { ok: false, error: yearError || 'Request limit reached!', quotaExceeded: true, cacheable: false };
    }

    if (yearResult.isAuthOrLimit || isAuthOrLimitError(yearError, yearResult.status)) {
      return { ok: false, error: yearError || 'Invalid OMDb API key.', cacheable: false };
    }
  }

  const titleUrl = `${OMDB_BASE_URL}?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(apiKey)}`;
  const titleResult = await fetchOmdbJson(titleUrl);

  if (titleResult.ok && titleResult.data.Response === 'True') {
    await clearQuotaExceeded();
    return { ok: true, payload: extractRatingsFromOmdb(titleResult.data) };
  }

  const titleError = titleResult.data && titleResult.data.Error
    ? titleResult.data.Error
    : titleResult.error;

  if (titleResult.isQuotaLimit || isQuotaLimitError(titleError)) {
    await recordQuotaExceeded(titleError);
    return { ok: false, error: titleError || 'Request limit reached!', quotaExceeded: true, cacheable: false };
  }

  if (titleResult.isAuthOrLimit || isAuthOrLimitError(titleError, titleResult.status)) {
    return { ok: false, error: titleError || 'Invalid OMDb API key.', cacheable: false };
  }

  if (titleResult.ok && titleResult.data.Response === 'False') {
    await clearQuotaExceeded();
    return {
      ok: true,
      payload: {
        found: false,
        imdbRating: null,
        imdbID: null,
        rottenTomatoes: null,
        metacritic: null
      }
    };
  }

  return { ok: false, error: titleError || 'Failed to fetch ratings.', cacheable: false };
}

/**
 * Resolves ratings for a normalized title via memory cache, persistent storage cache, or OMDb API.
 * @param {string} rawTitle
 * @param {string|null|undefined} year
 */
async function getRatings(rawTitle, year) {
  const title = String(rawTitle || '').trim();
  if (!title) {
    return { ok: false, error: 'Empty title.' };
  }

  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: false, disabled: true };
  }

  const normalizedKey = normalizeTitleKey(title);
  const storageKey = `${CACHE_PREFIX}${normalizedKey}`;

  // 1. In-memory Map cache
  const memEntry = memoryCache.get(normalizedKey);
  if (memEntry) {
    if (isCacheFresh(memEntry)) {
      return { ok: true, fromCache: true, data: memEntry };
    }
    memoryCache.delete(normalizedKey);
  }

  // 2. Persistent chrome.storage.local cache
  const storedMap = await chrome.storage.local.get(storageKey);
  const storedEntry = storedMap[storageKey];
  if (storedEntry) {
    if (isCacheFresh(storedEntry)) {
      memoryCache.set(normalizedKey, storedEntry);
      return { ok: true, fromCache: true, data: storedEntry };
    }
    await chrome.storage.local.remove(storageKey);
  }

  if (!settings.apiKey) {
    return { ok: false, missingApiKey: true, error: 'OMDb API key is not configured.' };
  }

  // 3. Deduplicate concurrent requests for the same normalized title
  if (inFlightRequests.has(normalizedKey)) {
    return inFlightRequests.get(normalizedKey);
  }

  const fetchPromise = (async () => {
    const result = await fetchRatingsWithFallback(title, year, settings.apiKey);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        quotaExceeded: Boolean(result.quotaExceeded)
      };
    }

    const cacheRecord = {
      ...result.payload,
      cachedAt: Date.now()
    };

    memoryCache.set(normalizedKey, cacheRecord);
    try {
      await chrome.storage.local.set({ [storageKey]: cacheRecord });
    } catch {
      // Ignore storage quota errors so active rendering still succeeds
    }

    return { ok: true, fromCache: false, data: cacheRecord };
  })();

  inFlightRequests.set(normalizedKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightRequests.delete(normalizedKey);
  }
}

/**
 * Validates an OMDb API key using the canonical test IMDb ID tt3896198.
 * @param {string} apiKey
 */
async function validateApiKey(apiKey) {
  const trimmedKey = String(apiKey || '').trim();
  if (!trimmedKey) {
    return { ok: true, valid: false, error: 'Please enter an OMDb API key.' };
  }

  const testUrl = `${OMDB_BASE_URL}?i=tt3896198&apikey=${encodeURIComponent(trimmedKey)}`;
  const res = await fetchOmdbJson(testUrl);

  if (res.ok && res.data.Response === 'True') {
    await clearQuotaExceeded();
    return { ok: true, valid: true, quotaExceeded: false };
  }

  const errorMsg = (res.data && res.data.Error) || res.error || 'Invalid OMDb API key.';
  const quotaExceeded = Boolean(res.isQuotaLimit || isQuotaLimitError(errorMsg));
  if (quotaExceeded) {
    await recordQuotaExceeded(errorMsg);
  }

  return {
    ok: true,
    valid: false,
    quotaExceeded,
    error: errorMsg
  };
}

/**
 * Counts valid cached titles in chrome.storage.local, prunes expired entries, and returns quota state.
 */
async function getCacheStats() {
  const allItems = await chrome.storage.local.get(null);
  const expiredKeys = [];
  let validCount = 0;

  for (const [key, value] of Object.entries(allItems)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    if (isCacheFresh(value)) {
      validCount += 1;
    } else {
      expiredKeys.push(key);
      memoryCache.delete(key.slice(CACHE_PREFIX.length));
    }
  }

  if (expiredKeys.length > 0) {
    await chrome.storage.local.remove(expiredKeys);
  }

  const quotaExceeded = await getQuotaExceededStatus();
  return { ok: true, count: validCount, quotaExceeded };
}

/**
 * Clears all cached rating entries from both memory and chrome.storage.local.
 */
async function clearRatingsCache() {
  memoryCache.clear();
  const allItems = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(allItems).filter((key) => key.startsWith(CACHE_PREFIX));
  if (cacheKeys.length > 0) {
    await chrome.storage.local.remove(cacheKeys);
  }
  return { ok: true, count: 0 };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  (async () => {
    switch (message.type) {
      case 'GET_RATINGS':
        return await getRatings(message.title, message.year);
      case 'VALIDATE_API_KEY':
        return await validateApiKey(message.apiKey);
      case 'GET_CACHE_STATS':
        return await getCacheStats();
      case 'CLEAR_CACHE':
        return await clearRatingsCache();
      default:
        return { ok: false, error: 'Unknown message type.' };
    }
  })()
    .then((response) => sendResponse(response))
    .catch(() => sendResponse({ ok: false, error: 'Internal extension error.' }));

  return true;
});
