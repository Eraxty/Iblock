/*
 * Iblock core: constants, the storage schema and the rules that decide when
 * short-form is blocked. Loaded by the background worker, every content
 * script and the popup. Only markup() and holdButton() touch the DOM, and the
 * background never calls them.
 */
globalThis.Iblock = (() => {
  'use strict';

  const ext = globalThis.browser ?? globalThis.chrome;

  const PLATFORMS = Object.freeze([
    { id: 'youtube', name: 'YouTube Shorts', label: 'YouTube', host: 'youtube.com', where: 'youtube.com/shorts', home: 'https://www.youtube.com/' },
    { id: 'instagram', name: 'Instagram Reels', label: 'Instagram', host: 'instagram.com', where: 'instagram.com/reels', home: 'https://www.instagram.com/' },
    { id: 'tiktok', name: 'TikTok', label: 'TikTok', host: 'tiktok.com', where: 'All of tiktok.com', home: null },
    { id: 'snapchat', name: 'Snapchat Spotlight', label: 'Snapchat', host: 'snapchat.com', where: 'snapchat.com/spotlight', home: 'https://www.snapchat.com/' },
    { id: 'facebook', name: 'Facebook Reels', label: 'Facebook', host: 'facebook.com', where: 'facebook.com/reel', home: 'https://www.facebook.com/' },
  ]);
  const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
  const HOST_PATTERNS = PLATFORMS.map((p) => `*://*.${p.host}/*`);

  // null means "no limit, just count". 0 means short-form is always blocked.
  const LIMIT_STEPS = Object.freeze([0, 3, 5, 10, 15, 20, 30, 50, 100, null]);
  const LOCK_PRESETS = Object.freeze([30, 60, 180, 300]);
  const MAX_LOCK_MIN = 7 * 1440;
  const HOLD_TO_UNLOCK_MS = 10_000;
  const KEEP_DAYS = 400;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const THEMES = ['system', 'light', 'dark'];

  const DEFAULT_SETTINGS = Object.freeze({
    limit: 10,
    sites: Object.freeze(Object.fromEntries(PLATFORM_IDS.map((id) => [id, true]))),
    bedtime: Object.freeze({ on: false, from: 23 * 60, to: 7 * 60 }),
    strict: false,
    hud: true,
    hide: true,
    badge: true,
    theme: 'system',
  });

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const isMinute = (v) => Number.isInteger(v) && v >= 0 && v < 1440;
  const isLimit = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10_000);

  function refusal(code) {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  function hostMatches(hostname, host) {
    return hostname === host || hostname.endsWith(`.${host}`);
  }

  function platformById(id) {
    return PLATFORMS.find((p) => p.id === id) || null;
  }

  /* ---------- schema ---------- */

  function normalizeSettings(raw) {
    const s = isObj(raw) ? raw : {};
    const d = DEFAULT_SETTINGS;
    const sites = {};
    for (const id of PLATFORM_IDS) sites[id] = bool(isObj(s.sites) ? s.sites[id] : undefined, d.sites[id]);
    const bt = isObj(s.bedtime) ? s.bedtime : {};
    return {
      limit: s.limit !== undefined && isLimit(s.limit) ? s.limit : d.limit,
      sites,
      bedtime: {
        on: bool(bt.on, d.bedtime.on),
        from: isMinute(bt.from) ? bt.from : d.bedtime.from,
        to: isMinute(bt.to) ? bt.to : d.bedtime.to,
      },
      strict: bool(s.strict, d.strict),
      hud: bool(s.hud, d.hud),
      hide: bool(s.hide, d.hide),
      badge: bool(s.badge, d.badge),
      theme: THEMES.includes(s.theme) ? s.theme : d.theme,
    };
  }

  function counts(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const id of PLATFORM_IDS) if (count(raw[id])) out[id] = count(raw[id]);
    return out;
  }

  // n = scrolls, t = seconds watched, b = shorts blocked, over = tried to go past the limit
  function emptyDay() {
    return { n: 0, t: 0, b: 0, over: false, p: {}, tp: {} };
  }

  function normalizeDay(raw) {
    const d = isObj(raw) ? raw : {};
    return { n: count(d.n), t: count(d.t), b: count(d.b), over: d.over === true, p: counts(d.p), tp: counts(d.tp) };
  }

  function normalizeStats(raw) {
    const s = isObj(raw) ? raw : {};
    const days = {};
    if (isObj(s.days)) {
      for (const [k, v] of Object.entries(s.days)) if (DAY_RE.test(k)) days[k] = normalizeDay(v);
    }
    const life = isObj(s.life) ? s.life : {};
    return {
      since: count(s.since) || Date.now(),
      days,
      life: { n: count(life.n), t: count(life.t), b: count(life.b), p: counts(life.p), tp: counts(life.tp) },
    };
  }

  function normalizeLock(raw) {
    if (!isObj(raw)) return null;
    const { start, until } = raw;
    return Number.isFinite(start) && Number.isFinite(until) && until > start ? { start, until } : null;
  }

  function normalizeState(raw) {
    const r = isObj(raw) ? raw : {};
    return { settings: normalizeSettings(r.settings), stats: normalizeStats(r.stats), lock: normalizeLock(r.lock) };
  }

  /* ---------- calendar ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Midnight `offset` days from the day containing ts (local time, DST-safe).
  function dayStart(ts, offset = 0) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
  }

  const nextMidnight = (ts) => dayStart(ts, 1);

  function atMinute(ts, minute, offset) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, Math.floor(minute / 60), minute % 60).getTime();
  }

  function nextAt(ts, minute) {
    const today = atMinute(ts, minute, 0);
    return today > ts ? today : atMinute(ts, minute, 1);
  }

  function bedtimeState(bedtime, now) {
    if (!bedtime.on || bedtime.from === bedtime.to) return { active: false, until: 0, next: 0 };
    const d = new Date(now);
    const m = d.getHours() * 60 + d.getMinutes();
    const { from, to } = bedtime;
    const active = from < to ? m >= from && m < to : m >= from || m < to;
    return active ? { active: true, until: nextAt(now, to), next: nextAt(now, to) } : { active: false, until: 0, next: nextAt(now, from) };
  }

  /* ---------- rules ---------- */

  /**
   * Everything the UI needs to know about "right now".
   * reason: why short-form is blocked (lock > bedtime > off > limit), or null.
   * frozen: strict mode forbids loosening settings while this is true.
   */
  function status(state, now = Date.now()) {
    const { settings, stats, lock } = state;
    const key = dayKey(now);
    const today = stats.days[key] || emptyDay();
    const { limit } = settings;
    const bedtime = bedtimeState(settings.bedtime, now);
    let reason = null;
    let until = 0;
    if (lock && lock.until > now) {
      reason = 'lock';
      until = lock.until;
    } else if (bedtime.active) {
      reason = 'bedtime';
      until = bedtime.until;
    } else if (limit === 0) {
      reason = 'off';
    } else if (limit !== null && today.n >= limit) {
      reason = 'limit';
      until = nextMidnight(now);
    }
    return {
      reason,
      until,
      key,
      today,
      limit,
      left: limit === null ? null : Math.max(0, limit - today.n),
      locked: Boolean(lock && lock.until > now),
      bedtime,
      frozen: settings.strict && (reason === 'lock' || reason === 'bedtime' || reason === 'limit'),
    };
  }

  // The next moment the answer of status() can change without any write.
  function nextBoundary(state, now = Date.now()) {
    const times = [nextMidnight(now)];
    if (state.lock && state.lock.until > now) times.push(state.lock.until);
    const bed = bedtimeState(state.settings.bedtime, now);
    if (bed.next) times.push(bed.next);
    return Math.min(...times);
  }

  const looserLimit = (from, to) => (to === null ? from !== null : from !== null && to > from);

  function stepLimit(current, dir) {
    // null ("no limit") is itself a step, so search by index rather than value.
    const rank = (v) => (v === null ? Infinity : v);
    if (dir > 0) {
      const i = LIMIT_STEPS.findIndex((v) => rank(v) > rank(current));
      return i === -1 ? current : LIMIT_STEPS[i];
    }
    for (let i = LIMIT_STEPS.length - 1; i >= 0; i--) if (rank(LIMIT_STEPS[i]) < rank(current)) return LIMIT_STEPS[i];
    return current;
  }

  /**
   * Validates a partial settings update and returns the merged result.
   * Throws refusal('strict') when strict mode is holding and the patch would
   * make blocking weaker, refusal('invalid') for malformed input.
   */
  function applySettingsPatch(current, patch, frozen) {
    if (!isObj(patch)) throw refusal('invalid');
    const next = normalizeSettings({
      ...current,
      ...patch,
      sites: { ...current.sites, ...(isObj(patch.sites) ? patch.sites : {}) },
      bedtime: { ...current.bedtime, ...(isObj(patch.bedtime) ? patch.bedtime : {}) },
    });
    if ('limit' in patch && !isLimit(patch.limit)) throw refusal('invalid');
    if (frozen) {
      const loosens =
        looserLimit(current.limit, next.limit) ||
        PLATFORM_IDS.some((id) => current.sites[id] && !next.sites[id]) ||
        (current.strict && !next.strict) ||
        (current.bedtime.on && (!next.bedtime.on || next.bedtime.from !== current.bedtime.from || next.bedtime.to !== current.bedtime.to));
      if (loosens) throw refusal('strict');
    }
    return next;
  }

  /* ---------- stats ---------- */

  function touchDay(stats, now = Date.now()) {
    const key = dayKey(now);
    if (!stats.days[key]) {
      stats.days[key] = emptyDay();
      const keys = Object.keys(stats.days).sort();
      for (let i = 0; i < keys.length - KEEP_DAYS; i++) delete stats.days[keys[i]];
    }
    return stats.days[key];
  }

  function monthTotals(stats, now = Date.now()) {
    const prefix = dayKey(now).slice(0, 8);
    const out = { n: 0, t: 0, b: 0 };
    for (const [k, d] of Object.entries(stats.days)) {
      if (!k.startsWith(prefix)) continue;
      out.n += d.n;
      out.t += d.t;
      out.b += d.b;
    }
    return out;
  }

  // Days in a row (ending today) without trying to go past the daily limit.
  function streak(stats, now = Date.now()) {
    const first = dayKey(stats.since);
    let days = 0;
    for (let i = 0; i < KEEP_DAYS; i++) {
      const k = dayKey(dayStart(now, -i));
      if (k < first || stats.days[k]?.over) break;
      days++;
    }
    return days;
  }

  function series(stats, now = Date.now(), length = 7, endOffset = 0) {
    const out = [];
    for (let i = length - 1; i >= 0; i--) {
      const ts = dayStart(now, -i - endOffset);
      const key = dayKey(ts);
      out.push({ key, ts, n: stats.days[key]?.n || 0, today: i === 0 && endOffset === 0 });
    }
    return out;
  }

  /* ---------- formatting ---------- */

  const fmtNum = (n) => Math.round(n).toLocaleString();

  function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${pad(m)}m`;
    if (m) return `${m}m`;
    return s ? `${s}s` : '0m';
  }

  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function fmtLeft(ms) {
    const mins = Math.max(1, Math.ceil(ms / 60_000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return `${m}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtMinute = (minute) => fmtClock(atMinute(Date.now(), minute, 0));

  // "until 10:45 PM", or "until Tue 10:45 PM" when it isn't today.
  function fmtUntil(ts, now = Date.now()) {
    if (dayKey(ts) === dayKey(now)) return fmtClock(ts);
    const day = new Date(ts).toLocaleDateString([], { weekday: 'short' });
    return `${day} ${fmtClock(ts)}`;
  }

  function fmtLockChip(min) {
    return min < 60 ? `${min}m` : `${min / 60}h`;
  }

  function fmtLockLength(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return m === 1 ? '1 minute' : `${m} minutes`;
    if (!m) return h === 1 ? '1 hour' : `${h} hours`;
    return `${h}h ${m}m`;
  }

  const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

  /* ---------- messaging ---------- */

  async function send(message) {
    try {
      return await ext.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  /* ---------- DOM helpers (popup + lock screen) ---------- */

  // Turns Iblock's own static markup into nodes. Parsed with DOMParser rather
  // than assigned to innerHTML, so no string is ever live HTML in a page.
  function markup(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fragment = document.createDocumentFragment();
    fragment.append(...doc.body.childNodes);
    return fragment;
  }

  // Ending a lock early takes a deliberate press-and-hold, not a reflex click.
  // `button` must contain a `.fill` and a `.label` element.
  function holdButton(button, onDone, duration = HOLD_TO_UNLOCK_MS) {
    const fill = button.querySelector('.fill');
    const label = button.querySelector('.label');
    const idle = label.textContent;
    let started = 0;
    let frame = 0;
    let busy = false;

    function stop() {
      cancelAnimationFrame(frame);
      started = 0;
      if (busy) return;
      fill.style.transform = 'scaleX(0)';
      label.textContent = idle;
    }

    async function finish() {
      started = 0;
      busy = true;
      label.textContent = 'Unlocking…';
      try {
        await onDone();
      } finally {
        busy = false;
        stop();
      }
    }

    function step() {
      const progress = Math.min(1, (performance.now() - started) / duration);
      fill.style.transform = `scaleX(${progress})`;
      if (progress >= 1) {
        finish();
        return;
      }
      label.textContent = `Keep holding… ${Math.ceil(((1 - progress) * duration) / 1000)}s`;
      frame = requestAnimationFrame(step);
    }

    function start() {
      if (started || busy || button.disabled) return;
      started = performance.now();
      frame = requestAnimationFrame(step);
    }

    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      button.setPointerCapture?.(e.pointerId);
      start();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(type, stop);
    button.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        start();
      }
    });
    button.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') stop();
    });
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    return { reset: stop };
  }

  return Object.freeze({
    ext,
    PLATFORMS,
    PLATFORM_IDS,
    HOST_PATTERNS,
    LIMIT_STEPS,
    LOCK_PRESETS,
    MAX_LOCK_MIN,
    HOLD_TO_UNLOCK_MS,
    DEFAULT_SETTINGS,
    refusal,
    hostMatches,
    platformById,
    normalizeSettings,
    normalizeStats,
    normalizeLock,
    normalizeState,
    emptyDay,
    dayKey,
    dayStart,
    nextMidnight,
    bedtimeState,
    status,
    nextBoundary,
    looserLimit,
    stepLimit,
    applySettingsPatch,
    touchDay,
    monthTotals,
    streak,
    series,
    fmtNum,
    fmtDuration,
    fmtCountdown,
    fmtLeft,
    fmtClock,
    fmtMinute,
    fmtUntil,
    fmtLockChip,
    fmtLockLength,
    plural,
    send,
    markup,
    holdButton,
  });
})();
