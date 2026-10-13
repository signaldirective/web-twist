import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, lstat, open, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./native-host-fixture.sh', import.meta.url));
const FRAME_LIMIT = 12 * 1024 * 1024;
const QUOTA = 256 * 1024 * 1024;
const MARKER = '.omarchy-browser-theme';
const colors = { background: '#112233', foreground: '#DDEEFF', accent: '#445566' };
const toml = 'background = "#112233"\nforeground = "#ddeeff"\naccent = "#445566"\n';

function frame(message, advertisedLength) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(advertisedLength ?? body.length);
  return Buffer.concat([header, body]);
}

function parseFrames(buffer) {
  const messages = [];
  for (let offset = 0; offset < buffer.length;) {
    assert.ok(buffer.length - offset >= 4, 'complete response header');
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    assert.ok(length > 0 && length <= 1024 * 1024, 'bounded response');
    assert.ok(buffer.length - offset >= length, 'complete response body');
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString()));
    offset += length;
  }
  return messages;
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'webtwist-native-host-test-'));
  const home = join(root, 'home');
  const themes = join(home, '.config/omarchy/themes');
  const state = join(home, '.local/state/omarchy/browser-theme-host');
  const current = join(home, '.local/state/omarchy/current');
  const env = {
    ...process.env, TEST_ROOT: root, TEST_NOW: '1800000000', HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'), OMARCHY_PATH: join(root, 'omarchy'),
  };
  delete env.BASH_ENV;
  delete env.ENV;
  for (const path of [themes, current, env.XDG_RUNTIME_DIR, env.TMPDIR, join(env.OMARCHY_PATH, 'themes'), join(env.OMARCHY_PATH, 'bin')]) {
    await mkdir(path, { recursive: true });
  }
  t.after(() => rm(root, { recursive: true, force: true }));

  async function run(input = Buffer.alloc(0), overrides = {}) {
    const child = spawn('/bin/bash', [fixture], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const finished = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      child.stdin.end(input);
      const exit = await finished;
      assert.equal(exit.signal, null, Buffer.concat(stderr).toString());
      assert.equal(exit.code, 0, Buffer.concat(stderr).toString());
      const messages = parseFrames(Buffer.concat(stdout));
      return { messages, results: messages.filter(m => m.type === 'theme-result'), stderr: Buffer.concat(stderr).toString() };
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
    }
  }
  const install = (name = 'Review', extra = {}, overrides = {}) => run(frame({ type: 'install-theme', id: 'install', name, colors, ...extra }), overrides);
  async function expire() {
    await writeFile(join(state, 'last-install'), `${Number(env.TEST_NOW) - 3}\n`);
  }
  async function clean() {
    assert.deepEqual((await readdir(themes)).filter(name => name.startsWith('.omarchy-browser-stage.')), []);
    assert.deepEqual(await readdir(env.TMPDIR), []);
    assert.equal(await exists(join(state, '.last-install.tmp')), false);
  }
  return { root, home, themes, state, current, env, run, install, expire, clean };
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function markedTheme(path) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, MARKER), '1\n');
  await writeFile(join(path, 'colors.toml'), toml);
}

function usage(path) {
  return Number(execFileSync('du', ['-sb', '--', path], { encoding: 'utf8' }).split('\t')[0]);
}

async function sparse(path, size) {
  const file = await open(path, 'w');
  try { await file.truncate(size); } finally { await file.close(); }
}

test('valid install creates only generated files, releases its lock, and can be set later', async t => {
  const s = await sandbox(t);
  const installed = await s.install('Review_1.0+Blue');
  assert.equal(installed.results[0].ok, true);
  const target = join(s.themes, 'review_1.0+blue');
  assert.deepEqual((await readdir(target)).sort(), [MARKER, 'colors.toml']);
  assert.equal(await readFile(join(target, 'colors.toml'), 'utf8'), toml);
  assert.equal(await readFile(join(target, MARKER), 'utf8'), '1\n');
  assert.equal(await exists(join(s.root, 'lock-leak')), false);
  const result = await s.run(frame({ type: 'set-theme', id: 'set', name: 'Review_1.0+Blue' }));
  assert.equal(result.results[0].ok, true);
  assert.equal((await readFile(join(s.root, 'setter-calls'), 'utf8')).split('\n').filter(Boolean).length, 2);
  await s.clean();
});

for (const collision of ['custom', 'git', 'symlink', 'dangling', 'file', 'builtin', 'builtin-symlink', 'web']) {
  test(`refuses ${collision} collision without changing existing data`, async t => {
    const s = await sandbox(t);
    const target = join(s.themes, 'review');
    const victim = join(s.root, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'sentinel'), 'original');
    let preserved = target;
    if (collision === 'symlink' || collision === 'dangling') {
      await symlink(collision === 'symlink' ? victim : join(s.root, 'missing'), target);
    } else if (collision === 'file') {
      await writeFile(target, 'original');
    } else if (collision.startsWith('builtin')) {
      preserved = join(s.env.OMARCHY_PATH, 'themes/review');
      if (collision === 'builtin-symlink') await symlink(join(s.root, 'missing'), preserved);
      else { await mkdir(preserved); await writeFile(join(preserved, 'sentinel'), 'original'); }
    } else {
      await mkdir(target);
      await writeFile(join(target, 'sentinel'), 'original');
      if (collision === 'git') await mkdir(join(target, '.git'));
      if (collision === 'web') await writeFile(join(target, MARKER), '1\n');
    }
    const before = await lstat(preserved);
    const result = await s.install();
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /already exists/);
    assert.equal((await lstat(preserved)).ino, before.ino);
    assert.equal(await readFile(join(victim, 'sentinel'), 'utf8'), 'original');
    if (collision === 'git') assert.equal(await exists(join(target, '.git')), true);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    await s.clean();
  });
}

for (const fault of ['fail', 'skip', 'directory', 'symlink']) {
  test(`publication ${fault} fails closed and cleans only its staging directory`, async t => {
    const s = await sandbox(t);
    await mkdir(join(s.root, 'victim'));
    await writeFile(join(s.root, 'victim/sentinel'), 'original');
    const result = await s.install('Review', {}, { TEST_PUBLICATION: fault });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /without overwriting/);
    assert.equal(await readFile(join(s.root, 'victim/sentinel'), 'utf8'), 'original');
    if (fault === 'directory') assert.deepEqual(await readdir(join(s.themes, 'review')), ['sentinel']);
    else if (fault === 'symlink') assert.equal((await lstat(join(s.themes, 'review'))).isSymbolicLink(), true);
    else assert.equal(await exists(join(s.themes, 'review')), false);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    await s.clean();
  });
}

test('admission persists across sessions, including failed installs', async t => {
  const s = await sandbox(t);
  assert.equal((await s.install('First', { background: '!!!!' })).results[0].ok, false);
  const rejected = await s.install('Second');
  assert.match(rejected.results[0].error, /rate limited/);
  assert.equal(await exists(join(s.themes, 'second')), false);
  await s.expire();
  assert.equal((await s.install('Second')).results[0].ok, true);
  await s.clean();
});

test('persistent admission requires a two-second timestamp interval', async t => {
  const s = await sandbox(t);
  assert.equal((await s.install('First')).results[0].ok, true);
  const early = await s.install('Second', {}, { TEST_NOW: String(Number(s.env.TEST_NOW) + 1) });
  assert.match(early.results[0].error, /rate limited/);
  const admitted = await s.install('Second', {}, { TEST_NOW: String(Number(s.env.TEST_NOW) + 2) });
  assert.equal(admitted.results[0].ok, true);
  await s.clean();
});

test('timestamp publication failure prevents staging and leaves admission retryable', async t => {
  const s = await sandbox(t);
  const result = await s.install('Review', {}, { TEST_TIMESTAMP_FAILURE: '1' });
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /persist/);
  assert.equal(await exists(join(s.state, 'last-install')), false);
  assert.deepEqual(await readdir(s.themes), []);
  await s.clean();
  assert.equal((await s.install()).results[0].ok, true);
});

test('interrupted publication cleans staging and releases the lock without forgetting admission', async t => {
  const s = await sandbox(t);
  const interrupted = await s.install('First', {}, { TEST_PUBLICATION: 'interrupt' });
  assert.equal(interrupted.results.length, 0);
  assert.deepEqual(await readdir(s.themes), []);
  await s.clean();
  assert.match((await s.install('Second')).results[0].error, /rate limited/);
  await s.expire();
  assert.equal((await s.install('Second')).results[0].ok, true);
});

test('cross-host lock rejects a competing admission before staging', async t => {
  const s = await sandbox(t);
  const first = s.install('First', {}, { TEST_PUBLICATION: 'hold' });
  for (let attempt = 0; !await exists(join(s.root, 'publishing')); attempt++) {
    assert.ok(attempt < 300, 'first host reached publication');
    await delay(10);
  }
  const second = await s.install('Second');
  assert.match(second.results[0].error, /busy/);
  assert.equal((await first).results[0].ok, true);
  assert.deepEqual(await readdir(s.themes), ['first']);
  await s.clean();
});

test('unrelated themes do not consume quota; 64 marked themes is the count boundary', async t => {
  const s = await sandbox(t);
  for (let i = 0; i < 63; i++) await markedTheme(join(s.themes, `owned-${i}`));
  await mkdir(join(s.themes, 'unrelated/.git'), { recursive: true });
  await sparse(join(s.themes, 'unrelated/large'), QUOTA + 1);
  assert.equal((await s.install('Last')).results[0].ok, true);
  await s.expire();
  const rejected = await s.install('Excess');
  assert.match(rejected.results[0].error, /quota/);
  assert.equal(await exists(join(s.themes, 'excess')), false);
  await rm(join(s.themes, 'owned-0'), { recursive: true });
  await s.expire();
  assert.equal((await s.install('Excess')).results[0].ok, true, 'removing a theme frees its quota');
  await s.clean();
});

test('abandoned staging directories remain charged to quota', async t => {
  const s = await sandbox(t);
  for (let i = 0; i < 63; i++) await markedTheme(join(s.themes, `owned-${i}`));
  const abandoned = join(s.themes, '.omarchy-browser-stage.abandoned0');
  await mkdir(abandoned);
  await writeFile(join(abandoned, 'partial'), 'interrupted install');
  assert.match((await s.install()).results[0].error, /quota/);
  assert.equal(await readFile(join(abandoned, 'partial'), 'utf8'), 'interrupted install');
  assert.equal(await exists(join(s.themes, 'review')), false);
});

for (const excess of [0, 1]) {
  test(`aggregate apparent-byte quota ${excess ? 'rejects one byte over' : 'permits exactly'} 256 MiB`, async t => {
    const s = await sandbox(t);
    const existing = join(s.themes, 'owned');
    const sample = join(s.root, 'sample');
    await markedTheme(existing);
    await markedTheme(sample);
    await sparse(join(existing, 'padding'), 0);
    await sparse(join(existing, 'padding'), QUOTA - usage(sample) - usage(existing) + excess);
    const result = await s.install();
    assert.equal(result.results[0].ok, excess === 0);
    if (excess) {
      assert.match(result.results[0].error, /quota/);
      assert.equal(await exists(join(s.themes, 'review')), false);
    } else assert.equal(usage(existing) + usage(join(s.themes, 'review')), QUOTA);
    await s.clean();
  });
}

test('quota measurement errors and malformed markers fail closed', async t => {
  const s = await sandbox(t);
  await markedTheme(join(s.themes, 'owned'));
  assert.match((await s.install('First', {}, { TEST_QUOTA_FAILURE: '1' })).results[0].error, /measure/);
  await s.expire();
  await writeFile(join(s.themes, 'owned', MARKER), 'bogus');
  assert.match((await s.install('Second')).results[0].error, /marker/);
  await s.clean();
});

for (const state of ['malformed', 'future', 'symlink', 'permissions']) {
  test(`rejects unsafe persisted admission state: ${state}`, async t => {
    const s = await sandbox(t);
    await mkdir(s.state, { recursive: true, mode: 0o700 });
    if (state === 'permissions') await chmod(s.state, 0o755);
    else if (state === 'symlink') {
      await writeFile(join(s.root, 'victim'), 'preserve');
      await symlink(join(s.root, 'victim'), join(s.state, 'install.lock'));
    } else {
      await writeFile(join(s.state, 'last-install'), state === 'future' ? '999999999999\n' : '$(id)\n');
    }
    assert.equal((await s.install()).results[0].ok, false);
    assert.deepEqual(await readdir(s.themes), []);
    if (state === 'symlink') assert.equal(await readFile(join(s.root, 'victim'), 'utf8'), 'preserve');
  });
}

test('strict schema rejects malformed colors, controls, extra fields, and oversized names/palettes', async t => {
  const s = await sandbox(t);
  const many = { ...colors };
  for (let i = 0; i < 126; i++) many[`extra${i}`] = '#123456';
  const invalid = [
    { name: 'a'.repeat(65) }, { name: 'Review\n' }, { name: 'Re\u0000view' }, { name: 3 },
    { colors: many }, { colors: [] }, { colors: null }, { colors: { background: '#112233' } },
    { colors: { ...colors, accent: '#123456\n' } },
    { colors: { ...colors, extra: 7 } }, { colors: { ...colors, extra: '#fff' } },
    { colors: { ...colors, 'extra\n': '#123456' } },
    { colors: { ...colors, ['x'.repeat(33)]: '#123456' } },
    { background: null }, { background: 'AA\u0000==' }, { id: 'x'.repeat(65) }, { unexpected: true },
  ];
  const input = Buffer.concat(invalid.map(extra => frame({ type: 'install-theme', id: 'invalid', name: 'Review', colors, ...extra })));
  const result = await s.run(input);
  assert.equal(result.results.length, invalid.length);
  assert.ok(result.results.every(reply => !reply.ok && /schema/.test(reply.error)));
  assert.deepEqual(await readdir(s.themes), []);
  assert.equal(await exists(s.state), false, 'schema failures precede admission writes');
});

test('exact name, color-count, and key-length boundaries are accepted', async t => {
  const s = await sandbox(t);
  const palette = { ...colors, ['x'.repeat(32)]: '#ABCDEF' };
  for (let i = 0; i < 124; i++) palette[`extra${i}`] = '#123456';
  assert.equal((await s.install('a'.repeat(64), { colors: palette })).results[0].ok, true);
  await s.clean();
});

test('set rejects unknown or unsafe names and keeps its per-port apply limit', async t => {
  const s = await sandbox(t);
  await mkdir(join(s.env.OMARCHY_PATH, 'themes/example'));
  const names = ['../escape', 'example;id', 'missing', 'Example', 'Example'];
  const result = await s.run(Buffer.concat(names.map((name, i) => frame({ type: 'set-theme', id: String(i), name }))));
  assert.deepEqual(result.results.map(reply => reply.ok), [false, false, false, true, false]);
  assert.match(result.results.at(-1).error, /rate limited/);
});

test('installation also updates the existing per-port apply limit', async t => {
  const s = await sandbox(t);
  const result = await s.run(Buffer.concat([
    frame({ type: 'install-theme', id: 'install', name: 'Review', colors }),
    frame({ type: 'set-theme', id: 'set', name: 'Review' }),
  ]));
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].error, /rate limited/);
});

test('8 MiB image fits the native cap; one extra decoded byte is refused and cleaned', async t => {
  const s = await sandbox(t);
  const image = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  const accepted = await s.install('Image', { background: image.toString('base64') });
  assert.equal(accepted.results[0].ok, true);
  assert.equal((await lstat(join(s.themes, 'image/backgrounds/image.png'))).size, image.length);
  await s.expire();
  const rejected = await s.install('Oversized', { background: Buffer.concat([image, Buffer.alloc(1)]).toString('base64') });
  assert.equal(rejected.results[0].ok, false);
  assert.match(rejected.results[0].error, /larger than/);
  assert.equal(await exists(join(s.themes, 'oversized')), false);
  await s.clean();
});

test('native framing refuses oversized, partial, NUL-containing, and malformed JSON frames before dispatch', async t => {
  const s = await sandbox(t);
  await mkdir(join(s.env.OMARCHY_PATH, 'themes/example'));
  const request = Buffer.from(JSON.stringify({ type: 'set-theme', id: 'frame', name: 'Example' }));
  for (const input of [
    Buffer.from([1, 0, 0]), frame(Buffer.alloc(0), 0), frame(Buffer.alloc(0), FRAME_LIMIT + 1),
    frame(Buffer.alloc(0), 0xffffffff), frame(request, request.length + 10),
    frame(Buffer.concat([request, Buffer.from('garbage')])), frame(Buffer.concat([request, request])),
    frame(Buffer.concat([request, Buffer.from([0])])), frame(Buffer.from('[]')),
  ]) {
    const result = await s.run(input);
    assert.equal(result.results.length, 0);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
  }
  const padded = Buffer.concat([request, Buffer.alloc(FRAME_LIMIT - request.length, 0x20)]);
  assert.equal((await s.run(frame(padded))).results[0].ok, true);
});

test('palette output is bounded, uses stdin rather than a large argv, and supports resync', async t => {
  const s = await sandbox(t);
  const theme = join(s.current, 'theme');
  await mkdir(theme);
  await writeFile(join(s.current, 'theme.name'), 'T\u00f8ky\u00f8');
  // ASCII JSON escaping expands this below-cap source past Linux MAX_ARG_STRLEN.
  await writeFile(join(theme, 'colors.toml'), `background = "${'\x01'.repeat(30000)}"\n`);
  const result = await s.run(Buffer.concat([frame({}), frame({ type: 'get-palette' })]));
  assert.equal(result.messages.length, 3);
  assert.ok(result.messages.every(message => message.colors.background.length === 30000 && message.name === 'T\u00f8ky\u00f8'));
  await writeFile(join(theme, 'colors.toml'), 'x'.repeat(65537));
  await writeFile(join(s.current, 'theme.name'), 'n'.repeat(200000));
  const oversized = await s.run();
  assert.deepEqual(oversized.messages[0].colors, {});
  assert.equal(oversized.messages[0].name.length, 64);
  assert.equal(oversized.stderr, '');
});
