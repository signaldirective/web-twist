// Main world. Exposes window.webtwist to page scripts.
//
// Every accessor reads the live DOM rather than caching a payload, so this is
// immune to the injection-order race between the isolated and main worlds: there
// is no first message to miss, only <html> to look at whenever the page asks.

(() => {
  const VAR_PREFIX = '--webtwist-';

  // One round trip to the isolated world, which relays to the service worker.
  // detail is a JSON string on purpose: strings clone cleanly between worlds,
  // plain objects are realm-sensitive.
  function request(payload, onTimeout, timeoutMs) {
    return new Promise((resolve) => {
      const id = 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36);

      const onResponse = (event) => {
        let message;
        try {
          message = JSON.parse(event.detail);
        } catch (error) {
          return;
        }
        if (!message || message.id !== id) return;
        cleanup();
        resolve(message.result);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(onTimeout);
      }, timeoutMs || 20000);

      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener('__webtwist_response', onResponse);
      }

      document.addEventListener('__webtwist_response', onResponse);
      document.dispatchEvent(
        new CustomEvent('__webtwist_request', {
          detail: JSON.stringify(Object.assign({ id }, payload)),
        })
      );
    });
  }

  function colors() {
    const style = document.documentElement && document.documentElement.style;
    const out = {};
    if (!style) return out;

    // Inline custom properties enumerate through the style declaration's index,
    // which is how the main world reads what the isolated world wrote.
    for (let i = 0; i < style.length; i++) {
      const property = style[i];
      if (!property.startsWith(VAR_PREFIX)) continue;
      out[property.slice(VAR_PREFIX.length).replace(/-/g, '_')] =
        style.getPropertyValue(property).trim();
    }
    return out;
  }

  Object.defineProperty(window, 'omarchy', {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      get theme() {
        return document.documentElement?.dataset.webtwistTheme || null;
      },
      get mode() {
        return document.documentElement?.dataset.webtwistMode || null;
      },
      colors,
      color(name) {
        return colors()[String(name).replace(/-/g, '_')] || null;
      },
      // Whether this origin may set themes. Resolves to { allowed, origin }.
      // Check this before rendering a theme picker rather than finding out from
      // a failed click.
      canSetTheme() {
        return request({ kind: 'can-set' }, { allowed: false, origin: null, error: 'no response from extension' })
          .then((result) => {
            // A worker that never answered returns an error object with no
            // `allowed` field. Reporting that as "not allowed" would blame the
            // origin for what is really an unreachable worker, so keep the two
            // apart: `error` set means the question was never answered.
            if (result && typeof result.allowed === 'boolean') return result;
            return {
              allowed: false,
              origin: null,
              error: (result && result.error) || 'no response from extension',
            };
          });
      },

      // Ask Omarchy to switch themes. Resolves to { ok, name, error }.
      // Only origins the extension allows will succeed; everything else comes
      // back with ok:false and a reason rather than throwing.
      setTheme(name) {
        return request({ kind: 'set', name: String(name) }, {
          ok: false,
          error: 'no response from extension',
        });
      },

      // Install a custom theme and apply it. Takes a palette of "#rrggbb" values
      // and an optional direct https image url on an allowed wallpaper host,
      // which the extension fetches because wallpaper CDNs often omit CORS headers.
      // Existing names are never replaced; use setTheme to apply an installed theme.
      // Resolves to { ok, name, error }.
      installTheme(theme) {
        const spec = theme || {};
        return request(
          {
            kind: 'install',
            name: String(spec.name || ''),
            colors: spec.colors && typeof spec.colors === 'object' ? spec.colors : {},
            backgroundUrl: spec.backgroundUrl ? String(spec.backgroundUrl) : '',
          },
          { ok: false, error: 'no response from extension' },
          120000
        );
      },

      onChange(handler) {
        if (typeof handler !== 'function') return () => {};
        const listener = () => handler(Object.freeze(colors()));
        document.addEventListener('webtwistthemechange', listener);
        return () => document.removeEventListener('webtwistthemechange', listener);
      },
    }),
  });
})();
