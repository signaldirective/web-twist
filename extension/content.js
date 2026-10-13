// Isolated world. Writes the palette into the shared DOM, which is the only part
// of this extension that pages actually see.
//
// Inline custom properties on <html> are visible to page CSS and to page
// JavaScript through getComputedStyle, even though this script's own globals are
// not. That makes the DOM the contract and removes any need to hand the palette
// across the world boundary.

const VAR_PREFIX = '--webtwist-';
const CHANGE_EVENT = 'webtwistthemechange';

// Firefox exposes browser.* with promises and only fills chrome.* with callbacks;
// Chrome resolves chrome.* storage promises but keeps callbacks for runtime and
// tabs. Picking the promise-capable namespace for storage lets one file run on
// both, while the callback-style runtime calls below stay portable as they are.
const storage = (globalThis.browser || globalThis.chrome).storage.local;

let applied = null;

function apply(palette) {
  const root = document.documentElement;
  if (!root || !palette || !palette.colors) return;

  // Theme switches re-send the whole palette; a key that disappeared between
  // themes has to be removed or it would linger as a stale value.
  const next = new Set();
  for (const [key, value] of Object.entries(palette.colors)) {
    if (typeof value !== 'string') continue;
    const property = VAR_PREFIX + key.replace(/_/g, '-');
    next.add(property);
    root.style.setProperty(property, value);
  }

  if (applied) {
    for (const property of applied) {
      if (!next.has(property)) root.style.removeProperty(property);
    }
  }
  applied = next;

  // Descriptive only. Setting color-scheme here would restyle form controls and
  // scrollbars on every site, so the mode is advertised and left for pages to use.
  if (palette.mode) root.dataset.webtwistMode = palette.mode;
  if (palette.name) root.dataset.webtwistTheme = palette.name;

  // No detail: cloning an object across the isolated/main boundary is realm
  // -sensitive, and pages read the values straight off window.webtwist or CSS.
  document.dispatchEvent(new Event(CHANGE_EVENT));
}

// Two sources, whichever lands first. The cached read covers a cold service
// worker; the request wakes the worker so it re-opens the native port.
storage.get('palette').then(
  (stored) => { if (stored.palette && !applied) apply(stored.palette); },
  () => {}
);

chrome.runtime.sendMessage({ type: 'webtwist-get-palette' }, (palette) => {
  void chrome.runtime.lastError;
  if (palette) apply(palette);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'palette') apply(message.palette);
});

// Bridge for the write path. The page cannot reach chrome.runtime, so the main
// world raises an event here and this relays it. detail is carried as a JSON
// string on purpose: strings clone cleanly between worlds, plain objects are
// realm-sensitive.
document.addEventListener('__webtwist_request', (event) => {
  let request;
  try {
    request = JSON.parse(event.detail);
  } catch (error) {
    return;
  }
  if (!request || typeof request.id !== 'string') return;

  const respond = (result) =>
    document.dispatchEvent(
      new CustomEvent('__webtwist_response', {
        detail: JSON.stringify({ id: request.id, result }),
      })
    );

  let outbound;
  if (request.kind === 'can-set') {
    outbound = { type: 'webtwist-can-set-theme' };
  } else if (request.kind === 'install') {
    outbound = {
      type: 'webtwist-install-theme',
      name: String(request.name || ''),
      colors: request.colors,
      backgroundUrl: request.backgroundUrl ? String(request.backgroundUrl) : '',
    };
  } else {
    outbound = { type: 'webtwist-set-theme', name: String(request.name || '') };
  }

  chrome.runtime.sendMessage(
    outbound,
    (result) => {
      if (result) {
        respond(result);
        return;
      }
      // No result means the background script never answered. The browser's own
      // wording for that ("The message port closed before a response was
      // received") describes the plumbing rather than the cause, and for an
      // unpacked add-on the cause is almost always a background script running
      // code older than the files on disk.
      const failure = chrome.runtime.lastError;
      const reason = (failure && failure.message) || 'extension unavailable';
      respond({
        ok: false,
        error: /message port closed/i.test(reason)
          ? 'the add-on did not respond -- reload it from about:debugging'
          : reason,
      });
    }
  );
});
