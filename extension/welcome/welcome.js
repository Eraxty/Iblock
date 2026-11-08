/* Welcome page: quick setup on first install. Saves as you go. */
(() => {
  'use strict';

  const I = globalThis.Iblock;
  const { ext } = I;
  const $ = (id) => document.getElementById(id);
  const LIMIT_CHOICES = [5, 10, 20, 30, null];
  let settings = I.normalizeSettings(null);

  function toast(text) {
    const node = $('toast');
    node.textContent = text;
    node.classList.add('show');
    setTimeout(() => node.classList.remove('show'), 2400);
  }

  async function save(patch) {
    const res = await I.send({ type: 'settings', patch });
    if (res?.ok) settings = res.settings;
    else toast("Couldn't save that. Try again from the Iblock menu.");
    render();
  }

  function render() {
    for (const chip of $('limitChips').children) {
      const on = chip.dataset.value === String(settings.limit);
      chip.setAttribute('aria-checked', String(on));
      chip.tabIndex = on ? 0 : -1;
    }
    for (const input of document.querySelectorAll('[data-site]')) input.checked = settings.sites[input.dataset.site];
    for (const input of document.querySelectorAll('[data-setting]')) input.checked = settings[input.dataset.setting];
  }

  function build() {
    $('limitChips').replaceChildren(
      ...LIMIT_CHOICES.map((value) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.setAttribute('role', 'radio');
        chip.dataset.value = String(value);
        chip.textContent = value === null ? 'No limit' : String(value);
        chip.addEventListener('click', () => save({ limit: value }));
        return chip;
      }),
    );

    $('siteList').replaceChildren(
      ...I.PLATFORMS.map((p) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.append(I.markup('<span class="row-text"><span class="row-title"></span><span class="row-desc"></span></span><input type="checkbox" class="switch" role="switch">'));
        row.querySelector('.row-title').textContent = p.name;
        row.querySelector('.row-desc').textContent = p.where;
        const input = row.querySelector('input');
        input.dataset.site = p.id;
        input.addEventListener('change', () => save({ sites: { [p.id]: input.checked } }));
        return row;
      }),
    );

    for (const input of document.querySelectorAll('[data-setting]')) {
      input.addEventListener('change', () => save({ [input.dataset.setting]: input.checked }));
    }

    $('doneBtn').addEventListener('click', async () => {
      const res = await I.send({ type: 'closeTab' });
      if (!res) window.close();
    });

    $('permBtn').addEventListener('click', async () => {
      try {
        $('perm').hidden = await ext.permissions.request({ origins: I.HOST_PATTERNS });
      } catch {
        toast("Couldn't request access. Try again from the extensions page.");
      }
    });

    ext.commands
      ?.getAll()
      .then((commands) => {
        const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
        if (shortcut) $('shortcut').textContent = shortcut;
        else $('pinText').textContent = "Click the puzzle piece in your browser's toolbar and pin Iblock.";
      })
      .catch(() => {});
  }

  async function init() {
    build();
    const raw = await ext.storage.local.get(['settings']);
    settings = I.normalizeSettings(raw.settings);
    if (settings.theme !== 'system') document.documentElement.dataset.theme = settings.theme;
    render();
    try {
      $('perm').hidden = await ext.permissions.contains({ origins: I.HOST_PATTERNS });
    } catch {
      $('perm').hidden = true;
    }
  }

  init();
})();
