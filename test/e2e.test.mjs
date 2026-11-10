// End-to-end tests: the real extension loaded into Chromium, visiting mock
// pages served at the real site URLs so the content script runs exactly as it
// would on youtube.com, tiktok.com, instagram.com and reddit.com.
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
    <ytd-browse page-subtype="home" style="display:block"><div id="primary"><ytd-rich-grid-renderer id="grid" style="display:block">Home feed</ytd-rich-grid-renderer></div></ytd-browse>
    <video id="v" muted loop playsinline></video>
    <script>${PLAYABLE}
      const v = document.getElementById('v');
      playable(v, 0);
      v.play().catch(() => {});
      v.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
    </script>`,
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
  reddit: `<!doctype html><title>Reddit</title><p>Front page</p>`,
};

// A strict policy like real sites send: the page itself may not frame
// anything but itself. The lock screen's menu has to load regardless.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'";

let context;
let worker;
let extensionId;
let welcomeOpened = false;

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
    await context.route(`https://www.${site}.com/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html, headers: { 'content-security-policy': CSP } }),
    );
  }
  const end = Date.now() + 5000;
  while (!welcomeOpened && Date.now() < end) {
    welcomeOpened = context.pages().some((p) => p.url().endsWith('/welcome/welcome.html'));
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => context?.close());

beforeEach(async () => {
  for (const page of context.pages()) await page.close();
  await seed({});
});

/* ---------- helpers ---------- */

// Tests turn the pause screen off unless they're about it.
const withDefaults = (data) => (data.settings ? { ...data, settings: { pause: false, ...data.settings } } : data);

// `day` pre-fills today's stats, e.g. { n: 9 } for nine scrolls already.
function seed(data, day) {
  return worker.evaluate(
    async ({ d, day }) => {
      await chrome.storage.local.clear();
      if (day) {
        const now = new Date();
        const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        d.stats = { since: Date.now() - 864e5, days: { [key]: day } };
      }
      await chrome.storage.local.set(d);
    },
    { d: withDefaults({ settings: {}, ...data }), day },
  );
}

function patchStorage(data) {
  return worker.evaluate((d) => chrome.storage.local.set(d), withDefaults(data));
}

const popupUrl = () => `chrome-extension://${extensionId}/popup/popup.html`;
const storedSettings = () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings ?? {});

// The overlay lives in a closed shadow root, out of reach of selectors; find a
// node there through DevTools and click the middle of it.
async function clickInOverlay(page, className) {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node) => {
      const i = node.attributes?.indexOf('class') ?? -1;
      if (i >= 0 && node.attributes[i + 1].split(' ').includes(className)) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(root);
    assert.ok(node, `.${className} in the overlay`);
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId });
    const [x1, y1, , , x3, y3] = model.border;
    await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  } finally {
    await cdp.detach();
  }
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

test('scrolling back up to a short you already watched does not count again', async () => {
  await seed({ settings: { limit: 2 } });
  const page = await openPage('https://www.youtube.com/shorts/backbackbkA');
  await waitCount(1);
  await go(page, '/shorts/backbackbkB');
  await waitCount(2);
  await go(page, '/shorts/backbackbkA');
  await page.waitForTimeout(700);
  assert.equal((await today()).n, 2, 'scrolling back up is not another short');
  assert.equal(await overlayUp(page), false, 'and it stays watchable at the limit');
  await go(page, '/shorts/backbackbkB');
  await page.waitForTimeout(500);
  assert.equal(await overlayUp(page), false);
  await go(page, '/shorts/backbackbkC');
  await waitOverlay(page, true);
  assert.equal((await today()).n, 2);
  await go(page, '/shorts/backbackbkA');
  await waitOverlay(page, false);
  await page.reload();
  await page.waitForTimeout(800);
  assert.equal(await overlayUp(page), false, 'a reload does not make it new either');
  assert.equal((await today()).n, 2);
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
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  assert.equal((await today()).n, 2, 'scrolling back up to the first video is not another one');
  assert.equal(await overlayUp(page), false);
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

test('Instagram: the home feed and Explore lock with short-form, DMs stay open', async () => {
  await seed({ settings: { limit: null }, lock: { start: Date.now(), until: Date.now() + 3600e3 } });
  const page = await openPage('https://www.instagram.com/');
  await waitOverlay(page, true);
  await go(page, '/direct/inbox/');
  await waitOverlay(page, false);
  await go(page, '/explore/');
  await waitOverlay(page, true);
  await go(page, '/some.friend/');
  await waitOverlay(page, false);
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

test('install opens the welcome page, which sets things up', async () => {
  assert.ok(welcomeOpened, 'welcome page opened on install');
  await seed({ settings: {} });
  const page = await openPage(`chrome-extension://${extensionId}/welcome/welcome.html`);
  await page.getByRole('radio', { name: '20' }).click();
  await waitFor(async () => (await storedSettings()).limit === 20, 'limit saved');
  await page.locator('label.row', { hasText: 'Reddit' }).locator('input').check();
  await waitFor(async () => (await storedSettings()).sites?.reddit === true, 'Reddit turned on');
  const closed = page.waitForEvent('close');
  await page.getByRole('button', { name: "I'm all set" }).click();
  await closed;
});

test('pause screen: a breather first, then it stays out of the way', async () => {
  await seed({ settings: { limit: null, pause: true } });
  const page = await openPage('https://www.youtube.com/shorts/pppppppppp1');
  await waitOverlay(page, true);
  await clickInOverlay(page, 'go');
  await page.waitForTimeout(800);
  assert.equal(await overlayUp(page), true, 'the button waits out the countdown');
  assert.equal((await today()).n, 0, 'nothing counts behind the pause screen');
  await page.waitForTimeout(4500);
  await clickInOverlay(page, 'go');
  await waitOverlay(page, false);
  await waitCount(1);
  await go(page, '/shorts/pppppppppp2');
  await waitCount(2);
  assert.equal(await overlayUp(page), false, 'swiping on does not bring it back');
  await page.reload();
  await page.waitForTimeout(800);
  assert.equal(await overlayUp(page), false, 'a reload in the same tab remembers it');
});

// Regression: the time tracker used to read the address bar directly, so if
// it ticked between an in-page navigation and the next check it counted the
// short as watched and waved the pause screen through. Firefox and Zen showed
// it about 1 time in 4; Chromium happens to fire the two timers in a safe
// order, so here this guards the behaviour rather than reproducing the race.
test('pause screen also catches in-page navigation into Shorts, every time', async () => {
  await seed({ settings: { limit: null, pause: true } });
  const page = await openPage('https://www.youtube.com/');
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.hasFocus()), true, 'the tracker only runs in a focused tab');
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(150 + i * 125);
    await go(page, `/shorts/racerace00${i}`);
    await waitOverlay(page, true);
    await go(page, '/');
    await waitOverlay(page, false);
  }
  assert.equal((await today()).n, 0, 'nothing counted behind the pause screen');
});

test('the lock screen carries the real menu, and the menu can lift the lock', async () => {
  await seed({ settings: { limit: 0 } });
  const page = await openPage('https://www.youtube.com/shorts/mmmmmmmmmm1');
  await waitOverlay(page, true);
  const menu = await waitFor(() => page.frames().find((f) => f.url().includes('/popup/popup.html')), 'menu inside the lock screen');
  await menu.locator('#heroTitle', { hasText: 'Blocked completely' }).waitFor();
  await menu.getByRole('button', { name: 'Raise the daily limit' }).click();
  await waitOverlay(page, false);
  assert.equal((await storedSettings()).limit, 3);
});

test('friction: grayscale, no autoplay and a hidden YouTube feed', async () => {
  await seed({ settings: { limit: null, gray: true, noAutoplay: true, ytFeed: true } });
  const page = await openPage('https://www.youtube.com/shorts/hhhhhhhhhh1');
  await waitCount(1);
  const css = (id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i))[p], [id, prop]);
  assert.equal(await css('v', 'filter'), 'grayscale(1)');
  assert.equal(await css('grid', 'display'), 'none', 'home feed hidden');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), true, 'autoplay was stopped');
  await page.click('#v');
  await waitFor(() => page.evaluate(() => !document.getElementById('v').paused), 'plays after a click');
  await go(page, '/feed/subscriptions');
  await waitFor(async () => (await css('v', 'filter')) === 'none', 'color back off short-form');
});

test('Shorts in the normal player: counted, then opened as a regular video', async () => {
  await seed({ settings: { limit: null, ytPlayer: true } });
  const page = await openPage('https://www.youtube.com/shorts/nnnnnnnnnn1');
  await waitFor(() => page.url().endsWith('/watch?v=nnnnnnnnnn1'), 'opened in the player');
  assert.equal((await today()).n, 1);
});

test('time limit locks short-form and feeds once the minutes are used', async () => {
  await seed({ settings: { limit: null, minutes: 1, sites: { reddit: true } } }, { t: 57 });
  const page = await openPage('https://www.youtube.com/shorts/tttttttttt1');
  await page.bringToFront();
  await waitFor(() => overlayUp(page), 'time runs out', 8000);
  assert.ok((await today()).t >= 60);
  const feed = await openPage('https://www.reddit.com/');
  await waitOverlay(feed, true);
  await feed.goto('https://www.reddit.com/r/cooking/');
  await feed.waitForTimeout(600);
  assert.equal(await overlayUp(feed), false, 'a subreddit is not the endless feed');
});

test('feeds are left alone unless turned on', async () => {
  await seed({ settings: { limit: 0 } });
  const feed = await openPage('https://www.reddit.com/');
  await feed.waitForTimeout(800);
  assert.equal(await overlayUp(feed), false);
  await patchStorage({ settings: { limit: 0, sites: { reddit: true } } });
  await waitOverlay(feed, true);
});

test('popup: hold for bonus scrolls once the limit is hit', async () => {
  await seed({ settings: { limit: 2 } }, { n: 2 });
  const popup = await openPage(popupUrl());
  const bonus = popup.locator('#bonusBtn');
  await bonus.waitFor();
  await bonus.hover();
  await popup.mouse.down();
  await popup.waitForTimeout(5400);
  await popup.mouse.up();
  await waitFor(async () => (await today()).bonus === 3, 'bonus granted');
  await waitFor(async () => (await popup.locator('#ringSub').textContent()) === 'of 5', 'ring shows the new allowance');
  assert.equal(await popup.locator('#bonusCard').isVisible(), false, 'once a day');
});

test('popup: the password lock asks before anything loosens', async () => {
  await seed({ settings: { limit: 10 } });
  const popup = await openPage(popupUrl());
  await popup.click('#settingsBtn');
  await popup.click('#pwSetBtn');
  await popup.fill('#pwInput', 'tulip42');
  await popup.fill('#pwConfirm', 'tulip42');
  await popup.click('#pwOk');
  await waitFor(() => worker.evaluate(async () => Boolean((await chrome.storage.local.get('guard')).guard)), 'password saved');
  await popup.click('#backBtn');

  await popup.getByRole('button', { name: 'Lower the daily limit' }).click();
  await waitFor(async () => (await storedSettings()).limit === 5, 'tightening goes straight through');
  assert.equal(await popup.locator('#pwModal').isVisible(), false);

  await popup.getByRole('button', { name: 'Raise the daily limit' }).click();
  await popup.locator('#pwModal').waitFor();
  await popup.fill('#pwInput', 'wrong');
  await popup.click('#pwOk');
  await waitFor(async () => (await popup.locator('#pwError').textContent()) === "That's not the password.", 'wrong password rejected');
  await popup.fill('#pwInput', 'tulip42');
  await popup.click('#pwOk');
  await waitFor(async () => (await storedSettings()).limit === 10, 'loosened with the password');
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
