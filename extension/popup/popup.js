/* Iblock popup: today's numbers, quick locks, insights and settings. */
(() => {
  'use strict';

  const I = globalThis.Iblock;
  const { ext } = I;
  const $ = (id) => document.getElementById(id);
  const RING = 2 * Math.PI * 44;
  const BAR_AREA = 92; // px of the 112px plot used by bars; the rest fits the value label
  const STRICT_MSG = 'Strict mode is on. You can loosen this once the lock is over.';

  const GLYPHS = {
    youtube:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8zM10 15V9l5.2 3L10 15z"/></svg>',
    instagram:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="12" r="3.9" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="17.2" cy="6.8" r="1.15" fill="currentColor"/></svg>',
    tiktok:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" transform="translate(1.6 1.6) scale(.867)"/></svg>',
    snapchat:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M12 2.6a7.4 7.4 0 0 0-7.4 7.4v11l2.8-2.8 2.3 2.3L12 18.2l2.3 2.3 2.3-2.3 2.8 2.8V10A7.4 7.4 0 0 0 12 2.6z"/></svg>',
    facebook:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H7.8v3h2.6V21h3.1z"/></svg>',
  };

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let state = null;
  let view = 'today';
  let tab = 'today';
  let lockMinutes = readLockMinutes();
  let appliedTheme = '';
  let toastTimer = 0;
  let resetTimer = 0;

  /* ---------- small helpers ---------- */

  function readLockMinutes() {
    try {
      const value = Number(localStorage.getItem('iblock:lockMinutes'));
      return I.LOCK_PRESETS.includes(value) ? value : 60;
    } catch {
      return 60;
    }
  }

  function remember(key, value) {
    try {
      localStorage.setItem(`iblock:${key}`, String(value));
    } catch {
      // Only a convenience; nothing breaks without it.
    }
  }

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html) node.append(I.markup(html));
    return node;
  }

  const toHHMM = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

  function fromHHMM(value) {
    const m = /^(\d{2}):(\d{2})/.exec(value || '');
    if (!m) return null;
    const minute = Number(m[1]) * 60 + Number(m[2]);
    return minute < 1440 ? minute : null;
  }

  function toast(text) {
    const node = $('toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  }

  const failure = (res, fallback) => (res?.error === 'strict' ? STRICT_MSG : fallback);

  /* ---------- static structure ---------- */

  function build() {
    $('todayApps').replaceChildren(
      ...I.PLATFORMS.map((p) => {
        const li = el('li', 'app', `${GLYPHS[p.id]}<span class="app-n">0</span>`);
        li.dataset.id = p.id;
        return li;
      }),
    );

    $('lockChips').replaceChildren(
      ...I.LOCK_PRESETS.map((min) => {
        const chip = el('button', 'chip');
        chip.type = 'button';
        chip.dataset.min = String(min);
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-label', I.fmtLockLength(min));
        chip.textContent = I.fmtLockChip(min);
        chip.addEventListener('click', () => pickLock(min));
        return chip;
      }),
    );

    $('plot').append(...Array.from({ length: 7 }, () => el('div', 'col', '<span class="col-val"></span><span class="col-bar"></span>')));
    $('days').append(...Array.from({ length: 7 }, () => el('span')));

    $('appList').replaceChildren(
      ...I.PLATFORMS.map((p) => {
        const li = el(
          'li',
          'app-row',
          `<span class="tile">${GLYPHS[p.id]}</span><span class="app-name">${p.name}</span><span class="app-count"><b></b> · <span class="app-time"></span></span><span class="app-bar"><span></span></span>`,
        );
        li.dataset.id = p.id;
        return li;
      }),
    );

    $('siteList').replaceChildren(
      ...I.PLATFORMS.map((p) => {
        const row = el(
          'label',
          'row',
          `<span class="tile">${GLYPHS[p.id]}</span><span class="row-text"><span class="row-title">${p.name}</span><span class="row-desc">${p.where}</span></span><input type="checkbox" class="switch" role="switch">`,
        );
        const input = row.querySelector('input');
        input.dataset.site = p.id;
        input.addEventListener('change', () => patch({ sites: { [p.id]: input.checked } }));
        return row;
      }),
    );

    $('version').textContent = `Iblock ${ext.runtime.getManifest().version} · Everything stays on this device`;
  }

  /* ---------- rendering ---------- */

  function render() {
    if (!state) return;
    const now = Date.now();
    const st = I.status(state, now);
    applyTheme();
    if (view === 'today') {
      renderHero(st, now);
      renderAction(st, now);
      renderLimit(st);
    } else if (view === 'insights') {
      renderInsights(st, now);
    } else {
      renderSettings(st, now);
    }
  }

  function applyTheme() {
    const pref = state.settings.theme;
    const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
    const key = `${pref}|${dark}`;
    if (key === appliedTheme) return;
    appliedTheme = key;
    if (pref === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pref;
    remember('theme', pref);
    const btn = $('themeBtn');
    btn.dataset.mode = dark ? 'dark' : 'light';
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', btn.title);
  }

  function heroCopy(st, now) {
    const { t, b } = st.today;
    const watched = `${I.fmtDuration(t)} watched`;
    switch (st.reason) {
      case 'lock':
        return ['Short-form locked', `${watched} · ${I.fmtNum(b)} blocked`];
      case 'bedtime':
        return ['Bedtime', `Short-form is off until ${I.fmtUntil(st.until, now)}`];
      case 'off':
        return ['Blocked completely', `${I.plural(b, 'short', 'shorts')} blocked today`];
      case 'limit':
        return ['Limit reached', `Resets in ${I.fmtLeft(st.until - now)}`];
      default:
        if (st.limit === null) return ['No daily limit', `Just counting · ${watched}`];
        return [st.left === 1 ? '1 scroll left' : `${I.fmtNum(st.left)} scrolls left`, `${watched} · ${I.fmtNum(b)} blocked`];
    }
  }

  function renderHero(st, now) {
    const { today, limit } = st;
    $('ringNum').textContent = I.fmtNum(today.n);
    $('ringSub').textContent = limit === null || limit === 0 ? (today.n === 1 ? 'scroll' : 'scrolls') : `of ${I.fmtNum(limit)}`;
    const progress = limit === null ? 0 : limit === 0 ? 1 : Math.min(1, today.n / limit);
    const fill = $('ringFill');
    fill.style.strokeDasharray = String(RING);
    fill.style.strokeDashoffset = String(RING * (1 - progress));
    fill.style.opacity = progress > 0 ? '1' : '0';

    const [title, meta] = heroCopy(st, now);
    $('heroDate').textContent = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    $('heroTitle').textContent = title;
    $('heroMeta').textContent = meta;

    for (const li of $('todayApps').children) {
      const p = I.platformById(li.dataset.id);
      const n = today.p[p.id] || 0;
      const on = state.settings.sites[p.id];
      li.querySelector('.app-n').textContent = I.fmtNum(n);
      li.classList.toggle('off', !on);
      li.title = on ? `${p.name}: ${I.plural(n, 'scroll', 'scrolls')} today` : `${p.name} is turned off`;
      li.setAttribute('aria-label', li.title);
    }
  }

  function renderAction(st, now) {
    const lock = st.locked ? state.lock : null;
    $('breakCard').hidden = Boolean(lock);
    $('lockCard').hidden = !lock;
    if (lock) {
      const strict = state.settings.strict;
      $('lockCountdown').textContent = I.fmtCountdown(lock.until - now);
      $('lockProgress').style.transform = `scaleX(${Math.min(1, Math.max(0, (now - lock.start) / (lock.until - lock.start)))})`;
      $('lockMeta').textContent = `Until ${I.fmtUntil(lock.until, now)}`;
      $('extendBtn').disabled = lock.until - now > (I.MAX_LOCK_MIN - 60) * 60_000;
      $('unlockBtn').hidden = strict;
      $('lockStrictNote').hidden = !strict;
    }
    for (const chip of $('lockChips').children) {
      const on = Number(chip.dataset.min) === lockMinutes;
      chip.setAttribute('aria-checked', String(on));
      chip.tabIndex = on ? 0 : -1;
    }
    $('lockBtn').textContent = `Lock for ${I.fmtLockLength(lockMinutes)}`;
  }

  function renderLimit(st) {
    const { limit } = state.settings;
    $('limitValue').textContent = limit === null ? '∞' : String(limit);
    $('limitDesc').textContent =
      limit === null ? 'No limit, just counting' : limit === 0 ? 'Short-form is blocked completely' : `Locks after ${I.plural(limit, 'scroll', 'scrolls')} a day`;
    $('limitDown').disabled = I.stepLimit(limit, -1) === limit;
    const up = $('limitUp');
    up.disabled = I.stepLimit(limit, 1) === limit || st.frozen;
    up.title = st.frozen ? 'Strict mode is on' : '';
  }

  function renderInsights(st, now) {
    const { stats } = state;
    const month = I.monthTotals(stats, now);
    $('sMonth').textContent = I.fmtNum(month.n);
    $('sMonthTime').textContent = I.fmtDuration(month.t);
    $('sMonthTime').parentElement.title = `${I.fmtDuration(month.t)} watched this month`;
    $('sLife').textContent = I.fmtNum(stats.life.n);
    $('sLifeTime').textContent = I.fmtDuration(stats.life.t);
    $('sLifeTime').parentElement.title = `${I.fmtDuration(stats.life.t)} watched in total`;
    const streak = I.streak(stats, now);
    $('sStreak').textContent = I.fmtNum(streak);
    $('sStreakSub').textContent = streak === 1 ? 'day on track' : 'days on track';

    renderChart(st, now);

    const blocked = stats.life.b;
    $('savedTitle').textContent = blocked ? `${I.plural(blocked, 'short', 'shorts')} blocked` : 'Nothing blocked yet';
    $('savedSub').textContent = blocked ? "Every one is a scroll you didn't take." : 'Shorts Iblock stops for you show up here.';

    const life = stats.life;
    const top = Math.max(1, ...I.PLATFORM_IDS.map((id) => life.p[id] || 0));
    const rows = [...$('appList').children];
    for (const li of rows) {
      const n = life.p[li.dataset.id] || 0;
      li.querySelector('.app-count b').textContent = I.fmtNum(n);
      li.querySelector('.app-time').textContent = I.fmtDuration(life.tp[li.dataset.id] || 0);
      li.querySelector('.app-bar span').style.transform = `scaleX(${n / top})`;
    }
    const sorted = rows.slice().sort((a, b) => (life.p[b.dataset.id] || 0) - (life.p[a.dataset.id] || 0));
    if (sorted.some((li, i) => li !== rows[i])) $('appList').append(...sorted);

    const since = new Date(stats.since).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    $('since').textContent = `Counting since ${since}. Everything stays on this device.`;
  }

  function renderChart(st, now) {
    const { stats } = state;
    const week = I.series(stats, now, 7);
    const values = week.map((d) => d.n);
    let max = Math.max(1, ...values);
    const showLine = st.limit > 0 && st.limit <= max * 1.6;
    if (showLine) max = Math.max(max, st.limit);

    const cols = $('plot').querySelectorAll('.col');
    const days = $('days').children;
    const spoken = [];
    week.forEach((d, i) => {
      const weekday = new Date(d.ts).toLocaleDateString([], { weekday: 'short' });
      cols[i].classList.toggle('today', d.today);
      cols[i].title = `${d.today ? 'Today' : weekday}: ${I.plural(d.n, 'scroll', 'scrolls')}`;
      cols[i].querySelector('.col-val').textContent = d.n ? I.fmtNum(d.n) : '';
      cols[i].querySelector('.col-bar').style.height = `${Math.max(3, Math.round((d.n / max) * BAR_AREA))}px`;
      days[i].textContent = d.today ? 'Today' : weekday;
      days[i].classList.toggle('today', d.today);
      spoken.push(`${d.today ? 'today' : weekday} ${d.n}`);
    });
    $('chart').setAttribute('aria-label', `Scrolls over the last 7 days: ${spoken.join(', ')}`);

    const line = $('limitLine');
    line.hidden = !showLine;
    if (showLine) {
      line.style.bottom = `${Math.round((st.limit / max) * BAR_AREA)}px`;
      line.title = `Daily limit: ${st.limit}`;
    }

    const thisWeek = values.reduce((a, b) => a + b, 0);
    const prev = I.series(stats, now, 7, 7);
    const lastWeek = prev.reduce((a, d) => a + d.n, 0);
    const delta = $('weekDelta');
    if (stats.since <= prev[0].ts && lastWeek > 0) {
      const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
      delta.textContent = pct === 0 ? 'Same as last week' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}% vs last week`;
      delta.classList.toggle('up', pct > 0);
    } else {
      delta.textContent = `${I.fmtNum(thisWeek)} this week`;
      delta.classList.remove('up');
    }
  }

  function renderSettings(st, now) {
    const s = state.settings;
    const { frozen } = st;
    const banner = $('strictBanner');
    banner.hidden = !frozen;
    if (frozen) {
      const when = st.reason === 'limit' ? 'midnight' : I.fmtUntil(st.until, now);
      banner.textContent = `Strict mode is on. You can tighten settings, but loosening them waits until ${when}.`;
    }

    for (const input of $('siteList').querySelectorAll('input')) {
      input.checked = s.sites[input.dataset.site];
      input.disabled = frozen && input.checked;
    }

    const bedLocked = frozen && s.bedtime.on;
    $('bedtimeOn').checked = s.bedtime.on;
    $('bedtimeOn').disabled = bedLocked;
    $('bedtimeTimes').hidden = !s.bedtime.on;
    for (const [id, minute] of [
      ['bedFrom', s.bedtime.from],
      ['bedTo', s.bedtime.to],
    ]) {
      const input = $(id);
      if (document.activeElement !== input) input.value = toHHMM(minute);
      input.disabled = bedLocked;
    }

    $('strictOn').checked = s.strict;
    $('strictOn').disabled = frozen;
    $('hudOn').checked = s.hud;
    $('hideOn').checked = s.hide;
    $('badgeOn').checked = s.badge;
    for (const radio of document.querySelectorAll('input[name="theme"]')) radio.checked = radio.value === s.theme;
    $('resetBtn').disabled = frozen;
  }

  /* ---------- actions ---------- */

  async function patch(changes) {
    const res = await I.send({ type: 'settings', patch: changes });
    if (res?.ok) {
      state.settings = res.settings;
    } else {
      toast(failure(res, "Couldn't save that. Try again."));
    }
    render();
    return Boolean(res?.ok);
  }

  function pickLock(min) {
    lockMinutes = min;
    remember('lockMinutes', min);
    render();
  }

  async function startLock(minutes, extend) {
    const res = await I.send({ type: 'lock', minutes, extend });
    if (!res?.ok) {
      toast(failure(res, "Couldn't start the lock. Try again."));
      return;
    }
    state.lock = res.lock;
    render();
    toast(`Locked until ${I.fmtUntil(res.lock.until)}.`);
  }

  function setView(next) {
    view = next;
    const settings = next === 'settings';
    if (!settings) tab = next;
    $('tabs').hidden = settings;
    $('tabs').dataset.active = tab;
    $('brand').hidden = settings;
    $('backBtn').hidden = !settings;
    $('viewTitle').hidden = !settings;
    $('settingsBtn').setAttribute('aria-pressed', String(settings));
    $('view-today').hidden = next !== 'today';
    $('view-insights').hidden = next !== 'insights';
    $('view-settings').hidden = !settings;
    for (const name of ['today', 'insights']) {
      const button = $(`tab-${name}`);
      button.setAttribute('aria-selected', String(name === tab));
      button.tabIndex = name === tab ? 0 : -1;
    }
    $('main').scrollTop = 0;
    render();
  }

  // Arrow keys move between options in a radio-like group (tabs, lock lengths).
  function arrowNav(container, onPick) {
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const items = [...container.children].filter((n) => n.tagName === 'BUTTON');
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
      next.focus();
      onPick(next);
    });
  }

  function wire() {
    $('tab-today').addEventListener('click', () => setView('today'));
    $('tab-insights').addEventListener('click', () => setView('insights'));
    arrowNav($('tabs'), (button) => setView(button.id.replace('tab-', '')));
    arrowNav($('lockChips'), (chip) => pickLock(Number(chip.dataset.min)));
    $('settingsBtn').addEventListener('click', () => setView(view === 'settings' ? tab : 'settings'));
    $('backBtn').addEventListener('click', () => setView(tab));

    $('themeBtn').addEventListener('click', () => {
      const dark = $('themeBtn').dataset.mode === 'dark';
      state.settings = { ...state.settings, theme: dark ? 'light' : 'dark' };
      render();
      patch({ theme: state.settings.theme });
    });

    $('lockBtn').addEventListener('click', () => startLock(lockMinutes, false));
    $('extendBtn').addEventListener('click', () => startLock(60, true));
    I.holdButton($('unlockBtn'), async () => {
      const res = await I.send({ type: 'unlock' });
      if (!res?.ok) {
        toast(failure(res, "Couldn't end the lock. Try again."));
        return;
      }
      state.lock = null;
      render();
      toast('Lock ended.');
    });

    $('limitDown').addEventListener('click', () => patch({ limit: I.stepLimit(state.settings.limit, -1) }));
    $('limitUp').addEventListener('click', () => patch({ limit: I.stepLimit(state.settings.limit, 1) }));

    $('bedtimeOn').addEventListener('change', (e) => patch({ bedtime: { on: e.target.checked } }));
    for (const [id, key, other] of [
      ['bedFrom', 'from', 'to'],
      ['bedTo', 'to', 'from'],
    ]) {
      $(id).addEventListener('change', (e) => {
        const minute = fromHHMM(e.target.value);
        if (minute === null) return render();
        if (minute === state.settings.bedtime[other]) {
          toast('Bedtime needs two different times.');
          return render();
        }
        patch({ bedtime: { [key]: minute } });
      });
    }

    for (const [id, key] of [
      ['strictOn', 'strict'],
      ['hudOn', 'hud'],
      ['hideOn', 'hide'],
      ['badgeOn', 'badge'],
    ]) {
      $(id).addEventListener('change', (e) => patch({ [key]: e.target.checked }));
    }
    for (const radio of document.querySelectorAll('input[name="theme"]')) {
      radio.addEventListener('change', () => patch({ theme: radio.value }));
    }

    const resetBtn = $('resetBtn');
    const disarm = () => {
      clearTimeout(resetTimer);
      resetBtn.classList.remove('armed');
      resetBtn.textContent = 'Reset';
    };
    resetBtn.addEventListener('click', async () => {
      if (!resetBtn.classList.contains('armed')) {
        resetBtn.classList.add('armed');
        resetBtn.textContent = 'Tap to confirm';
        resetTimer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      const res = await I.send({ type: 'reset' });
      toast(res?.ok ? 'Statistics erased.' : failure(res, "Couldn't reset. Try again."));
    });

    $('permBtn').addEventListener('click', async () => {
      try {
        $('perm').hidden = await ext.permissions.request({ origins: I.HOST_PATTERNS });
      } catch {
        toast("Couldn't request access. Try again from the extensions page.");
      }
    });

    darkQuery.addEventListener('change', () => {
      appliedTheme = '';
      render();
    });

    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !state) return;
      if (changes.settings) state.settings = I.normalizeSettings(changes.settings.newValue);
      if (changes.stats) state.stats = I.normalizeStats(changes.stats.newValue);
      if (changes.lock) state.lock = I.normalizeLock(changes.lock.newValue);
      render();
    });
  }

  // Firefox asks for site access separately from install; make that visible.
  async function checkAccess() {
    try {
      $('perm').hidden = await ext.permissions.contains({ origins: I.HOST_PATTERNS });
    } catch {
      $('perm').hidden = true;
    }
  }

  async function init() {
    build();
    wire();
    state = I.normalizeState(await ext.storage.local.get(['settings', 'stats', 'lock']));
    setView('today');
    setInterval(render, 1000);
    checkAccess();
  }

  init().catch(() => toast("Iblock couldn't load its data. Try reopening this menu."));
})();
