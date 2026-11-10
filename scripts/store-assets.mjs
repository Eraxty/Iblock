// Builds the Chrome Web Store / Firefox Add-ons images from the real extension:
//   store/screenshots/1-5 (1280x800), store/promo-small.png (440x280),
//   store/promo-marquee.png (1400x560). All 24-bit PNG, no alpha.
//
//   npm run store-assets          (CHROMIUM_PATH=/usr/bin/chromium to use a system Chromium)
//
// Needs ImageMagick (`magick`) for the final resize and alpha flattening.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'store');
const SHOTS = path.join(OUT, 'screenshots');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'iblock-store-'));
fs.mkdirSync(SHOTS, { recursive: true });

const FONT = `file://${path.join(EXT, 'assets/fonts/geist.woff2')}`;
const MARK = `<svg viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="var(--ink)"/><rect x="30" y="14" width="36" height="68" rx="6" fill="none" stroke-width="8" stroke="var(--on-ink)"/><rect x="12" y="39" width="72" height="18" rx="9" stroke-width="6" paint-order="stroke" fill="#FF6B35" stroke="var(--ink)"/></svg>`;

/* ---------- sample data ---------- */

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function sampleStats(todayN) {
  const now = Date.now();
  const days = {};
  const pattern = [14, 9, 22, 11, 6, 17, 12, 8, 12, 5, 10, 4, 9];
  const hours = [22, 23, 23, 0, 13, 17, 23, 22, 21, 23, 8, 18];
  const fill = (n) => {
    const h = {};
    for (let i = 0; i < n; i++) h[hours[i % hours.length]] = (h[hours[i % hours.length]] || 0) + 1;
    return h;
  };
  pattern.forEach((n, i) => {
    days[dayKey(now - (pattern.length - i) * 864e5)] = { n, t: n * 41, b: i % 3, over: false, p: { youtube: Math.ceil(n * 0.6), instagram: Math.floor(n * 0.4) }, tp: {}, h: fill(n) };
  });
  days[dayKey(now)] = { n: todayN, t: todayN * 52, b: 2, p: { youtube: Math.min(4, todayN), instagram: Math.min(2, Math.max(0, todayN - 4)), tiktok: Math.max(0, todayN - 6) }, tp: {}, h: fill(todayN) };
  return {
    since: now - 40 * 864e5,
    days,
    life: { n: 1204, t: 69120, b: 58, p: { youtube: 611, instagram: 402, tiktok: 151, snapchat: 12, facebook: 28 }, tp: { youtube: 30100, instagram: 21000, tiktok: 15500, snapchat: 700, facebook: 1820 } },
    badges: { firstLock: now - 20 * 864e5, streak3: now - 12 * 864e5, streak7: now - 8 * 864e5, zeroDay: now - 5 * 864e5 },
  };
}

const SHORT_PAGE = `<!doctype html><meta charset="utf-8"><title>Shorts</title>
<style>body{margin:0;background:#0f0f0f}.s{width:380px;aspect-ratio:9/16;max-height:calc(100vh - 96px);margin:80px auto;border-radius:12px;background:linear-gradient(160deg,#5a3d7a,#1d4a6b 60%,#0e2b3c)}</style><div class="s"></div>`;

/* ---------- capture the real UI ---------- */

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iblock-store-profile-'));
const args = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'];
const context = await chromium.launchPersistentContext(userDir, {
  deviceScaleFactor: 2,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH, headless: false, args: ['--headless=new', ...args] }
    : { channel: 'chromium', headless: true, args }),
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const popupUrl = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
await context.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: SHORT_PAGE }));
const seed = (data) => worker.evaluate((d) => chrome.storage.local.clear().then(() => chrome.storage.local.set(d)), data);
for (const page of context.pages()) await page.close(); // the welcome tab

async function capture(name, { url, size, theme = 'light', before, clock }) {
  const page = await context.newPage();
  if (clock) await page.clock.setFixedTime(clock);
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize(size);
  await page.goto(url);
  await page.waitForTimeout(900);
  if (before) await before(page);
  const file = path.join(WORK, `${name}.png`);
  await page.screenshot({ path: file });
  await page.close();
  return file;
}

const popup = { width: 360, height: 600 };
const ui = {};

await seed({ settings: { limit: 10, pause: false, theme: 'light' }, stats: sampleStats(7) });
ui.today = await capture('today', { url: popupUrl, size: popup });
ui.insights = await capture('insights', { url: `${popupUrl}#insights`, size: popup });

await seed({ settings: { limit: 10, pause: false, theme: 'dark' }, stats: sampleStats(7) });
ui.insightsDark = await capture('insights-dark', { url: `${popupUrl}#insights`, size: popup, theme: 'dark' });
ui.insightsDark2 = await capture('insights-dark-2', {
  url: `${popupUrl}#insights`,
  size: popup,
  theme: 'dark',
  before: async (p) => {
    // End the view on the badges card rather than halfway through the next heading.
    await p.evaluate(() => {
      const main = document.getElementById('main');
      const card = document.getElementById('badges').closest('.card');
      main.scrollTop += card.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom + 16;
    });
    await p.waitForTimeout(300);
  },
});

await seed({ settings: { limit: 10, pause: false, strict: true, gray: true, theme: 'light' }, stats: sampleStats(7), lock: { start: Date.now() - 2 * 3600e3, until: Date.now() + 3 * 3600e3 } });
ui.locked = await capture('locked', { url: popupUrl, size: popup });

await seed({ settings: { limit: 10, pause: false, theme: 'light' }, stats: sampleStats(10) });
ui.lockScreen = await capture('lock-screen', { url: 'https://www.youtube.com/shorts/storeshot01', size: { width: 1280, height: 800 }, before: (p) => p.waitForTimeout(900) });

await seed({ settings: { limit: 10, pause: true, theme: 'light' }, stats: sampleStats(4) });
ui.pause = await capture('pause', { url: 'https://www.youtube.com/shorts/storeshot02', size: { width: 1280, height: 800 }, before: (p) => p.waitForTimeout(1800) });

await seed({ settings: { limit: 10, pause: false, theme: 'dark' }, stats: sampleStats(7) });
ui.todayDark = await capture('today-dark', { url: popupUrl, size: popup, theme: 'dark' });

// Bedtime, strict mode and a password all on. The page clock sits at 7:30 PM so bedtime
// isn't running and the switches aren't frozen, whatever time this script runs. Playwright's
// clock covers the whole browser context, so this capture has to come last.
const evening = new Date();
evening.setHours(19, 30, 0, 0);
await seed({
  settings: { limit: 10, pause: false, strict: true, bedtime: { on: true, from: 1380, to: 420 }, theme: 'light' },
  stats: sampleStats(7),
  guard: { salt: 'storeshot', hash: 'storeshot' },
});
ui.settings = await capture('settings', {
  url: popupUrl,
  size: popup,
  clock: evening,
  before: async (p) => {
    await p.click('#settingsBtn');
    // Scroll so the Protection card ends just above the bottom edge instead of cutting a row in half.
    await p.evaluate(() => {
      const main = document.getElementById('main');
      const card = document.querySelector('[data-setting="strict"]').closest('.card');
      main.scrollTop += card.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom + 16;
    });
    await p.waitForTimeout(300);
  },
});

/* ---------- compose ---------- */

const css = `
  @font-face { font-family: Geist; src: url('${FONT}') format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  body { --ink: #171716; --on-ink: #fff; --bg: #F4F3EF; --text: #171716; --text-2: #62615C; --accent: #E8521C;
    width: var(--w); height: var(--h); overflow: hidden; background: var(--bg); color: var(--text);
    font-family: Geist, sans-serif; -webkit-font-smoothing: antialiased; }
  body.dark { --ink: #F2F1EC; --on-ink: #111112; --bg: #0E0E0F; --text: #F2F1EC; --text-2: #A5A39D; --accent: #FF6B35; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 650; letter-spacing: -0.02em; }
  .brand svg { width: var(--mark, 28px); height: var(--mark, 28px); }
  h1 { font-size: 54px; line-height: 1.05; font-weight: 650; letter-spacing: -0.04em; text-wrap: balance; }
  p.sub { font-size: 20px; line-height: 1.45; color: var(--text-2); }
  .shot { display: block; border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06); }
  .dark .shot { box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); }
  .split { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 72px; height: 100%; padding: 0 96px; }
  .copy { display: grid; gap: 22px; }
  .window { border-radius: 14px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.2), 0 0 0 1px rgba(0,0,0,.08); }
  .dark .window { box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.1); }
  .chrome { height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: #E7E5DF; }
  .dark .chrome { background: #222225; }
  .chrome i { width: 11px; height: 11px; border-radius: 50%; background: #CFCCC4; }
  .dark .chrome i { background: #3A3A3F; }
  .chrome span { margin-left: 14px; font-size: 13px; color: var(--text-2); }
  .window img { display: block; width: 100%; }
  .stack { display: grid; justify-items: center; align-content: start; gap: 28px; height: 100%; padding-top: 52px; text-align: center; }
  .pill { position: absolute; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 18px 0 12px; border-radius: 999px;
    background: #fff; box-shadow: 0 12px 32px rgba(0,0,0,.16); font-size: 17px; font-weight: 600; }
  .pill b { font-weight: 650; } .pill em { font-style: normal; color: #B93F0E; }
  .pill svg { width: 22px; height: 22px; transform: rotate(-90deg); }
`;

const img = (file, width) => `<img class="shot" src="file://${file}" width="${width}">`;
const brand = `<div class="brand">${MARK}<span>Iblock</span></div>`;

function pageHtml(w, h, body, dark = false) {
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><body class="${dark ? 'dark' : ''}" style="--w:${w}px;--h:${h}px">${body}</body>`;
}

const ringPill = `<div class="pill" style="right:60px;top:34px"><svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5" fill="none" stroke="#F0EFEA" stroke-width="2.5"/><circle cx="9" cy="9" r="6.5" fill="none" stroke="#E8521C" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="40.8" stroke-dashoffset="12.2"/></svg><b>7</b><span style="color:#92908A">/10</span><span style="color:#92908A">·</span><em>3 left</em></div>`;

const compositions = {
  '1-count-and-limit': pageHtml(
    1280,
    800,
    `<div class="split">
      <div class="copy">${brand}<h1>Count every short. Stop at your limit.</h1>
      <p class="sub">Iblock counts each YouTube Short, Reel and TikTok you swipe to, and locks short-form once you've had your daily allowance.</p></div>
      <div style="position:relative">${img(ui.today, 400)}</div>
    </div>${ringPill}`,
  ),
  '2-lock-screen': pageHtml(
    1280,
    800,
    `<div class="stack">${brand}<h1 style="font-size:46px">When you're out, it locks. The menu's right there.</h1>
      <div class="window" style="width:1040px"><div class="chrome"><i></i><i></i><i></i><span>youtube.com/shorts</span></div><img src="file://${ui.lockScreen}"></div></div>`,
    true,
  ),
  '3-pause': pageHtml(
    1280,
    800,
    `<div class="stack">${brand}<h1 style="font-size:46px">A breath before you start scrolling.</h1>
      <div class="window" style="width:1040px"><div class="chrome"><i></i><i></i><i></i><span>youtube.com/shorts</span></div><img src="file://${ui.pause}"></div></div>`,
  ),
  '4-insights': pageHtml(
    1280,
    800,
    `<div class="split" style="padding:0 80px">
      <div class="copy">${brand}<h1 style="font-size:52px">See where your time actually goes.</h1>
      <p class="sub">Today, this month and lifetime. Your week against your limit, the hour you scroll most, streaks and badges.</p></div>
      <div style="display:flex;gap:28px">${img(ui.insightsDark, 320)}${img(ui.insightsDark2, 320)}</div>
    </div>`,
    true,
  ),
  '5-breaks-and-rules': pageHtml(
    1280,
    800,
    `<div class="split" style="padding:0 80px">
      <div class="copy">${brand}<h1 style="font-size:52px">Take a break.<br>Make it stick.</h1>
      <p class="sub">Lock short-form for an hour or a whole weekend, set bedtime, add friction, and use strict mode or a password so future you can't wriggle out.</p></div>
      <div style="display:flex;gap:28px">${img(ui.locked, 320)}${img(ui.settings, 320)}</div>
    </div>`,
  ),
};

const smallTile = pageHtml(
  440,
  280,
  `<div style="height:100%;padding:36px 34px;display:grid;align-content:space-between">
    <div class="brand" style="font-size:30px;gap:14px;--mark:48px">${MARK}<span>Iblock</span></div>
    <div><p style="font-size:25px;line-height:1.15;font-weight:650;letter-spacing:-0.03em">Shorts, Reels &amp; TikTok,<br>on your terms.</p>
    <p style="margin-top:10px;font-size:15px;color:var(--text-2)">Count, limit and lock short-form.</p></div>
  </div>`,
  true,
);

const marquee = pageHtml(
  1400,
  560,
  `<div style="display:grid;grid-template-columns:1fr auto;align-items:center;height:100%;padding:0 110px;gap:80px">
    <div class="copy">${brand}<h1 style="font-size:58px">Get your time back from short-form.</h1>
    <p class="sub">Daily limits, timed breaks and a lock screen for YouTube Shorts, Instagram Reels, TikTok and more.</p></div>
    <div style="height:560px;overflow:hidden;padding-top:56px">${img(ui.todayDark, 380)}</div>
  </div>`,
  true,
);

// Render each composition at 2x, then downscale and drop the alpha channel.
async function render(name, html, w, h, dest) {
  const file = path.join(WORK, `${name}.html`);
  fs.writeFileSync(file, html);
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const raw = path.join(WORK, `${name}-2x.png`);
  await page.screenshot({ path: raw });
  await page.close();
  execFileSync('magick', [raw, '-filter', 'Lanczos', '-resize', `${w}x${h}!`, '-background', '#0E0E0F', '-alpha', 'remove', '-alpha', 'off', `PNG24:${dest}`]);
  console.log(path.relative(ROOT, dest));
}

for (const [name, html] of Object.entries(compositions)) await render(name, html, 1280, 800, path.join(SHOTS, `${name}.png`));
await render('promo-small', smallTile, 440, 280, path.join(OUT, 'promo-small.png'));
await render('promo-marquee', marquee, 1400, 560, path.join(OUT, 'promo-marquee.png'));

await context.close();
fs.rmSync(WORK, { recursive: true, force: true });
