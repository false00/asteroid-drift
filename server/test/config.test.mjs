import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig, port } from '../config.mjs';
import { buildApp } from '../server.mjs';

const environment = () => ({
  PUBLIC_ORIGIN: 'https://arcade.example', DATABASE_PATH: 'data/game.sqlite',
  MASTER_KEY_FILE: 'master-key', TLS_KEY_FILE: 'tls-key', TLS_CERT_FILE: 'tls-cert',
});
const read = name => name === 'master-key' ? Buffer.alloc(32, 9) : Buffer.from('test-only-certificate-material');

test('production configuration is explicit, HTTPS-only, loopback-bound and auth-disabled by default', () => {
  const config = loadConfig(environment(), read);
  assert.equal(config.origin, 'https://arcade.example');
  assert.equal(config.rpID, 'arcade.example');
  assert.equal(config.listenAddress, '127.0.0.1');
  assert.equal(config.port, 8443);
  assert.equal(config.trustedProxy, null);
  assert.equal(config.authEnabled, false);
  assert.equal(config.https.minVersion, 'TLSv1.3');
});

test('invalid origins, proxy settings, bindings, keys, and ports fail explicitly', () => {
  for (const value of ['http://arcade.example', 'https://arcade.example/', 'https://user:password@arcade.example', 'https://arcade.example/path', 'https://arcade.example?query=1']) assert.throws(() => loadConfig({ ...environment(), PUBLIC_ORIGIN: value }, read));
  for (const field of ['PUBLIC_ORIGIN', 'DATABASE_PATH', 'MASTER_KEY_FILE', 'TLS_KEY_FILE', 'TLS_CERT_FILE']) {
    const env = environment();
    delete env[field];
    assert.throws(() => loadConfig(env, read));
  }
  for (const [field, value] of [['BIND_HOST', 'host.invalid'], ['TRUSTED_PROXY_IP', '*'], ['CLIENT_IP_HEADER', 'arbitrary-header'], ['REDIRECT_HOST', 'arcade.example'], ['REDIRECT_HOST', 'alias.example/path'], ['AUTH_ENABLED', 'yes']]) assert.throws(() => loadConfig({ ...environment(), [field]: value }, read));
  for (const value of ['0', '65536', '80\n', '443 ', '-1', '1.5']) assert.throws(() => port(value));
  assert.throws(() => loadConfig(environment(), () => Buffer.alloc(31)));
});

test('configuration supports credential directories without embedding a deployment path', () => {
  const config = loadConfig({ PUBLIC_ORIGIN: 'https://arcade.example', DATABASE_PATH: 'data/game.sqlite', CREDENTIALS_DIRECTORY: 'credentials', AUTH_ENABLED: '1' }, path => path.endsWith('master-key') ? Buffer.alloc(32, 2) : Buffer.from('test-only'));
  assert.equal(config.authEnabled, true);
});

test('loopback HTTP is allowed only for explicit local development, never a public binding', async t => {
  const config = { origin: 'http://localhost:8080', rpID: 'localhost', listenAddress: '127.0.0.1', allowHttpLocal: true, authEnabled: true, databasePath: ':memory:', masterKey: randomBytes(32) };
  const local = await buildApp(config);
  t.after(() => local.app.close());
  await assert.rejects(buildApp({ ...config, listenAddress: '0.0.0.0' }));
  await assert.rejects(buildApp({ ...config, allowHttpLocal: false }));
  const response = await local.app.inject({ url: '/', remoteAddress: '127.0.0.1', headers: { host: 'localhost:8080' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['strict-transport-security'], undefined);
  assert.ok(response.headers['content-security-policy'].includes('ws://localhost:8080'));
});

test('direct mode ignores forged forwarding headers and derives audits from the connection', async t => {
  const service = await buildApp({ test: true, origin: 'https://arcade.example', rpID: 'arcade.example', listenAddress: '127.0.0.1', databasePath: ':memory:', masterKey: randomBytes(32) });
  t.after(() => service.app.close());
  const response = await service.app.inject({ method: 'POST', url: '/api/auth/bootstrap', remoteAddress: '127.0.0.1', headers: { host: 'arcade.example', origin: 'https://untrusted.example', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.99', 'cf-connecting-ip': '198.51.100.98' }, payload: {} });
  assert.equal(response.statusCode, 403);
  service.flushFailures();
  const events = service.store.export(0, 64).filter(event => event.payload.event_action === 'security.request_rejected');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.client_ip, '127.0.0.1');
});

test('an explicitly trusted proxy cannot be bypassed by another connection address', async t => {
  const service = await buildApp({ test: true, origin: 'https://arcade.example', rpID: 'arcade.example', listenAddress: '127.0.0.1', trustedProxy: '127.0.0.1', clientIpHeader: 'x-real-ip', databasePath: ':memory:', masterKey: randomBytes(32) });
  t.after(() => service.app.close());
  const headers = { host: 'arcade.example', 'x-real-ip': '198.51.100.22' };
  assert.equal((await service.app.inject({ url: '/', remoteAddress: '198.51.100.23', headers })).statusCode, 403);
  assert.equal((await service.app.inject({ url: '/', remoteAddress: '127.0.0.1', headers })).statusCode, 200);
});
