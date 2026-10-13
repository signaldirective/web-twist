// The popup: show the active palette, choose where it comes from, and flip site
// theming for the tab in front of it.
//
// It never names an origin itself -- the worker resolves "this site" from the
// active tab -- so a page cannot be themed by a value the popup was handed. The
// preset tables come from the worker too, so there is one copy of them.

const storage = (globalThis.browser || globalThis.chrome).storage.local;
const $ = (id) => document.getElementById(id);

// A representative slice rather than all 46 colors, so the strip reads at a
// glance.
const STRIP = ['background', 'accent', 'red', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'foreground'];
const SOURCE_LABEL = { desktop: 'desktop', preset: 'preset', fallback: 'no helper' };

const toggle = $('siteToggle');
let savedSite = false;
let data = null;

function setStatus(text, kind) {
  const status = $('status');
  status.textContent = text;
  status.className = kind ? 'status ' + kind : 'status';
}

function paint(palette) {
  const colors = (palette && palette.colors) || {};
  const root = document.documentElement;

  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === 'string') root.style.setProperty('--webtwist-' + key.replace(/_/g, '-'), value);
  }

  $('themeName').textContent = (palette && palette.name) || 'no palette';

  const strip = $('swatches');
  strip.replaceChildren();
  for (const key of STRIP) {
    if (!colors[key]) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.backgroundColor = 'var(--webtwist-' + key.replace(/_/g, '-') + ')';
    strip.appendChild(chip);
  }
}

function makeChip({ label, colors, active, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pchip' + (active ? ' active' : '');

  if (colors) {
    const swatch = document.createElement('span');
    swatch.className = 'pstrip';
    for (const key of ['background', 'accent', 'foreground']) {
      const dot = document.createElement('i');
      dot.style.backgroundColor = colors[key] || 'transparent';
      swatch.appendChild(dot);
    }
    button.appendChild(swatch);
  }

  const name = document.createElement('span');
  name.textContent = label;
  button.appendChild(name);

  button.addEventListener('click', onClick);
  return button;
}

function renderSource() {
  if (!data) return;
  const { settings, source, desktop } = data;

  const pill = $('sourcePill');
  pill.textContent = SOURCE_LABEL[source] || source;
  pill.className = 'mode ' + source;

  const host = $('paletteChips');
  host.replaceChildren();
  host.appendChild(makeChip({
    label: 'Desktop',
    active: settings.paletteMode === 'desktop',
    onClick: () => choose({ paletteMode: 'desktop' }),
  }));
  for (const preset of data.presets) {
    host.appendChild(makeChip({
      label: preset.name,
      colors: preset.colors,
      active: settings.paletteMode === 'preset' && settings.preset === preset.id,
      onClick: () => choose({ paletteMode: 'preset', preset: preset.id }),
    }));
  }

  const hint = $('paletteHint');
  if (settings.paletteMode === 'preset') hint.textContent = 'A fixed palette; the desktop theme is ignored.';
  else if (desktop) hint.textContent = 'Following your desktop theme.';
  else hint.textContent = 'No Omarchy helper is running, so this fallback palette is used.';
}

function choose(change) {
  chrome.runtime.sendMessage({ type: 'webtwist-set-palette-settings', ...change }, (result) => {
    void chrome.runtime.lastError;
    if (!result || !result.ok) {
      setStatus((result && result.error) || 'Could not save the palette choice.', 'err');
      return;
    }
    // The worker republishes the palette; storage.onChanged repaints the colors.
    data = { ...data, settings: result.settings, source: result.source, desktop: result.desktop };
    renderSource();
  });
}

storage.get('palette').then(
  (stored) => paint(stored.palette || null),
  () => paint(null)
);

if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.palette) paint(changes.palette.newValue || null);
  });
}

chrome.runtime.sendMessage({ type: 'webtwist-palette-settings' }, (result) => {
  void chrome.runtime.lastError;
  if (!result) {
    setStatus('The extension did not answer.', 'err');
    return;
  }
  data = result;
  renderSource();
});

// ---- site theming ----

chrome.runtime.sendMessage({ type: 'webtwist-tab-state' }, (state) => {
  void chrome.runtime.lastError;
  if (!state) {
    toggle.disabled = true;
    setStatus('The extension did not answer.', 'err');
    return;
  }
  if (!state.supported) {
    // about:, a PDF viewer, a blank tab: there is no origin to theme.
    toggle.disabled = true;
    setStatus('This page cannot be themed.');
    return;
  }
  savedSite = Boolean(state.enabled);
  toggle.checked = savedSite;
  setStatus(savedSite ? 'Themed with the active palette.' : 'Off for this site.', savedSite ? 'ok' : '');
});

toggle.addEventListener('change', () => {
  const wanted = toggle.checked;
  toggle.disabled = true;

  chrome.runtime.sendMessage({ type: 'webtwist-set-site', enabled: wanted }, (result) => {
    void chrome.runtime.lastError;
    toggle.disabled = false;

    if (!result || !result.ok) {
      // Put the switch back where it was rather than showing a state that was
      // never saved.
      toggle.checked = savedSite;
      setStatus((result && result.error) || 'Could not save the setting.', 'err');
      return;
    }
    savedSite = Boolean(result.enabled);
    toggle.checked = savedSite;
    setStatus(savedSite ? 'Themed with the active palette.' : 'Off for this site.', savedSite ? 'ok' : '');
  });
});
