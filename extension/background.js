/*
 * Iblock background. The single writer of stats, lock, settings and the
 * password: every change goes through one serial queue so scrolls counted
 * from many tabs at once can never overwrite each other. It also keeps the
 * toolbar badge fresh, hands out badges and sends the weekly report.
 *
 * Chrome runs this as a service worker (shared.js comes in via importScripts);
 * Firefox runs it as an event page with shared.js listed before it.
 */
if (typeof importScripts === 'function' && !globalThis.Iblock) importScripts('shared.js');

const { ext } = Iblock;
const KEYS = ['settings', 'stats', 'lock', 'guard', 'seen'];
const BOUNDARY_ALARM = 'iblock-boundary';
const WEEKLY_ALARM = 'iblock-weekly';
const BADGE_IDLE = '#3A3A3D';
const BADGE_BLOCKED = '#E8521C';
const LOCK_DONE_MIN = 60; // shortest lock that earns "Saw it through"

let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function load() {
  return Iblock.normalizeState(await ext.storage.local.get(KEYS));
}

const saveStats = (state) => ext.storage.local.set({ stats: state.stats });

function assertPlatform(id) {
  if (!Iblock.PLATFORM_IDS.includes(id)) throw Iblock.refusal('invalid');
}

function bump(map, id, by = 1) {
  map[id] = (map[id] || 0) + by;
}

function recordBlock(stats, day, reason) {
  day.b += 1;
  stats.life.b += 1;
  if (reason === 'limit' || reason === 'off') day.over = true;
}

/* ---------- password lock ---------- */

const encoder = new TextEncoder();
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 200_000 },
    key,
    256,
  );
  return toHex(bits);
}

// Throws unless there's no password lock, or `password` opens it.
async function requirePassword(state, password) {
  if (!state.guard) return;
  if (typeof password !== 'string' || !password) throw Iblock.refusal('password');
  if ((await hashPassword(password, state.guard.salt)) !== state.guard.hash) throw Iblock.refusal('wrong-password');
}

/* ---------- badges & notifications ---------- */

function notify(title, message) {
  if (!ext.notifications) return;
  Promise.resolve(
    ext.notifications.create(`iblock-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('assets/icons/icon-128.png'),
      title,
      message,
    }),
  ).catch(() => {});
}

// Marks badges as earned; returns the ones that are new. Caller saves stats.
function award(state, ids, now) {
  const fresh = ids.filter((id) => !state.stats.badges[id]);
  for (const id of fresh) state.stats.badges[id] = now;
  return fresh;
}

function celebrate(state, ids) {
  if (!state.settings.notify) return;
  for (const id of ids) {
    const badge = Iblock.BADGES.find((b) => b.id === id);
    if (badge) notify(`Badge unlocked: ${badge.title}`, badge.desc);
  }
}

/* ---------- messages ---------- */

const handlers = {
  // A new short appeared on screen. A short already counted today is free
  // (scrolling back up isn't another scroll), even at the limit; otherwise it
  // either fits in today's allowance and is counted, or is recorded as blocked.
  async count({ platform, key }) {
    assertPlatform(platform);
    const state = await load();
    if (!state.settings.sites[platform]) return { allowed: true, ignored: true };
    const now = Date.now();
    const st = Iblock.status(state, now);
    const day = Iblock.touchDay(state.stats, now);
    const id = typeof key === 'string' && key && key.length <= 40 ? `${platform}:${key}` : null;
    const seen = Iblock.seenToday(state.seen, now);
    if (id && seen.includes(id) && (!st.reason || st.reason === 'limit')) return { allowed: true, repeat: true, total: day.n };
    if (st.reason) {
      recordBlock(state.stats, day, st.reason);
      const fresh = award(state, Iblock.pendingBadges(state.stats, now), now);
      await saveStats(state);
      celebrate(state, fresh);
      return { allowed: false, reason: st.reason };
    }
    day.n += 1;
    bump(day.p, platform);
    bump(day.h, String(new Date(now).getHours()));
    state.stats.life.n += 1;
    bump(state.stats.life.p, platform);
    if (id) seen.push(id);
    await ext.storage.local.set({ stats: state.stats, seen: { day: Iblock.dayKey(now), keys: seen.slice(-Iblock.MAX_SEEN) } });
    return { allowed: true, total: day.n };
  },

  // The content script already knew short-form was blocked and showed the
  // lock screen for a new short; just record it.
  async blocked({ platform }) {
    assertPlatform(platform);
    const state = await load();
    if (!state.settings.sites[platform]) return { ok: true };
    const now = Date.now();
    const st = Iblock.status(state, now);
    if (!st.reason) return { ok: true, stale: true };
    recordBlock(state.stats, Iblock.touchDay(state.stats, now), st.reason);
    const fresh = award(state, Iblock.pendingBadges(state.stats, now), now);
    await saveStats(state);
    celebrate(state, fresh);
    return { ok: true };
  },

  async time({ platform, seconds }) {
    assertPlatform(platform);
    const sec = Math.min(300, Math.round(Number(seconds)));
    if (!(sec > 0)) return { ok: true };
    const state = await load();
    const day = Iblock.touchDay(state.stats);
    day.t += sec;
    bump(day.tp, platform, sec);
    state.stats.life.t += sec;
    bump(state.stats.life.tp, platform, sec);
    await saveStats(state);
    return { ok: true };
  },

  // Start a lock, or extend the running one. A new lock never shortens one
  // that is already running.
  async lock({ minutes, extend }) {
    const min = Number(minutes);
    if (!Number.isFinite(min) || min < 1 || min > Iblock.MAX_LOCK_MIN) throw Iblock.refusal('invalid');
    const state = await load();
    const now = Date.now();
    const running = state.lock && state.lock.until > now ? state.lock : null;
    const cap = now + Iblock.MAX_LOCK_MIN * 60_000;
    const target = extend && running ? running.until + min * 60_000 : now + min * 60_000;
    const lock = {
      start: running ? running.start : now,
      until: Math.min(cap, Math.max(target, running ? running.until : 0)),
    };
    const fresh = award(state, ['firstLock'], now);
    await ext.storage.local.set(fresh.length ? { lock, stats: state.stats } : { lock });
    celebrate(state, fresh);
    return { ok: true, lock };
  },

  async unlock({ password }) {
    const state = await load();
    if (state.lock && state.lock.until > Date.now()) {
      if (state.settings.strict) throw Iblock.refusal('strict');
      await requirePassword(state, password);
    }
    await ext.storage.local.set({ lock: null });
    return { ok: true };
  },

  async settings({ patch, password }) {
    const state = await load();
    const next = Iblock.applySettingsPatch(state.settings, patch, Iblock.status(state).frozen);
    if (Iblock.loosens(state.settings, next)) await requirePassword(state, password);
    await ext.storage.local.set({ settings: next });
    return { ok: true, settings: next };
  },

  // Once a day, after hitting the limit, a few more scrolls.
  async bonus({ password }) {
    const state = await load();
    const now = Date.now();
    const st = Iblock.status(state, now);
    if (st.frozen) throw Iblock.refusal('strict');
    if (!st.canBonus) throw Iblock.refusal('invalid');
    await requirePassword(state, password);
    Iblock.touchDay(state.stats, now).bonus = Iblock.BONUS_SCROLLS;
    await saveStats(state);
    return { ok: true };
  },

  // Set, change or (with an empty `password`) remove the password lock.
  async password({ password, current }) {
    const state = await load();
    await requirePassword(state, current);
    if (password === '') {
      await ext.storage.local.set({ guard: null });
      return { ok: true, locked: false };
    }
    if (typeof password !== 'string' || password.length < 4 || password.length > 200) throw Iblock.refusal('invalid');
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    await ext.storage.local.set({ guard: { salt, hash: await hashPassword(password, salt) } });
    return { ok: true, locked: true };
  },

  async reset({ password }) {
    const state = await load();
    if (Iblock.status(state).frozen) throw Iblock.refusal('strict');
    await requirePassword(state, password);
    await ext.storage.local.set({ stats: Iblock.normalizeStats({ since: Date.now() }), seen: null });
    return { ok: true };
  },

  async closeTab(_msg, sender) {
    const id = sender?.tab?.id;
    if (typeof id === 'number') await ext.tabs.remove(id);
    return { ok: true };
  },
};

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== ext.runtime.id) return false;
  const type = msg && typeof msg.type === 'string' ? msg.type : '';
  if (!Object.hasOwn(handlers, type)) return false;
  serial(() => handlers[type](msg, sender)).then(
    (result) => sendResponse(result ?? { ok: true }),
    (err) => sendResponse({ ok: false, error: err?.code || 'error' }),
  );
  return true;
});

/* ---------- badge, boundaries, weekly report ---------- */

function badgeTitle(st, now) {
  switch (st.reason) {
    case 'lock':
      return `Iblock: locked until ${Iblock.fmtUntil(st.until, now)}`;
    case 'bedtime':
      return `Iblock: bedtime until ${Iblock.fmtUntil(st.until, now)}`;
    case 'off':
      return 'Iblock: short-form is blocked';
    case 'limit':
      return `Iblock: daily limit reached (${st.today.n} scrolls)`;
    case 'time':
      return `Iblock: daily time limit reached (${Iblock.fmtDuration(st.today.t)})`;
    default:
      return st.allowance === null
        ? `Iblock: ${Iblock.plural(st.today.n, 'scroll', 'scrolls')} today`
        : `Iblock: ${st.today.n} of ${st.allowance} scrolls today`;
  }
}

async function refresh() {
  const state = await load();
  const now = Date.now();

  // A lock that ran out by itself was seen through.
  if (state.lock && state.lock.until <= now) {
    const long = state.lock.until - state.lock.start >= LOCK_DONE_MIN * 60_000;
    const fresh = long ? award(state, ['lockDone'], now) : [];
    state.lock = null;
    await ext.storage.local.set({ lock: null, stats: state.stats });
    celebrate(state, fresh);
  }
  const earned = award(state, Iblock.pendingBadges(state.stats, now), now);
  if (earned.length) {
    await saveStats(state);
    celebrate(state, earned);
  }

  const st = Iblock.status(state, now);
  const n = st.today.n;
  const action = ext.action;
  await Promise.allSettled([
    action.setBadgeText({ text: state.settings.badge && n > 0 ? (n > 999 ? '999+' : String(n)) : '' }),
    action.setBadgeBackgroundColor({ color: st.reason ? BADGE_BLOCKED : BADGE_IDLE }),
    action.setBadgeTextColor?.({ color: '#FFFFFF' }),
    action.setTitle({ title: badgeTitle(st, now) }),
  ]);
  // Wake up again when things change on their own (midnight, lock end, bedtime).
  await ext.alarms.create(BOUNDARY_ALARM, { when: Math.max(now + 1000, Iblock.nextBoundary(state, now) + 500) });
  if (!(await ext.alarms.get(WEEKLY_ALARM))) await ext.alarms.create(WEEKLY_ALARM, { when: Iblock.nextWeeklyReport(now) });
}

async function weeklyReport() {
  const state = await load();
  const now = Date.now();
  const today = Iblock.dayKey(now);
  if (state.settings.notify && state.stats.reported !== today) {
    const { thisWeek, pct } = Iblock.weekSummary(state.stats, now);
    const trend =
      pct === null ? '' : pct < 0 ? ` That's ${-pct}% less than last week.` : pct > 0 ? ` That's ${pct}% more than last week.` : ' Same as last week.';
    notify(
      'Your week with Iblock',
      `${Iblock.plural(thisWeek.n, 'short', 'shorts')} and ${Iblock.fmtDuration(thisWeek.t)} on short-form in the last 7 days.${trend}`,
    );
    state.stats.reported = today;
    await saveStats(state);
  }
  await ext.alarms.create(WEEKLY_ALARM, { when: Iblock.nextWeeklyReport(now) });
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => serial(refresh).catch(() => {}), 50);
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && KEYS.some((k) => k in changes)) scheduleRefresh();
});
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BOUNDARY_ALARM) scheduleRefresh();
  if (alarm.name === WEEKLY_ALARM) serial(weeklyReport).catch(() => {});
});
ext.runtime.onStartup.addListener(scheduleRefresh);
ext.notifications?.onClicked.addListener((id) => {
  ext.tabs.create({ url: ext.runtime.getURL('popup/popup.html#insights') });
  ext.notifications.clear(id);
});

/* ---------- install ---------- */

// Chrome doesn't inject content scripts into tabs that were already open, so
// do it once on install/update. Firefox does this by itself.
async function injectIntoOpenTabs() {
  if (!ext.scripting || !ext.runtime.getURL('').startsWith('chrome-extension:')) return;
  const script = ext.runtime.getManifest().content_scripts?.[0];
  if (!script) return;
  const tabs = await ext.tabs.query({ url: script.matches });
  await Promise.allSettled(
    tabs.map((tab) => ext.scripting.executeScript({ target: { tabId: tab.id }, files: script.js })),
  );
}

ext.runtime.onInstalled.addListener(({ reason }) => {
  serial(async () => {
    // Re-save normalised data so the stored shape is always current.
    const state = await load();
    await ext.storage.local.set(state);
    await refresh();
  }).catch(() => {});
  injectIntoOpenTabs().catch(() => {});
  if (reason === 'install') ext.tabs.create({ url: ext.runtime.getURL('welcome/welcome.html') });
});
