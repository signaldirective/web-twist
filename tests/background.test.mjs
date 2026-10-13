import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The worker loads presets.js and background.js into one shared scope, the way
// the manifest lists them, so the test concatenates them the same way.
const presets = readFileSync(new URL('../extension/presets.js', import.meta.url), 'utf8');
const source = presets + '\n' + readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const wallpaperHost = 'wallpapers.hel1.your-objectstorage.com';
const wallpaper = `https://${wallpaperHost}/test.png`;
const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const colors = { background: '#112233', foreground: '#DDEEFF', accent: '#445566' };
const trusted = { origin: 'https://omarchy.org', frameId: 0 };
const flush = () => new Promise(setImmediate);
// Replies cross a vm realm boundary, so their prototypes are not this realm's.
// Compare a plain, structured-cloned copy instead of the live object.
const plain = (value) => JSON.parse(JSON.stringify(value));
// The worker also broadcasts the palette on startup, so a test interested in the
// per-site decision looks past those to the site-state messages.
const siteMessages = (w) => w.sentTabMessages.filter((entry) => entry.message.type === 'webtwist-site-state');

function event() {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), emit: (...args) => listeners.map((listener) => listener(...args)) };
}

function worker(fetchImpl = async () => { throw new Error('unexpected fetch'); }, options = {}) {
  const messages = event();
  const commands = event();
  const timers = new Map();
  const ports = [];
  const posts = [];
  const fetches = [];
  const sentTabMessages = [];
  const store = options.store || {};
  const tabs = options.tabs || [];
  let timerId = 0;
  const context = vm.createContext({
    URL, Uint8Array, AbortController, btoa,
    fetch: (url, options) => {
      fetches.push({ url, options });
      return fetchImpl(url, options);
    },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      runtime: {
        onMessage: messages, onStartup: event(), onInstalled: event(),
        connectNative: () => {
          const port = { onMessage: event(), onDisconnect: event(), postMessage: (message) => posts.push(message) };
          ports.push(port);
          return port;
        },
      },
      storage: {
        local: {
          get: async (keys) => {
            if (typeof keys === 'string') return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
            return { ...store };
          },
          set: async (values) => { Object.assign(store, values); },
        },
      },
      tabs: {
        query: (_query, callback) => callback(typeof options.tabs === 'function' ? options.tabs(_query) : tabs),
        sendMessage: (id, message, callback) => {
          sentTabMessages.push({ id, message });
          if (callback) callback();
        },
      },
      commands: { onCommand: commands },
    },
  });
  vm.runInContext(source + '\nglobalThis.testApi = { fetchImage, maySetThemes, effectivePalette, PRESET_PALETTES, DOWNLOAD_TIMEOUT_MS, INSTALL_TIMEOUT_MS, MAX_IMAGE_BYTES };', context);
  const send = (message, sender = trusted) => {
    const replies = [];
    const result = new Promise((resolve) => messages.emit(message, sender, (reply) => {
      replies.push(reply);
      resolve(reply);
    }));
    result.replies = replies;
    return result;
  };
  return {
    ...context.testApi, fetches, posts, ports, timers, store, sentTabMessages, commands,
    send,
    install: (extra = {}, sender = trusted) => send({
      type: 'webtwist-install-theme', name: 'Review', colors, ...extra,
    }, sender),
    finish: (extra = {}) => ports.at(-1).onMessage.emit({ type: 'theme-result', id: posts.at(-1).id, ok: true, name: posts.at(-1).name, ...extra }),
    fire: (delay) => {
      const matching = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
      assert.equal(matching.length, 1, `exactly one ${delay}ms timer`);
      const [id, timer] = matching[0];
      timers.delete(id);
      timer.callback();
    },
  };
}

test('only the exact production origin in the top frame may write by default', async () => {
  const w = worker();
  assert.equal(w.maySetThemes(trusted).allowed, true);
  const denied = [
    { ...trusted, frameId: 1 }, { origin: trusted.origin },
    { origin: 'null', url: trusted.origin, frameId: 0 },
    ...['http://localhost', 'http://localhost:8080', 'https://localhost:54321',
      'https://omarchy.org:444', 'http://omarchy.org', 'https://themes.omarchy.org',
      'https://omarchy.org.evil.example', 'https://evil.example', 'file://', 'null']
      .map((origin) => ({ origin, frameId: 0 })),
  ];
  for (const sender of denied) {
    assert.equal(w.maySetThemes(sender).allowed, false, JSON.stringify(sender));
    assert.equal((await w.install({ backgroundUrl: wallpaper }, sender)).ok, false);
    assert.equal((await w.send({ type: 'webtwist-set-theme', name: 'Review' }, sender)).ok, false);
  }
  assert.equal(w.fetches.length, 0);
  assert.equal(w.posts.length, 0);
});

test('wallpaper allowlist rejects private IPv4/IPv6, unknown hosts, alternate ports and credentials before fetching', async () => {
  const w = worker();
  for (const url of [
    'https://[::1]/', 'https://[::]/', 'https://[fc00::1]/', 'https://[fe80::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://[::ffff:192.168.1.1]/',
    'https://[2001:4860:4860::8888]/', 'https://127.0.0.1/', 'https://127.1/',
    'https://2130706433/', 'https://192.168.1.1/', 'https://10.1.2.3/',
    'https://localhost/', 'https://internal/', 'https://evil.example/',
    `https://${wallpaperHost}.evil.example/`, `https://evil.${wallpaperHost}/`,
    `https://${wallpaperHost}./`, `https://${wallpaperHost}:8443/`,
    `https://user:pass@${wallpaperHost}/`, `https://${wallpaperHost}@127.0.0.1/`,
    `http://${wallpaperHost}/`, 'data:image/png;base64,AA==', 'file:///tmp/test.png', 'not a url',
  ]) {
    await assert.rejects(w.fetchImage(url), /allowed wallpaper host|must be https|not a url/, url);
  }
  assert.equal(w.fetches.length, 0);
  assert.equal(w.timers.size, 0);
  assert.deepEqual(manifest.host_permissions, [`https://${wallpaperHost}/*`]);
});

test('valid image requests omit credentials, reject redirects and clean up their timeout', async () => {
  const w = worker(async () => new Response(image, { headers: { 'content-type': 'IMAGE/PNG; charset=binary' } }));
  assert.equal(await w.fetchImage(wallpaper), Buffer.from(image).toString('base64'));
  assert.equal(w.fetches[0].options.redirect, 'error');
  assert.equal(w.fetches[0].options.credentials, 'omit');
  assert.equal(w.fetches[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
});

test('redirect responses never trigger a second request', async () => {
  const w = worker(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 302, headers: { location: 'https://[::1]/' } });
  });
  await assert.rejects(w.fetchImage(wallpaper), /HTTP 302/);
  assert.equal(w.fetches.length, 1);
  assert.equal(w.fetches[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
});

test('declared oversized images are rejected before reading their stream', async () => {
  let reads = 0;
  const w = worker(async () => new Response(new ReadableStream({
    pull() { reads++; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png', 'content-length': String(8 * 1024 * 1024 + 1) } }));
  await assert.rejects(w.fetchImage(wallpaper), /larger than 8MB/);
  assert.equal(reads, 0);
  assert.equal(w.fetches[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
});

for (const declaredLength of [undefined, '1']) {
  test(`stream limit aborts an oversized response with ${declaredLength ? 'a false' : 'no'} Content-Length`, async () => {
    let chunks = 0;
    let cancelled = false;
    const w = worker(async () => new Response(new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (chunks === 100) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png', ...(declaredLength ? { 'content-length': declaredLength } : {}) } }));
    await assert.rejects(w.fetchImage(wallpaper), /larger than 8MB/);
    assert.equal(chunks, 9, 'stop at the first chunk crossing the limit, not the end of the body');
    assert.equal(cancelled, true);
    assert.equal(w.fetches[0].options.signal.aborted, true);
    assert.equal(w.timers.size, 0);
  });
}

test('an image exactly 8 MiB is accepted without altering its bytes', async () => {
  const input = new Uint8Array(8 * 1024 * 1024).fill(123);
  input.set(image);
  const w = worker(async () => new Response(input, { headers: { 'content-type': 'image/png' } }));
  assert.equal(await w.fetchImage(wallpaper), Buffer.from(input).toString('base64'));
  assert.equal(w.timers.size, 0);
});

for (const stage of ['headers', 'body']) {
  test(`download deadline aborts stalled ${stage} and releases the installation slot`, async () => {
    const w = worker(async (_url, { signal }) => {
      if (stage === 'headers') return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }), { headers: { 'content-type': 'image/png' } });
    });
    const request = w.install({ backgroundUrl: wallpaper });
    await flush();
    for (let i = 0; i < 20; i++) assert.match((await w.install()).error, /in progress/);
    assert.equal(w.fetches.length, 1);
    w.fire(w.DOWNLOAD_TIMEOUT_MS);
    assert.match((await request).error, /download timed out/);
    assert.equal(w.timers.size, 0);
    assert.equal(w.posts.length, 0);
    const next = w.install();
    w.finish();
    assert.equal((await next).ok, true);
    assert.equal(w.timers.size, 0);
  });
}

for (const [name, response] of [
  ['HTTP failure', () => new Response(null, { status: 500 })],
  ['invalid MIME', () => new Response(image, { headers: { 'content-type': 'image/png+xml' } })],
  ['empty image', () => new Response(null, { headers: { 'content-type': 'image/png' } })],
  ['empty stream', () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } })],
  ['network failure', () => { throw new Error('network failed'); }],
  ['stream failure', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')); } }), { headers: { 'content-type': 'image/png' } })],
]) {
  test(`${name} does not leave an active timer or installation`, async () => {
    const w = worker(async () => response());
    assert.equal((await w.install({ backgroundUrl: wallpaper })).ok, false);
    assert.equal(w.timers.size, 0);
    assert.equal(w.posts.length, 0);
    const next = w.install();
    w.finish();
    assert.equal((await next).ok, true);
  });
}

test('installation admission lasts until the host replies and transports bounded image data', async () => {
  const w = worker(async () => new Response(image, { headers: { 'content-type': 'image/png' } }));
  const first = w.install({ backgroundUrl: wallpaper });
  await flush();
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].background, Buffer.from(image).toString('base64'));
  assert.match((await w.install({ backgroundUrl: wallpaper })).error, /in progress/);
  assert.equal(w.fetches.length, 1);
  w.finish();
  assert.equal((await first).ok, true);
  assert.equal(w.timers.size, 0);
});

for (const failure of ['timeout', 'disconnect', 'post']) {
  test(`native ${failure} releases installation admission and settles only once`, async () => {
    const w = worker();
    if (failure === 'post') w.ports[0].postMessage = () => { throw new Error('port lost'); };
    const request = w.install();
    if (failure === 'timeout') w.fire(w.INSTALL_TIMEOUT_MS);
    if (failure === 'disconnect') w.ports[0].onDisconnect.emit();
    assert.equal((await request).ok, false);
    if (failure === 'timeout') {
      for (let i = 0; i < 4; i++) assert.match((await w.install()).error, /in progress/);
      assert.equal(w.posts.length, 1, 'timeout must not queue additional native work');
      w.finish();
      await flush();
    }
    assert.equal(request.replies.length, 1, 'each caller receives exactly one response');
    const next = w.install();
    w.finish();
    assert.equal((await next).ok, true);
    assert.ok([...w.timers.values()].every(({ delay }) => delay === 1000), 'only a reconnect timer may remain');
  });
}

test('a timed-out native installation releases admission on disconnection', async () => {
  const w = worker();
  const request = w.install();
  w.fire(w.INSTALL_TIMEOUT_MS);
  assert.equal((await request).ok, false);
  assert.match((await w.install()).error, /in progress/);
  w.ports[0].onDisconnect.emit();
  await flush();
  const next = w.install();
  w.finish();
  assert.equal((await next).ok, true);
});

test('invalid or oversized specifications are rejected before downloading or posting', async () => {
  const w = worker();
  const many = { ...colors };
  for (let i = 0; i < 126; i++) many[`extra${i}`] = '#123456';
  for (const extra of [
    { name: '' }, { name: 'x'.repeat(65) }, { name: 'Review\n' }, { name: {} },
    { colors: many }, { colors: [] }, { colors: null }, { colors: { accent: '#123456' } },
    { colors: { ...colors, ['x'.repeat(33)]: '#123456' } },
    { colors: { ...colors, 'extra\n': '#123456' } }, { colors: { ...colors, extra: '#123456\n' } },
    { colors: { ...colors, extra: 3 } }, { backgroundUrl: {} }, { backgroundUrl: 'x'.repeat(4097) },
  ]) {
    assert.match((await w.install({ backgroundUrl: wallpaper, ...extra })).error, /invalid theme specification/);
  }
  assert.equal(w.fetches.length, 0);
  assert.equal(w.posts.length, 0);
  assert.equal(w.timers.size, 0);
});

test('gallery-shaped specifications and exact schema boundaries remain valid', async () => {
  const w = worker(async () => new Response(image, { headers: { 'content-type': 'image/png' } }));
  const maximum = { ...colors, ['x'.repeat(32)]: '#ABCDEF' };
  for (let i = 0; i < 124; i++) maximum[`extra${i}`] = '#123456';
  const specs = [
    { name: 'Review', colors: { ...colors }, background: wallpaper },
    { name: 'x'.repeat(64), colors: maximum, background: wallpaper },
  ];
  for (const spec of specs) {
    const request = w.install({ name: spec.name, colors: spec.colors, backgroundUrl: spec.background });
    await flush();
    assert.equal(w.posts.at(-1)?.name, spec.name);
    w.finish();
    assert.equal((await request).ok, true);
  }
  assert.equal(w.fetches.length, specs.length);
  assert.equal(w.timers.size, 0);
});

test('site theming is on by default and follows per-site exceptions', async () => {
  const w = worker(undefined, { store: { autoTheme: { default: true, sites: { 'https://quiet.test': false } } } });
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://example.com' })).enabled, true);
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://quiet.test' })).enabled, false);
});

test('a global default of off is overridden per site without touching other sites', async () => {
  const w = worker(undefined, { store: { autoTheme: { default: false, sites: { 'https://loud.test': true } } } });
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://loud.test' })).enabled, true);
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://other.test' })).enabled, false);
});

test('malformed stored exceptions fall back to the default instead of leaking through', async () => {
  const w = worker(undefined, {
    store: { autoTheme: { default: true, sites: { 'not-an-origin': false, 'https://stringy.test': 'no', 'https://ok.test': false } } },
  });
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://ok.test' })).enabled, false);
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://stringy.test' })).enabled, true);
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'not-an-origin' })).enabled, true);
  // A sandboxed frame reports an opaque origin; it must not inherit default-on.
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'null' })).enabled, false);
});

test('the popup toggles the active tab and broadcasts the decision to that origin only', async () => {
  const w = worker(undefined, {
    tabs: [
      { id: 7, url: 'https://example.com/a', title: 'Example' },
      { id: 8, url: 'https://other.test/b' },
      { id: 9, url: 'about:blank' },
    ],
  });

  const state = await w.send({ type: 'webtwist-tab-state' });
  assert.deepEqual(plain(state), { origin: 'https://example.com', title: 'Example', enabled: true, supported: true });

  const result = await w.send({ type: 'webtwist-set-site', enabled: false });
  assert.deepEqual(plain(result), { ok: true, origin: 'https://example.com', enabled: false });
  assert.equal(w.store.autoTheme.sites['https://example.com'], false);
  assert.deepEqual(plain(siteMessages(w)), [{ id: 7, message: { type: 'webtwist-site-state', enabled: false } }]);

  // Asking the content-script path afterwards reads the saved exception.
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://example.com' })).enabled, false);
  assert.equal((await w.send({ type: 'webtwist-site-state' }, { origin: 'https://other.test' })).enabled, true);

  // Turning it back on drops the redundant exception rather than storing a value
  // equal to the default.
  await w.send({ type: 'webtwist-set-site', enabled: true });
  assert.equal(Object.hasOwn(w.store.autoTheme.sites, 'https://example.com'), false);
});

test('a tab with no themeable origin cannot be toggled and is reported unsupported', async () => {
  const w = worker(undefined, { tabs: [{ id: 1, url: 'about:blank' }] });
  assert.deepEqual(plain(await w.send({ type: 'webtwist-tab-state' })), { origin: null, title: '', enabled: false, supported: false });
  assert.match((await w.send({ type: 'webtwist-set-site', enabled: false })).error, /cannot be themed/);
  assert.equal(w.store.autoTheme, undefined);
  assert.equal(siteMessages(w).length, 0);
});

test('an invalid toggle is refused before the tab is even looked at', async () => {
  const w = worker(undefined, { tabs: [{ id: 1, url: 'https://example.com/' }] });
  assert.match((await w.send({ type: 'webtwist-set-site', enabled: 'yes' })).error, /invalid setting/);
  assert.equal(w.store.autoTheme, undefined);
});

test('the keyboard command flips the active tab and announces the change', async () => {
  const w = worker(undefined, { tabs: [{ id: 3, url: 'https://shortcut.test/page', title: 'Shortcut' }] });
  w.commands.emit('toggle-site-theming');
  for (let i = 0; i < 10 && !w.store.autoTheme; i++) await flush();

  assert.equal(w.store.autoTheme.sites['https://shortcut.test'], false);
  assert.deepEqual(plain(siteMessages(w)), [{ id: 3, message: { type: 'webtwist-site-state', enabled: false } }]);
});

test('a bundled palette is used when no desktop palette arrives', async () => {
  const w = worker();
  const palette = w.effectivePalette();
  assert.equal(palette.source, 'fallback');
  assert.equal(palette.name, 'Omarchy');
  assert.equal(palette.mode, 'dark');
});

test('the desktop palette takes over once the helper connects', async () => {
  const w = worker();
  assert.equal(w.effectivePalette().source, 'fallback');

  // Asking for the palette also opens the port, so ports[0] exists deterministically.
  await w.send({ type: 'webtwist-get-palette' });
  w.ports[0].onMessage.emit({
    type: 'palette', name: 'Grand Theft Omarchy', mode: 'dark',
    colors: { background: '#08050d', foreground: '#ffd0c0', accent: '#ff5ccc' },
  });

  const palette = w.effectivePalette();
  assert.equal(palette.source, 'desktop');
  assert.equal(palette.name, 'Grand Theft Omarchy');
  assert.deepEqual(plain(palette.colors), { background: '#08050d', foreground: '#ffd0c0', accent: '#ff5ccc' });
});

test('a chosen preset is used even while a desktop palette is live', async () => {
  const w = worker();
  await w.send({ type: 'webtwist-get-palette' });
  w.ports[0].onMessage.emit({ type: 'palette', name: 'Desktop', mode: 'dark', colors: { background: '#000000' } });

  const result = await w.send({ type: 'webtwist-set-palette-settings', paletteMode: 'preset', preset: 'gruvbox' });
  assert.deepEqual(plain(result), {
    ok: true, settings: { paletteMode: 'preset', preset: 'gruvbox' }, source: 'preset', desktop: true,
  });
  assert.equal(w.effectivePalette().name, 'Gruvbox');
  assert.equal(w.store.settings.preset, 'gruvbox');
});

test('an invalid palette change keeps the previous choice rather than resetting it', async () => {
  const w = worker();
  await w.send({ type: 'webtwist-set-palette-settings', paletteMode: 'preset', preset: 'gruvbox' });

  const result = await w.send({ type: 'webtwist-set-palette-settings', paletteMode: 'nonsense', preset: 'does-not-exist' });
  assert.equal(result.ok, true);
  assert.equal(result.settings.paletteMode, 'preset');
  assert.equal(result.settings.preset, 'gruvbox');
});

test('the palette settings response names the source, the presets, and the desktop state', async () => {
  const w = worker();
  const response = await w.send({ type: 'webtwist-palette-settings' });

  assert.equal(response.settings.paletteMode, 'desktop');
  assert.equal(response.source, 'fallback');
  assert.equal(response.desktop, false);
  assert.deepEqual(plain(response.presets.map((preset) => preset.id)), ['omarchy', 'omarchy-light', 'catppuccin', 'gruvbox']);
  assert.match(response.presets[0].colors.background, /^#[0-9a-f]{6}$/);
});

test('every bundled preset is a complete, well-formed palette', () => {
  const w = worker();
  for (const preset of w.PRESET_PALETTES) {
    assert.match(preset.id, /^[a-z][a-z0-9-]*$/, preset.id);
    assert.ok(preset.mode === 'dark' || preset.mode === 'light', preset.id);
    assert.ok(preset.name.length > 0, preset.id);
    for (const key of ['background', 'foreground', 'accent', 'dark_background', 'lighter_background']) {
      assert.match(preset.colors[key], /^#[0-9a-f]{6}$/, `${preset.id}.${key}`);
    }
  }
});
