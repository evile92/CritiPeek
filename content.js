'use strict';

(() => {
  const CACHE_PREFIX = 'rating_cache:';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const HOVER_DEBOUNCE_MS = 250;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const CARD_CANDIDATE_SELECTOR = '.title-card-container, [data-uia="title-card"], .slider-item, a[aria-label]';
  const MODAL_ROOT_SELECTOR = '.previewModal--wrapper, [data-uia="mini-modal"]';
  const EXCLUDED_CONTEXT_SELECTOR = '.nf-ratings-badge, header, nav, .pinning-header, .watch-video, [data-uia="watch-video"]';
  const MODAL_SUBLIST_SELECTOR = '.moreLikeThis--wrapper, .episodeSelector, .titleCardList--container';

  const IGNORED_LABELS = new Set([
    'play',
    'resume',
    'pause',
    'mute',
    'unmute',
    'close',
    'back',
    'more info',
    'add to my list',
    'remove from my list',
    'i like this',
    'not for me',
    'love this!',
    'rate',
    'audio & subtitles',
    'previous',
    'next',
    'home',
    'tv shows',
    'movies',
    'new & popular',
    'my list',
    'browse by languages',
    'search',
    'episodes',
    'details'
  ]);

  /** @type {Map<string, { found: boolean, imdbRating: string|null, imdbID: string|null, rottenTomatoes: string|null, cachedAt: number }>} */
  const localCache = new Map();

  /** @type {WeakMap<Element, number>} */
  const hoverTimers = new WeakMap();

  /** @type {WeakSet<Element>} */
  const boundCards = new WeakSet();

  let extensionEnabled = true;
  let cardScanRafId = null;
  const pendingScanRoots = new Set();

  /**
   * Strips common Netflix noise from extracted titles before querying OMDb.
   * @param {string} rawTitle
   * @returns {string}
   */
  function cleanTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== 'string') return '';
    let cleaned = rawTitle.replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';

    let previous;
    do {
      previous = cleaned;
      cleaned = cleaned
        .replace(/^watch\s+/i, '')
        .replace(/\s*\((?:limited\s+series|miniseries|mini-series|season\s+\d+|series\s+\d+|part\s+\d+|vol(?:ume)?\.?\s+\d+)\)\s*$/i, '')
        .replace(/\s*[:\-–—]\s*(?:limited\s+series|miniseries|mini-series|season\s+\d+|series\s+\d+|part\s+\d+|vol(?:ume)?\.?\s+\d+)\s*$/i, '')
        .replace(/[\s:]+$/g, '')
        .replace(/\s+[-–—]+$/g, '')
        .trim();
    } while (cleaned !== previous);

    return cleaned;
  }

  /**
   * Produces a normalized cache key matching background.js.
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
   * Validates whether a cache entry is within the 7-day TTL.
   * @param {object|null|undefined} entry
   * @returns {boolean}
   */
  function isCacheFresh(entry) {
    return Boolean(
      entry &&
      typeof entry.cachedAt === 'number' &&
      Date.now() - entry.cachedAt < CACHE_TTL_MS
    );
  }

  /**
   * Filters out non-title UI aria labels such as Play or Close.
   * @param {string|null|undefined} label
   * @returns {boolean}
   */
  function isUsableLabel(label) {
    if (!label || typeof label !== 'string') return false;
    const trimmed = label.trim();
    if (!trimmed) return false;
    return !IGNORED_LABELS.has(trimmed.toLowerCase());
  }

  /**
   * Hydrates the local in-memory cache and extensionEnabled setting from chrome.storage.local.
   */
  async function initializeState() {
    try {
      const items = await chrome.storage.local.get(null);
      extensionEnabled = items.extensionEnabled !== false;

      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith(CACHE_PREFIX) && isCacheFresh(value)) {
          localCache.set(key.slice(CACHE_PREFIX.length), value);
        }
      }
    } catch {
      extensionEnabled = true;
    }
  }

  /**
   * Requests ratings from background.js safely, guarding against invalidated extension contexts.
   * @param {string} title
   * @param {string|null} year
   */
  function fetchRatingsFromBackground(title, year) {
    return new Promise((resolve) => {
      if (!chrome.runtime || !chrome.runtime.id) {
        resolve({ ok: false, error: 'Extension context unavailable.' });
        return;
      }

      try {
        chrome.runtime.sendMessage(
          { type: 'GET_RATINGS', title, year },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              resolve({ ok: false, error: 'Background unavailable.' });
              return;
            }
            resolve(response);
          }
        );
      } catch {
        resolve({ ok: false, error: 'Failed to contact background.' });
      }
    });
  }

  /**
   * Creates an inline SVG star icon for IMDb.
   */
  function createStarIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('nf-ratings-icon');

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', '#F5C518');
    path.setAttribute(
      'd',
      'M12 2.2l2.92 5.92 6.53.95-4.72 4.6 1.11 6.5L12 17.1l-5.84 3.07 1.11-6.5-4.72-4.6 6.53-.95L12 2.2z'
    );
    svg.appendChild(path);
    return svg;
  }

  /**
   * Creates an inline SVG tomato icon colored by Rotten Tomatoes threshold.
   * @param {string} colorHex
   */
  function createTomatoIcon(colorHex) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('nf-ratings-icon');

    const body = document.createElementNS(SVG_NS, 'circle');
    body.setAttribute('cx', '12');
    body.setAttribute('cy', '13.5');
    body.setAttribute('r', '7.5');
    body.setAttribute('fill', colorHex);

    const stem = document.createElementNS(SVG_NS, 'path');
    stem.setAttribute('fill', colorHex === '#FA320A' ? '#22C55E' : '#14532D');
    stem.setAttribute(
      'd',
      'M12 3.2c.6 0 1 .4 1 1v1.4c1.1-.6 2.5-.6 3.5.1-.9.9-2.2 1.3-3.5 1.1-.4.7-1.6.7-2 0-1.3.2-2.6-.2-3.5-1.1 1-.7 2.4-.7 3.5-.1V4.2c0-.6.4-1 1-1z'
    );

    svg.appendChild(body);
    svg.appendChild(stem);
    return svg;
  }

  /**
   * Builds the ratings badge DOM node safely without innerHTML.
   * @param {{ imdbRating?: string|null, imdbID?: string|null, rottenTomatoes?: string|null }} data
   * @param {'card'|'modal'} variant
   * @param {Element} hostElement
   * @returns {HTMLElement|null}
   */
  function buildRatingsBadge(data, variant, hostElement) {
    if (!data) return null;
    const hasImdb = Boolean(data.imdbRating);
    const hasRt = Boolean(data.rottenTomatoes);
    if (!hasImdb && !hasRt) return null;

    const badge = document.createElement('div');
    badge.className = `nf-ratings-badge nf-ratings-badge--${variant}`;

    if (hasImdb) {
      const imdbUrl = data.imdbID ? `https://www.imdb.com/title/${data.imdbID}` : null;
      const insideAnchor = Boolean(hostElement.closest('a'));

      let imdbNode;
      if (imdbUrl && !insideAnchor) {
        imdbNode = document.createElement('a');
        imdbNode.href = imdbUrl;
        imdbNode.target = '_blank';
        imdbNode.rel = 'noopener noreferrer';
      } else if (imdbUrl) {
        imdbNode = document.createElement('span');
        imdbNode.setAttribute('role', 'link');
        imdbNode.tabIndex = 0;
      } else {
        imdbNode = document.createElement('span');
      }

      imdbNode.className = imdbUrl
        ? 'nf-ratings-item nf-ratings-imdb'
        : 'nf-ratings-item nf-ratings-imdb nf-ratings-imdb--static';
      imdbNode.title = imdbUrl ? `Open on IMDb (${data.imdbRating}/10)` : `IMDb ${data.imdbRating}/10`;

      if (imdbUrl) {
        const stopOnly = (e) => {
          e.stopPropagation();
        };
        imdbNode.addEventListener('mousedown', stopOnly);
        imdbNode.addEventListener('pointerdown', stopOnly);
        imdbNode.addEventListener('click', (e) => {
          e.stopPropagation();
          if (insideAnchor) {
            e.preventDefault();
            window.open(imdbUrl, '_blank', 'noopener,noreferrer');
          }
        });
        if (insideAnchor) {
          imdbNode.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              window.open(imdbUrl, '_blank', 'noopener,noreferrer');
            }
          });
        }
      }

      imdbNode.appendChild(createStarIcon());

      const imdbLabel = document.createElement('span');
      imdbLabel.className = 'nf-ratings-imdb-label';
      imdbLabel.textContent = 'IMDb';
      imdbNode.appendChild(imdbLabel);

      const imdbScore = document.createElement('span');
      imdbScore.className = 'nf-ratings-score';
      imdbScore.textContent = data.imdbRating;
      imdbNode.appendChild(imdbScore);

      badge.appendChild(imdbNode);
    }

    if (hasImdb && hasRt) {
      const divider = document.createElement('span');
      divider.className = 'nf-ratings-divider';
      divider.setAttribute('aria-hidden', 'true');
      badge.appendChild(divider);
    }

    if (hasRt) {
      const numericPct = parseInt(String(data.rottenTomatoes).replace(/[^0-9]/g, ''), 10);
      const tomatoColor = !Number.isNaN(numericPct) && numericPct >= 60 ? '#FA320A' : '#22C55E';

      const rtNode = document.createElement('span');
      rtNode.className = 'nf-ratings-item nf-ratings-rt';
      rtNode.title = `Rotten Tomatoes ${data.rottenTomatoes}`;

      rtNode.appendChild(createTomatoIcon(tomatoColor));

      const rtScore = document.createElement('span');
      rtScore.className = 'nf-ratings-score';
      rtScore.textContent = data.rottenTomatoes;
      rtNode.appendChild(rtScore);

      badge.appendChild(rtNode);
    }

    return badge;
  }

  /**
   * Injects a badge into a card or modal host and prevents duplicate injections.
   * @param {Element} hostElement
   * @param {object} data
   * @param {'card'|'modal'} variant
   * @param {string} normalizedTitle
   */
  function renderBadge(hostElement, data, variant, normalizedTitle) {
    if (!extensionEnabled || !hostElement || !hostElement.isConnected) return;

    const existing = hostElement.querySelector(':scope > .nf-ratings-badge');
    if (existing) {
      if (hostElement.dataset.ratingsTitle === normalizedTitle) {
        return;
      }
      existing.remove();
    }

    if (variant === 'card' && getComputedStyle(hostElement).position === 'static') {
      hostElement.classList.add('nf-ratings-card-host');
    }

    hostElement.setAttribute('data-ratings-injected', 'true');
    hostElement.dataset.ratingsTitle = normalizedTitle;

    if (!data || !data.found) return;

    const badge = buildRatingsBadge(data, variant, hostElement);
    if (badge) {
      hostElement.appendChild(badge);
    }
  }

  /**
   * Maps a DOM match to a single canonical thumbnail card container.
   * @param {Element} el
   * @returns {Element|null}
   */
  function resolveCanonicalCard(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.closest(EXCLUDED_CONTEXT_SELECTOR) || el.closest(MODAL_ROOT_SELECTOR)) {
      return null;
    }

    if (el.matches('[data-uia="title-card"]')) {
      return el;
    }

    if (el.matches('.title-card-container')) {
      return el.querySelector('[data-uia="title-card"]') || el;
    }

    if (el.matches('.slider-item')) {
      return el.querySelector('[data-uia="title-card"], .title-card-container') || el;
    }

    if (el.matches('a[aria-label]')) {
      const parentCard = el.closest('[data-uia="title-card"], .title-card-container, .slider-item');
      if (parentCard) {
        return resolveCanonicalCard(parentCard);
      }
      const hasArtwork = Boolean(el.querySelector('img, .boxart-container, .boxart-image'));
      if (hasArtwork && isUsableLabel(el.getAttribute('aria-label'))) {
        return el;
      }
      return null;
    }

    return null;
  }

  /**
   * Extracts a clean title from a Netflix thumbnail card.
   * @param {Element} card
   * @returns {string}
   */
  function extractCardTitle(card) {
    const directLabel = card.getAttribute('aria-label');
    if (isUsableLabel(directLabel)) {
      const cleaned = cleanTitle(directLabel);
      if (cleaned) return cleaned;
    }

    const anchors = card.querySelectorAll('a[aria-label]');
    for (const anchor of anchors) {
      const label = anchor.getAttribute('aria-label');
      if (isUsableLabel(label)) {
        const cleaned = cleanTitle(label);
        if (cleaned) return cleaned;
      }
    }

    const fallbackNode = card.querySelector('.fallback-text');
    if (fallbackNode && fallbackNode.textContent) {
      const cleaned = cleanTitle(fallbackNode.textContent);
      if (cleaned) return cleaned;
    }

    const imgWithAlt = card.querySelector('img[alt]');
    if (imgWithAlt) {
      const alt = imgWithAlt.getAttribute('alt');
      if (isUsableLabel(alt)) {
        const cleaned = cleanTitle(alt);
        if (cleaned) return cleaned;
      }
    }

    return '';
  }

  /**
   * Extracts an optional 4-digit release year from an element subtree if visible.
   * @param {Element} root
   * @returns {string|null}
   */
  function extractYearFromElement(root) {
    if (!root) return null;
    const yearSelectors = '.year, [data-uia="item-year"]';
    const yearNodes = root.querySelectorAll(yearSelectors);
    for (const node of yearNodes) {
      if (node.closest(MODAL_SUBLIST_SELECTOR)) continue;
      const match = (node.textContent || '').match(/\b(19\d{2}|20\d{2})\b/);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Cancels any pending hover timer on a card.
   * @param {Element} card
   */
  function clearCardHoverTimer(card) {
    const timerId = hoverTimers.get(card);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      hoverTimers.delete(card);
    }
  }

  /**
   * Handles mouseenter on a thumbnail card: instant render on cache hit, 250ms debounce otherwise.
   * @param {Element} card
   */
  function handleCardMouseEnter(card) {
    if (!extensionEnabled || !card.isConnected) return;

    const title = extractCardTitle(card);
    if (!title) return;

    const normalizedKey = normalizeTitleKey(title);
    if (
      card.getAttribute('data-ratings-injected') === 'true' &&
      card.dataset.ratingsTitle === normalizedKey
    ) {
      return;
    }

    const cached = localCache.get(normalizedKey);
    if (cached && isCacheFresh(cached)) {
      renderBadge(card, cached, 'card', normalizedKey);
      return;
    }

    clearCardHoverTimer(card);
    const year = extractYearFromElement(card);

    const timerId = window.setTimeout(async () => {
      hoverTimers.delete(card);
      if (!extensionEnabled || !card.isConnected) return;

      const latestCached = localCache.get(normalizedKey);
      if (latestCached && isCacheFresh(latestCached)) {
        renderBadge(card, latestCached, 'card', normalizedKey);
        return;
      }

      card.dataset.ratingsPendingTitle = normalizedKey;
      const response = await fetchRatingsFromBackground(title, year);

      if (!extensionEnabled || !card.isConnected) return;
      if (card.dataset.ratingsPendingTitle !== normalizedKey) return;
      delete card.dataset.ratingsPendingTitle;

      if (response && response.ok && response.data) {
        localCache.set(normalizedKey, response.data);
        renderBadge(card, response.data, 'card', normalizedKey);
      }
    }, HOVER_DEBOUNCE_MS);

    hoverTimers.set(card, timerId);
  }

  /**
   * Attaches hover listeners once per thumbnail card without triggering any initial fetch.
   * @param {Element} card
   */
  function bindThumbnailCard(card) {
    if (!card || boundCards.has(card)) return;
    boundCards.add(card);

    card.addEventListener('mouseenter', () => handleCardMouseEnter(card), { passive: true });
    card.addEventListener('mouseleave', () => clearCardHoverTimer(card), { passive: true });
  }

  /**
   * Scans a subtree for thumbnail cards and binds hover listeners.
   * @param {Element} root
   */
  function bindCardsInSubtree(root) {
    if (!root || !(root instanceof Element)) return;

    const directCard = resolveCanonicalCard(root);
    if (directCard) {
      bindThumbnailCard(directCard);
    }

    const candidates = root.querySelectorAll(CARD_CANDIDATE_SELECTOR);
    for (const candidate of candidates) {
      const card = resolveCanonicalCard(candidate);
      if (card) {
        bindThumbnailCard(card);
      }
    }
  }

  /**
   * Locates the primary metadata row element inside a Netflix Mini-Modal or Detail Modal.
   * @param {Element} modalRoot
   * @returns {Element|null}
   */
  function findModalMetadataTarget(modalRoot) {
    const selectors = [
      '.previewModal--info [data-uia="video-metadata"]',
      '.previewModal--detailsMetadata [data-uia="video-metadata"]',
      '.previewModal--detailsMetadata-left .videoMetadata--container',
      '.previewModal--detailsMetadata-left',
      '.previewModal--detailsMetadata',
      '[data-uia="video-metadata"]'
    ];

    for (const selector of selectors) {
      const candidates = modalRoot.querySelectorAll(selector);
      for (const el of candidates) {
        if (!el.closest(MODAL_SUBLIST_SELECTOR)) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Extracts title from a Netflix Mini-Modal or Detail Modal.
   * @param {Element} modalRoot
   * @returns {string}
   */
  function extractModalTitle(modalRoot) {
    const logoSelectors = [
      '.previewModal--boxart[alt]',
      '.previewModal--boxart img[alt]',
      '.playerModel--player__storyArt[alt]',
      '.previewModal--player-titleTreatment-logo[alt]',
      '.previewModal--player-titleTreatmentWrapper img[alt]'
    ];

    for (const selector of logoSelectors) {
      const el = modalRoot.querySelector(selector);
      if (el && !el.closest(MODAL_SUBLIST_SELECTOR)) {
        const alt = el.getAttribute('alt');
        if (isUsableLabel(alt)) {
          const cleaned = cleanTitle(alt);
          if (cleaned) return cleaned;
        }
      }
    }

    const headerSelectors = [
      '[data-uia="title-text"]',
      '.previewModal--section-header strong',
      '.about-header strong'
    ];

    for (const selector of headerSelectors) {
      const el = modalRoot.querySelector(selector);
      if (el && !el.closest(MODAL_SUBLIST_SELECTOR) && el.textContent) {
        const cleaned = cleanTitle(el.textContent);
        if (cleaned) return cleaned;
      }
    }

    const wrapperLabel = modalRoot.getAttribute('aria-label');
    if (isUsableLabel(wrapperLabel)) {
      const cleaned = cleanTitle(wrapperLabel);
      if (cleaned) return cleaned;
    }

    const modalLinks = modalRoot.querySelectorAll('a[aria-label]');
    for (const link of modalLinks) {
      if (link.closest(MODAL_SUBLIST_SELECTOR)) continue;
      const label = link.getAttribute('aria-label');
      if (isUsableLabel(label)) {
        const cleaned = cleanTitle(label);
        if (cleaned) return cleaned;
      }
    }

    return '';
  }

  /**
   * Extracts release year from modal .year / [data-uia="item-year"] or metadata row text.
   * @param {Element} modalRoot
   * @param {Element} metadataTarget
   * @returns {string|null}
   */
  function extractModalYear(modalRoot, metadataTarget) {
    const explicitYear = extractYearFromElement(modalRoot);
    if (explicitYear) return explicitYear;

    if (metadataTarget && metadataTarget.textContent) {
      const match = metadataTarget.textContent.match(/\b(19\d{2}|20\d{2})\b/);
      if (match) return match[1];
    }

    return null;
  }

  /**
   * Detects open modal metadata and fetches/injects ratings immediately.
   * @param {Element} modalRoot
   */
  async function processModal(modalRoot) {
    if (!extensionEnabled || !modalRoot || !modalRoot.isConnected) return;

    const metadataTarget = findModalMetadataTarget(modalRoot);
    if (!metadataTarget) return;

    const title = extractModalTitle(modalRoot);
    if (!title) return;

    const normalizedKey = normalizeTitleKey(title);

    if (
      metadataTarget.getAttribute('data-ratings-injected') === 'true' &&
      metadataTarget.dataset.ratingsTitle === normalizedKey &&
      (metadataTarget.querySelector(':scope > .nf-ratings-badge') ||
        (localCache.get(normalizedKey) && !localCache.get(normalizedKey).found))
    ) {
      return;
    }

    // Handle in-place modal navigation to a different title
    if (metadataTarget.dataset.ratingsTitle && metadataTarget.dataset.ratingsTitle !== normalizedKey) {
      const oldBadge = metadataTarget.querySelector(':scope > .nf-ratings-badge');
      if (oldBadge) oldBadge.remove();
      metadataTarget.removeAttribute('data-ratings-injected');
      delete metadataTarget.dataset.ratingsTitle;
    }

    if (metadataTarget.dataset.ratingsPendingTitle === normalizedKey) {
      return;
    }

    const cached = localCache.get(normalizedKey);
    if (cached && isCacheFresh(cached)) {
      renderBadge(metadataTarget, cached, 'modal', normalizedKey);
      return;
    }

    const year = extractModalYear(modalRoot, metadataTarget);
    metadataTarget.dataset.ratingsPendingTitle = normalizedKey;

    const response = await fetchRatingsFromBackground(title, year);
    if (!extensionEnabled || !metadataTarget.isConnected) return;
    if (metadataTarget.dataset.ratingsPendingTitle !== normalizedKey) return;
    delete metadataTarget.dataset.ratingsPendingTitle;

    if (response && response.ok && response.data) {
      localCache.set(normalizedKey, response.data);
      renderBadge(metadataTarget, response.data, 'modal', normalizedKey);
    }
  }

  /**
   * Scans all currently mounted modals on the page.
   */
  function processAllOpenModals() {
    if (!extensionEnabled) return;
    const modals = document.querySelectorAll(MODAL_ROOT_SELECTOR);
    for (const modal of modals) {
      processModal(modal);
    }
  }

  /**
   * Batches thumbnail listener binding per animation frame to avoid scroll/render jank.
   */
  function scheduleCardScan(root) {
    if (!root || !(root instanceof Element)) return;
    pendingScanRoots.add(root);
    if (cardScanRafId !== null) return;

    cardScanRafId = window.requestAnimationFrame(() => {
      cardScanRafId = null;
      const roots = Array.from(pendingScanRoots);
      pendingScanRoots.clear();
      for (const node of roots) {
        if (node.isConnected) {
          bindCardsInSubtree(node);
        }
      }
    });
  }

  /**
   * Removes all injected badges and attributes when the extension is disabled.
   */
  function removeAllInjectedBadges() {
    document.querySelectorAll('.nf-ratings-badge').forEach((badge) => badge.remove());
    document.querySelectorAll('[data-ratings-injected]').forEach((el) => {
      el.removeAttribute('data-ratings-injected');
      delete el.dataset.ratingsTitle;
      delete el.dataset.ratingsPendingTitle;
      el.classList.remove('nf-ratings-card-host');
    });
  }

  /**
   * Starts the MutationObserver on document.body for SPA modal detection and card listener binding.
   */
  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!extensionEnabled) return;

      let shouldCheckModals = false;

      for (const mutation of mutations) {
        if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) continue;

        const targetEl = mutation.target instanceof Element ? mutation.target : null;
        if (targetEl && targetEl.closest('.nf-ratings-badge')) continue;

        if (targetEl && targetEl.closest(MODAL_ROOT_SELECTOR)) {
          shouldCheckModals = true;
        }

        for (const added of mutation.addedNodes) {
          if (!(added instanceof Element)) continue;
          if (added.classList.contains('nf-ratings-badge')) continue;

          if (
            added.matches(MODAL_ROOT_SELECTOR) ||
            added.querySelector(MODAL_ROOT_SELECTOR) ||
            added.matches('.previewModal--detailsMetadata, [data-uia="video-metadata"]') ||
            added.querySelector('.previewModal--detailsMetadata, [data-uia="video-metadata"]')
          ) {
            shouldCheckModals = true;
          }

          scheduleCardScan(added);
        }
      }

      if (shouldCheckModals) {
        processAllOpenModals();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (Object.prototype.hasOwnProperty.call(changes, 'extensionEnabled')) {
      extensionEnabled = changes.extensionEnabled.newValue !== false;
      if (!extensionEnabled) {
        removeAllInjectedBadges();
      } else {
        bindCardsInSubtree(document.body);
        processAllOpenModals();
      }
    }

    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(CACHE_PREFIX)) continue;
      const normalizedKey = key.slice(CACHE_PREFIX.length);
      if (change.newValue === undefined) {
        localCache.delete(normalizedKey);
      } else {
        localCache.set(normalizedKey, change.newValue);
      }
    }
  });

  async function init() {
    await initializeState();
    if (extensionEnabled) {
      bindCardsInSubtree(document.body);
      processAllOpenModals();
    }
    startObserver();
  }

  init();
})();
