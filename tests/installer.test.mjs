import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const HOST_NAME = 'com.webtwist.host';

function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'webtwist-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: root };
  const run = (args = []) => execFileSync('/bin/bash', [join(project, 'install.sh'), ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 20000,
  });
  return { root, run };
}

// Firefox reads the fixed ~/.mozilla path even with an XDG profile, and an
// XDG-honouring build looks under the config dir. The installer writes both.
const hostManifests = (root) => [
  join(root, '.mozilla', 'native-messaging-hosts', `${HOST_NAME}.json`),
  join(root, 'config', 'mozilla', 'native-messaging-hosts', `${HOST_NAME}.json`),
];

test('install registers the native host for both Firefox manifest locations', (t) => {
  const { root, run } = environment(t);
  assert.match(run(), /Registered com\.webtwist\.host/);

  const gecko = JSON.parse(readFileSync(join(project, 'extension/manifest.json'), 'utf8'))
    .browser_specific_settings.gecko.id;

  for (const manifest of hostManifests(root)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(parsed.name, HOST_NAME);
    assert.equal(parsed.type, 'stdio');
    assert.equal(parsed.path, join(project, 'bin', 'webtwist-host'));
    // The add-on id is registered once, in two files; this keeps them honest.
    assert.deepEqual(parsed.allowed_extensions, [gecko]);
    assert.equal(parsed.allowed_origins, undefined, 'Firefox uses allowed_extensions, not allowed_origins');
  }
});

test('uninstall removes the host manifests again', (t) => {
  const { root, run } = environment(t);
  run();
  run(['--uninstall']);
  for (const manifest of hostManifests(root)) assert.equal(existsSync(manifest), false);
});

test('uninstalling when nothing is installed is a quiet no-op', (t) => {
  const { run } = environment(t);
  assert.match(run(['--uninstall']), /Removed the com\.webtwist\.host host manifest/);
});

test('an unknown option is refused instead of doing something unexpected', (t) => {
  const { run } = environment(t);
  assert.throws(() => run(['--all']), /unknown option/);
});
