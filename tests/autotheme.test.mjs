import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const engine = readFileSync(join(project, 'extension/autotheme.js'), 'utf8');

const chromium = ['chromium', 'chromium-browser', 'google-chrome'].flatMap((name) =>
  (process.env.PATH || '').split(delimiter).map((directory) => join(directory, name))).find((file) => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
});

// The palette content.js would have written, as inline variables on <html>. The
// engine reads these rather than a message, so the fixtures set them directly.
const palette = `
  root.dataset.webtwistMode = 'dark';
  root.style.setProperty('--webtwist-background', '#08050d');
  root.style.setProperty('--webtwist-dark-background', '#05030a');
  root.style.setProperty('--webtwist-lighter-background', '#1e1330');
  root.style.setProperty('--webtwist-foreground', '#ffd0c0');
  root.style.setProperty('--webtwist-accent', '#ff5ccc');
  root.style.setProperty('--webtwist-selection', '#51438f');
`;

// Elements are built through the CSSOM so a page with a strict style-src still
// has fixture styling: CSP blocks the style attribute, not el.style writes.
const fixtures = `
  const host = document.getElementById('host');
  const make = (id, styles, tag = 'div', text = '') => {
    const el = document.createElement(tag);
    el.id = id;
    for (const [key, value] of Object.entries(styles)) el.style[key] = value;
    if (text) el.textContent = text;
    host.appendChild(el);
    return el;
  };
  make('light', { backgroundColor: '#ffffff', color: '#111111' }, 'div', 'panel');
  const inner = document.createElement('span');
  inner.id = 'inner';
  inner.style.color = '#222222';
  inner.textContent = 'inner';
  document.getElementById('light').appendChild(inner);
  make('mid', { backgroundColor: '#dddddd' });
  make('art', { backgroundImage: 'url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)' });
  const img = make('img', {}, 'img');
  img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const link = make('', {}, 'a', 'link');
  link.href = '#';
`;

// A minimal stand-in for the extension APIs autotheme.js touches. sendMessage
// answers synchronously with "themed", which is what a page does when the worker
// is healthy; onMessage captures the listener so the test can flip the site off.
const stub = `
  window.chrome = {
    runtime: {
      sendMessage: (message, callback) => { window.__asked = message; callback({ origin: 'https://example.com', enabled: true }); },
      onMessage: { addListener: (listener) => { window.__listener = listener; } },
    },
  };
`;

const checks = `
  const computed = (id) => getComputedStyle(document.getElementById(id));
  const bg = (id) => computed(id).backgroundColor;
  function check(ok, message) { if (!ok) throw new Error(message); }
  try {
    check(window.__asked && window.__asked.type === 'webtwist-site-state', 'engine did not ask the worker');
    check(document.documentElement.classList.contains('webtwist-site-theme'), 'theme class missing');
    check(document.adoptedStyleSheets.length >= 1, 'base layer is not a constructable stylesheet');

    check(bg('light') === 'rgb(8, 5, 13)', 'near-white surface not turned into the canvas: ' + bg('light'));
    check(computed('inner').color === 'rgb(255, 208, 192)', 'text inside a repainted surface stayed dark: ' + computed('inner').color);
    check(bg('mid') === 'rgb(30, 19, 48)', 'mid surface did not take the contrasting tone: ' + bg('mid'));
    check(bg('art') === 'rgba(0, 0, 0, 0)', 'a surface carrying page art was painted over: ' + bg('art'));
    check(bg('img') === 'rgba(0, 0, 0, 0)', 'media was painted over: ' + bg('img'));
    check(getComputedStyle(document.body).backgroundColor === 'rgb(8, 5, 13)', 'page canvas not themed');
    check(getComputedStyle(document.querySelector('a')).color === 'rgb(255, 92, 204)', 'link accent missing');

    window.__listener({ type: 'webtwist-site-state', enabled: false });
    check(!document.documentElement.classList.contains('webtwist-site-theme'), 'theme class not removed');
    check(document.adoptedStyleSheets.length === 0, 'base layer not withdrawn');
    check(bg('light') === 'rgb(255, 255, 255)', 'surface not handed back: ' + bg('light'));
    check(computed('inner').color === 'rgb(34, 34, 34)', 'text color not handed back: ' + computed('inner').color);
    check(bg('mid') === 'rgb(221, 221, 221)', 'mid surface not handed back: ' + bg('mid'));

    document.documentElement.dataset.result = 'passed';
  } catch (error) {
    document.documentElement.dataset.error = error.message;
  }
`;

function page(csp = '') {
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>
<div id="host"></div>
<script>
  const root = document.documentElement;
${palette}
${fixtures}
${stub}
</script>
<script>${engine}</script>
<script>${checks}</script>
</body></html>`;
}

function render(html, root) {
  const file = join(root, `page-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  const result = spawnSync(chromium, [
    '--headless', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-sync', '--disable-breakpad', '--no-first-run',
    '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--password-store=basic', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000',
    '--user-data-dir=' + join(root, 'browser-profile'), pathToFileURL(file).href,
  ], { cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.match(/<html\b[^>]*>/)?.[0] || '';
}

test('the auto-theme engine repaints light surfaces, spares media, and hands a site back', {
  skip: chromium ? false : 'Chromium is not installed',
  timeout: 60000,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'webtwist-autotheme-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const htmlTag = render(page(), root);
  assert.doesNotMatch(htmlTag, /data-error=/, htmlTag.match(/data-error="[^"]*"/)?.[0] || '');
  assert.match(htmlTag, /data-result="passed"/);
});

test('the base layer survives a page Content-Security-Policy that forbids inline styles', {
  skip: chromium ? false : 'Chromium is not installed',
  timeout: 60000,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'webtwist-autotheme-csp-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'none\'">';
  const htmlTag = render(page(csp), root);
  assert.match(htmlTag, /data-result="passed"/, htmlTag.match(/data-error="[^"]*"/)?.[0] || '');
});
