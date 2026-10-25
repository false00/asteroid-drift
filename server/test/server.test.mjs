import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../server.mjs';
import { authenticator } from './authenticator.mjs';

async function rig(t) {
  let time = 1900000000000;
  const service = await buildApp({
    test: true, origin: 'https://arcade.example', rpID: 'arcade.example', trustedProxy: '127.0.0.1', listenAddress: '127.0.0.1',
    databasePath: ':memory:', masterKey: randomBytes(32), now: () => time,
  });
  t.after(() => service.app.close());
  let cookie;
  let csrf;
  const request = async (url, body, headers = {}) => {
    const result = await service.app.inject({
      method: body === undefined ? 'GET' : 'POST', url, remoteAddress: '127.0.0.1',
      headers: { host: 'arcade.example', 'x-forwarded-for': '198.51.100.12', origin: 'https://arcade.example', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
      ...(body === undefined ? {} : { payload: body }),
    });
    if (result.headers['set-cookie']) {
      cookie = result.headers['set-cookie'].includes('Max-Age=0') ? undefined : result.headers['set-cookie'].split(';')[0];
      if (!cookie) csrf = undefined;
    }
    const data = result.headers['content-type']?.startsWith('application/json') ? result.json() : null;
    if (data?.csrf) csrf = data.csrf;
    return { status: result.statusCode, data, headers: result.headers };
  };
  const register = async (handle = 'Pilot_01', options = {}) => {
    const device = authenticator();
    assert.equal((await request('/api/auth/bootstrap', {})).status, 200);
    const result = await request('/api/auth/register/options', { username: handle });
    assert.equal(result.status, 200);
    const response = device.register(result.data.options, options);
    return { device, response, result: await request('/api/auth/register/verify', { credential: response }) };
  };
  return { ...service, request, register, time: value => { time += value; }, cookie: () => cookie, csrf: () => csrf };
}

test('real WebAuthn cryptography reserves an encrypted handle and creates a rotated secure session', async t => {
  const env = await rig(t);
  await env.request('/api/auth/bootstrap', {});
  const before = env.cookie();
  const { result } = await env.register('Space_Pilot');
  assert.equal(result.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.user.username, 'Space_Pilot');
  assert.equal(result.data.user.personalBest, 0);
  assert.notEqual(env.cookie(), before);
  assert.match(result.headers['set-cookie'], /^__Host-curlred_session=/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(result.headers['set-cookie'].includes(flag));
  assert.doesNotMatch(result.headers['set-cookie'], /Domain=/);
  assert.equal((await env.request('/api/session')).data.user.username, 'Space_Pilot');
  assert.equal((await env.request('/api/session', undefined, { cookie: before })).data.authenticated, false);
  const events = env.store.export(0, 100).map(item => item.payload);
  assert.ok(events.some(event => event.event_action === 'account.created' && event.actor.username === 'Space_Pilot' && event.client_ip === '198.51.100.12'));
  assert.ok(!JSON.stringify(events).includes('clientDataJSON'));
  assert.ok(!JSON.stringify(events).includes(env.cookie().split('=')[1]));
});

test('WebAuthn rejects missing UV, a wrong RP ID and a wrong signed origin without creating an account', async t => {
  for (const options of [{ uv: false }, { rpID: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }]) {
    const env = await rig(t);
    const { result } = await env.register('Bad_Pilot', options);
    assert.equal(result.status, 401);
    assert.equal(env.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
  }
});

test('discoverable sign-in checks signatures and single-use challenges, and replay does not create a new session', async t => {
  const env = await rig(t);
  const { device } = await env.register();
  await env.request('/api/auth/logout', {});
  await env.request('/api/auth/bootstrap', {});
  const options = await env.request('/api/auth/login/options', {});
  assert.deepEqual(options.data.options.allowCredentials, []);
  const credential = device.login(options.data.options);
  const logged = await env.request('/api/auth/login/verify', { credential });
  assert.equal(logged.status, 200);
  const replay = await env.request('/api/auth/login/verify', { credential });
  assert.equal(replay.status, 400);
  assert.equal(replay.data.error, 'challenge_expired');
});

test('sibling-subdomain CSRF, invalid schemas, Unicode, malformed cookies and oversized bodies fail closed', async t => {
  const env = await rig(t);
  assert.equal((await env.request('/api/auth/bootstrap', {}, { origin: 'https://untrusted.arcade.example' })).status, 403);
  assert.equal((await env.request('/api/auth/bootstrap', {}, { origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await env.request('/api/auth/bootstrap', {}, { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' })).status, 400);
  await env.request('/api/auth/bootstrap', {});
  assert.equal((await env.request('/api/auth/register/options', { username: 'Valid_123', role: 'admin' })).status, 400);
  assert.equal((await env.request('/api/auth/register/options', { username: 'Ａlice' })).status, 400);
  assert.equal((await env.request('/api/auth/register/options', { username: 'Valid_123' }, { 'x-csrf-token': 'forged' })).status, 403);
  assert.equal((await env.request('/api/session', undefined, { cookie: '__Host-curlred_session=bad' })).status, 400);
  assert.equal((await env.request('/api/auth/register/options', { username: 'a'.repeat(17000) })).status, 413);
  assert.equal((await env.request('/api/session?token=not-allowed')).status, 400);
  const response = await env.app.inject({ method: 'POST', url: '/api/auth/register/options', headers: { host: 'arcade.example', 'x-forwarded-for': '198.51.100.1', origin: 'https://arcade.example', 'content-type': 'application/json' }, payload: Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]) });
  assert.equal(response.statusCode, 400);
});

test('public responses forbid caching, framing, MIME sniffing and cross-origin credentials access', async t => {
  const env = await rig(t);
  const result = await env.request('/api/leaderboard');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['x-frame-options'], 'DENY');
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(result.data.entries, []);
  assert.equal((await env.request('/server.mjs')).status, 404);
  assert.equal((await env.request('/game.sqlite')).status, 404);
  assert.equal((await env.request('/api/score', { score: 99999999 })).status, 404);
});

test('ranked REST rejects browser scores and cheats rather than accepting signed client totals', async t => {
  const env = await rig(t);
  await env.register();
  assert.equal((await env.request('/api/ranked/start', { score: 9999999 })).status, 400);
  assert.equal((await env.request('/api/ranked/start', { cheats: 127 })).status, 400);
  assert.equal((await env.request('/api/ranked/start', { personalBest: 9999999 })).status, 400);
  assert.equal((await env.request('/api/ranked/start', {})).status, 200);
  assert.equal((await env.request('/api/ranked/start', {})).status, 409);
  assert.equal(env.store.leaderboard().length, 0);
});

test('personal best is read from the owned account and never accepted from browser data', async t => {
  const env = await rig(t);
  const { result } = await env.register();
  const pilot = env.store.account(result.data.user.id);
  const { id } = env.runs.start(pilot, '198.51.100.12');
  const run = env.runs.runs.get(id);
  run.game.score = 12345;
  run.activeMs = 3000;
  env.runs.finish(run, 'player_finished');
  assert.equal((await env.request('/api/session')).data.user.personalBest, 12345);
  assert.equal((await env.request('/api/auth/bootstrap', { personalBest: 9999999 })).status, 400);
  await env.request('/api/auth/logout', {});
  const signedOut = (await env.request('/api/session')).data;
  assert.equal(signedOut.authenticated, false);
  assert.equal(signedOut.user, null);
});

test('ranked restart requires authentication, exact origin, CSRF, a current owned run and the start rate budget', async t => {
  const env = await rig(t);
  assert.equal((await env.request('/api/ranked/restart', { runId: null })).status, 401);
  await env.register();
  const started = await env.request('/api/ranked/start', {});
  const id = started.data.run.id;
  for (const body of [{}, { runId: 'invalid' }, { runId: id, score: 99999 }, { runId: id, cheats: 127 }]) {
    assert.equal((await env.request('/api/ranked/restart', body)).status, 400);
  }
  assert.equal((await env.request('/api/ranked/restart', { runId: id }, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await env.request('/api/ranked/restart', { runId: id }, { 'x-csrf-token': 'forged' })).status, 403);
  assert.equal((await env.request('/api/ranked/restart', { runId: null })).status, 409);
  const before = env.store.db.prepare('SELECT count(*) AS n FROM runs').get().n;
  const restarted = await env.request('/api/ranked/restart', { runId: id });
  assert.equal(restarted.status, 200);
  assert.notEqual(restarted.data.run.id, id);
  assert.equal(env.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, before);
  assert.equal((await env.request('/api/ranked/restart', { runId: id })).status, 409);
  let current = restarted.data.run.id;
  for (let i = 0; i < 10; i++) {
    const result = await env.request('/api/ranked/restart', { runId: current });
    if (result.status === 429) break;
    assert.equal(result.status, 200);
    current = result.data.run.id;
  }
  assert.equal((await env.request('/api/ranked/restart', { runId: current })).status, 429);
  assert.equal(env.store.leaderboard().length, 0);
});

test('ranked creation accepts only a bounded viewport and the server derives its arena', async t => {
  const env = await rig(t);
  const { result } = await env.register();
  for (const viewport of [{ width: 0, height: 600 }, { width: 390.5, height: 620 }, { width: 390, height: 620, score: 9999 }, { width: 1, height: 100000 }]) {
    assert.equal((await env.request('/api/ranked/start', { viewport })).status, 400);
  }
  const response = await env.request('/api/ranked/start', { viewport: { width: 390 * 64, height: 620 * 64 } });
  assert.equal(response.status, 200);
  const run = env.runs.mine(result.data.user.id);
  assert.equal(run.id, response.data.run.id);
  assert.ok(Math.abs(run.game.width / run.game.height - 390 / 620) < 0.0000001);
  assert.ok(Math.abs(run.game.width * run.game.height - 960 * 640) < 0.000001);
  assert.equal(run.game.score, 0);
});

test('legacy anonymous actual-play payloads remain separate and preserve the exact typed parser shape', async t => {
  const env = await rig(t);
  const payload = new URLSearchParams({
    v: 1, run: '1153022a-2af4-443c-a434-50726f524c53', seq: 1, event: 'start', reason: 'qualified',
    play_ms: 2000, active_ms: 2000, score: 0, wave: 1, shots: 4, hits: 0, rocks: 0,
    deaths: 0, shields: 0, pickups: 0, combo: 1, controls: 'keyboard', device: 'desktop',
    automated: 1, cheats: 0, sound: 1, haptics: 0, build: '20261024.5',
  }).toString();
  const accepted = await env.request(`/arcade/events?${payload}`, '');
  assert.equal(accepted.status, 204);
  const events = env.store.export(0, 100);
  const gameplay = events.find(event => event.kind === 'gameplay').payload;
  assert.equal(gameplay.args, payload);
  assert.equal(gameplay.time_iso8601, new Date(1900000000000).toISOString());
  assert.equal(gameplay.client_ip, undefined);
  assert.equal(gameplay.actor, undefined);
  const detached = await env.request(`/arcade/events?${payload}`, '', { origin: 'null', 'sec-fetch-site': 'same-origin' });
  assert.equal(detached.status, 204);
  const unsafe = await env.request(`/arcade/events?${payload}`, '', { origin: 'null', 'sec-fetch-site': 'cross-site' });
  assert.equal(unsafe.status, 403);
  for (const ending of ['%0A', '%0D', '%E2%80%A8', '%E2%80%A9']) {
    assert.equal((await env.request(`/arcade/events?${payload.replace('shots=4', `shots=4${ending}`)}`, '')).status, 400);
  }
  assert.equal(env.store.export(0, 100).at(-1).payload.origin_verification, 'same_origin_fetch_metadata');
});
