# Iblock

A browser extension that gets you off short-form video. It counts every Short, Reel and TikTok you scroll past, stops you at a daily limit, and lets you lock all of it for hours at a time.

Works on **YouTube Shorts, Instagram (Reels, Explore and the home feed), TikTok, Snapchat Spotlight and Facebook Reels**, plus the endless feeds of **X, Reddit and Pinterest** if you turn them on. Runs in Chrome, Edge, Brave, Opera, Firefox and Zen.

## What it does

- **Scroll counter.** Every new short you land on counts as one scroll. See today, this month and lifetime, plus time watched, per app.
- **Daily limit.** Step through 3, 5, 10 … 100 scrolls a day, type any number up to 999, pick "blocked completely" (0), or no limit (just counting). You always get to finish the short you're on; the next one is blocked.
- **Time limit.** Optionally, a number of minutes a day on top of the scroll count. Feed time counts toward it too.
- **Bonus scrolls.** Once a day, after you hit the limit, hold a button for 3 more.
- **Take a break.** Lock all short-form for 30 minutes, 1, 3 or 5 hours, or type a custom length up to 7 days. Ending a lock early takes a 10-second press-and-hold, not a reflex click.
- **Bedtime mode.** Block short-form every night between two times.
- **Pause screen.** A 5-second "take a breath" before short-form or a feed opens. Once you go in, it stays away until you've been gone 15 minutes.
- **Friction options.** Grayscale videos and images, no autoplay (each short waits for a click), YouTube Shorts opened in the normal player, and YouTube's home feed, suggestions and end screens hidden.
- **Strict mode.** While a lock, bedtime or a limit is active, you can tighten settings but not loosen them: no raising limits, turning sites or friction off, or unlocking early.
- **Password lock.** Someone you trust sets a password; loosening anything, ending a lock early, bonus scrolls and resetting stats all need it. Stored only as a salted PBKDF2 hash.
- **Lock screen with the menu built in.** Covers the page, pauses the video, stops the player skipping ahead, and shows the full Iblock menu beside it, so you can take a break, change limits or unlock from right there.
- **Feeds only lose the feed.** On the Instagram home feed and Explore, and the X, Reddit and Pinterest feeds, a lock just hides the posts and puts a small card in their place. Messages, search, notifications and profiles keep working. If a site redesign ever hides the feed from Iblock, the full lock screen covers the page instead.
- **On-page counter.** A small pill pops up in the corner with `7/10` each time you swipe, then fades away. It stays a bit longer when you're down to the last couple.
- **Hides the bait.** While locked, Shorts shelves, the Shorts tab and Reels links disappear from YouTube and Instagram.
- **Insights.** Last 7 days against your limit, week-over-week change, when in the day you scroll most, streak of days under your limit, shorts blocked, breakdown by app.
- **Badges.** Streaks, zero days, finishing a long lock, shorts blocked.
- **Weekly report.** A Sunday-evening notification with your week and how it compares. Click it for the full insights.
- **Welcome page.** Opens once on install for a 30-second setup.
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
| Instagram | home feed, `/reels/…`, `/reel/…`, `/explore/` | each new reel code in the address bar (the home feed and Explore get hidden when locked, but aren't counted) |
| Facebook | `/reel/…` | each new reel id in the address bar |
| X, Reddit, Pinterest | home and explore-style feeds | not counted, only timed; the feed is hidden whenever short-form is locked |
| TikTok | the whole site (except messages, upload, settings and similar) | each new full-size video that plays in the middle of the screen |
| Snapchat | `/spotlight` | each new full-size video that plays in the middle of the screen |

Each short counts once a day: scrolling back up to one you already watched, reloading it or opening it in another tab doesn't count again, and stays watchable even after you hit the limit. A short only counts once the tab is actually visible, and many tabs counting at once never lose or double up scrolls.

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
  background.js      the only writer of data; badge, alarms, badges, weekly report, password check
  content.js         per-site detection, counting, counter pill, pause and lock screens, friction
  popup/             Today, Insights and Settings (also shown inside the lock screen)
  welcome/           first-run setup page
  ui/app.css         styles shared by the popup and the welcome page
  assets/            icons and the Geist font (SIL Open Font License)
scripts/build.mjs    packages dist/chrome and dist/firefox, plus zips
test/                unit tests and Playwright end-to-end tests
```
