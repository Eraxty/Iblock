/*
 * Iblock popup: today's numbers, quick locks, insights and settings. The same
 * page also runs inside the lock screen (#embedded) and in a tab (#insights,
 * from the weekly report notification).
 */
(() => {
  'use strict';

  const I = globalThis.Iblock;
  const { ext } = I;
  const $ = (id) => document.getElementById(id);
  const RING = 2 * Math.PI * 44;
  const BAR_AREA = 92; // px of the 112px plot used by bars; the rest fits the value label
  const STRICT_MSG = 'Strict mode is on. You can loosen this once the lock is over.';
  const CUSTOM = 'custom';
  const MAX_LIMIT = 999;
  const MAX_MINUTES = 1440;

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
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z"/></svg>',
    reddit:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="14" rx="8" ry="6"/><path d="M12 8l1.2-4.2 3.6 1"/><path d="M9.3 16.6c1.6 1 3.8 1 5.4 0"/></g><circle cx="18.4" cy="5" r="1.5" fill="currentColor"/><circle cx="9.2" cy="13.2" r="1.2" fill="currentColor"/><circle cx="14.8" cy="13.2" r="1.2" fill="currentColor"/></svg>',
    pinterest:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10.4 20.6 12.3 12"/><path d="M10.9 13.9c.5.5 1.3.8 2.1.8 2 0 3.4-1.8 3.4-3.9 0-2.4-2-4.1-4.5-4.1-2.7 0-4.5 1.9-4.5 4.2 0 .9.3 1.6.8 2.1"/></g></svg>',
  };

  const BADGE_ICONS = {
    firstLock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    lockDone: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>',
    zeroDay: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    streak: '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.3 3.6-8.3.3-.9 1.4-1.1 2-.4 1 1.2 1.4 2.6 1.4 3.9 1-.6 1.6-1.6 1.8-2.6.2-.8 1.2-1 1.7-.3 1.4 1.9 2.5 4.3 2.5 7.6 0 3.7-2.6 6.3-6.5 6.3z"/>',
    blocked: '<path d="M12 21s7-3.5 7-9.5V5.5L12 3 5 5.5v6C5 17.5 12 21 12 21z"/><path d="m9 12 2 2 4-4"/>',
  };
  const badgeIcon = (b) => BADGE_ICONS[b.id] || (b.streak ? BADGE_ICONS.streak : BADGE_ICONS.blocked);

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let state = null;
  let view = 'today';
  let tab = 'today';
  let lockChoice = readLockChoice(); // a preset length in minutes, or CUSTOM
  let customMinutes = readCustomMinutes();
  let appliedTheme = '';
  let toastTimer = 0;
  let resetTimer = 0;

  /* ---------- small helpers ---------- */

  function recall(key) {
    try {
      return localStorage.getItem(`iblock:${key}`);
    } catch {
      return null;
    }
  }

  function remember(key, value) {
    try {
      localStorage.setItem(`iblock:${key}`, String(value));
    } catch {
      // Only a convenience; nothing breaks without it.
    }
  }

  function readLockChoice() {
    const value = recall('lockChoice');
    if (value === CUSTOM) return CUSTOM;
    return I.LOCK_PRESETS.includes(Number(value)) ? Number(value) : 60;
  }

  function readCustomMinutes() {
    const value = Number(recall('customMinutes'));
    return validLockLength(value) ? value : 120;
  }

  // Declarations, not arrow consts: readCustomMinutes() runs before this point.
  function validLockLength(min) {
    return Number.isInteger(min) && min >= 1 && min <= I.MAX_LOCK_MIN;
  }

  function selectedMinutes() {
    return lockChoice === CUSTOM ? customMinutes : lockChoice;
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
    if (!text) return;
    const node = $('toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  }

  // What to tell the user when a request didn't go through ('' to say nothing).
  function failure(res, fallback) {
    if (res?.error === 'cancelled') return '';
    if (res?.error === 'strict') return STRICT_MSG;
    return fallback;
  }

  // Number fields keep only digits, capped at `max`.
  function digitsOnly(input, max) {
    const digits = input.value.replace(/\D/g, '');
    const value = digits && Number(digits) > max ? String(max) : digits;
    if (value !== input.value) input.value = value;
    return value;
  }

  // Clicking into a number selects it, so typing replaces it.
  function selectOnFocus(input) {
    let focusing = false;
    input.addEventListener('focus', () => {
      input.select();
      focusing = true;
    });
    input.addEventListener('mouseup', (e) => {
      if (focusing) e.preventDefault();
      focusing = false;
    });
  }

  /* ---------- password lock ---------- */

  // Resolves with what was typed, or null when cancelled.
  function passwordDialog({ title, text, action, confirm = false, error = '' }) {
    return new Promise((resolve) => {
      const modal = $('pwModal');
      const form = $('pwForm');
      const input = $('pwInput');
      const again = $('pwConfirm');
      $('pwTitle').textContent = title;
      $('pwText').textContent = text;
      $('pwOk').textContent = action;
      $('pwError').textContent = error;
      input.value = '';
      again.value = '';
      again.hidden = !confirm;
      input.placeholder = confirm ? 'New password, 4+ characters' : 'Password';
      modal.hidden = false;
      input.focus();

      const done = (value) => {
        modal.hidden = true;
        form.removeEventListener('submit', onSubmit);
        $('pwCancel').removeEventListener('click', onCancel);
        modal.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const value = input.value;
        let problem = '';
        if (!value) problem = 'Type the password.';
        else if (confirm && value.length < 4) problem = 'Use at least 4 characters.';
        else if (confirm && value !== again.value) problem = "The two don't match.";
        if (problem) {
          $('pwError').textContent = problem;
          return;
        }
        done(value);
      };
      const onCancel = () => done(null);
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          done(null);
        }
      };
      form.addEventListener('submit', onSubmit);
      $('pwCancel').addEventListener('click', onCancel);
      modal.addEventListener('keydown', onKey);
    });
  }

  // Sends a message; when the password lock wants the password, asks for it
  // and tries again.
  async function guarded(message, what) {
    let res = await I.send(message);
    while (res?.error === 'password' || res?.error === 'wrong-password') {
      const password = await passwordDialog({
        title: 'Password needed',
        text: `Iblock is password locked. Enter the password to ${what}.`,
        action: 'Continue',
        error: res.error === 'wrong-password' ? "That's not the password." : '',
      });
      if (password === null) return { ok: false, error: 'cancelled' };
      res = await I.send({ ...message, password });
    }
    return res;
  }

  async function setPassword() {
    let current;
    if (state.guard) {
      current = await passwordDialog({ title: 'Change password', text: 'First, the current password.', action: 'Continue' });
      if (current === null) return;
    }
    const password = await passwordDialog({
      title: state.guard ? 'New password' : 'Set a password',
      text: "Best set by someone else. If it's forgotten, the only way out is reinstalling Iblock, which erases your stats.",
      action: 'Save password',
      confirm: true,
    });
    if (password === null) return;
    const res = await I.send({ type: 'password', password, current });
    if (res?.ok) toast('Password lock is on.');
    else toast(res?.error === 'wrong-password' ? "That's not the current password." : "Couldn't save the password.");
  }

  async function removePassword() {
    let error = '';
    for (;;) {
      const current = await passwordDialog({ title: 'Remove password', text: 'Enter the password to turn the lock off.', action: 'Remove', error });
      if (current === null) return;
      const res = await I.send({ type: 'password', password: '', current });
      if (res?.ok) {
        toast('Password lock is off.');
        return;
      }
      if (res?.error !== 'wrong-password') {
        toast("Couldn't remove the password.");
        return;
      }
      error = "That's not the password.";
    }
  }

  /* ---------- static structure ---------- */

  function build() {
    $('todayApps').replaceChildren(
      ...I.SHORT_PLATFORMS.map((p) => {
        const li = el('li', 'app', `${GLYPHS[p.id]}<span class="app-n">0</span>`);
        li.dataset.id = p.id;
        return li;
      }),
    );

    $('lockChips').replaceChildren(
      ...[...I.LOCK_PRESETS, CUSTOM].map((choice) => {
        const chip = el('button', 'chip');
        chip.type = 'button';
        chip.dataset.choice = String(choice);
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-label', choice === CUSTOM ? 'Custom length' : I.fmtLength(choice));
        chip.textContent = choice === CUSTOM ? 'Custom' : I.fmtLockChip(choice);
        chip.addEventListener('click', () => pickLock(choice));
        return chip;
      }),
    );
    $('bonusBtn').querySelector('.label').textContent = `Hold for ${I.BONUS_SCROLLS} more`;

    $('plot').append(...Array.from({ length: 7 }, () => el('div', 'col', '<span class="col-val"></span><span class="col-bar"></span>')));
    $('days').append(...Array.from({ length: 7 }, () => el('span')));
    $('hours').append(...Array.from({ length: 24 }, () => el('span')));
    $('hourLabels').append(...[0, 6, 12, 18].map((h) => Object.assign(el('span'), { textContent: I.fmtHour(h) })));

    $('badges').replaceChildren(
      ...I.BADGES.map((b) => {
        const li = el('li', 'badge-item', `<span class="badge-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${badgeIcon(b)}</svg></span><span class="badge-name"></span>`);
        li.dataset.id = b.id;
        li.querySelector('.badge-name').textContent = b.title;
        return li;
      }),
    );

    $('appList').replaceChildren(
      ...I.PLATFORMS.map((p) => {
        const li = el(
          'li',
          'app-row',
          `<span class="tile">${GLYPHS[p.id]}</span><span class="app-name"></span><span class="app-count"></span><span class="app-bar"><span></span></span>`,
        );
        li.dataset.id = p.id;
        li.querySelector('.app-name').textContent = p.name;
        return li;
      }),
    );

    for (const [listId, kind] of [
      ['siteList', 'short'],
      ['feedList', 'feed'],
    ]) {
      $(listId).replaceChildren(
        ...I.PLATFORMS.filter((p) => p.kind === kind).map((p) => {
          const row = el(
            'label',
            'row',
            `<span class="tile">${GLYPHS[p.id]}</span><span class="row-text"><span class="row-title"></span><span class="row-desc"></span></span><input type="checkbox" class="switch" role="switch">`,
          );
          row.querySelector('.row-title').textContent = p.name;
          row.querySelector('.row-desc').textContent = p.where;
          const input = row.querySelector('input');
          input.dataset.site = p.id;
          input.addEventListener('change', () => patch({ sites: { [p.id]: input.checked } }));
          return row;
        }),
      );
    }

    const version = `Iblock ${ext.runtime.getManifest().version}`;
    $('version').textContent = `${version} · Everything stays on this device`;
    // Show the real shortcut, in case it was changed or taken by something else.
    ext.commands
      ?.getAll()
      .then((commands) => {
        const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
        if (shortcut) $('version').textContent = `${version} · Open anytime with ${shortcut}`;
      })
      .catch(() => {});
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
    const watched = st.minutes ? `${I.fmtDuration(t)} of ${I.fmtDuration(st.minutes * 60)}` : `${I.fmtDuration(t)} watched`;
    switch (st.reason) {
      case 'lock':
        return ['Short-form locked', `${watched} · ${I.fmtNum(b)} blocked`];
      case 'bedtime':
        return ['Bedtime', `Short-form is off until ${I.fmtUntil(st.until, now)}`];
      case 'off':
        return ['Blocked completely', `${I.plural(b, 'short', 'shorts')} blocked today`];
      case 'limit':
        return ['Limit reached', `Resets in ${I.fmtLeft(st.until - now)}`];
      case 'time':
        return ['Time limit reached', `Resets in ${I.fmtLeft(st.until - now)}`];
      default:
        if (st.allowance === null) return ['No daily limit', `${watched} · ${I.fmtNum(b)} blocked`];
        return [st.left === 1 ? '1 scroll left' : `${I.fmtNum(st.left)} scrolls left`, `${watched} · ${I.fmtNum(b)} blocked`];
    }
  }

  function renderHero(st, now) {
    const { today, allowance } = st;
    $('ringNum').textContent = I.fmtNum(today.n);
    $('ringSub').textContent = !allowance ? (today.n === 1 ? 'scroll' : 'scrolls') : `of ${I.fmtNum(allowance)}`;
    const progress = allowance === null ? 0 : allowance === 0 ? 1 : Math.min(1, today.n / allowance);
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
    const bonus = !lock && st.canBonus;
    $('breakCard').hidden = Boolean(lock) || bonus;
    $('bonusCard').hidden = !bonus;
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
      const on = chip.dataset.choice === String(lockChoice);
      chip.setAttribute('aria-checked', String(on));
      chip.tabIndex = on ? 0 : -1;
    }
    const custom = lockChoice === CUSTOM;
    $('customFields').hidden = !custom;
    if (custom) {
      for (const [id, value] of [
        ['customH', Math.floor(customMinutes / 60)],
        ['customM', customMinutes % 60],
      ]) {
        const input = $(id);
        if (document.activeElement !== input) input.value = String(value);
      }
    }
    const minutes = selectedMinutes();
    const ok = validLockLength(minutes);
    const lockBtn = $('lockBtn');
    lockBtn.disabled = !ok;
    lockBtn.textContent = ok ? `Lock for ${I.fmtLength(minutes)}` : minutes < 1 ? 'Pick a length' : '7 days max';
  }

  function renderLimit(st) {
    const { limit } = state.settings;
    const input = $('limitValue');
    if (document.activeElement !== input) input.value = limit === null ? '∞' : String(limit);
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
    renderHours(now);

    const blocked = stats.life.b;
    $('savedTitle').textContent = blocked ? `${I.plural(blocked, 'short', 'shorts')} blocked` : 'Nothing blocked yet';
    $('savedSub').textContent = blocked ? "Every one is a scroll you didn't take." : 'Shorts Iblock stops for you show up here.';

    let earned = 0;
    for (const li of $('badges').children) {
      const badge = I.BADGES.find((b) => b.id === li.dataset.id);
      const when = stats.badges[badge.id];
      if (when) earned++;
      li.classList.toggle('earned', Boolean(when));
      li.title = when ? `${badge.desc}. Earned ${new Date(when).toLocaleDateString([], { month: 'short', day: 'numeric' })}.` : `${badge.desc}.`;
    }
    $('badgeCount').textContent = `${earned} of ${I.BADGES.length}`;

    // By time watched, so short-form and feeds sit on one scale.
    const life = stats.life;
    const top = Math.max(1, ...I.PLATFORM_IDS.map((id) => life.tp[id] || 0));
    const rows = [...$('appList').children];
    for (const li of rows) {
      const id = li.dataset.id;
      const p = I.platformById(id);
      const n = life.p[id] || 0;
      const t = life.tp[id] || 0;
      li.hidden = !state.settings.sites[id] && !n && !t;
      const count = li.querySelector('.app-count');
      count.replaceChildren();
      if (p.kind === 'short') count.append(Object.assign(el('b'), { textContent: I.fmtNum(n) }), ` · ${I.fmtDuration(t)}`);
      else count.append(Object.assign(el('b'), { textContent: I.fmtDuration(t) }));
      li.querySelector('.app-bar span').style.transform = `scaleX(${t / top})`;
    }
    const sorted = rows.slice().sort((a, b) => (life.tp[b.dataset.id] || 0) - (life.tp[a.dataset.id] || 0));
    if (sorted.some((li, i) => li !== rows[i])) $('appList').append(...sorted);

    const since = new Date(stats.since).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    $('since').textContent = `Counting since ${since}. Everything stays on this device.`;
  }

  function renderChart(st, now) {
    const { stats } = state;
    const week = I.series(stats, now, 7);
    const values = week.map((d) => d.n);
    let max = Math.max(1, ...values);
    const showLine = st.allowance > 0 && st.allowance <= max * 1.6;
    if (showLine) max = Math.max(max, st.allowance);

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
      line.style.bottom = `${Math.round((st.allowance / max) * BAR_AREA)}px`;
      line.title = `Daily limit: ${st.allowance}`;
    }

    const { thisWeek, pct } = I.weekSummary(stats, now);
    const delta = $('weekDelta');
    if (pct === null) {
      delta.textContent = `${I.fmtNum(thisWeek.n)} this week`;
      delta.classList.remove('up');
    } else {
      delta.textContent = pct === 0 ? 'Same as last week' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}% vs last week`;
      delta.classList.toggle('up', pct > 0);
    }
  }

  function renderHours(now) {
    const hours = I.hourTotals(state.stats, now, 30);
    const max = Math.max(...hours);
    const peak = max ? hours.indexOf(max) : -1;
    [...$('hours').children].forEach((bar, h) => {
      bar.style.height = `${max ? Math.max(2, Math.round((hours[h] / max) * 64)) : 2}px`;
      bar.classList.toggle('peak', h === peak);
      bar.title = `${I.fmtHour(h)}: ${I.plural(hours[h], 'scroll', 'scrolls')}`;
    });
    $('peakHour').textContent = peak < 0 ? 'Last 30 days' : `Most around ${I.fmtHour(peak)}`;
    $('hours').setAttribute(
      'aria-label',
      peak < 0 ? 'No scrolls in the last 30 days' : `Scrolls by hour over the last 30 days. Most around ${I.fmtHour(peak)}.`,
    );
  }

  function renderSettings(st, now) {
    const s = state.settings;
    const { frozen } = st;
    const banner = $('strictBanner');
    banner.hidden = !frozen;
    if (frozen) {
      const when = st.reason === 'limit' || st.reason === 'time' ? 'midnight' : I.fmtUntil(st.until, now);
      banner.textContent = `Strict mode is on. You can tighten settings, but loosening them waits until ${when}.`;
    }

    for (const input of document.querySelectorAll('#siteList input, #feedList input')) {
      input.checked = s.sites[input.dataset.site];
      input.disabled = frozen && input.checked;
    }

    const { minutes } = s;
    const minutesInput = $('minutesValue');
    if (document.activeElement !== minutesInput) minutesInput.value = minutes === null ? 'Off' : String(minutes);
    $('minutesDesc').textContent = minutes === null ? 'Off. Only the scroll limit counts.' : `Locks after ${I.fmtLength(minutes)} a day, feeds included`;
    $('minutesDown').disabled = I.stepMinutes(minutes, -1) === minutes;
    $('minutesUp').disabled = I.stepMinutes(minutes, 1) === minutes || frozen;

    // A switch that would loosen things can't be turned off while strict mode holds.
    for (const input of document.querySelectorAll('input[data-setting]')) {
      const key = input.dataset.setting;
      input.checked = s[key];
      input.disabled = frozen && s[key] && I.loosens(s, { ...s, [key]: false });
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

    const locked = Boolean(state.guard);
    $('pwDesc').textContent = locked ? 'On. Loosening limits, unlocking early and resetting need the password.' : 'Off. Ask someone you trust to set one.';
    $('pwSetBtn').textContent = locked ? 'Change' : 'Set';
    $('pwRemoveBtn').hidden = !locked;

    for (const radio of document.querySelectorAll('input[name="theme"]')) radio.checked = radio.value === s.theme;
    $('resetBtn').disabled = frozen;
  }

  /* ---------- actions ---------- */

  async function patch(changes) {
    const res = await guarded({ type: 'settings', patch: changes }, 'change this setting');
    if (res?.ok) state.settings = res.settings;
    else toast(failure(res, "Couldn't save that. Try again."));
    render();
    return Boolean(res?.ok);
  }

  function pickLock(choice) {
    lockChoice = choice;
    remember('lockChoice', choice);
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

  // A stepper whose number can also be typed: `steps` through presets with
  // -/+, any whole number up to `max` by typing. `none` is shown for null.
  function wireStepper({ input, down, up, max, get, stepper, none, save }) {
    selectOnFocus(input);
    down.addEventListener('click', () => save(stepper(get(), -1)));
    up.addEventListener('click', () => save(stepper(get(), 1)));
    input.addEventListener('input', () => digitsOnly(input, max));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      const typed = digitsOnly(input, max);
      if (!typed || Number(typed) === get()) {
        input.value = get() === null ? none : String(get());
        return;
      }
      save(Number(typed));
    });
  }

  function wire() {
    $('tab-today').addEventListener('click', () => setView('today'));
    $('tab-insights').addEventListener('click', () => setView('insights'));
    arrowNav($('tabs'), (button) => setView(button.id.replace('tab-', '')));
    arrowNav($('lockChips'), (chip) => pickLock(chip.dataset.choice === CUSTOM ? CUSTOM : Number(chip.dataset.choice)));
    $('settingsBtn').addEventListener('click', () => setView(view === 'settings' ? tab : 'settings'));
    $('backBtn').addEventListener('click', () => setView(tab));

    $('themeBtn').addEventListener('click', () => {
      const dark = $('themeBtn').dataset.mode === 'dark';
      state.settings = { ...state.settings, theme: dark ? 'light' : 'dark' };
      render();
      patch({ theme: state.settings.theme });
    });

    $('lockBtn').addEventListener('click', () => startLock(selectedMinutes(), false));
    for (const [id, max] of [
      ['customH', I.MAX_LOCK_MIN / 60],
      ['customM', 59],
    ]) {
      const input = $(id);
      selectOnFocus(input);
      input.addEventListener('input', () => {
        digitsOnly(input, max);
        customMinutes = Number($('customH').value || 0) * 60 + Number($('customM').value || 0);
        if (validLockLength(customMinutes)) remember('customMinutes', customMinutes);
        render();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !$('lockBtn').disabled) startLock(selectedMinutes(), false);
      });
      input.addEventListener('blur', render);
    }
    $('extendBtn').addEventListener('click', () => startLock(60, true));
    I.holdButton($('unlockBtn'), async () => {
      const res = await guarded({ type: 'unlock' }, 'end the lock early');
      if (!res?.ok) {
        toast(failure(res, "Couldn't end the lock. Try again."));
        return;
      }
      state.lock = null;
      render();
      toast('Lock ended.');
    });
    I.holdButton(
      $('bonusBtn'),
      async () => {
        const res = await guarded({ type: 'bonus' }, 'take extra scrolls');
        toast(res?.ok ? `${I.BONUS_SCROLLS} more scrolls. Make them count.` : failure(res, "Couldn't add scrolls."));
      },
      I.HOLD_FOR_BONUS_MS,
    );

    wireStepper({
      input: $('limitValue'),
      down: $('limitDown'),
      up: $('limitUp'),
      max: MAX_LIMIT,
      get: () => state.settings.limit,
      stepper: I.stepLimit,
      none: '∞',
      save: (limit) => patch({ limit }),
    });
    wireStepper({
      input: $('minutesValue'),
      down: $('minutesDown'),
      up: $('minutesUp'),
      max: MAX_MINUTES,
      get: () => state.settings.minutes,
      stepper: I.stepMinutes,
      none: 'Off',
      save: (minutes) => (minutes === 0 ? render() : patch({ minutes })),
    });

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

    for (const input of document.querySelectorAll('input[data-setting]')) {
      input.addEventListener('change', () => patch({ [input.dataset.setting]: input.checked }));
    }
    for (const radio of document.querySelectorAll('input[name="theme"]')) {
      radio.addEventListener('change', () => patch({ theme: radio.value }));
    }
    $('pwSetBtn').addEventListener('click', setPassword);
    $('pwRemoveBtn').addEventListener('click', removePassword);

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
      const res = await guarded({ type: 'reset' }, 'reset your statistics');
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
      if (changes.guard) state.guard = I.normalizeGuard(changes.guard.newValue);
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
    document.documentElement.classList.toggle('embedded', location.hash.includes('embedded'));
    build();
    wire();
    state = I.normalizeState(await ext.storage.local.get(['settings', 'stats', 'lock', 'guard']));
    setView(location.hash.includes('insights') ? 'insights' : 'today');
    setInterval(render, 1000);
    checkAccess();
  }

  init().catch(() => toast("Iblock couldn't load its data. Try reopening this menu."));
})();
