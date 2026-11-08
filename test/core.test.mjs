// Unit tests for the rules (shared.js) and the background message handlers,
// run in Node against an in-memory fake of the extension APIs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const EXT = path.resolve(import.meta.dirname, '../extension');
const read = (file) => fs.readFileSync(path.join(EXT, file), 'utf8');

const HOUR = 3600e3;
const MIN = 60e3;
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 2, 10 + dayOffset, h, m).getTime();

function loadShared() {
  const ctx = vm.createContext({ console });
  vm.runInContext(read('shared.js'), ctx, { filename: 'shared.js' });
  return ctx.Iblock;
}

function fakeBrowser() {
  const store = {};
  const hooks = { message: [], changed: [], alarm: [], installed: [], startup: [] };
  const event = (list) => ({ addListener: (fn) => list.push(fn), removeListener: () => {} });
  const badge = { text: '', title: '', color: '' };
  const closed = [];
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const chrome = {
    runtime: {
      id: 'iblock-test',
      onMessage: event(hooks.message),
      onInstalled: event(hooks.installed),
      onStartup: event(hooks.startup),
      getURL: (p) => `moz-extension://iblock-test/${p}`,
      getManifest: () => ({ version: '1.0.0', content_scripts: [] }),
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(items) {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
            store[k] = clone(v);
          }
          setTimeout(() => hooks.changed.forEach((fn) => fn(changes, 'local')));
        },
      },
      onChanged: event(hooks.changed),
    },
    alarms: { create: async () => {}, onAlarm: event(hooks.alarm) },
    action: {
      setBadgeText: async ({ text }) => void (badge.text = text),
      setBadgeBackgroundColor: async ({ color }) => void (badge.color = color),
      setBadgeTextColor: async () => {},
      setTitle: async ({ title }) => void (badge.title = title),
    },
    tabs: { remove: async (id) => void closed.push(id), query: async () => [] },
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, structuredClone });
  ctx.importScripts = (file) => vm.runInContext(read(file), ctx, { filename: file });
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });

  const sender = { id: 'iblock-test', tab: { id: 7 } };
  const send = (msg, from = sender) =>
    new Promise((resolve) => {
      const handled = hooks.message[0](msg, from, resolve);
      if (handled !== true) resolve(undefined);
    });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  return { store, send, badge, closed, settle, I: ctx.Iblock };
}

/* ---------------- rules ---------------- */

describe('bedtime', () => {
  const I = loadShared();
  const night = { on: true, from: 23 * 60, to: 7 * 60 };

  test('overnight window is active late and early, with the right end time', () => {
    const late = I.bedtimeState(night, at(23, 30));
    assert.equal(late.active, true);
    assert.equal(late.until, at(7, 0, 1));
    const early = I.bedtimeState(night, at(6, 59));
    assert.equal(early.active, true);
    assert.equal(early.until, at(7, 0));
  });

  test('outside the window it reports when the next one starts', () => {
    const s = I.bedtimeState(night, at(7, 0));
    assert.equal(s.active, false);
    assert.equal(s.next, at(23, 0));
  });

  test('same-day windows and switched-off bedtime', () => {
    const nap = { on: true, from: 13 * 60, to: 15 * 60 };
    assert.equal(I.bedtimeState(nap, at(14)).active, true);
    assert.equal(I.bedtimeState(nap, at(15)).active, false);
    assert.equal(I.bedtimeState({ ...night, on: false }, at(23, 30)).active, false);
    assert.equal(I.bedtimeState({ on: true, from: 600, to: 600 }, at(10)).active, false);
  });
});

describe('status', () => {
  const I = loadShared();
  const make = (settings, n = 0, lock = null) => {
    const stats = I.normalizeStats({ since: at(0, 0, -30) });
    stats.days[I.dayKey(at(12))] = { ...I.emptyDay(), n };
    return { settings: I.normalizeSettings(settings), stats, lock };
  };

  test('blocks for the right reason, in priority order', () => {
    const now = at(23, 30);
    const lock = { start: now - HOUR, until: now + HOUR };
    const all = { limit: 0, bedtime: { on: true, from: 1380, to: 420 } };
    assert.equal(I.status(make(all, 0, lock), now).reason, 'lock');
    assert.equal(I.status(make(all), now).reason, 'bedtime');
    assert.equal(I.status(make({ limit: 0 }), now).reason, 'off');
    assert.equal(I.status(make({ limit: 5 }, 5), at(12)).reason, 'limit');
    assert.equal(I.status(make({ limit: 5 }, 4), at(12)).reason, null);
    assert.equal(I.status(make({ limit: null }, 999), at(12)).reason, null);
  });

  test('an expired lock no longer counts', () => {
    const now = at(12);
    assert.equal(I.status(make({}, 0, { start: now - 2 * HOUR, until: now - 1 }), now).reason, null);
  });

  test('limit resets at midnight and reports how many are left', () => {
    const st = I.status(make({ limit: 10 }, 7), at(12));
    assert.equal(st.left, 3);
    assert.equal(I.status(make({ limit: 10 }, 12), at(12)).until, at(0, 0, 1));
    assert.equal(I.status(make({ limit: 10 }, 12), at(0, 5, 1)).reason, null);
  });

  test('strict mode freezes settings only while something is holding', () => {
    assert.equal(I.status(make({ strict: true, limit: 3 }, 3), at(12)).frozen, true);
    assert.equal(I.status(make({ strict: true, limit: 3 }, 1), at(12)).frozen, false);
    assert.equal(I.status(make({ strict: false, limit: 3 }, 3), at(12)).frozen, false);
    // "Blocked completely" never traps you in strict mode.
    assert.equal(I.status(make({ strict: true, limit: 0 }), at(12)).frozen, false);
  });

  test('next boundary is the soonest of midnight, lock end and bedtime', () => {
    const now = at(12);
    const state = make({ bedtime: { on: true, from: 22 * 60, to: 6 * 60 } }, 0, { start: now, until: now + 30 * MIN });
    assert.equal(I.nextBoundary(state, now), now + 30 * MIN);
    assert.equal(I.nextBoundary(make({ bedtime: { on: true, from: 22 * 60, to: 360 } }), now), at(22));
    assert.equal(I.nextBoundary(make({}), now), at(0, 0, 1));
  });
});

describe('settings', () => {
  const I = loadShared();
  const base = I.normalizeSettings({ limit: 10 });

  test('garbage in storage falls back to defaults', () => {
    const s = I.normalizeSettings({ limit: -4, sites: { youtube: 'yes' }, theme: 'purple', bedtime: { from: 9999 } });
    assert.equal(s.limit, 10);
    assert.equal(s.sites.youtube, true);
    assert.equal(s.theme, 'system');
    assert.equal(s.bedtime.from, 23 * 60);
    assert.equal(I.normalizeSettings({ limit: null }).limit, null);
    assert.equal(I.normalizeSettings(null).limit, 10);
  });

  test('stepping through limits', () => {
    assert.equal(I.stepLimit(10, 1), 15);
    assert.equal(I.stepLimit(10, -1), 5);
    assert.equal(I.stepLimit(100, 1), null);
    assert.equal(I.stepLimit(null, 1), null);
    assert.equal(I.stepLimit(null, -1), 100);
    assert.equal(I.stepLimit(0, -1), 0);
    assert.equal(I.stepLimit(7, 1), 10);
    assert.equal(I.stepLimit(7, -1), 5);
  });

  test('patches merge and validate', () => {
    const next = I.applySettingsPatch(base, { sites: { tiktok: false }, bedtime: { on: true } }, false);
    assert.equal(next.sites.tiktok, false);
    assert.equal(next.sites.youtube, true);
    assert.equal(next.bedtime.on, true);
    assert.equal(next.bedtime.from, 23 * 60);
    assert.throws(() => I.applySettingsPatch(base, { limit: 2.5 }, false), { code: 'invalid' });
    assert.throws(() => I.applySettingsPatch(base, 'nope', false), { code: 'invalid' });
  });

  test('strict mode refuses anything that loosens, allows tightening', () => {
    const strict = { ...base, strict: true, bedtime: { on: true, from: 1380, to: 420 } };
    const refuse = (patch) => assert.throws(() => I.applySettingsPatch(strict, patch, true), { code: 'strict' }, JSON.stringify(patch));
    refuse({ limit: 15 });
    refuse({ limit: null });
    refuse({ sites: { youtube: false } });
    refuse({ strict: false });
    refuse({ bedtime: { on: false } });
    refuse({ bedtime: { to: 480 } });
    assert.equal(I.applySettingsPatch(strict, { limit: 5 }, true).limit, 5);
    assert.equal(I.applySettingsPatch(strict, { limit: 0 }, true).limit, 0);
    assert.equal(I.applySettingsPatch(strict, { theme: 'dark', hud: false }, true).theme, 'dark');
    assert.equal(I.applySettingsPatch(strict, { limit: 15 }, false).limit, 15);
  });
});

describe('stats helpers', () => {
  const I = loadShared();

  test('streak counts days without going over, from the first tracked day', () => {
    const stats = I.normalizeStats({ since: at(9, 0, -5) });
    assert.equal(I.streak(stats, at(12)), 6);
    stats.days[I.dayKey(at(12, 0, -2))] = { ...I.emptyDay(), over: true };
    assert.equal(I.streak(stats, at(12)), 2);
    stats.days[I.dayKey(at(12))] = { ...I.emptyDay(), over: true };
    assert.equal(I.streak(stats, at(12)), 0);
  });

  test('month totals only include this month', () => {
    const stats = I.normalizeStats({
      days: { '2026-03-01': { n: 4, t: 60 }, '2026-03-10': { n: 6, t: 30, b: 2 }, '2026-02-28': { n: 100 } },
    });
    assert.deepEqual({ ...I.monthTotals(stats, at(12)) }, { n: 10, t: 90, b: 2 });
  });

  test('old days are pruned but lifetime is untouched', () => {
    const stats = I.normalizeStats({ life: { n: 5000 } });
    for (let i = 0; i < 450; i++) stats.days[I.dayKey(at(12, 0, -i - 1))] = { ...I.emptyDay(), n: 1 };
    I.touchDay(stats, at(12));
    assert.equal(Object.keys(stats.days).length, 400);
    assert.ok(stats.days[I.dayKey(at(12))]);
    assert.equal(stats.life.n, 5000);
  });

  test('series lines up the last 7 days ending today', () => {
    const stats = I.normalizeStats({ days: { [I.dayKey(at(12))]: { n: 3 }, [I.dayKey(at(12, 0, -6))]: { n: 9 } } });
    const s = I.series(stats, at(12));
    assert.equal(s.length, 7);
    assert.deepEqual([...s.map((d) => d.n)], [9, 0, 0, 0, 0, 0, 3]);
    assert.equal(s[6].today, true);
  });
});

describe('formatting', () => {
  const I = loadShared();
  test('durations and countdowns', () => {
    assert.equal(I.fmtDuration(0), '0m');
    assert.equal(I.fmtDuration(42), '42s');
    assert.equal(I.fmtDuration(12 * 60 + 5), '12m');
    assert.equal(I.fmtDuration(3600 + 4 * 60), '1h 04m');
    assert.equal(I.fmtCountdown(0), '0:00');
    assert.equal(I.fmtCountdown(61_000), '1:01');
    assert.equal(I.fmtCountdown(4 * HOUR + 32 * MIN + 10_000), '4:32:10');
    assert.equal(I.fmtLeft(90 * MIN), '1h 30m');
    assert.equal(I.fmtLeft(2 * HOUR), '2h');
    assert.equal(I.fmtLeft(20_000), '1m');
    assert.equal(I.fmtLockLength(30), '30 minutes');
    assert.equal(I.fmtLockLength(60), '1 hour');
    assert.equal(I.fmtLockLength(300), '5 hours');
    assert.equal(I.fmtLockLength(1440), '24 hours');
    assert.equal(I.fmtLockLength(150), '2h 30m');
    assert.equal(I.fmtLockLength(1), '1 minute');
    assert.equal(I.fmtLockChip(1440), '24h');
    assert.equal(I.plural(1, 'scroll', 'scrolls'), '1 scroll');
    assert.equal(I.plural(2, 'scroll', 'scrolls'), '2 scrolls');
  });
});

/* ---------------- background ---------------- */

describe('background', () => {
  test('counts shorts up to the limit, then blocks and records it', async () => {
    const { send, store, badge, settle, I } = fakeBrowser();
    await send({ type: 'settings', patch: { limit: 3 } });
    for (let i = 1; i <= 3; i++) assert.deepEqual({ ...(await send({ type: 'count', platform: 'youtube' })) }, { allowed: true, total: i });
    const denied = await send({ type: 'count', platform: 'instagram' });
    assert.deepEqual({ ...denied }, { allowed: false, reason: 'limit' });
    const day = store.stats.days[I.dayKey()];
    assert.equal(day.n, 3);
    assert.equal(day.p.youtube, 3);
    assert.equal(day.b, 1);
    assert.equal(day.over, true);
    assert.equal(store.stats.life.n, 3);
    await settle();
    assert.equal(badge.text, '3');
    assert.match(badge.title, /limit reached/);
  });

  test('scrolls from many tabs at once are never lost', async () => {
    const { send, store, I } = fakeBrowser();
    await send({ type: 'settings', patch: { limit: null } });
    await Promise.all(Array.from({ length: 60 }, (_, i) => send({ type: 'count', platform: I.PLATFORM_IDS[i % 5] })));
    assert.equal(store.stats.days[I.dayKey()].n, 60);
    assert.equal(store.stats.life.n, 60);
  });

  test('a burst at the limit lets exactly the allowance through', async () => {
    const { send, store, I } = fakeBrowser();
    await send({ type: 'settings', patch: { limit: 10 } });
    const results = await Promise.all(Array.from({ length: 25 }, () => send({ type: 'count', platform: 'tiktok' })));
    assert.equal(results.filter((r) => r.allowed).length, 10);
    assert.equal(store.stats.days[I.dayKey()].n, 10);
    assert.equal(store.stats.days[I.dayKey()].b, 15);
  });

  test('turned-off sites are ignored', async () => {
    const { send, store } = fakeBrowser();
    await send({ type: 'settings', patch: { sites: { facebook: false } } });
    assert.equal((await send({ type: 'count', platform: 'facebook' })).ignored, true);
    assert.equal(store.stats, undefined);
  });

  test('locks start, extend, never shorten, and are capped at a week', async () => {
    const { send, store, I } = fakeBrowser();
    const t0 = Date.now();
    const first = await send({ type: 'lock', minutes: 300 });
    assert.ok(Math.abs(first.lock.until - (t0 + 300 * MIN)) < 2000);
    const shorter = await send({ type: 'lock', minutes: 30 });
    assert.equal(shorter.lock.until, first.lock.until);
    assert.equal(shorter.lock.start, first.lock.start);
    const extended = await send({ type: 'lock', minutes: 60, extend: true });
    assert.equal(extended.lock.until, first.lock.until + 60 * MIN);
    const capped = await send({ type: 'lock', minutes: I.MAX_LOCK_MIN, extend: true });
    assert.ok(capped.lock.until <= Date.now() + I.MAX_LOCK_MIN * MIN);
    assert.equal((await send({ type: 'lock', minutes: 0 })).error, 'invalid');
    assert.equal((await send({ type: 'lock', minutes: 'soon' })).error, 'invalid');
    assert.equal((await send({ type: 'count', platform: 'youtube' })).reason, 'lock');
    assert.equal((await send({ type: 'unlock' })).ok, true);
    assert.equal(store.lock, null);
  });

  test('strict mode holds the line while locked', async () => {
    const { send, store } = fakeBrowser();
    await send({ type: 'settings', patch: { strict: true, limit: 10 } });
    await send({ type: 'lock', minutes: 60 });
    assert.equal((await send({ type: 'unlock' })).error, 'strict');
    assert.equal((await send({ type: 'settings', patch: { limit: 20 } })).error, 'strict');
    assert.equal((await send({ type: 'settings', patch: { sites: { youtube: false } } })).error, 'strict');
    assert.equal((await send({ type: 'settings', patch: { strict: false } })).error, 'strict');
    assert.equal((await send({ type: 'reset' })).error, 'strict');
    assert.equal((await send({ type: 'settings', patch: { limit: 5 } })).ok, true);
    assert.equal(store.settings.limit, 5);
    assert.ok(store.lock);
  });

  test('time watched is clamped and validated', async () => {
    const { send, store, I } = fakeBrowser();
    await send({ type: 'time', platform: 'youtube', seconds: 15 });
    await send({ type: 'time', platform: 'youtube', seconds: 99999 });
    await send({ type: 'time', platform: 'youtube', seconds: -5 });
    await send({ type: 'time', platform: 'youtube', seconds: 'NaN' });
    const day = store.stats.days[I.dayKey()];
    assert.equal(day.t, 315);
    assert.equal(day.tp.youtube, 315);
    assert.equal(store.stats.life.t, 315);
  });

  test('reset wipes stats but keeps settings', async () => {
    const { send, store, I } = fakeBrowser();
    await send({ type: 'settings', patch: { limit: 20 } });
    await send({ type: 'count', platform: 'youtube' });
    assert.equal((await send({ type: 'reset' })).ok, true);
    assert.deepEqual(Object.keys(store.stats.days), []);
    assert.equal(store.stats.life.n, 0);
    assert.equal(store.settings.limit, 20);
    assert.equal(I.status(I.normalizeState(store)).today.n, 0);
  });

  test('blocked attempts are recorded only while something is blocking', async () => {
    const { send, store, I } = fakeBrowser();
    assert.equal((await send({ type: 'blocked', platform: 'youtube' })).stale, true);
    await send({ type: 'lock', minutes: 10 });
    await send({ type: 'blocked', platform: 'youtube' });
    const day = store.stats.days[I.dayKey()];
    assert.equal(day.b, 1);
    assert.equal(day.over, false, 'a lock is not a broken streak');
  });

  test('closeTab closes the sender tab', async () => {
    const { send, closed } = fakeBrowser();
    await send({ type: 'closeTab' });
    assert.deepEqual(closed, [7]);
  });

  test('ignores unknown messages, bad input and other extensions', async () => {
    const { send, store } = fakeBrowser();
    assert.equal(await send({ type: 'toString' }), undefined);
    assert.equal(await send(null), undefined);
    assert.equal((await send({ type: 'count', platform: 'myspace' })).error, 'invalid');
    assert.equal(await send({ type: 'reset' }, { id: 'someone-else' }), undefined);
    assert.equal(store.stats, undefined);
  });
});
