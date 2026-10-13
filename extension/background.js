// Owns the single native messaging port and fans the palette out to every tab.
//
// The host pushes unprompted whenever omarchy-theme-set swaps the theme, so this
// script mostly sits on an open port. Firefox keeps the event page alive while a
// native port is connected, which is what lets a push arrive at all -- an idle
// background page would otherwise be unloaded and miss it.

const HOST_NAME = 'com.webtwist.host';
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_THEME_NAME_CHARS = 64;
const MAX_COLORS = 128;

// Firefox exposes browser.* with promises and only fills chrome.* with callbacks;
// Chrome resolves chrome.* storage promises but keeps callbacks for runtime and
// tabs. Picking the promise-capable namespace for storage lets one worker file
// run on both, while the callback-style runtime calls below stay portable.
const storage = (globalThis.browser || globalThis.chrome).storage.local;

// Automatic site theming is on everywhere unless a site opts out. Only per-origin
// exceptions are stored, so a new site needs no entry and a choice survives a
// theme switch, an extension reload, or a browser restart.
const AUTO_THEME_DEFAULT = true;
const MAX_SITE_OVERRIDES = 2000;

// The wallpaper CDNs do not send CORS headers, so the page cannot read the bytes
// itself. Do not turn that exception into an arbitrary cross-origin proxy: an IP
// blacklist cannot account for DNS resolution or every IPv6 representation.
// Keep this list in sync with host_permissions in manifest.json.
const WALLPAPER_HOSTS = new Set(['wallpapers.hel1.your-objectstorage.com']);

// Reading the palette is open to every page. Changing the system theme is not:
// only the origins listed here, and only their top-level document, get the write
// path (setTheme, installTheme, and the wallpaper fetch it triggers).
//
// This check has to live in the worker, because only the worker sees an origin
// the page cannot forge: sender.origin is filled in by the browser. The native
// host is the wrong place for it -- it only ever learns the extension id, never
// which page asked.
const THEME_WRITE_ORIGINS = [
  // Production: the Omarchy site. https only, exact host -- no subdomains, so
  // neither themes.omarchy.org nor an attacker's omarchy.org.evil.com matches.
  /^https:\/\/omarchy\.org$/,
  // Local development is read-only unless explicitly opted in to an exact origin.
  // /^http:\/\/localhost:8080$/,
];

let port = null;
let pending = new Map();
let nextRequestId = 0;
let retryMs = RETRY_MIN_MS;
let retryTimer = null;
let installing = false;

// The palette actually sent to pages. It is either the live desktop palette from
// the helper or a bundled preset, so the add-on still themes pages -- and can be
// seen working -- with no helper at all.
let livePalette = null;
let settings = { paletteMode: 'desktop', preset: PRESET_PALETTES[0].id };
// Bumped every time a change is applied, so a settings read that was already in
// flight at startup cannot land late and overwrite a newer choice.
let settingsRevision = 0;

const PALETTE_MODES = new Set(['desktop', 'preset']);

function isPresetId(id) {
  return PRESET_PALETTES.some((preset) => preset.id === id);
}

function normalizeSettings(value) {
  return {
    paletteMode: value && PALETTE_MODES.has(value.paletteMode) ? value.paletteMode : 'desktop',
    preset: value && isPresetId(value.preset) ? value.preset : PRESET_PALETTES[0].id,
  };
}

// A partial change keeps whatever the caller did not ask to change, rather than
// resetting an unmentioned field to its default.
function applySettingsChange(current, incoming) {
  return {
    paletteMode: incoming && PALETTE_MODES.has(incoming.paletteMode) ? incoming.paletteMode : current.paletteMode,
    preset: incoming && isPresetId(incoming.preset) ? incoming.preset : current.preset,
  };
}

function readSettings() {
  return storage.get('settings').then(
    (stored) => normalizeSettings(stored.settings),
    () => normalizeSettings(null)
  );
}

function presetById(id) {
  return PRESET_PALETTES.find((preset) => preset.id === id) || PRESET_PALETTES[0];
}

// The one place the source rule lives: a chosen preset wins if one is forced,
// otherwise the live desktop palette wins, otherwise the chosen preset is the
// fallback. Every consumer -- pages, the popup -- sees the result of this.
function effectivePalette(active = settings) {
  const preset = presetById(active.preset);
  if (active.paletteMode === 'preset' || !livePalette) {
    return {
      type: 'palette',
      name: preset.name,
      mode: preset.mode,
      colors: preset.colors,
      // "preset" means the user chose it; "fallback" means there was no desktop
      // palette to use. The popup says which so the state is never ambiguous.
      source: active.paletteMode === 'preset' ? 'preset' : 'fallback',
    };
  }
  return {
    type: 'palette',
    name: livePalette.name,
    mode: livePalette.mode,
    colors: livePalette.colors,
    source: 'desktop',
  };
}

function publish() {
  const palette = effectivePalette();
  cache(palette);
  broadcast(palette);
}

function cache(palette) {
  // storage.local, not session: a content script at document_start needs the
  // palette even on the very first page load after the worker was torn down,
  // and session storage would be empty on a cold browser start.
  storage.set({ palette }).catch(() => {});
}

function broadcast(palette) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const tab of tabs || []) {
      if (tab.id === undefined) continue;
      // Tabs without our content script (about:, about:addons) reject the
      // message; that is expected, so swallow the error rather than logging per tab.
      chrome.tabs.sendMessage(tab.id, { type: 'palette', palette }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function scheduleReconnect() {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryMs);
  // Back off so a missing or crash-looping host does not spawn a process per second.
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

function connect() {
  if (port) return;

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    port = null;
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((message) => {
    if (!message) return;

    if (message.type === 'theme-result') {
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle({ ok: !!message.ok, name: message.name, error: message.error || '' });
      }
      return;
    }

    if (message.type !== 'palette') return;
    // A message proves the host is healthy, so the next disconnect starts its
    // backoff from scratch instead of inheriting a long delay.
    retryMs = RETRY_MIN_MS;
    // Hold the desktop palette and republish: which palette actually reaches
    // pages depends on the source setting, and this is where it changed.
    livePalette = message;
    publish();
  });

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    // A dropped port will never answer these, and a caller left awaiting a
    // promise that cannot settle is worse than a clear failure.
    for (const [id, settle] of pending) settle({ ok: false, error: 'host disconnected' });
    pending.clear();
    scheduleReconnect();
  });
}

// A content script asking for the palette is also the signal that the worker was
// respawned, so use it to re-open the port that died with the previous instance.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-get-palette') return false;

  connect();
  storage.get('palette').then(
    (stored) => sendResponse(stored.palette || null),
    () => sendResponse(null)
  );

  return true; // keep the channel open for the async storage read
});

function base64(bytes) {
  let binary = '';
  // btoa takes a string, and spreading a multi-megabyte array into one call
  // overflows the argument list, so build it in chunks.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchImage(url) {
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    throw new Error('background url is not a url');
  }
  if (target.protocol !== 'https:') throw new Error('background url must be https');
  if (!WALLPAPER_HOSTS.has(target.hostname) || target.port || target.username || target.password) {
    throw new Error('background url must use an allowed wallpaper host on the default HTTPS port');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let reader;
  try {
    // Refuse all redirects, including ones to another path on the same host.
    const response = await fetch(target.href, {
      redirect: 'error', credentials: 'omit', signal: controller.signal,
    });
    if (!response.ok) throw new Error('background fetch failed: HTTP ' + response.status);

    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg' && type !== 'image/png') throw new Error('background is not a JPEG or PNG');
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      throw new Error('background is larger than 8MB');
    }
    if (!response.body) throw new Error('background is empty');

    reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_IMAGE_BYTES);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_IMAGE_BYTES) throw new Error('background is larger than 8MB');
      buffer.set(value, size);
      size += value.byteLength;
    }
    if (!size) throw new Error('background is empty');
    return base64(buffer.subarray(0, size));
  } catch (error) {
    if (controller.signal.aborted) throw new Error('background download timed out');
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function originOf(sender) {
  if (sender.origin) return sender.origin;
  try {
    return sender.url ? new URL(sender.url).origin : null;
  } catch (error) {
    return null;
  }
}

// The origin the popup or a command should act on: the active tab, not a value
// the caller supplies. A tab with no origin (about:, a PDF viewer, a blank page)
// is not themeable and gets null.
function tabOrigin(tab) {
  try {
    const origin = tab && tab.url ? new URL(tab.url).origin : null;
    return origin && origin !== 'null' ? origin : null;
  } catch (error) {
    return null;
  }
}

function maySetThemes(sender) {
  const origin = originOf(sender);
  // Only the top-level document of an allowlisted origin may write. A subframe --
  // an ad slot, or an allowlisted page that some other site has framed -- carries
  // the same origin but a non-zero frameId, so gating on frame 0 keeps the write
  // path off every embedded instance. frameId is set by the browser, not the page.
  const topFrame = sender.frameId === 0;
  const originAllowed = THEME_WRITE_ORIGINS.some((pattern) => pattern.test(origin || ''));
  return { origin, allowed: topFrame && originAllowed };
}

// Lets a page find out whether it is allowed to write before it renders a theme
// picker, instead of discovering it from a failed click.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-can-set-theme') return false;
  sendResponse(maySetThemes(sender));
  return false;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-set-theme') return false;

  const { origin, allowed } = maySetThemes(sender);
  if (!allowed) {
    sendResponse({ ok: false, error: 'origin not permitted to set themes: ' + origin });
    return false;
  }

  connect();
  if (!port) {
    sendResponse({ ok: false, error: 'native host unavailable' });
    return false;
  }

  const id = String(++nextRequestId);
  pending.set(id, sendResponse);
  const timer = setTimeout(() => {
    const settle = pending.get(id);
    if (!settle) return;
    pending.delete(id);
    settle({ ok: false, error: 'timed out waiting for host' });
  }, REQUEST_TIMEOUT_MS);

  // postMessage throws on a port that disconnected since the null check above --
  // a narrow race, but an uncaught throw here escapes before `return true`, so
  // the browser sees no listener claiming the channel and closes it. The caller
  // then gets "The message port closed before a response was received", which
  // says nothing about what actually went wrong. Answer properly instead.
  try {
    port.postMessage({ type: 'set-theme', name: String(message.name || ''), id });
  } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    port = null;
    scheduleReconnect();
    sendResponse({ ok: false, error: 'native host connection lost, try again' });
    return false;
  }

  return true; // the host answers asynchronously
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-install-theme') return false;

  const { origin, allowed } = maySetThemes(sender);
  if (!allowed) {
    sendResponse({ ok: false, error: 'origin not permitted to install themes: ' + origin });
    return false;
  }

  // Reject oversized or malformed palettes before fetching or native transport.
  const { name, colors, backgroundUrl = '' } = message;
  if (typeof name !== 'string' || !name.length || name.length > MAX_THEME_NAME_CHARS || /[\x00-\x1f\x7f]/.test(name) ||
      !colors || typeof colors !== 'object' || Array.isArray(colors) || Object.keys(colors).length > MAX_COLORS ||
      !['background', 'foreground', 'accent'].every((key) => Object.hasOwn(colors, key)) ||
      !Object.entries(colors).every(([key, value]) =>
        key.length <= 32 && /^[a-z]/.test(key) && !/[^a-z0-9_]/.test(key) &&
        typeof value === 'string' && value.length === 7 && /^#[0-9a-fA-F]{6}$/.test(value)) ||
      typeof backgroundUrl !== 'string' || backgroundUrl.length > 4096) {
    sendResponse({ ok: false, error: 'invalid theme specification' });
    return false;
  }
  if (installing) {
    sendResponse({ ok: false, error: 'another theme installation is in progress' });
    return false;
  }
  installing = true;
  let responded = false;
  const respond = (result) => {
    if (responded) return;
    responded = true;
    sendResponse(result);
  };

  (async () => {
    try {
      const background = backgroundUrl ? await fetchImage(backgroundUrl) : '';
      connect();
      if (!port) throw new Error('native host unavailable');

      const result = await new Promise((resolve) => {
        const id = String(++nextRequestId);
        const timer = setTimeout(() => {
          // Timing out the caller does not cancel native work. Keep admission
          // occupied until the host actually answers or disconnects.
          respond({ ok: false, error: 'timed out waiting for host' });
        }, INSTALL_TIMEOUT_MS);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        try {
          port.postMessage({ type: 'install-theme', id, name, colors, background });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          port = null;
          scheduleReconnect();
          resolve({ ok: false, error: 'native host connection lost, try again' });
        }
      });
      respond(result);
    } catch (error) {
      respond({ ok: false, error: String(error.message || error) });
    } finally {
      installing = false;
    }
  })();

  return true; // the fetch and the host both answer asynchronously
});

// ---------------------------------------------------------------------------
// Automatic site theming
//
// The worker owns the on/off decision so the popup, the keyboard command, and
// the content script all read one rule. Content scripts ask with their own
// browser-set origin; the popup and command are resolved to the active tab here,
// so a caller cannot aim a change at a site it is not looking at.
// ---------------------------------------------------------------------------

function normalizeAutoTheme(value) {
  const source = value && typeof value.sites === 'object' && value.sites ? value.sites : {};
  const sites = {};
  let count = 0;
  for (const [origin, enabled] of Object.entries(source)) {
    if (count >= MAX_SITE_OVERRIDES) break;
    // Origins only: opaque or oversized keys would just sit in storage forever.
    if (typeof enabled !== 'boolean' || typeof origin !== 'string' || origin.length > 256) continue;
    if (!/^\w+:\/\//.test(origin)) continue;
    sites[origin] = enabled;
    count++;
  }
  return { default: !(value && value.default === false), sites };
}

function readAutoTheme() {
  return storage.get('autoTheme').then(
    (stored) => normalizeAutoTheme(stored.autoTheme),
    () => normalizeAutoTheme(null)
  );
}

function siteEnabled(state, origin) {
  // An opaque origin ("null") cannot be addressed by the popup and is not a site
  // the user chose, so it never inherits the default.
  if (!origin || origin === 'null') return false;
  return Object.hasOwn(state.sites, origin) ? state.sites[origin] : state.default;
}

// Writes are serialized: two tabs toggling at once would otherwise both read the
// old map and one choice would win by losing the other.
let autoThemeQueue = Promise.resolve();

function setSiteEnabled(origin, enabled) {
  autoThemeQueue = autoThemeQueue.then(() => readAutoTheme().then((state) => {
    // An override equal to the default carries no information, so drop it and let
    // the site follow the default again if the default ever changes.
    if (enabled === state.default) delete state.sites[origin];
    else state.sites[origin] = enabled;
    return storage.set({ autoTheme: state }).then(() => state);
  }));
  return autoThemeQueue;
}

function eachTabOfOrigin(origin, visit) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const tab of tabs || []) {
      if (tab.id === undefined || tabOrigin(tab) !== origin) continue;
      visit(tab);
    }
  });
}

function broadcastSiteState(origin, enabled) {
  eachTabOfOrigin(origin, (tab) => {
    chrome.tabs.sendMessage(tab.id, { type: 'webtwist-site-state', enabled }, () => {
      void chrome.runtime.lastError;
    });
  });
}

function activeTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    void chrome.runtime.lastError;
    callback((tabs || [])[0] || null);
  });
}

function toggleActiveTab() {
  activeTab((tab) => {
    const origin = tabOrigin(tab);
    if (!origin) return;
    readAutoTheme().then((state) => {
      setSiteEnabled(origin, !siteEnabled(state, origin)).then(
        (updated) => broadcastSiteState(origin, siteEnabled(updated, origin)),
        () => {}
      );
    });
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-site-theming') toggleActiveTab();
});

// A content script asking about itself. sender.origin is filled in by the
// browser, so the answer describes the frame that asked, not one it names.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-site-state') return false;
  const origin = originOf(sender);
  readAutoTheme().then(
    (state) => sendResponse({ origin, enabled: siteEnabled(state, origin) }),
    () => sendResponse({ origin, enabled: false })
  );
  return true; // the storage read is asynchronous
});

// The popup asks about the tab in front of it, and never names an origin.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-tab-state') return false;
  activeTab((tab) => {
    const origin = tabOrigin(tab);
    readAutoTheme().then(
      (state) => sendResponse({
        origin,
        title: (tab && tab.title) || '',
        enabled: siteEnabled(state, origin),
        supported: Boolean(origin),
      }),
      () => sendResponse({ origin, title: '', enabled: false, supported: false })
    );
  });
  return true; // the tab query and the storage read are asynchronous
});

// The popup flipping the switch for the site it is open on.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-set-site') return false;
  if (typeof message.enabled !== 'boolean') {
    sendResponse({ ok: false, error: 'invalid setting' });
    return false;
  }
  activeTab((tab) => {
    const origin = tabOrigin(tab);
    if (!origin) {
      sendResponse({ ok: false, error: 'this page cannot be themed' });
      return;
    }
    const enabled = message.enabled;
    setSiteEnabled(origin, enabled).then(
      (state) => {
        broadcastSiteState(origin, siteEnabled(state, origin));
        sendResponse({ ok: true, origin, enabled: siteEnabled(state, origin) });
      },
      () => sendResponse({ ok: false, error: 'could not save the setting' })
    );
  });
  return true; // the tab query, storage write, and broadcast are asynchronous
});

// The popup asks for the palette choice and the bundled options in one round
// trip. Presets are sent whole so the popup can draw their colors without a
// second copy of the tables.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-palette-settings') return false;
  readSettings().then((value) => {
    const palette = effectivePalette(value);
    sendResponse({
      settings: value,
      source: palette.source,
      desktop: Boolean(livePalette),
      theme: livePalette ? livePalette.name : '',
      presets: PRESET_PALETTES.map(({ id, name, mode, colors }) => ({ id, name, mode, colors })),
    });
  });
  return true; // the storage read is asynchronous
});

// Choosing a source or preset. Invalid fields keep their current value rather
// than resetting, so a popup bug cannot silently drop the desktop palette.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'webtwist-set-palette-settings') return false;
  const previous = settings;
  const next = applySettingsChange(settings, message);
  settingsRevision += 1;
  settings = next;
  storage.set({ settings: next }).then(
    () => {
      publish();
      sendResponse({ ok: true, settings: next, source: effectivePalette().source, desktop: Boolean(livePalette) });
    },
    () => {
      settings = previous;
      sendResponse({ ok: false, error: 'could not save the palette choice' });
    }
  );
  return true; // the storage write and rebroadcast are asynchronous
});

// Startup: pick the correct palette before any page asks.
//
// The last palette is cached, so on an Omarchy machine the desktop palette is
// already on screen and publishing a preset over it would flash the wrong colors
// until the helper reconnects. A forced preset always wins; otherwise a cached
// palette is left alone and a machine with no cache (no helper, first run) gets
// the fallback.
function initialize() {
  const revision = settingsRevision;
  readSettings().then((value) => {
    // A choice made while this read was in flight is newer than what it read, so
    // keep the choice and do not publish over it.
    if (settingsRevision !== revision) {
      connect();
      return null;
    }
    settings = value;
    if (settings.paletteMode === 'preset') {
      publish();
      connect();
      return null;
    }
    return storage.get('palette').then(
      (stored) => {
        if (!stored.palette) publish();
        connect();
      },
      () => {
        publish();
        connect();
      }
    );
  });
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);
// Open the port immediately, the way the previous version did, so a connected
// helper keeps the event page alive from the first moment; initialize() only
// decides which palette is published.
connect();
initialize();
