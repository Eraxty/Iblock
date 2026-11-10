/*
 * Iblock core: constants, the storage schema and the rules that decide when
 * short-form is blocked. Loaded by the background worker, every content
 * script, the popup and the welcome page. Only markup() and holdButton()
 * touch the DOM, and the background never calls them.
 */
globalThis.Iblock = (() => {
  'use strict';

  const ext = globalThis.browser ?? globalThis.chrome;

  // kind "short": short-form video, counted one short at a time.
  // kind "feed": an endless feed. Locked whenever short-form is, and its time
  // counts toward the time limit, but there are no shorts to count.
  const PLATFORMS = Object.freeze([
    { id: 'youtube', kind: 'short', name: 'YouTube Shorts', label: 'YouTube', hosts: ['youtube.com'], where: 'youtube.com/shorts', home: 'https://www.youtube.com/' },
    { id: 'instagram', kind: 'short', name: 'Instagram Reels', label: 'Instagram', hosts: ['instagram.com'], where: 'Home feed, Reels and Explore', home: null },
    { id: 'tiktok', kind: 'short', name: 'TikTok', label: 'TikTok', hosts: ['tiktok.com'], where: 'All of tiktok.com', home: null },
    { id: 'snapchat', kind: 'short', name: 'Snapchat Spotlight', label: 'Snapchat', hosts: ['snapchat.com'], where: 'snapchat.com/spotlight', home: 'https://www.snapchat.com/' },
    { id: 'facebook', kind: 'short', name: 'Facebook Reels', label: 'Facebook', hosts: ['facebook.com'], where: 'facebook.com/reel', home: 'https://www.facebook.com/' },
    { id: 'x', kind: 'feed', name: 'X', label: 'X', hosts: ['x.com', 'twitter.com'], where: 'Home and Explore feeds', home: null },
    { id: 'reddit', kind: 'feed', name: 'Reddit', label: 'Reddit', hosts: ['reddit.com'], where: 'Home, Popular and All', home: null },
    { id: 'pinterest', kind: 'feed', name: 'Pinterest', label: 'Pinterest', hosts: ['pinterest.com'], where: 'Home feed and Ideas', home: null },
  ]);
  const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
  const SHORT_PLATFORMS = PLATFORMS.filter((p) => p.kind === 'short');
  const HOST_PATTERNS = PLATFORMS.flatMap((p) => p.hosts.map((h) => `*://*.${h}/*`));

  // Scroll limit: null means "no limit, just count"; 0 means always blocked.
  const LIMIT_STEPS = Object.freeze([0, 3, 5, 10, 15, 20, 30, 50, 100, null]);
  // Time limit in minutes per day: null means none.
  const TIME_STEPS = Object.freeze([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, null]);
  const LOCK_PRESETS = Object.freeze([30, 60, 180, 300]);
  const MAX_LOCK_MIN = 7 * 1440;
  const HOLD_TO_UNLOCK_MS = 10_000;
  const HOLD_FOR_BONUS_MS = 5_000;
  const BONUS_SCROLLS = 3;
  const PAUSE_SECONDS = 5;
  const PAUSE_GRACE_MS = 15 * 60_000;
  const KEEP_DAYS = 400;
  const MAX_SEEN = 1000; // shorts remembered per day, so scrolling back doesn't count again
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const THEMES = ['system', 'light', 'dark'];

  const DEFAULT_SETTINGS = Object.freeze({
    limit: 10,
    minutes: null,
    sites: Object.freeze(Object.fromEntries(PLATFORMS.map((p) => [p.id, p.kind === 'short']))),
    bedtime: Object.freeze({ on: false, from: 23 * 60, to: 7 * 60 }),
    pause: true,
    gray: false,
    noAutoplay: false,
    ytPlayer: false,
    ytFeed: false,
    strict: false,
    hud: true,
    hide: true,
    badge: true,
    notify: true,
    theme: 'system',
  });

  // Turning one of these off makes short-form easier to reach.
  const PROTECTIVE = ['pause', 'gray', 'noAutoplay', 'ytPlayer', 'ytFeed', 'hide', 'strict'];

  const BADGES = Object.freeze([
    { id: 'firstLock', title: 'First break', desc: 'Started your first lock' },
    { id: 'lockDone', title: 'Saw it through', desc: 'Finished a lock of an hour or more' },
    { id: 'zeroDay', title: 'Zero day', desc: 'A whole day with no short-form' },
    { id: 'streak3', title: '3 days', desc: '3 days in a row under your limit', streak: 3 },
    { id: 'streak7', title: 'One week', desc: 'A week in a row under your limit', streak: 7 },
    { id: 'streak30', title: '30 days', desc: 'A month in a row under your limit', streak: 30 },
    { id: 'streak100', title: '100 days', desc: '100 days in a row under your limit', streak: 100 },
    { id: 'blocked100', title: '100 blocked', desc: 'Iblock stopped 100 shorts', blocked: 100 },
    { id: 'blocked1000', title: '1,000 blocked', desc: 'Iblock stopped 1,000 shorts', blocked: 1000 },
  ]);
  const BADGE_IDS = BADGES.map((b) => b.id);

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const isMinute = (v) => Number.isInteger(v) && v >= 0 && v < 1440;
  const isLimit = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10_000);
  const isTimeLimit = (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 1440);

  function refusal(code) {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  function hostMatches(hostname, host) {
    return hostname === host || hostname.endsWith(`.${host}`);
  }

  const platformById = (id) => PLATFORMS.find((p) => p.id === id) || null;
  const platformForHost = (hostname) => PLATFORMS.find((p) => p.hosts.some((h) => hostMatches(hostname, h))) || null;

  /* ---------- schema ---------- */

  function normalizeSettings(raw) {
    const s = isObj(raw) ? raw : {};
    const d = DEFAULT_SETTINGS;
    const sites = {};
    for (const id of PLATFORM_IDS) sites[id] = bool(isObj(s.sites) ? s.sites[id] : undefined, d.sites[id]);
    const bt = isObj(s.bedtime) ? s.bedtime : {};
    const out = {
      limit: s.limit !== undefined && isLimit(s.limit) ? s.limit : d.limit,
      minutes: s.minutes !== undefined && isTimeLimit(s.minutes) ? s.minutes : d.minutes,
      sites,
      bedtime: {
        on: bool(bt.on, d.bedtime.on),
        from: isMinute(bt.from) ? bt.from : d.bedtime.from,
        to: isMinute(bt.to) ? bt.to : d.bedtime.to,
      },
      theme: THEMES.includes(s.theme) ? s.theme : d.theme,
    };
    for (const key of ['pause', 'gray', 'noAutoplay', 'ytPlayer', 'ytFeed', 'strict', 'hud', 'hide', 'badge', 'notify']) {
      out[key] = bool(s[key], d[key]);
    }
    return out;
  }

  function counts(raw, keys = PLATFORM_IDS) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const k of keys) if (count(raw[k])) out[k] = count(raw[k]);
    return out;
  }

  const HOURS = Array.from({ length: 24 }, (_, h) => String(h));

  // n = scrolls, t = seconds watched, b = shorts blocked, over = tried to go
  // past the limit, p/tp = per app, h = scrolls per hour, bonus = extra scrolls
  function emptyDay() {
    return { n: 0, t: 0, b: 0, over: false, p: {}, tp: {}, h: {}, bonus: 0 };
  }

  function normalizeDay(raw) {
    const d = isObj(raw) ? raw : {};
    return {
      n: count(d.n),
      t: count(d.t),
      b: count(d.b),
      over: d.over === true,
      p: counts(d.p),
      tp: counts(d.tp),
      h: counts(d.h, HOURS),
      bonus: count(d.bonus),
    };
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
      badges: counts(s.badges, BADGE_IDS),
      reported: typeof s.reported === 'string' && DAY_RE.test(s.reported) ? s.reported : '',
    };
  }

  function normalizeLock(raw) {
    if (!isObj(raw)) return null;
    const { start, until } = raw;
    return Number.isFinite(start) && Number.isFinite(until) && until > start ? { start, until } : null;
  }

  function normalizeGuard(raw) {
    if (!isObj(raw)) return null;
    const { salt, hash } = raw;
    return typeof salt === 'string' && typeof hash === 'string' && salt && hash ? { salt, hash } : null;
  }

  // Today's already-counted shorts, as "platform:hash" ids.
  function normalizeSeen(raw) {
    const s = isObj(raw) ? raw : {};
    const keys = Array.isArray(s.keys) ? s.keys.filter((k) => typeof k === 'string' && k.length <= 64).slice(-MAX_SEEN) : [];
    return { day: typeof s.day === 'string' && DAY_RE.test(s.day) ? s.day : '', keys };
  }

  function normalizeState(raw) {
    const r = isObj(raw) ? raw : {};
    return {
      settings: normalizeSettings(r.settings),
      stats: normalizeStats(r.stats),
      lock: normalizeLock(r.lock),
      guard: normalizeGuard(r.guard),
      seen: normalizeSeen(r.seen),
    };
  }

  // A short, fixed-size stand-in for a short's id or video URL (FNV-1a).
  function hashKey(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  const countId = (platform, item) => `${platform}:${hashKey(item)}`;

  // The shorts already counted today (empty once the day has turned over).
  function seenToday(seen, now = Date.now()) {
    return seen.day === dayKey(now) ? seen.keys.slice() : [];
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

  // Sunday 19:00, the next time it comes round.
  function nextWeeklyReport(now = Date.now()) {
    const d = new Date(now);
    const toSunday = (7 - d.getDay()) % 7;
    const at = (offset) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 19, 0).getTime();
    return at(toSunday) > now ? at(toSunday) : at(toSunday + 7);
  }

  /* ---------- rules ---------- */

  /**
   * Everything the UI needs to know about "right now".
   * reason: why short-form is blocked (lock > bedtime > off > limit > time), or null.
   * frozen: strict mode forbids loosening settings while this is true.
   */
  function status(state, now = Date.now()) {
    const { settings, stats, lock } = state;
    const key = dayKey(now);
    const today = stats.days[key] || emptyDay();
    const { limit, minutes } = settings;
    const allowance = limit === null ? null : limit > 0 ? limit + today.bonus : 0;
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
    } else if (allowance !== null && today.n >= allowance) {
      reason = 'limit';
      until = nextMidnight(now);
    } else if (minutes !== null && today.t >= minutes * 60) {
      reason = 'time';
      until = nextMidnight(now);
    }
    const frozen = settings.strict && ['lock', 'bedtime', 'limit', 'time'].includes(reason);
    return {
      reason,
      until,
      key,
      today,
      limit,
      allowance,
      left: allowance === null ? null : Math.max(0, allowance - today.n),
      minutes,
      secondsLeft: minutes === null ? null : Math.max(0, minutes * 60 - today.t),
      locked: Boolean(lock && lock.until > now),
      bedtime,
      frozen,
      canBonus: reason === 'limit' && limit > 0 && !today.bonus && !frozen,
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

  // For limits where null means "unlimited": is `to` more permissive than `from`?
  const looserLimit = (from, to) => (to === null ? from !== null : from !== null && to > from);

  function step(steps, current, dir) {
    // null ("no limit") is itself a step, so search by index rather than value.
    const rank = (v) => (v === null ? Infinity : v);
    if (dir > 0) {
      const i = steps.findIndex((v) => rank(v) > rank(current));
      return i === -1 ? current : steps[i];
    }
    for (let i = steps.length - 1; i >= 0; i--) if (rank(steps[i]) < rank(current)) return steps[i];
    return current;
  }

  const stepLimit = (current, dir) => step(LIMIT_STEPS, current, dir);
  const stepMinutes = (current, dir) => step(TIME_STEPS, current, dir);

  // Would going from `current` to `next` make short-form easier to get to?
  function loosens(current, next) {
    return (
      looserLimit(current.limit, next.limit) ||
      looserLimit(current.minutes, next.minutes) ||
      PLATFORM_IDS.some((id) => current.sites[id] && !next.sites[id]) ||
      PROTECTIVE.some((key) => current[key] && !next[key]) ||
      (current.bedtime.on && (!next.bedtime.on || next.bedtime.from !== current.bedtime.from || next.bedtime.to !== current.bedtime.to))
    );
  }

  /**
   * Validates a partial settings update and returns the merged result.
   * Throws refusal('strict') when strict mode is holding and the patch would
   * make blocking weaker, refusal('invalid') for malformed input.
   */
  function applySettingsPatch(current, patch, frozen) {
    if (!isObj(patch)) throw refusal('invalid');
    if ('limit' in patch && !isLimit(patch.limit)) throw refusal('invalid');
    if ('minutes' in patch && !isTimeLimit(patch.minutes)) throw refusal('invalid');
    const next = normalizeSettings({
      ...current,
      ...patch,
      sites: { ...current.sites, ...(isObj(patch.sites) ? patch.sites : {}) },
      bedtime: { ...current.bedtime, ...(isObj(patch.bedtime) ? patch.bedtime : {}) },
    });
    if (frozen && loosens(current, next)) throw refusal('strict');
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

  // Days in a row (ending on the day of `now`) without trying to go past the limit.
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

  // This week (the last 7 days) against the 7 before. pct is null when last
  // week isn't a fair comparison (not tracked yet, or nothing to compare to).
  function weekSummary(stats, now = Date.now()) {
    const total = (days) =>
      days.reduce(
        (acc, d) => {
          const r = stats.days[d.key];
          acc.n += r?.n || 0;
          acc.t += r?.t || 0;
          acc.b += r?.b || 0;
          return acc;
        },
        { n: 0, t: 0, b: 0 },
      );
    const prev = series(stats, now, 7, 7);
    const thisWeek = total(series(stats, now, 7));
    const lastWeek = total(prev);
    const fair = stats.since <= prev[0].ts && lastWeek.n > 0;
    return { thisWeek, lastWeek, pct: fair ? Math.round(((thisWeek.n - lastWeek.n) / lastWeek.n) * 100) : null };
  }

  // Scrolls per hour of the day over the last `days` days.
  function hourTotals(stats, now = Date.now(), days = 30) {
    const out = new Array(24).fill(0);
    for (const d of series(stats, now, days)) {
      const h = stats.days[d.key]?.h;
      if (h) for (const [hour, n] of Object.entries(h)) out[Number(hour)] += n;
    }
    return out;
  }

  function hadZeroDay(stats, now) {
    const first = dayKey(stats.since);
    for (let i = 1; i <= 60; i++) {
      const k = dayKey(dayStart(now, -i));
      if (k <= first) return false; // the install day was never a full day
      const d = stats.days[k];
      if (!d || (d.n === 0 && d.t === 0)) return true;
    }
    return false;
  }

  // Badges earned by the numbers alone (the lock ones are awarded as they happen).
  function pendingBadges(stats, now = Date.now()) {
    const run = streak(stats, dayStart(now) - 1); // completed days only
    return BADGES.filter(
      (b) =>
        !stats.badges[b.id] &&
        ((b.streak && run >= b.streak) || (b.blocked && stats.life.b >= b.blocked) || (b.id === 'zeroDay' && hadZeroDay(stats, now))),
    ).map((b) => b.id);
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
  const fmtHour = (hour) => new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });

  // "10:45 PM", or "Tue 10:45 PM" when it isn't today.
  function fmtUntil(ts, now = Date.now()) {
    if (dayKey(ts) === dayKey(now)) return fmtClock(ts);
    const day = new Date(ts).toLocaleDateString([], { weekday: 'short' });
    return `${day} ${fmtClock(ts)}`;
  }

  function fmtLockChip(min) {
    return min < 60 ? `${min}m` : `${min / 60}h`;
  }

  // A length in minutes: "30 minutes", "1 hour", "2h 30m".
  function fmtLength(min) {
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

  /* ---------- DOM helpers (popup, welcome page, lock screen) ---------- */

  // Turns Iblock's own static markup into nodes. Parsed with DOMParser rather
  // than assigned to innerHTML, so no string is ever live HTML in a page.
  function markup(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fragment = document.createDocumentFragment();
    fragment.append(...doc.body.childNodes);
    return fragment;
  }

  // A deliberate press-and-hold instead of a reflex click.
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
      label.textContent = 'One moment…';
      try {
        await onDone();
      } finally {
        busy = false;
        stop();
      }
    }

    function frameStep() {
      const progress = Math.min(1, (performance.now() - started) / duration);
      fill.style.transform = `scaleX(${progress})`;
      if (progress >= 1) {
        finish();
        return;
      }
      label.textContent = `Keep holding… ${Math.ceil(((1 - progress) * duration) / 1000)}s`;
      frame = requestAnimationFrame(frameStep);
    }

    function start() {
      if (started || busy || button.disabled) return;
      started = performance.now();
      frame = requestAnimationFrame(frameStep);
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
    SHORT_PLATFORMS,
    HOST_PATTERNS,
    LIMIT_STEPS,
    TIME_STEPS,
    LOCK_PRESETS,
    MAX_LOCK_MIN,
    HOLD_TO_UNLOCK_MS,
    HOLD_FOR_BONUS_MS,
    BONUS_SCROLLS,
    PAUSE_SECONDS,
    PAUSE_GRACE_MS,
    MAX_SEEN,
    DEFAULT_SETTINGS,
    BADGES,
    refusal,
    hostMatches,
    platformById,
    platformForHost,
    normalizeSettings,
    normalizeStats,
    normalizeLock,
    normalizeGuard,
    normalizeSeen,
    normalizeState,
    hashKey,
    countId,
    seenToday,
    emptyDay,
    dayKey,
    dayStart,
    nextMidnight,
    bedtimeState,
    nextWeeklyReport,
    status,
    nextBoundary,
    looserLimit,
    stepLimit,
    stepMinutes,
    loosens,
    applySettingsPatch,
    touchDay,
    monthTotals,
    streak,
    series,
    weekSummary,
    hourTotals,
    pendingBadges,
    fmtNum,
    fmtDuration,
    fmtCountdown,
    fmtLeft,
    fmtClock,
    fmtMinute,
    fmtHour,
    fmtUntil,
    fmtLockChip,
    fmtLength,
    plural,
    send,
    markup,
    holdButton,
  });
})();
