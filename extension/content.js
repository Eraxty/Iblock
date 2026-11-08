/*
 * Iblock content script. Decides whether the current page is a short-form
 * feed, counts every new short you land on, shows the little counter pill,
 * and covers the page with a lock screen once short-form is off limits.
 */
(() => {
  'use strict';

  const I = globalThis.Iblock;
  if (!I || window.top !== window) return;
  const platform = I.PLATFORMS.find((p) => I.hostMatches(location.hostname, p.host));
  if (!platform) return;
  const { ext } = I;

  /* ---------- per-site rules ---------- */

  // "url" sites put the short's id in the address bar as you swipe; on "video"
  // sites we watch which big video is playing in the middle of the screen.
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
      surface: (path) => /(^|\/)reels?(\/|$)/.test(path),
      item: (path) => path.match(/(?:^|\/)reels?\/(?!audio\/)([\w-]{5,})/)?.[1] ?? null,
      hide: ['a[href="/reels/"]', 'a[role="tab"][href$="/reels/"]'],
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
  };
  const adapter = ADAPTERS[platform.id];

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

  let alive = true;
  let state = null;
  let lastHref = '';
  let seenId = null; // last item (or path) evaluated, to tell navigation apart from state changes
  let lastItem = null; // last short we asked the background to count
  let pendingItem = null; // count request in flight
  let allowedItem = null; // most recent short the background let through
  let videoItem = null; // key of the big playing video (video sites)
  let overlayReason = null;
  let overlayKey = '';
  let pendingSeconds = 0;
  let boundaryTimer = 0;
  let tickTimer = 0;
  let hudKey = ''; // what the pill last showed; it only pops up when this changes
  let hudTimer = 0;
  let ui = null;
  let hideStyle = null;

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

  /* ---------- the decision ---------- */

  function check() {
    if (!alive || !state) return;
    const st = I.status(state);
    const enabled = state.settings.sites[platform.id];
    setHideCss(enabled && state.settings.hide && st.reason !== null);
    scheduleBoundary();

    const path = location.pathname;
    if (!enabled || !adapter.surface(path)) {
      seenId = null;
      lastItem = null;
      videoItem = null;
      hideOverlay();
      hideHud();
      return;
    }

    const item = adapter.counts === 'url' ? adapter.item(path) : videoItem;
    const id = item ?? `path:${path}`;
    const navigated = id !== seenId;
    seenId = id;

    // Hitting the limit mid-short shouldn't yank away the short you just got.
    const finishing = st.reason === 'limit' && item !== null && (item === allowedItem || item === pendingItem);
    if (st.reason && !finishing) {
      lastItem = null;
      showOverlay(st);
      hideHud();
      if (navigated) send({ type: 'blocked', platform: platform.id });
      return;
    }

    hideOverlay();
    if (item !== null && item !== lastItem && !document.hidden) {
      lastItem = item;
      requestCount(item);
    }
    showHud(st);
  }

  async function requestCount(item) {
    pendingItem = item;
    const res = await send({ type: 'count', platform: platform.id });
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
      state = I.normalizeState(await ext.storage.local.get(['settings', 'stats', 'lock']));
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

  // The playing video that crosses the middle of the screen and is big enough
  // to be the feed item, not a hover preview in a grid.
  function activeVideo() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = null;
    let bestArea = 0;
    for (const v of document.getElementsByTagName('video')) {
      if (v.paused || v.ended || v.readyState < 2) continue;
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

  function videoKey(v) {
    const src = v.currentSrc || v.src;
    if (src) return src;
    if (!videoIds.has(v)) videoIds.set(v, `video-${++videoSeq}`);
    return videoIds.get(v);
  }

  function videoTick() {
    if (!alive || !state || overlayReason || adapter.counts !== 'video') return;
    if (!state.settings.sites[platform.id] || !adapter.surface(location.pathname)) return;
    const v = activeVideo();
    if (!v) return;
    const key = videoKey(v);
    if (key !== videoItem) {
      videoItem = key;
      check();
    }
  }

  /* ---------- time on short-form ---------- */

  function timeTick() {
    if (!alive || !state) return;
    const watching =
      !overlayReason &&
      state.settings.sites[platform.id] &&
      adapter.surface(location.pathname) &&
      document.visibilityState === 'visible' &&
      document.hasFocus();
    if (watching) pendingSeconds++;
    if (pendingSeconds >= 15) flushTime();
  }

  function flushTime() {
    if (!pendingSeconds || !alive) return;
    const seconds = pendingSeconds;
    pendingSeconds = 0;
    send({ type: 'time', platform: platform.id, seconds });
  }

  /* ---------- page integration ---------- */

  function setHideCss(on) {
    if (!adapter.hide.length) return;
    if (!on) {
      hideStyle?.remove();
      return;
    }
    if (!hideStyle) {
      hideStyle = document.createElement('style');
      hideStyle.dataset.iblock = '';
      // One rule per selector, so a selector a browser doesn't understand
      // can't take the rest down with it.
      hideStyle.textContent = adapter.hide.map((s) => `${s} { display: none !important; }`).join('\n');
    }
    if (!hideStyle.isConnected) (document.head || document.documentElement).append(hideStyle);
  }

  function pauseMedia() {
    for (const m of document.querySelectorAll('video, audio')) if (!m.paused) m.pause();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

  // While the lock screen is up, keep keys and scrolling away from the page so
  // the player can't skip to the next short underneath it.
  function swallow(e) {
    if (!overlayReason || (ui && e.composedPath().includes(ui.host))) return;
    e.stopImmediatePropagation();
    if (e.type === 'wheel' || e.type === 'touchmove') {
      if (e.cancelable) e.preventDefault();
    } else if (e.type === 'keydown' && !e.ctrlKey && !e.metaKey && !e.altKey && (NAV_KEYS.has(e.key) || e.key.length === 1)) {
      e.preventDefault();
    }
  }

  function onPlay(e) {
    if (!(e.target instanceof HTMLMediaElement)) return;
    check();
    if (overlayReason) e.target.pause();
    else if (adapter.counts === 'video') setTimeout(videoTick, 120);
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
    if (changes.settings) applyTheme();
    check();
  }

  function poll() {
    if (!runtimeAlive()) return teardown();
    if (location.href !== lastHref) {
      lastHref = location.href;
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
    hideStyle?.remove();
    if (globalThis.__iblockTeardown === teardown) delete globalThis.__iblockTeardown;
  }
  globalThis.__iblockTeardown = teardown;

  /* ---------- UI: counter pill + lock screen ---------- */

  const ICONS = {
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    shield: '<path d="M12 21s7-3.5 7-9.5V5.5L12 3 5 5.5v6C5 17.5 12 21 12 21z"/>',
    limit: '<path d="M6.5 3h11M6.5 21h11M7.5 3v2.5a4.5 4.5 0 0 0 9 0V3M7.5 21v-2.5a4.5 4.5 0 0 1 9 0V21"/>',
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
      --ink: #171716; --on-ink: #FFFFFF; --shadow: 0 8px 24px rgba(23, 23, 22, 0.12);
      font: 400 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      color-scheme: light;
    }
    .wrap[data-theme="dark"] {
      --bg: #0E0E0F; --surface: #18181A; --surface-2: #222225; --line: #2A2A2E; --line-strong: #3A3A3F;
      --text: #F2F1EC; --text-2: #A5A39D; --text-3: #6E6D69;
      --accent: #FF6B35; --accent-text: #FF8A5E; --accent-soft: rgba(255, 107, 53, 0.14);
      --ink: #F2F1EC; --on-ink: #111112; --shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
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
      padding: 40px 24px; overflow-y: auto; overscroll-behavior: contain;
      background: var(--bg); opacity: 0; transition: opacity 0.2s ease-out;
    }
    .overlay.show { opacity: 1; }
    .panel { width: 100%; max-width: 440px; }
    .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 56px; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .where { margin-left: auto; color: var(--text-3); font-weight: 500; }
    .badge {
      width: 48px; height: 48px; margin-bottom: 24px; border-radius: 14px;
      display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text);
    }
    .badge svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
    h1 { margin: 0 0 12px; font-size: 32px; line-height: 1.15; font-weight: 650; letter-spacing: -0.03em; text-wrap: balance; }
    .lead { margin: 0 0 32px; font-size: 16px; color: var(--text-2); max-width: 40ch; }
    .timer {
      display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
      padding: 16px 20px; margin-bottom: 8px;
      border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
    }
    .timer-label { color: var(--text-2); font-size: 14px; }
    .timer-value { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .stats {
      display: grid; grid-template-columns: repeat(3, 1fr); margin: 0;
      border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
    }
    .stats div { padding: 14px 16px; }
    .stats div + div { border-left: 1px solid var(--line); }
    .stats dt { font-size: 12px; color: var(--text-2); }
    .stats dd { margin: 2px 0 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
    .tip { margin: 24px 0 0; font-size: 14px; color: var(--text-2); }
    .tip b { color: var(--text); font-weight: 600; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 32px; }
    .btn {
      position: relative; overflow: hidden;
      height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid transparent;
      font-size: 14px; font-weight: 600; letter-spacing: -0.005em; cursor: pointer;
      transition: background-color 0.15s ease-out, border-color 0.15s ease-out, transform 0.1s ease-out;
    }
    .btn:active { transform: scale(0.98); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .primary { background: var(--ink); color: var(--on-ink); }
    .primary:hover { opacity: 0.9; }
    .secondary { background: var(--surface); border-color: var(--line-strong); }
    .secondary:hover { background: var(--surface-2); }
    .unlock { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
    .hold { width: 100%; background: transparent; border-color: var(--line-strong); color: var(--text-2); user-select: none; touch-action: none; }
    .hold:hover { color: var(--text); }
    .hold .fill { position: absolute; inset: 0; background: var(--accent-soft); transform: scaleX(0); transform-origin: left; }
    .hold .label { position: relative; }
    .note { margin: 0; font-size: 13px; color: var(--text-3); }
    @media (max-width: 480px) {
      h1 { font-size: 26px; }
      .brand { margin-bottom: 40px; }
      .actions { flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      .hud, .overlay, .btn, .hud-ring .f { transition: none; }
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
        <div class="panel">
          <div class="brand">${MARK}<span>Iblock</span><span class="where"></span></div>
          <div class="badge">${ICON_SVGS}</div>
          <h1 id="ib-title"></h1>
          <p class="lead"></p>
          <div class="timer"><span class="timer-label"></span><span class="timer-value"></span></div>
          <dl class="stats">
            <div><dt>Scrolls today</dt><dd class="s-n"></dd></div>
            <div><dt>Watched</dt><dd class="s-t"></dd></div>
            <div><dt>Blocked</dt><dd class="s-b"></dd></div>
          </dl>
          <p class="tip"><b>Instead:</b> <span class="tip-text"></span></p>
          <div class="actions">
            <button type="button" class="btn primary leave"></button>
            <button type="button" class="btn secondary close">Close tab</button>
          </div>
          <div class="unlock">
            <button type="button" class="btn hold"><span class="fill"></span><span class="label">Hold to unlock early</span></button>
            <p class="note strict">Strict mode is on, so this lock can't be ended early.</p>
          </div>
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
      statN: $('.s-n'),
      statT: $('.s-t'),
      statB: $('.s-b'),
      tip: $('.tip-text'),
      leave: $('.leave'),
      close: $('.close'),
      unlock: $('.unlock'),
      hold: $('.hold'),
      strictNote: $('.strict'),
    };
    ui.hudFill.style.strokeDasharray = String(RING);
    ui.where.textContent = platform.name;

    // Keep the page from reacting to clicks and keys aimed at the lock screen.
    for (const type of ['keydown', 'keyup', 'keypress', 'wheel', 'touchmove', 'click', 'pointerdown', 'mousedown']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    ui.leave.addEventListener('click', () => {
      if (platform.home) location.assign(platform.home);
      else send({ type: 'closeTab' });
    });
    ui.close.addEventListener('click', () => send({ type: 'closeTab' }));
    ui.holdControl = I.holdButton(ui.hold, async () => {
      const res = await send({ type: 'unlock' });
      if (res?.error === 'strict') {
        ui.hold.hidden = true;
        ui.strictNote.hidden = false;
      }
    });
    document.documentElement.append(host);
    applyTheme();
    return ui;
  }

  function applyTheme() {
    if (!ui || !state) return;
    const pref = state.settings.theme;
    ui.wrap.dataset.theme = pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref;
  }

  function copyFor(st) {
    const until = st.until ? I.fmtUntil(st.until) : '';
    switch (st.reason) {
      case 'lock':
        return { icon: 'lock', title: 'Short-form is locked.', lead: `You locked it until ${until}. Stick with it.`, timer: 'Unlocks in' };
      case 'bedtime':
        return { icon: 'moon', title: 'Bedtime. Short-form is off.', lead: `Bedtime mode runs until ${until}. Get some sleep.`, timer: 'Back in' };
      case 'off':
        return {
          icon: 'shield',
          title: 'Short-form is blocked.',
          lead: 'You turned it off completely. You can change that from the Iblock menu any time.',
          timer: null,
        };
      default:
        return {
          icon: 'limit',
          title: `That's your ${st.limit} for today.`,
          lead: "You've used every scroll you gave yourself today. Short-form opens again at midnight.",
          timer: 'Resets in',
        };
    }
  }

  function showOverlay(st) {
    const u = ensureUi();
    applyTheme();
    const key = `${st.reason}|${st.until}|${st.limit}`;
    if (key !== overlayKey) {
      overlayKey = key;
      const copy = copyFor(st);
      // SVG elements have no .hidden property, so set the attribute itself.
      for (const svg of u.icons) svg.toggleAttribute('hidden', svg.dataset.icon !== copy.icon);
      u.title.textContent = copy.title;
      u.lead.textContent = copy.lead;
      u.timer.hidden = !copy.timer;
      u.timerLabel.textContent = copy.timer || '';
      u.leave.textContent = platform.home ? `Go to ${platform.label} home` : 'Close tab';
      u.close.hidden = !platform.home;
      u.holdControl.reset();
    }
    if (overlayReason !== st.reason) u.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    const canUnlock = st.reason === 'lock';
    u.unlock.hidden = !canUnlock;
    u.hold.hidden = state.settings.strict;
    u.strictNote.hidden = !state.settings.strict;
    u.statN.textContent = I.fmtNum(st.today.n);
    u.statT.textContent = I.fmtDuration(st.today.t);
    u.statB.textContent = I.fmtNum(st.today.b);
    overlayReason = st.reason;
    updateTimer();
    if (u.overlay.hidden) {
      u.overlay.hidden = false;
      requestAnimationFrame(() => u.overlay.classList.add('show'));
    }
    pauseMedia();
    if (!tickTimer) tickTimer = setInterval(overlayTick, 1000);
  }

  function updateTimer() {
    if (!ui || !overlayReason) return;
    const st = I.status(state);
    if (st.until) ui.timerValue.textContent = I.fmtCountdown(st.until - Date.now());
  }

  function overlayTick() {
    if (!alive || !overlayReason) return;
    pauseMedia();
    const st = I.status(state);
    if (st.reason !== overlayReason || (st.until && st.until <= Date.now())) check();
    else updateTimer();
  }

  function hideOverlay() {
    if (!overlayReason) return;
    overlayReason = null;
    overlayKey = '';
    clearInterval(tickTimer);
    tickTimer = 0;
    if (ui) {
      ui.overlay.classList.remove('show');
      ui.overlay.hidden = true;
      ui.holdControl.reset();
    }
  }

  // The pill pops up in the corner when you land on a new short, then gets
  // out of the way. It lingers a little longer when you're nearly out.
  function showHud(st) {
    if (!state.settings.hud) return hideHud();
    if (pendingItem !== null) return; // wait for the new count, then show it once
    const n = st.today.n;
    const key = `${n}|${st.limit}`;
    if (key === hudKey) return;
    const u = ensureUi();
    u.hudNum.textContent = I.fmtNum(n);
    u.hudOf.textContent = st.limit === null ? ' today' : `/${st.limit}`;
    const progress = st.limit ? Math.min(1, n / st.limit) : 0;
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

  ext.storage.local.get(['settings', 'stats', 'lock']).then(
    (raw) => {
      if (!alive) return;
      state = I.normalizeState(raw);
      lastHref = location.href;
      check();
    },
    () => teardown(),
  );
})();
