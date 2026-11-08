// End-to-end tests: the real extension loaded into Chromium, visiting mock
// pages served at the real site URLs so the content script runs exactly as it
// would on youtube.com, tiktok.com and instagram.com.
//
//   npx playwright install chromium   (once)
//   npm run test:e2e
//
// Set CHROMIUM_PATH to use a system Chromium instead of Playwright's.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const EXT = path.resolve(import.meta.dirname, '../extension');

// A video that really plays without media files: frames come from a canvas.
const PLAYABLE = `
  function playable(video, hue) {
    const c = document.createElement('canvas');
    c.width = 90; c.height = 160;
    const g = c.getContext('2d');
    let f = 0;
    setInterval(() => { g.fillStyle = 'hsl(' + ((hue + f++) % 360) + ' 60% 40%)'; g.fillRect(0, 0, 90, 160); }, 50);
    video.srcObject = c.captureStream(20);
  }
  window.__keys = 0;
  document.addEventListener('keydown', () => window.__keys++);
`;

const PAGES = {
  youtube: `<!doctype html><title>YouTube</title>
    <style>body{margin:0} video{display:block;width:360px;height:640px;margin:24px auto;background:#000}</style>
    <ytd-reel-shelf-renderer id="shelf" style="display:block">Shorts shelf</ytd-reel-shelf-renderer>
    <video id="v" muted loop playsinline></video>
    <script>${PLAYABLE} const v = document.getElementById('v'); playable(v, 0); v.play().catch(() => {});</script>`,
  tiktok: `<!doctype html><title>TikTok</title>
    <style>body{margin:0} .item{height:100vh;display:grid;place-items:center} video{height:90vh;aspect-ratio:9/16;background:#000}</style>
    ${'<div class="item"><video muted loop playsinline></video></div>'.repeat(4)}
    <script>${PLAYABLE}
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) e.intersectionRatio > 0.6 ? e.target.play().catch(() => {}) : e.target.pause();
      }, { threshold: [0, 0.6, 1] });
      document.querySelectorAll('video').forEach((v, i) => { playable(v, i * 90); io.observe(v); });
    </script>`,
  instagram: `<!doctype html><title>Instagram</title><p>Reels</p>`,
};

let context;
let worker;
let extensionId;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iblock-e2e-'));
  const args = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'];
  context = await chromium.launchPersistentContext(
    dir,
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH, headless: false, args: ['--headless=new', ...args] }
      : { channel: 'chromium', headless: true, args },
  );
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  for (const [site, html] of Object.entries(PAGES)) {
    await context.route(`https://www.${site}.com/**`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  }
});

after(() => context?.close());

beforeEach(async () => {
  for (const page of context.pages()) await page.close();
  await seed({});
});

/* ---------- helpers ---------- */

function seed(data) {
  return worker.evaluate((d) => chrome.storage.local.clear().then(() => chrome.storage.local.set(d)), data);
}

function patchStorage(data) {
  return worker.evaluate((d) => chrome.storage.local.set(d), data);
}

async function today() {
  return worker.evaluate(async () => {
    const { stats } = await chrome.storage.local.get('stats');
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { n: 0, b: 0, t: 0, ...(stats?.days?.[key] ?? {}) };
  });
}

async function waitFor(fn, what, timeout = 4000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const waitCount = (n) => waitFor(async () => (await today()).n === n, `${n} scrolls counted`);

// The lock screen is the only thing of ours that takes pointer events.
const overlayUp = (page) => page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName === 'IBLOCK-ROOT');
const waitOverlay = (page, up) => waitFor(async () => (await overlayUp(page)) === up, `lock screen ${up ? 'shown' : 'hidden'}`);

async function go(page, pathname) {
  await page.evaluate((p) => history.pushState({}, '', p), pathname);
}

async function openPage(url) {
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/* ---------- tests ---------- */

test('YouTube Shorts: counts each short, lets you finish the last one, then locks', async () => {
  await seed({ settings: { limit: 3 } });
  const page = await openPage('https://www.youtube.com/shorts/aaaaaaaaaa1');
  await waitCount(1);
  await go(page, '/shorts/aaaaaaaaaa2');
  await waitCount(2);
  await go(page, '/shorts/aaaaaaaaaa3');
  await waitCount(3);
  await page.waitForTimeout(400);
  assert.equal(await overlayUp(page), false, 'the third short (the last allowed) stays watchable');

  await go(page, '/shorts/aaaaaaaaaa4');
  await waitOverlay(page, true);
  const day = await today();
  assert.equal(day.n, 3, 'a blocked short is not counted as a scroll');
  assert.equal(day.b, 1, 'but it is recorded as blocked');
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), true, 'video is paused');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('shelf')).display), 'none', 'Shorts shelf hidden');

  const keysBefore = await page.evaluate(() => window.__keys);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('j');
  assert.equal(await page.evaluate(() => window.__keys), keysBefore, 'keys never reach the player');

  await go(page, '/watch?v=regular');
  await waitOverlay(page, false);

  // Raising the limit (not in strict mode) opens things back up.
  await go(page, '/shorts/aaaaaaaaaa5');
  await waitOverlay(page, true);
  await patchStorage({ settings: { limit: 10 } });
  await waitOverlay(page, false);
  await waitCount(4);
});

test('a lock covers the page immediately and lifts when it ends', async () => {
  await seed({ settings: { limit: null } });
  const page = await openPage('https://www.youtube.com/shorts/bbbbbbbbbb1');
  await waitCount(1);
  await patchStorage({ lock: { start: Date.now(), until: Date.now() + 3600e3 } });
  await waitOverlay(page, true);
  assert.equal((await today()).b, 0, 'locking while watching is not a blocked attempt');

  await go(page, '/shorts/bbbbbbbbbb2');
  await waitFor(async () => (await today()).b === 1, 'attempt recorded');
  assert.equal((await today()).n, 1);

  await patchStorage({ lock: null });
  await waitOverlay(page, false);
  await waitCount(2);
});

test('a short lock expires on its own', async () => {
  await seed({ settings: { limit: null }, lock: { start: Date.now(), until: Date.now() + 2500 } });
  const page = await openPage('https://www.youtube.com/shorts/cccccccccc1');
  await waitOverlay(page, true);
  await waitOverlay(page, false);
  await waitCount(1);
});

test('turned-off sites are left alone', async () => {
  await seed({ settings: { limit: 0, sites: { youtube: false } } });
  const page = await openPage('https://www.youtube.com/shorts/dddddddddd1');
  await page.waitForTimeout(800);
  assert.equal(await overlayUp(page), false);
  assert.equal((await today()).n, 0);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('shelf')).display), 'none');
});

test('"blocked completely" blocks the first short', async () => {
  await seed({ settings: { limit: 0 } });
  const page = await openPage('https://www.youtube.com/shorts/eeeeeeeeee1');
  await waitOverlay(page, true);
  assert.deepEqual([(await today()).n, (await today()).b], [0, 1]);
});

test('two tabs racing for the last scroll: exactly one gets it', async () => {
  await seed({ settings: { limit: 1 } });
  const [a, b] = await Promise.all([
    openPage('https://www.youtube.com/shorts/ffffffffff1'),
    openPage('https://www.youtube.com/shorts/ffffffffff2'),
  ]);
  await waitFor(async () => (await overlayUp(a)) !== (await overlayUp(b)), 'one tab locked, one open');
  const day = await today();
  assert.equal(day.n, 1);
  assert.equal(day.b, 1);
});

test('TikTok: counts the video in the middle of the screen as you scroll', async () => {
  await seed({ settings: { limit: 2 } });
  const page = await openPage('https://www.tiktok.com/foryou');
  await waitCount(1);
  await page.evaluate(() => window.scrollTo(0, innerHeight));
  await waitCount(2);
  await page.evaluate(() => window.scrollTo(0, innerHeight * 2));
  await waitOverlay(page, true);
  assert.equal((await today()).n, 2);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('video')].every((v) => v.paused)), true, 'every video paused');
});

test('Instagram: reels feed and single reels count, audio pages do not', async () => {
  await seed({ settings: { limit: null } });
  const page = await openPage('https://www.instagram.com/reels/C0deAbc12/');
  await waitCount(1);
  await go(page, '/some.user/reel/XyZ987654/');
  await waitCount(2);
  await go(page, '/reels/audio/1234567890/');
  await page.waitForTimeout(600);
  assert.equal((await today()).n, 2);
  await go(page, '/direct/inbox/');
  await page.waitForTimeout(400);
  assert.equal(await overlayUp(page), false);
});

test('popup: lock, strict mode and the limit stepper', async () => {
  await seed({ settings: { limit: 10 } });
  const popup = await openPage(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.getByRole('radio', { name: '3 hours' }).click();
  await popup.getByRole('button', { name: 'Lock for 3 hours' }).click();
  const lock = await waitFor(() => worker.evaluate(async () => (await chrome.storage.local.get('lock')).lock), 'lock stored');
  assert.ok(Math.abs(lock.until - lock.start - 3 * 3600e3) < 3000);
  await popup.locator('#lockCard').waitFor();

  await popup.getByRole('button', { name: 'Raise the daily limit' }).click();
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.limit)) === 15, 'limit raised');

  await patchStorage({ settings: { limit: 15, strict: true } });
  await waitFor(() => popup.getByRole('button', { name: 'Raise the daily limit' }).isDisabled(), 'raise disabled in strict mode');
  assert.equal(await popup.locator('#unlockBtn').isVisible(), false, 'no early unlock in strict mode');
  await popup.getByRole('button', { name: 'Lower the daily limit' }).click();
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.limit)) === 10, 'limit lowered');
});

test('popup: type your own limit and lock length', async () => {
  await seed({ settings: { limit: 10 } });
  const popup = await openPage(`chrome-extension://${extensionId}/popup/popup.html`);
  const storedLimit = () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.limit);

  const limit = popup.getByRole('textbox', { name: 'Daily limit' });
  await limit.fill('12');
  await limit.press('Enter');
  await waitFor(async () => (await storedLimit()) === 12, 'limit 12 saved');
  await limit.fill('abc');
  await limit.press('Enter');
  await popup.waitForTimeout(300);
  assert.equal(await storedLimit(), 12, 'junk input is ignored');
  assert.equal(await limit.inputValue(), '12', 'and the field shows the real limit again');
  await popup.getByRole('button', { name: 'Raise the daily limit' }).click();
  await waitFor(async () => (await storedLimit()) === 15, '+ steps from a custom value to the next preset');

  await popup.getByRole('radio', { name: 'Custom length' }).click();
  await popup.getByRole('textbox', { name: 'Hours' }).fill('0');
  await popup.getByRole('textbox', { name: 'Minutes' }).fill('0');
  assert.equal(await popup.locator('#lockBtn').isDisabled(), true, "can't lock for zero minutes");
  await popup.getByRole('textbox', { name: 'Minutes' }).fill('99');
  assert.equal(await popup.getByRole('textbox', { name: 'Minutes' }).inputValue(), '59', 'minutes cap at 59');
  await popup.getByRole('textbox', { name: 'Hours' }).fill('2');
  await popup.getByRole('textbox', { name: 'Minutes' }).fill('15');
  await popup.getByRole('button', { name: 'Lock for 2h 15m' }).click();
  const lock = await waitFor(() => worker.evaluate(async () => (await chrome.storage.local.get('lock')).lock), 'lock stored');
  assert.ok(Math.abs(lock.until - lock.start - 135 * 60e3) < 3000, 'locked for 2h 15m');
});

// On install/update the background injects the content script into tabs that
// are already open, so a tab can end up with two copies. The newer one must
// take over: one counter on screen, every short counted once.
test('injecting the content script twice never double counts', async () => {
  await seed({ settings: { limit: null } });
  const page = await openPage('https://www.youtube.com/shorts/gggggggggg1');
  await waitCount(1);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] });
  });
  await page.waitForTimeout(500);
  await go(page, '/shorts/gggggggggg2');
  await waitCount(2);
  await go(page, '/shorts/gggggggggg3');
  await waitCount(3);
  await page.waitForTimeout(800);
  assert.equal((await today()).n, 3, 'each short counted once');
  assert.equal(await page.evaluate(() => document.querySelectorAll('iblock-root').length), 1, 'one counter on the page');
});

test('popup: holding the button ends a lock early', async () => {
  await seed({ settings: { limit: 10 }, lock: { start: Date.now(), until: Date.now() + 3600e3 } });
  const popup = await openPage(`chrome-extension://${extensionId}/popup/popup.html`);
  const hold = popup.locator('#unlockBtn');
  await hold.hover();
  await popup.mouse.down();
  await popup.waitForTimeout(3000);
  await popup.mouse.up();
  assert.ok(await worker.evaluate(async () => (await chrome.storage.local.get('lock')).lock), 'letting go early keeps the lock');
  await popup.mouse.down();
  await popup.waitForTimeout(10_600);
  await popup.mouse.up();
  await waitFor(async () => !(await worker.evaluate(async () => (await chrome.storage.local.get('lock')).lock)), 'lock cleared');
  await popup.locator('#breakCard').waitFor();
});
