import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.mjs';

const script = fileURLToPath(new URL('../admin.mjs', import.meta.url));

test('the portable management CLI exports encrypted batches and acknowledges the same database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asteroid-drift-admin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'test.sqlite');
  const masterKey = randomBytes(32);
  const store = new Store({ path: databasePath, masterKey });
  store.audit('authentication.initiated', null, '198.51.100.22');
  store.close();
  const call = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: databasePath } });
  const exported = call('export', '0', '64');
  assert.equal(exported.status, 0, exported.stderr);
  const document = JSON.parse(exported.stdout);
  assert.equal(document.events.length, 1);
  assert.equal(document.latest_sequence, 1);
  assert.equal(typeof document.events[0].cipher, 'string');
  assert.ok(!exported.stdout.includes('198.51.100.22'));
  const ack = call('ack', '1');
  assert.equal(ack.status, 0, ack.stderr);
  assert.deepEqual(JSON.parse(ack.stdout), { acknowledged: 1 });
});

test('the management CLI rejects controls, excessive batches, and an implicit database', () => {
  for (const args of [['export', '0\n'], ['export', '0', '65'], ['export', '0', '1\n'], ['ack', '-1']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  const env = { ...process.env };
  delete env.DATABASE_PATH;
  const result = spawnSync(process.execPath, [script, 'export', '0'], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_PATH/);
});
