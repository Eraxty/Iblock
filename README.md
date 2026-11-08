# Iblock

A browser extension that gets you off short-form video. It counts every Short, Reel and TikTok you scroll past, stops you at a daily limit, and lets you lock all of it for hours at a time.

Works on **YouTube Shorts, Instagram Reels, TikTok, Snapchat Spotlight and Facebook Reels**, in Chrome, Edge, Brave, Opera and Firefox.

## What it does

- **Scroll counter.** Every new short you land on counts as one scroll. See today, this month and lifetime, plus time watched, per app.
- **Daily limit.** Step through 3, 5, 10 … 100 scrolls a day, type any number up to 999, pick "blocked completely" (0), or no limit (just counting). You always get to finish the short you're on; the next one is blocked.
- **Take a break.** Lock all short-form for 30 minutes, 1, 3 or 5 hours, or type a custom length up to 7 days. Ending a lock early takes a 10-second press-and-hold, not a reflex click.
- **Bedtime mode.** Block short-form every night between two times.
- **Strict mode.** While a lock, bedtime or your limit is active, you can tighten settings but not loosen them: no raising the limit, turning sites off or unlocking early.
- **Lock screen.** Covers the page, pauses the video, stops the player from skipping ahead, and offers a way out (home page or close tab).
- **On-page counter.** A small pill pops up in the corner with `7/10` each time you swipe, then fades away. It stays a bit longer when you're down to the last couple.
- **Hides the bait.** While locked, Shorts shelves, the Shorts tab and Reels links disappear from YouTube and Instagram.
- **Insights.** Last 7 days chart against your limit, week-over-week change, streak of days under your limit, shorts blocked, breakdown by app.
- **Light and dark themes**, following the system or set manually.

Everything is stored in your browser. Iblock makes no network requests and collects nothing.

## Install

### Chrome, Edge, Brave, Opera

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension` folder.
4. Pin Iblock from the puzzle-piece menu so it's always one click away.

Anywhere in the browser, **Alt+Shift+O** opens the Iblock menu. Change it at `chrome://extensions/shortcuts`, or in Firefox/Zen under `about:addons` → gear → **Manage Extension Shortcuts**.

Tabs that were already open get Iblock straight away; no reload needed.

### Firefox

```sh
npm run build
```

Then open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `dist/firefox/manifest.json`. Temporary add-ons are removed when Firefox restarts; for a permanent install, upload `dist/iblock-firefox.zip` to [addons.mozilla.org](https://addons.mozilla.org/developers/) to get it signed.

If the popup says it can't see the sites yet, click **Allow access**.

### Zen (and other Firefox builds that allow unsigned add-ons)

These can install Iblock permanently without signing:

1. Open `about:config` and set `xpinstall.signatures.required` to `false`.
2. Run `npm run build`.
3. Open `about:addons`, click the gear icon, choose **Install Add-on From File…** and pick `dist/iblock-firefox.xpi`.

To update later, run `npm run build` again and install the new `.xpi` the same way. In Chrome, click the reload arrow on Iblock's card in `chrome://extensions`.

## How counting works

| Site | Counts on | How |
| --- | --- | --- |
| YouTube | `/shorts/…` | each new short id in the address bar |
| Instagram | `/reels/…`, `/reel/…` | each new reel code in the address bar |
| Facebook | `/reel/…` | each new reel id in the address bar |
| TikTok | the whole site (except messages, upload, settings and similar) | each new full-size video that plays in the middle of the screen |
| Snapchat | `/spotlight` | each new full-size video that plays in the middle of the screen |

A short only counts once the tab is actually visible, and many tabs counting at once never lose or double up scrolls.

## Development

```sh
npm install
npm test                           # rules + background, runs in Node
npx playwright install chromium    # once
npm run test:e2e                   # real extension in Chromium against mock pages
npm run build                      # dist/ folders and store zips for Chrome and Firefox
```

Set `CHROMIUM_PATH=/usr/bin/chromium` to run the end-to-end tests with a system Chromium.

```
extension/
  manifest.json      Chrome manifest (the build derives the Firefox one)
  shared.js          storage schema, blocking rules, formatting, shared UI helpers
  background.js      the only writer of data; badge, alarms, message handlers
  content.js         per-site detection, counting, counter pill, lock screen
  popup/             Today, Insights and Settings
  assets/            icons and the Geist font (SIL Open Font License)
scripts/build.mjs    packages dist/chrome and dist/firefox, plus zips
test/                unit tests and Playwright end-to-end tests
```
