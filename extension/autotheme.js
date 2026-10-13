// Isolated world. Automatic site theming: spends the live palette, supplied as
// the --webtwist-* variables content.js writes, on pages that do not theme
// themselves.
//
// Two layers:
//
// 1. A stylesheet that pins the page canvas, text, links, controls, and
//    scrollbars to palette variables. Because it references the variables rather
//    than literal colors, a theme switch retints it with no work.
// 2. A bounded scan that repaints the opaque surfaces a page declares for itself
//    -- white cards, light panels -- and darkens their text. The scan writes
//    variables too, for the same reason, and remembers what it replaced so the
//    site can be handed back untouched.
//
// It is deliberately conservative: media, image and gradient surfaces, and
// anything hidden are left alone, and the whole layer is off when the site or
// the user turns it off. The stylesheet goes through a constructable stylesheet
// rather than a <style> element, which keeps it working under a page's
// Content-Security-Policy that forbids inline styles.
//
// This never restyles a page that has its own palette on purpose -- that is what
// the per-site switch and the variables in content.js are for.

(() => {
  const CLASS = 'webtwist-site-theme';
  const STYLE_ID = 'webtwist-site-theme-style';
  const CHANGE_EVENT = 'webtwistthemechange';
  const VAR_PREFIX = '--webtwist-';

  // A hard ceiling on how much work one page can cause. Rich applications ship
  // tens of thousands of nodes; repainting the first few thousand visible
  // surfaces is where the payoff is, and the rest inherit from an ancestor.
  const MAX_ELEMENTS = 4000;
  // Overrides accumulate as a page mutates. Past this many, new surfaces are left
  // alone rather than growing the bookkeeping without bound on a long session.
  const MAX_OVERRIDES = MAX_ELEMENTS + 2000;
  const SCAN_DELAY_MS = 40;
  const MAX_ANCESTOR_LOOKUP = 3;

  // Perceived luminance of a surface. At or above LIGHT it reads as "light"; at
  // or above VERY_LIGHT it is a near-white panel rather than a mid tone.
  const LIGHT = 0.6;
  const VERY_LIGHT = 0.8;

  // Tags that carry no readable surface, are media, or live inside SVG where a
  // background-color is not what paints them.
  const SKIP_TAGS = new Set([
    'HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT',
    'TEMPLATE', 'BR', 'WBR', 'AREA', 'MAP', 'SOURCE', 'TRACK', 'PARAM', 'COL',
    'COLGROUP', 'BASE', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME',
    'EMBED', 'OBJECT',
    'SVG', 'PATH', 'G', 'DEFS', 'USE', 'SYMBOL', 'CLIPPATH', 'LINEARGRADIENT',
    'RADIALGRADIENT', 'STOP', 'POLYGON', 'POLYLINE', 'RECT', 'CIRCLE', 'ELLIPSE',
    'LINE', 'TEXT', 'TSPAN', 'TEXTAREA',
  ]);

  const RGB = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/;

  let palette = null;
  let enabled = false;
  let sheet = null;
  let observer = null;
  let timer = null;
  let pending = [];

  // element -> Map(css property -> the inline value and priority it had before)
  const overridden = new Map();

  function parseColor(value) {
    const match = RGB.exec(String(value || '').trim());
    if (!match) return null;
    const alpha = match[4] === undefined
      ? 1
      : (match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]));
    if (!Number.isFinite(alpha)) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
  }

  function luminance({ r, g, b }) {
    const channel = (value) => {
      const v = Math.min(255, Math.max(0, value)) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  // The palette, read from the inline variables content.js left on <html>. Reading
  // the DOM rather than messages means there is nothing to miss: whenever this
  // runs, it sees whatever has been applied so far.
  function readPalette() {
    const root = document.documentElement;
    if (!root) return null;

    const colors = {};
    const style = root.style;
    for (let i = 0; i < style.length; i++) {
      const property = style[i];
      if (!property.startsWith(VAR_PREFIX)) continue;
      colors[property.slice(VAR_PREFIX.length)] = style.getPropertyValue(property).trim();
    }
    if (!Object.keys(colors).length) return null;

    return { colors, mode: root.dataset.webtwistMode === 'light' ? 'light' : 'dark' };
  }

  function baseCss(dark) {
    const canvas = 'var(--webtwist-background)';
    const foreground = 'var(--webtwist-foreground, var(--webtwist-light-foreground, inherit))';
    const accent = 'var(--webtwist-accent, var(--webtwist-blue, inherit))';
    return `
html.${CLASS} {
  background-color: ${canvas} !important;
  color-scheme: ${dark ? 'dark' : 'light'};
  scrollbar-color: var(--webtwist-lighter-background, ${canvas}) ${canvas};
}
html.${CLASS} body {
  background-color: ${canvas} !important;
  color: ${foreground} !important;
}
html.${CLASS} a,
html.${CLASS} a:visited {
  color: ${accent} !important;
}
html.${CLASS} ::selection {
  background-color: var(--webtwist-selection, ${accent}) !important;
  color: ${foreground} !important;
}
html.${CLASS} input,
html.${CLASS} textarea,
html.${CLASS} select {
  background-color: var(--webtwist-dark-background, ${canvas}) !important;
  color: ${foreground} !important;
  border-color: var(--webtwist-lighter-background, ${accent}) !important;
}
html.${CLASS} ::placeholder {
  color: var(--webtwist-dark-foreground, var(--webtwist-muted, inherit)) !important;
}
`;
  }

  function setSheet(css) {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(css);
      return;
    } catch (error) {
      // No constructable stylesheets. A <style> element may be refused by the
      // page's CSP, but the inline overrides on individual elements still land.
    }
    let fallback = document.getElementById(STYLE_ID);
    if (!fallback) {
      fallback = document.createElement('style');
      fallback.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(fallback);
    }
    fallback.textContent = css;
  }

  function clearSheet() {
    if (sheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
      sheet = null;
    }
    const fallback = document.getElementById(STYLE_ID);
    if (fallback) fallback.remove();
  }

  function override(element, property, value) {
    let record = overridden.get(element);
    if (!record) {
      if (overridden.size >= MAX_OVERRIDES) return;
      record = new Map();
      overridden.set(element, record);
    }
    if (!record.has(property)) {
      record.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    }
    element.style.setProperty(property, value, 'important');
  }

  // Give every element back exactly what it had. Restoring the recorded value
  // rather than blanking the property matters when a page had its own inline
  // color, which the override would otherwise erase for good.
  function release() {
    for (const [element, record] of overridden) {
      for (const [property, original] of record) {
        if (original.value) element.style.setProperty(property, original.value, original.priority);
        else element.style.removeProperty(property);
      }
    }
    overridden.clear();
  }

  function repaintedAncestor(element) {
    let node = element.parentElement;
    for (let depth = 0; node && depth < MAX_ANCESTOR_LOOKUP; depth++, node = node.parentElement) {
      const record = overridden.get(node);
      if (record && record.has('background-color')) return true;
    }
    return false;
  }

  function consider(element) {
    if (overridden.has(element)) return;
    const tag = element.tagName;
    if (typeof tag !== 'string' || SKIP_TAGS.has(tag)) return;

    let style;
    try {
      style = getComputedStyle(element);
    } catch (error) {
      return;
    }
    if (!style || style.display === 'none' || style.visibility === 'hidden') return;
    // A declared image or gradient is the page's own art. Painting over it would
    // hide content, so a surface that carries one is left entirely alone.
    if (style.backgroundImage && style.backgroundImage !== 'none') return;

    const dark = !palette || palette.mode !== 'light';
    const background = parseColor(style.backgroundColor);
    const color = parseColor(style.color);
    const textWantsWork = color && (dark ? luminance(color) < LIGHT : luminance(color) >= LIGHT);

    if (background && background.a > 0) {
      const light = luminance(background) >= LIGHT;
      // Only surfaces facing the wrong way for the theme are converted: a dark
      // panel in a dark theme, or a light one in a light theme, is already right.
      if (dark ? light : !light) {
        // Preserve the page's own contrast: a near-white panel becomes the canvas,
        // a mid tone becomes the theme's contrasting surface.
        override(element, 'background-color', luminance(background) >= VERY_LIGHT
          ? 'var(--webtwist-background)'
          : 'var(--webtwist-lighter-background, var(--webtwist-dark-background, var(--webtwist-background)))');
        if (textWantsWork) override(element, 'color', 'var(--webtwist-foreground, inherit)');
        return;
      }
    }

    // Transparent text inside a surface we repainted inherits a color that is now
    // unreadable. Trust a repainted ancestor instead of assuming the page repeats
    // its color on every node.
    if (textWantsWork && repaintedAncestor(element)) {
      override(element, 'color', 'var(--webtwist-foreground, inherit)');
    }
  }

  function scan(root) {
    if (!enabled || !palette || !root || root.nodeType !== 1) return;
    if (overridden.size >= MAX_OVERRIDES) return;

    // A TreeWalker stops at the ceiling without materializing every node first,
    // which matters on pages with tens of thousands of elements.
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      consider(node);
      if (++count >= MAX_ELEMENTS) break;
    }
  }

  function flush() {
    timer = null;
    if (!enabled || !palette) {
      pending = [];
      return;
    }
    const batch = pending;
    pending = [];
    for (const node of batch) scan(node);
  }

  function scheduleScan(nodes) {
    if (!enabled || !palette) return;
    pending.push(...nodes);
    if (timer !== null) return;
    timer = setTimeout(flush, SCAN_DELAY_MS);
  }

  function observe() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      const added = [];
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) added.push(node);
        }
      }
      if (added.length) scheduleScan(added);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Re-read the palette and make the stylesheet reflect it. A mode change is the
  // one case that invalidates the scan: every decision was made for the opposite
  // direction, so the repaints have to be undone and redone.
  function refresh() {
    const next = readPalette();
    if (!next) return;
    const modeChanged = !palette || palette.mode !== next.mode;
    palette = next;
    if (!enabled) return;
    document.documentElement.classList.add(CLASS);
    setSheet(baseCss(palette.mode === 'dark'));
    if (modeChanged) {
      release();
      scan(document.documentElement);
    }
  }

  function setEnabled(next) {
    if (next === enabled) return;
    if (next) {
      enabled = true;
      observe();
      refresh();
      scan(document.documentElement);
      return;
    }
    enabled = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = [];
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    release();
    clearSheet();
    document.documentElement.classList.remove(CLASS);
  }

  // The worker owns the on/off rule. A page that does not answer leaves the layer
  // off, which is the safe direction to fail.
  chrome.runtime.sendMessage({ type: 'webtwist-site-state' }, (state) => {
    void chrome.runtime.lastError;
    if (state && state.enabled) setEnabled(true);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'webtwist-site-state') setEnabled(Boolean(message.enabled));
  });

  // content.js dispatches this after it writes the variables, including the very
  // first palette on a cold load.
  document.addEventListener(CHANGE_EVENT, refresh);
  refresh();
})();
