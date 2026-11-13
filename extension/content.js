/*
 * Iblock content script. Decides whether the current page is a short-form
 * feed (or an endless feed like Reddit's), counts every new short you land on,
 * shows the counter pill and the pause screen, and covers the page with the
 * lock screen (which carries the Iblock menu) once it's off limits.
 */
(() => {
  'use strict';

  const I = globalThis.Iblock;
  if (!I || window.top !== window) return;
  const platform = I.platformForHost(location.hostname);
  if (!platform) return;
  const { ext } = I;
  const isShort = platform.kind === 'short';

  /* ---------- per-site rules ---------- */

  // How shorts are counted: "url" sites put the short's id in the address bar
  // as you swipe; on "video" sites we watch which big video is playing in the
  // middle of the screen; "none" is for feeds, which are timed but not counted.
  //
  // On feed pages a lock only empties the feed itself (`feedHide`, the main one
  // first), so messages, search and the rest of the site keep working around it.
  // `feedItems` are the posts themselves, to notice a feed nothing is hiding.
  const TIKTOK_NOT_FEED =
    /^\/(messages|tiktokstudio|creator|upload|setting|settings|login|signup|legal|business|coin|feedback|privacy|community-guidelines|about|download|transparency)(\/|$)/;

  const ADAPTERS = {
    youtube: {
      counts: 'url',
      surface: (path) => /^\/shorts(\/|$)/.test(path),
      item: (path) => path.match(/^\/shorts\/([\w-]{6,})/)?.[1] ?? null,
      hide: [
        'ytd-guide-entry-renderer:has(a[title="Shorts"])',
        'ytd-guide-entry-renderer:has(a[href^="/shorts"])',
        'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
        'ytd-mini-guide-entry-renderer:has(a[href^="/shorts"])',
        'ytd-rich-shelf-renderer[is-shorts]',
        'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
        'ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model)',
        'ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2)',
        'ytd-reel-shelf-renderer',
        'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
        'grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)',
        'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
        'ytd-video-renderer:has(a[href^="/shorts/"])',
        'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
        'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
        'yt-tab-shape[tab-title="Shorts"]',
        'ytm-reel-shelf-renderer',
        'ytm-shorts-lockup-view-model',
        'ytm-shorts-lockup-view-model-v2',
        'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
        'ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)',
        'ytm-video-with-context-renderer:has(a[href^="/shorts/"])',
      ],
    },
    instagram: {
      counts: 'url',
      // The home feed and Explore are endless too; DMs and profiles stay open.
      feed: (path) => path === '/' || /^\/explore\/?$/.test(path),
      surface: (path) => path === '/' || /(^|\/)reels?(\/|$)/.test(path) || /^\/explore\/?$/.test(path),
      item: (path) => path.match(/(?:^|\/)reels?\/(?!audio\/)([\w-]{5,})/)?.[1] ?? null,
      hide: ['a[href="/reels/"]', 'a[role="tab"][href$="/reels/"]', 'a[href="/explore/"]'],
      // The home feed is a <div role="main">, profiles and Explore a <main>.
      feedHide: ['[role="main"]', 'main'],
      feedItems: 'article, a[href*="/p/"], a[href*="/reel/"]',
    },
    tiktok: {
      counts: 'video',
      surface: (path) => !TIKTOK_NOT_FEED.test(path),
      hide: [],
    },
    snapchat: {
      counts: 'video',
      surface: (path) => /(^|\/)spotlight(\/|$)/.test(path),
      hide: ['a[href="/spotlight"]', 'a[href^="/spotlight?"]', 'a[href="https://www.snapchat.com/spotlight"]'],
    },
    facebook: {
      counts: 'url',
      surface: (path) => /^\/reels?(\/|$)/.test(path),
      item: (path) => path.match(/^\/reels?\/(\d+)/)?.[1] ?? null,
      hide: ['a[href^="/reel/?s="]', 'a[href^="https://www.facebook.com/reel/?s="]'],
    },
    x: {
      counts: 'none',
      surface: (path) => /^\/(home|explore)(\/|$)/.test(path),
      hide: [],
      feedHide: ['[data-testid="primaryColumn"]'], // the sidebar keeps X's search box
      feedItems: 'article',
    },
    reddit: {
      counts: 'none',
      surface: (path) => /^\/((best|hot|new|top|rising)\/?)?$/.test(path) || /^\/r\/(popular|all)(\/|$)/.test(path),
      hide: [],
      feedHide: ['#main-content', '#right-sidebar-container', '.content[role="main"]'],
      feedItems: 'shreddit-post, article, .thing.link',
    },
    pinterest: {
      counts: 'none',
      surface: (path) => /^\/((today|ideas|homefeed)(\/.*)?)?$/.test(path),
      hide: [],
      feedHide: ['[data-test-id="masonry-container"]', '.masonryContainer'],
      feedItems: '[data-test-id="pin"], a[href^="/pin/"]',
    },
  };
  const adapter = ADAPTERS[platform.id];
  const feedHide = adapter.feedHide ?? [];
  const FEED = feedHide.join(', ');
  const FEED_MEDIA = feedHide.flatMap((s) => [`${s} video`, `${s} audio`]).join(', ');

  const GRAY_RULE = 'video, img, picture, canvas { filter: grayscale(1) !important; }';
  const YT_FEED_RULES = [
    'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer { display: none !important; }',
    'ytd-browse[page-subtype="home"] #primary::before { content: "Iblock hid your home feed. Search for what you came for."; display: block; padding: 96px 24px; text-align: center; font: 500 16px/1.5 Roboto, Arial, sans-serif; color: var(--yt-spec-text-secondary, #606060); }',
    '#related, ytd-watch-next-secondary-results-renderer { display: none !important; }',
    '.ytp-endscreen-content, .ytp-ce-element, .ytp-autonav-endscreen-countdown-overlay, .ytp-fullscreen-grid { display: none !important; }',
    'ytm-browse ytm-rich-grid-renderer, ytm-item-section-renderer[section-identifier="related-items"] { display: none !important; }',
  ];

  const TIPS = [
    'Drink a glass of water.',
    'Stand up and stretch for two minutes.',
    "Text someone you haven't talked to in a while.",
    'Step outside for ten minutes.',
    'Read five pages of something.',
    'Tidy one small thing near you.',
    "Start the task you've been putting off. Just the first step.",
    'Take ten slow breaths.',
    'Make yourself a cup of tea.',
    'Put on one song and do nothing else.',
  ];

  // An older copy of this script (left behind by an extension update) steps aside.
  globalThis.__iblockTeardown?.();

  /* ---------- state ---------- */

  const KEYS = ['settings', 'stats', 'lock', 'seen'];
  const PAUSE_KEY = 'iblock:pause-until';

  let alive = true;
  let state = null;
  let lastHref = '';
  let seenId = null; // last item (or path) evaluated, to tell navigation apart from state changes
  let lastItem = null; // last short we asked the background to count
  let pendingItem = null; // count request in flight
  let allowedItem = null; // most recent short the background let through
  let videoItem = null; // key of the big playing video (video sites)
  let overlayReason = null; // why the overlay is up: a block reason, or 'pause'
  let overlaySoft = false; // shown as a card over a hidden feed instead of covering the page
  let overlayKey = '';
  let feedPage = false; // check() found a feed page (not a short) on screen
  let pauseUntil = readPause(); // the pause screen stays away until then
  let pauseShownAt = 0;
  let leaving = false;
  let watchable = false; // check() decided short-form is on screen and open: time counts, the pause grace extends
  let intentAt = 0; // last click or play key, to tell a chosen play from autoplay
  let pendingSeconds = 0;
  let boundaryTimer = 0;
  let tickTimer = 0;
  let hudKey = ''; // what the pill last showed; it only pops up when this changes
  let hudTimer = 0;
  let ui = null;
  let pageStyle = null;
  const pausedByUs = new Set();

  const runtimeAlive = () => {
    try {
      return Boolean(ext.runtime?.id);
    } catch {
      return false;
    }
  };

  async function send(message) {
    const res = await I.send(message);
    if (!res && !runtimeAlive()) teardown();
    return res;
  }

  function readPause() {
    try {
      return Number(sessionStorage.getItem(PAUSE_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  // While you keep using the feed, the pause screen stays away; it comes back
  // after PAUSE_GRACE_MS away.
  function keepPause(now) {
    const next = now + I.PAUSE_GRACE_MS;
    if (next - pauseUntil < 30_000) return;
    pauseUntil = next;
    try {
      sessionStorage.setItem(PAUSE_KEY, String(next));
    } catch {
      // Without sessionStorage the pause just shows again on reload.
    }
  }

  /* ---------- the decision ---------- */

  function check() {
    if (!alive || !state) return;
    watchable = false;
    const now = Date.now();
    const st = I.status(state, now);
    const s = state.settings;
    const enabled = s.sites[platform.id];
    const path = location.pathname;
    const onSurface = enabled && adapter.surface(path);
    const css = {
      hide: enabled && s.hide && st.reason !== null,
      gray: onSurface && s.gray,
      feed: enabled && s.ytFeed && platform.id === 'youtube',
      feedLock: false,
    };
    scheduleBoundary();

    if (!onSurface) {
      setPageCss(css);
      seenId = null;
      lastItem = null;
      videoItem = null;
      feedPage = false;
      hideOverlay();
      hideHud();
      return;
    }

    const item = adapter.counts === 'url' ? adapter.item(path) : adapter.counts === 'video' ? videoItem : null;
    const id = item ?? `path:${path}`;
    const navigated = id !== seenId;
    seenId = id;
    feedPage = platform.kind === 'feed' || Boolean(adapter.feed?.(path));

    // Hitting the limit mid-short shouldn't yank away the short you just got,
    // and going back to one you already watched today is free.
    const finishing = st.reason === 'limit' && item !== null && (item === allowedItem || item === pendingItem || countedToday(item));
    const blocked = st.reason !== null && !finishing;
    setPageCss({ ...css, feedLock: feedPage && (blocked || (s.pause && pauseUntil <= now)) });
    if (blocked) {
      lastItem = null;
      showOverlay('block', st);
      hideHud();
      if (navigated && isShort && !feedPage) send({ type: 'blocked', platform: platform.id });
      return;
    }

    // YouTube: count the short, then open it in the normal player, no swipe feed.
    if (platform.id === 'youtube' && s.ytPlayer && item) {
      hideOverlay();
      hideHud();
      if (item !== lastItem) {
        lastItem = item;
        requestCount(item);
      } else if (item === allowedItem && !leaving) {
        leaving = true;
        location.replace(`/watch?v=${encodeURIComponent(item)}`);
      }
      return;
    }

    if (s.pause && pauseUntil <= now) {
      showOverlay('pause', st);
      hideHud();
      return;
    }
    if (s.pause) keepPause(now);

    hideOverlay();
    watchable = true;
    if (isShort && item !== null && item !== lastItem && !document.hidden) {
      lastItem = item;
      if (!countedToday(item)) requestCount(item);
    }
    if (isShort) showHud(st);
  }

  const countedToday = (item) => I.seenToday(state.seen).includes(I.countId(platform.id, item));

  // A feed page gets the small card, unless posts are on screen with none of
  // `feedHide` there to empty (say, after a redesign): then the full lock
  // screen covers the page. A slow page or a login screen keeps the card.
  function wantSoft() {
    if (!feedPage || !FEED) return false;
    if (document.querySelector(FEED)) return true;
    for (const el of document.querySelectorAll(adapter.feedItems)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) return false;
    }
    return true;
  }

  async function requestCount(item) {
    pendingItem = item;
    const res = await send({ type: 'count', platform: platform.id, key: I.hashKey(item) });
    if (pendingItem === item) pendingItem = null;
    if (!alive || !res) return;
    if (res.allowed) {
      allowedItem = item;
      const day = I.touchDay(state.stats);
      day.n = Math.max(day.n, res.total);
    } else {
      // The background had newer news (another tab used up the limit). It has
      // already recorded the block, so just catch up and show the lock screen.
      await reloadState();
    }
    check();
  }

  async function reloadState() {
    try {
      state = I.normalizeState(await ext.storage.local.get(KEYS));
    } catch {
      if (!runtimeAlive()) teardown();
    }
  }

  function scheduleBoundary() {
    clearTimeout(boundaryTimer);
    const wait = I.nextBoundary(state) - Date.now() + 250;
    boundaryTimer = setTimeout(check, Math.min(2 ** 31 - 1, Math.max(500, wait)));
  }

  /* ---------- video sites ---------- */

  const videoIds = new WeakMap();
  let videoSeq = 0;

  // The video crossing the middle of the screen that's big enough to be the
  // feed item, not a hover preview in a grid.
  function centralVideo(videos) {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      if (!v.isConnected) continue;
      const r = v.getBoundingClientRect();
      if (r.height < vh * 0.3 || r.width < 120 || r.top > vh / 2 || r.bottom < vh / 2) continue;
      const area = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  const playing = () => [...document.getElementsByTagName('video')].filter((v) => !v.paused && !v.ended && v.readyState >= 2);

  function videoKey(v) {
    const src = v.currentSrc || v.src;
    if (src) return src;
    if (!videoIds.has(v)) videoIds.set(v, `video-${++videoSeq}`);
    return videoIds.get(v);
  }

  function videoTick() {
    if (!alive || !state || overlayReason || adapter.counts !== 'video') return;
    if (!state.settings.sites[platform.id] || !adapter.surface(location.pathname)) return;
    const v = centralVideo(playing());
    if (!v) return;
    const key = videoKey(v);
    if (key !== videoItem) {
      videoItem = key;
      check();
    }
  }

  /* ---------- time on short-form ---------- */

  // Goes by what check() last decided, never the raw address: after an SPA
  // navigation the URL changes up to one poll before check() runs, and in
  // that gap this would count time and wave the pause screen through.
  function timeTick() {
    if (!alive || !state) return;
    const watching = watchable && !overlayReason && document.visibilityState === 'visible' && document.hasFocus();
    if (!watching) return;
    pendingSeconds++;
    if (state.settings.pause) keepPause(Date.now());
    // With a time limit, report the moment it runs out rather than 15s later.
    const { minutes } = state.settings;
    const today = I.status(state).today;
    if (pendingSeconds >= 15 || (minutes !== null && today.t + pendingSeconds >= minutes * 60)) flushTime();
  }

  function flushTime() {
    if (!pendingSeconds || !alive) return;
    const seconds = pendingSeconds;
    pendingSeconds = 0;
    send({ type: 'time', platform: platform.id, seconds });
  }

  /* ---------- page integration ---------- */

  // One stylesheet for everything Iblock changes on the page itself. One rule
  // per selector, so a selector a browser doesn't know can't sink the rest.
  function setPageCss({ hide, gray, feed, feedLock }) {
    const rules = [];
    if (hide) rules.push(...adapter.hide.map((s) => `${s} { display: none !important; }`));
    if (gray) rules.push(GRAY_RULE);
    if (feed) rules.push(...YT_FEED_RULES);
    // Empty the feed but keep its box, so the card can stand in its place.
    if (feedLock) rules.push(...feedHide.map((s) => `${s} > * { display: none !important; }`));
    const css = rules.join('\n');
    if (!css) {
      pageStyle?.remove();
      return;
    }
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      pageStyle.dataset.iblock = '';
    }
    if (pageStyle.textContent !== css) pageStyle.textContent = css;
    if (!pageStyle.isConnected) (document.head || document.documentElement).append(pageStyle);
  }

  // A hidden feed keeps playing (and can be heard) unless it's paused. With the
  // card up, only the feed's own media is stopped, not a video in your DMs.
  function pauseMedia() {
    for (const m of document.querySelectorAll(overlaySoft ? FEED_MEDIA : 'video, audio')) {
      if (m.paused) continue;
      m.pause();
      pausedByUs.add(m);
    }
    if (!overlaySoft && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  const PLAY_KEYS = new Set([' ', 'k', 'K', 'Enter']);

  // While the lock screen is up, keep keys and scrolling away from the page so
  // the player can't skip to the next short underneath it. The feed card leaves
  // them alone: you're meant to keep using the rest of the site.
  function swallow(e) {
    if (!overlayReason || overlaySoft || (ui && e.composedPath().includes(ui.host))) return;
    e.stopImmediatePropagation();
    if (e.type === 'wheel' || e.type === 'touchmove') {
      if (e.cancelable) e.preventDefault();
    } else if (e.type === 'keydown' && !e.ctrlKey && !e.metaKey && !e.altKey && (NAV_KEYS.has(e.key) || e.key.length === 1)) {
      e.preventDefault();
    }
  }

  function onIntent(e) {
    if (e.type === 'click' || PLAY_KEYS.has(e.key)) intentAt = performance.now();
  }

  function onPlay(e) {
    if (!(e.target instanceof HTMLMediaElement)) return;
    check();
    if (overlayReason) {
      if (!overlaySoft || e.target.matches(FEED_MEDIA)) {
        e.target.pause();
        pausedByUs.add(e.target);
      }
      return;
    }
    const s = state?.settings;
    const here = s && s.sites[platform.id] && adapter.surface(location.pathname);
    // "No autoplay": a short only plays after a click or a play key.
    if (here && s.noAutoplay && isShort && e.target.tagName === 'VIDEO' && performance.now() - intentAt > 1200) {
      e.target.pause();
      return;
    }
    if (adapter.counts === 'video') setTimeout(videoTick, 120);
  }

  function onVisibility() {
    if (document.hidden) flushTime();
    check();
  }

  function onStorage(changes, area) {
    if (area !== 'local' || !state || !alive) return;
    if (changes.settings) state.settings = I.normalizeSettings(changes.settings.newValue);
    if (changes.stats) state.stats = I.normalizeStats(changes.stats.newValue);
    if (changes.lock) state.lock = I.normalizeLock(changes.lock.newValue);
    if (changes.seen) state.seen = I.normalizeSeen(changes.seen.newValue);
    if (changes.settings) applyTheme();
    check();
  }

  function poll() {
    if (!runtimeAlive()) return teardown();
    if (location.href !== lastHref) {
      lastHref = location.href;
      leaving = false;
      check();
    }
  }

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => applyTheme();

  const listeners = [
    [window, 'popstate', check],
    [window, 'pagehide', flushTime],
    [document, 'yt-navigate-finish', check],
    [document, 'visibilitychange', onVisibility],
    [document, 'play', onPlay, true],
    [document, 'playing', onPlay, true],
    [darkQuery, 'change', onScheme],
    ...['keydown', 'keyup', 'keypress', 'wheel', 'touchmove'].map((t) => [window, t, swallow, { capture: true, passive: false }]),
    [window, 'click', onIntent, true],
    [window, 'keydown', onIntent, true],
  ];
  for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
  ext.storage.onChanged.addListener(onStorage);
  const intervals = [setInterval(poll, 250), setInterval(timeTick, 1000)];
  if (adapter.counts === 'video') intervals.push(setInterval(videoTick, 600));

  function teardown() {
    if (!alive) return;
    alive = false;
    for (const id of intervals) clearInterval(id);
    clearTimeout(boundaryTimer);
    clearInterval(tickTimer);
    clearTimeout(hudTimer);
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    try {
      ext.storage.onChanged.removeListener(onStorage);
    } catch {
      // The extension context is already gone.
    }
    ui?.host.remove();
    pageStyle?.remove();
    if (globalThis.__iblockTeardown === teardown) delete globalThis.__iblockTeardown;
  }
  globalThis.__iblockTeardown = teardown;

  /* ---------- UI: counter pill, pause screen, lock screen ---------- */

  const ICONS = {
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    shield: '<path d="M12 21s7-3.5 7-9.5V5.5L12 3 5 5.5v6C5 17.5 12 21 12 21z"/>',
    limit: '<path d="M6.5 3h11M6.5 21h11M7.5 3v2.5a4.5 4.5 0 0 0 9 0V3M7.5 21v-2.5a4.5 4.5 0 0 1 9 0V21"/>',
    time: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    breath: '<path d="M12.8 19.6A2 2 0 1 0 14 16H3"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H3"/><path d="M9.8 4.4A2 2 0 1 1 11 8H3"/>',
  };
  const ICON_SVGS = Object.entries(ICONS)
    .map(([name, paths]) => `<svg viewBox="0 0 24 24" data-icon="${name}" aria-hidden="true">${paths}</svg>`)
    .join('');

  const MARK = `<svg class="mark" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" class="mark-bg"/><rect x="30" y="14" width="36" height="68" rx="6" fill="none" stroke-width="8" class="mark-frame"/><rect x="12" y="39" width="72" height="18" rx="9" stroke-width="6" paint-order="stroke" class="mark-bar"/></svg>`;

  const CSS = `
    :host { all: initial; }
    .wrap {
      --bg: #F4F3EF; --surface: #FFFFFF; --surface-2: #F0EFEA; --line: #E6E4DE; --line-strong: #D6D3CB;
      --text: #171716; --text-2: #62615C; --text-3: #92908A;
      --accent: #E8521C; --accent-text: #B93F0E; --accent-soft: #FCE7DD;
      --ink: #171716; --on-ink: #FFFFFF;
      --shadow: 0 8px 24px rgba(23, 23, 22, 0.12); --shadow-lg: 0 24px 64px rgba(23, 23, 22, 0.14);
      font: 400 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      color-scheme: light;
    }
    .wrap[data-theme="dark"] {
      --bg: #0E0E0F; --surface: #18181A; --surface-2: #222225; --line: #2A2A2E; --line-strong: #3A3A3F;
      --text: #F2F1EC; --text-2: #A5A39D; --text-3: #6E6D69;
      --accent: #FF6B35; --accent-text: #FF8A5E; --accent-soft: rgba(255, 107, 53, 0.14);
      --ink: #F2F1EC; --on-ink: #111112;
      --shadow: 0 8px 24px rgba(0, 0, 0, 0.4); --shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.5);
      color-scheme: dark;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { font: inherit; color: inherit; }

    .mark { width: 20px; height: 20px; flex: none; }
    .mark-bg { fill: var(--ink); }
    .mark-frame { stroke: var(--on-ink); }
    .mark-bar { fill: var(--accent); stroke: var(--ink); }

    .hud {
      position: fixed; top: 72px; right: 16px;
      display: flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px 0 8px;
      border-radius: 999px; border: 1px solid var(--line);
      background: var(--surface); box-shadow: var(--shadow);
      font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
      pointer-events: none; opacity: 0; transform: translateY(-6px);
      transition: opacity 0.25s ease-out, transform 0.25s ease-out;
    }
    .hud.show { opacity: 0.96; transform: none; }
    .hud.bump .hud-num { animation: bump 0.25s ease-out; }
    .hud-ring { width: 18px; height: 18px; transform: rotate(-90deg); }
    .hud-ring circle { fill: none; stroke-width: 2.5; }
    .hud-ring .t { stroke: var(--surface-2); }
    .hud-ring .f { stroke: var(--text); stroke-linecap: round; transition: stroke-dashoffset 0.3s ease-out; }
    .hud.warn .hud-ring .f { stroke: var(--accent); }
    .hud-of { color: var(--text-3); font-weight: 500; }
    .hud-note { color: var(--accent-text); font-weight: 600; }
    .hud-note:empty { display: none; }
    .hud-note::before { content: "·"; color: var(--text-3); margin: 0 6px 0 2px; font-weight: 400; }
    @keyframes bump { 40% { transform: scale(1.18); } }

    .overlay {
      position: fixed; inset: 0; pointer-events: auto;
      display: grid; place-items: center;
      padding: 32px 24px; overflow-y: auto; overscroll-behavior: contain;
      background: var(--bg); opacity: 0; transition: opacity 0.2s ease-out;
    }
    .overlay.show { opacity: 1; }
    .layout { display: flex; align-items: center; justify-content: center; gap: 64px; width: 100%; max-width: 920px; }
    .panel { flex: 1 1 0; min-width: 0; max-width: 440px; }
    .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 48px; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .where { margin-left: auto; color: var(--text-3); font-weight: 500; }
    .badge {
      width: 48px; height: 48px; margin-bottom: 24px; border-radius: 14px;
      display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text);
    }
    .badge svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
    h1 { margin: 0 0 12px; font-size: 32px; line-height: 1.15; font-weight: 650; letter-spacing: -0.03em; text-wrap: balance; }
    .lead { margin: 0 0 28px; font-size: 16px; color: var(--text-2); max-width: 42ch; }
    .timer {
      display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
      padding: 16px 20px;
      border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
    }
    .timer-label { color: var(--text-2); font-size: 14px; }
    .timer-value { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .breath { height: 6px; overflow: hidden; border-radius: 999px; background: var(--surface-2); }
    .breath span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transform: scaleX(0); transform-origin: left; }
    .breath.run span { animation: breathe var(--pause, 5s) linear forwards; }
    @keyframes breathe { to { transform: scaleX(1); } }
    .tip { margin: 24px 0 0; font-size: 14px; color: var(--text-2); }
    .tip b { color: var(--text); font-weight: 600; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 32px; }
    .btn {
      position: relative; overflow: hidden;
      height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid transparent;
      font-size: 14px; font-weight: 600; letter-spacing: -0.005em; cursor: pointer;
      transition: background-color 0.15s ease-out, border-color 0.15s ease-out, opacity 0.15s ease-out, transform 0.1s ease-out;
    }
    .btn:active:not(:disabled) { transform: scale(0.98); }
    .btn:disabled { cursor: default; opacity: 0.5; }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .primary { background: var(--ink); color: var(--on-ink); }
    .primary:hover { opacity: 0.9; }
    .secondary { background: var(--surface); border-color: var(--line-strong); }
    .secondary:hover:not(:disabled) { background: var(--surface-2); }
    .go { font-variant-numeric: tabular-nums; }
    .note { margin: 20px 0 0; font-size: 13px; color: var(--text-3); }
    .menu {
      flex: none; width: 360px; height: 600px; overflow: hidden;
      border: 1px solid var(--line); border-radius: 18px;
      background: var(--bg); box-shadow: var(--shadow-lg);
    }
    .menu:empty { display: none; }
    .menu iframe { display: block; width: 100%; height: 100%; border: 0; }

    /* On a feed page: a card where the feed was, and the rest of the site still usable. */
    .overlay.card {
      inset: auto; top: 50%; left: 50%; display: block;
      width: min(400px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
      padding: 28px; border: 1px solid var(--line); border-radius: 18px;
      background: var(--surface); box-shadow: var(--shadow-lg);
      transform: translate(-50%, -50%);
    }
    .card .layout { display: block; }
    .card .panel { max-width: none; }
    .card .brand { margin-bottom: 24px; }
    .card .badge { width: 40px; height: 40px; margin-bottom: 16px; border-radius: 12px; }
    .card .badge svg { width: 20px; height: 20px; }
    .card h1 { margin-bottom: 8px; font-size: 22px; }
    .card .lead { margin-bottom: 20px; font-size: 14px; }
    .card .timer { padding: 12px 16px; background: var(--bg); }
    .card .timer-value { font-size: 22px; }
    .card .actions { margin-top: 20px; }
    .card .note { margin-top: 16px; }
    .card.dodge { visibility: hidden; }
    @media (max-width: 900px) {
      .layout { flex-direction: column; gap: 40px; }
      .panel { width: 100%; }
      .brand { margin-bottom: 32px; }
    }
    @media (max-width: 480px) {
      .overlay { padding: 24px 16px; }
      h1 { font-size: 26px; }
      .actions { flex-direction: column; }
      .menu { width: 100%; max-width: 360px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .hud, .overlay, .btn, .hud-ring .f { transition: none; }
      .breath.run span { animation: none; transform: scaleX(1); }
      .hud.bump .hud-num { animation: none; }
    }
  `;

  const TEMPLATE = `
    <div class="wrap">
      <div class="hud" aria-hidden="true">
        <svg class="hud-ring" viewBox="0 0 18 18"><circle class="t" cx="9" cy="9" r="6.5"/><circle class="f" cx="9" cy="9" r="6.5"/></svg>
        <span><span class="hud-num"></span><span class="hud-of"></span></span><span class="hud-note"></span>
      </div>
      <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="ib-title" hidden>
        <div class="layout">
          <section class="panel">
            <div class="brand">${MARK}<span>Iblock</span><span class="where"></span></div>
            <div class="badge">${ICON_SVGS}</div>
            <h1 id="ib-title"></h1>
            <p class="lead"></p>
            <div class="timer"><span class="timer-label"></span><span class="timer-value"></span></div>
            <div class="breath" aria-hidden="true"><span></span></div>
            <p class="tip"><b>Instead:</b> <span class="tip-text"></span></p>
            <div class="actions">
              <button type="button" class="btn primary leave"></button>
              <button type="button" class="btn secondary go"></button>
              <button type="button" class="btn secondary close">Close tab</button>
            </div>
            <p class="note menu-note">Take a break, change your limits or unlock early from the menu.</p>
          </section>
          <div class="menu"></div>
        </div>
      </div>
    </div>
  `;

  const RING = 2 * Math.PI * 6.5;

  function ensureUi() {
    if (ui) {
      if (!ui.host.isConnected) document.documentElement.append(ui.host);
      return ui;
    }
    for (const stale of document.querySelectorAll('iblock-root')) stale.remove();
    const host = document.createElement('iblock-root');
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style, I.markup(TEMPLATE));
    const $ = (s) => root.querySelector(s);
    ui = {
      host,
      wrap: $('.wrap'),
      hud: $('.hud'),
      hudFill: $('.hud-ring .f'),
      hudNum: $('.hud-num'),
      hudOf: $('.hud-of'),
      hudNote: $('.hud-note'),
      overlay: $('.overlay'),
      where: $('.where'),
      icons: root.querySelectorAll('.badge svg'),
      title: $('h1'),
      lead: $('.lead'),
      timer: $('.timer'),
      timerLabel: $('.timer-label'),
      timerValue: $('.timer-value'),
      breath: $('.breath'),
      tipRow: $('.tip'),
      tip: $('.tip-text'),
      actions: $('.actions'),
      leave: $('.leave'),
      go: $('.go'),
      close: $('.close'),
      menuNote: $('.menu-note'),
      menu: $('.menu'),
    };
    ui.hudFill.style.strokeDasharray = String(RING);
    ui.breath.style.setProperty('--pause', `${I.PAUSE_SECONDS}s`);
    ui.where.textContent = platform.name;

    // Keep the page from reacting to clicks and keys aimed at the overlay.
    for (const type of ['keydown', 'keyup', 'keypress', 'wheel', 'touchmove', 'click', 'pointerdown', 'mousedown']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    ui.leave.addEventListener('click', () => {
      if (platform.home) location.assign(platform.home);
      else send({ type: 'closeTab' });
    });
    ui.close.addEventListener('click', () => send({ type: 'closeTab' }));
    ui.go.addEventListener('click', continuePastPause);
    document.documentElement.append(host);
    applyTheme();
    return ui;
  }

  function applyTheme() {
    if (!ui || !state) return;
    const pref = state.settings.theme;
    ui.wrap.dataset.theme = pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref;
  }

  function blockCopy(st, soft) {
    const what = soft ? 'Your feed is' : isShort ? 'Short-form is' : 'Feeds are';
    const until = st.until ? I.fmtUntil(st.until) : '';
    switch (st.reason) {
      case 'lock':
        return { icon: 'lock', title: `${what} locked.`, lead: `You started a break that runs until ${until}. Stick with it.`, timer: 'Unlocks in' };
      case 'bedtime':
        return { icon: 'moon', title: `Bedtime. ${what} off.`, lead: `Bedtime mode runs until ${until}. Get some sleep.`, timer: 'Back in' };
      case 'off':
        return { icon: 'shield', title: `${what} blocked.`, lead: 'You turned short-form off completely. Change that from the Iblock menu any time.', timer: null };
      case 'time':
        return {
          icon: 'time',
          title: `That's your ${I.fmtLength(st.minutes)} for today.`,
          lead: "You've used all the time you gave yourself today. It opens again at midnight.",
          timer: 'Resets in',
        };
      default:
        return {
          icon: 'limit',
          title: `That's your ${st.allowance} for today.`,
          lead: "You've used every scroll you gave yourself today. It opens again at midnight.",
          timer: 'Resets in',
        };
    }
  }

  function pauseCopy(st) {
    const where = feedPage ? `your ${platform.label} feed` : platform.name;
    const used = [];
    if (st.allowance) used.push(`${st.today.n} of ${st.allowance} scrolls`);
    if (st.minutes) used.push(`${I.fmtDuration(st.today.t)} of ${I.fmtLength(st.minutes)}`);
    const usage = used.length ? ` So far today: ${used.join(' and ')}.` : '';
    return { icon: 'breath', title: 'Take a breath.', lead: `You're about to open ${where}. Is it what you want to be doing right now?${usage}`, timer: null };
  }

  function showOverlay(mode, st) {
    const u = ensureUi();
    applyTheme();
    const soft = wantSoft();
    const reason = mode === 'pause' ? 'pause' : st.reason;
    const key = `${soft}|${mode === 'pause' ? 'pause' : `${st.reason}|${st.until}|${st.allowance}|${st.minutes}`}`;
    if (key !== overlayKey) {
      overlayKey = key;
      const copy = mode === 'pause' ? pauseCopy(st) : blockCopy(st, soft);
      // SVG elements have no .hidden property, so set the attribute itself.
      for (const svg of u.icons) svg.toggleAttribute('hidden', svg.dataset.icon !== copy.icon);
      u.overlay.classList.toggle('card', soft);
      u.overlay.setAttribute('aria-modal', String(!soft));
      u.where.textContent = soft ? `${platform.label} feed` : platform.name;
      u.title.textContent = copy.title;
      u.lead.textContent = copy.lead;
      u.timer.hidden = !copy.timer;
      u.timerLabel.textContent = copy.timer || '';
      u.leave.textContent = mode === 'pause' ? 'Not now' : platform.home ? `Go to ${platform.label} home` : 'Close tab';
      u.leave.hidden = soft;
      u.close.hidden = soft || mode === 'pause' || !platform.home;
      u.go.hidden = mode !== 'pause';
      u.actions.hidden = soft && mode !== 'pause';
      u.breath.hidden = mode !== 'pause';
      u.tipRow.hidden = soft;
      u.menuNote.hidden = !soft && mode !== 'block';
      u.menuNote.textContent = soft
        ? `Messages, search and the rest of ${platform.label} still work.`
        : 'Take a break, change your limits or unlock early from the menu.';
    }
    if (overlayReason !== reason) {
      u.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
      if (mode === 'pause') startPause();
    }
    // The lock screen carries the real Iblock menu, so everything is one click away.
    if (mode === 'block' && !soft) {
      if (!u.menu.firstChild) {
        const frame = document.createElement('iframe');
        frame.title = 'Iblock menu';
        frame.src = ext.runtime.getURL('popup/popup.html#embedded');
        u.menu.append(frame);
      }
    } else {
      u.menu.replaceChildren();
    }
    overlayReason = reason;
    overlaySoft = soft;
    if (soft) settleCard();
    else u.overlay.style.removeProperty('left');
    updateOverlay();
    if (u.overlay.hidden) {
      u.overlay.hidden = false;
      requestAnimationFrame(() => u.overlay.classList.add('show'));
    }
    pauseMedia();
    if (!tickTimer) tickTimer = setInterval(overlayTick, 250);
  }

  // The card stands where the feed was, so the site's own menus and panels
  // beside it stay clear, and it steps aside while the site has a dialog open over it.
  function settleCard() {
    const feed = feedHide.map((s) => document.querySelector(s)).find(Boolean)?.getBoundingClientRect();
    const half = Math.min(400, innerWidth - 32) / 2 + 16;
    const x = feed?.width ? feed.left + feed.width / 2 : innerWidth / 2;
    ui.overlay.style.left = `${Math.round(Math.min(Math.max(x, half), innerWidth - half))}px`;
    const card = ui.overlay.getBoundingClientRect();
    const covered = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].some((d) => {
      const r = d.getBoundingClientRect();
      const shown = r.width > 0 && r.height > 0 && (d.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true);
      return shown && r.left < card.right && r.right > card.left && r.top < card.bottom && r.bottom > card.top;
    });
    ui.overlay.classList.toggle('dodge', covered);
  }

  function startPause() {
    pauseShownAt = Date.now();
    ui.breath.classList.remove('run');
    void ui.breath.offsetWidth; // restart the fill
    ui.breath.classList.add('run');
  }

  function continuePastPause() {
    if (ui.go.disabled) return;
    pauseUntil = 0;
    keepPause(Date.now());
    // Pick up the video the pause screen stopped (a click counts as choosing to play).
    const resume = centralVideo(pausedByUs);
    pausedByUs.clear();
    check();
    if (resume && !overlayReason && !state.settings.noAutoplay) resume.play().catch(() => {});
  }

  function updateOverlay() {
    if (!ui || !overlayReason) return;
    if (overlayReason === 'pause') {
      const left = Math.ceil((pauseShownAt + I.PAUSE_SECONDS * 1000 - Date.now()) / 1000);
      ui.go.disabled = left > 0;
      if (overlaySoft) ui.go.textContent = left > 0 ? `Show feed in ${left}s` : 'Show feed';
      else ui.go.textContent = left > 0 ? `Open in ${left}s` : `Open ${isShort ? platform.label : 'feed'}`;
      return;
    }
    const st = I.status(state);
    if (st.until) ui.timerValue.textContent = I.fmtCountdown(st.until - Date.now());
  }

  function overlayTick() {
    if (!alive || !overlayReason) return;
    if (wantSoft() !== overlaySoft) return check(); // the feed turned up, or never did
    if (overlaySoft) settleCard();
    pauseMedia();
    const st = I.status(state);
    const stale = overlayReason === 'pause' ? st.reason !== null : st.reason !== overlayReason || (st.until && st.until <= Date.now());
    if (stale) check();
    else updateOverlay();
  }

  function hideOverlay() {
    if (!overlayReason) return;
    overlayReason = null;
    overlaySoft = false;
    overlayKey = '';
    clearInterval(tickTimer);
    tickTimer = 0;
    pausedByUs.clear();
    if (ui) {
      ui.overlay.classList.remove('show', 'card', 'dodge');
      ui.overlay.style.removeProperty('left');
      ui.overlay.hidden = true;
      ui.menu.replaceChildren();
    }
  }

  // The pill pops up in the corner when you land on a new short, then gets
  // out of the way. It lingers a little longer when you're nearly out.
  function showHud(st) {
    if (!state.settings.hud) return hideHud();
    if (pendingItem !== null) return; // wait for the new count, then show it once
    const n = st.today.n;
    const key = `${n}|${st.allowance}`;
    if (key === hudKey) return;
    const u = ensureUi();
    u.hudNum.textContent = I.fmtNum(n);
    u.hudOf.textContent = st.allowance === null ? ' today' : `/${st.allowance}`;
    const progress = st.allowance ? Math.min(1, n / st.allowance) : 0;
    u.hudFill.style.strokeDashoffset = String(RING * (1 - progress));
    const warn = st.left !== null && st.left <= 2;
    u.hud.classList.toggle('warn', warn);
    u.hudNote.textContent = !warn ? '' : st.left === 0 ? 'last one' : `${st.left} left`;
    if (hudKey && u.hud.classList.contains('show')) {
      u.hud.classList.remove('bump');
      void u.hud.offsetWidth; // restart the animation
      u.hud.classList.add('bump');
    }
    hudKey = key;
    u.hud.classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => u.hud.classList.remove('show'), warn ? 4000 : 2500);
  }

  function hideHud() {
    clearTimeout(hudTimer);
    hudKey = '';
    ui?.hud.classList.remove('show');
  }

  /* ---------- start ---------- */

  ext.storage.local.get(KEYS).then(
    (raw) => {
      if (!alive) return;
      state = I.normalizeState(raw);
      lastHref = location.href;
      check();
      // A video that started before the settings arrived gets the same "no autoplay" treatment.
      const s = state.settings;
      if (!overlayReason && !intentAt && s.noAutoplay && isShort && s.sites[platform.id] && adapter.surface(location.pathname)) {
        for (const v of document.getElementsByTagName('video')) if (!v.paused) v.pause();
      }
    },
    () => teardown(),
  );
})();
