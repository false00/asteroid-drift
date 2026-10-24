import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { Runs } from './runs.mjs';
import { ApiError, Budget, base64url, cookieToken, equal, object, tokenMatches, username, webauthnCredential } from './validation.mjs';
import { loadConfig } from './config.mjs';
import { FILES } from './assets.mjs';

const SITE = fileURLToPath(new URL('../web/site/', import.meta.url));
const COOKIE = '__Host-curlred_session';
const cookie = (value, age = 43200) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
const apiBody = (request, keys = [], required = keys) => object(request.body, keys, required);

export async function buildApp(config) {
  const origin = new URL(config.origin);
  const rpID = config.rpID;
  const now = config.now || Date.now;
  const localHttp = config.allowHttpLocal && origin.protocol === 'http:' && origin.hostname === 'localhost' && ['127.0.0.1', '::1'].includes(config.listenAddress) && !config.trustedProxy;
  if (origin.hostname !== rpID || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || config.origin !== origin.origin || (!config.test && !localHttp && (origin.protocol !== 'https:' || !config.https))) throw new Error('Canonical verified HTTPS is required outside loopback-only local development.');
  const clientIpHeader = config.clientIpHeader || 'x-forwarded-for';
  const socketOrigin = new URL(origin);
  socketOrigin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const store = new Store({ path: config.databasePath, masterKey: config.masterKey, now });
  let mutationsAvailable = true;
  const runs = new Runs(store, { now, monotonic: config.monotonic, onStorageFailure: () => { mutationsAvailable = false; } });
  const budget = new Budget({ now });
  const failures = new Map();
  let rejectedOverflow = 0;
  const app = Fastify({
    https: config.https,
    logger: false,
    bodyLimit: 16384,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    maxRequestsPerSocket: 200,
    routerOptions: { maxParamLength: 100 },
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  });
  app.decorateRequest('clientIP', null);
  app.decorateRequest('auth', null);
  app.decorateRequest('routeName', null);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      const parsed = JSON.parse(text, (key, value) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ApiError(400, 'invalid_json');
        return value;
      });
      object(parsed, Object.keys(parsed), []);
      done(null, parsed);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof ApiError)) return done(error);
      done(new ApiError(400, 'invalid_json'));
    }
  });
  await app.register(websocket, { options: { maxPayload: 1024, perMessageDeflate: false, clientTracking: true } });

  function session(request, required = false, csrf = false) {
    const value = cookieToken(request.headers.cookie);
    const found = store.session(value);
    if (found) found.value = value;
    request.auth = found;
    if (required && !found?.accountId) throw new ApiError(401, 'authentication_required');
    if (csrf && (!found || typeof request.headers['x-csrf-token'] !== 'string' || !equal(Buffer.from(request.headers['x-csrf-token']), Buffer.from(found.csrf)))) throw new ApiError(403, 'csrf_rejected');
    return found;
  }

  function mutable() {
    if (!mutationsAvailable || !runs.available) throw new ApiError(503, 'ranked_unavailable');
  }

  function recent(auth) {
    if (auth.verifiedAt + 5 * 60000 <= now()) throw new ApiError(401, 'reauthentication_required');
  }

  function view(auth) {
    return auth?.accountId ? {
      authenticated: true, user: { id: auth.accountId, username: auth.account?.username || store.account(auth.accountId).username, passkeys: store.credentials(auth.accountId).length },
      csrf: auth.csrf, expiresAt: auth.expiresAt, verifiedAt: auth.verifiedAt,
    } : { authenticated: false, user: null, csrf: auth?.csrf || null };
  }

  function rotate(request, reply, account) {
    const old = request.auth;
    const next = store.createSession(account.id);
    if (old) store.dropSession(old.hash);
    store.audit('session.created', account, request.clientIP, { method: 'passkey', user_verification: true });
    reply.header('Set-Cookie', cookie(next.value));
    next.account = account;
    return view(next);
  }

  function rejected(request, reason) {
    const actor = request.auth?.account || null;
    const key = `${request.clientIP}|${actor?.id || ''}|${reason}`;
    let record = failures.get(key);
    if (!record) {
      if (failures.size >= 512) { rejectedOverflow++; return; }
      record = { actor, ip: request.clientIP, reason, count: 0, first: now(), last: now() };
      failures.set(key, record);
    }
    record.count++;
    record.last = now();
  }

  function flushFailures() {
    if (!mutationsAvailable) return;
    if (!failures.size && !rejectedOverflow) return;
    store.atomic(() => {
      for (const record of failures.values()) store.audit('security.request_rejected', record.actor, record.ip, {
        reason: record.reason, count: record.count, first_at: new Date(record.first).toISOString(), last_at: new Date(record.last).toISOString(),
      });
      if (rejectedOverflow) store.audit('security.rejection_overflow', null, null, { count: rejectedOverflow, reason: 'distinct_source_budget' });
    });
    failures.clear();
    rejectedOverflow = 0;
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${socketOrigin.origin}; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), fullscreen=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
      ...(origin.protocol === 'https:' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    const raw = request.raw.url;
    if (!raw || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//')) throw new ApiError(400, 'invalid_url');
    if (raw === '/health' && [config.trustedProxy, config.listenAddress, '127.0.0.1', '::1'].includes(request.socket.remoteAddress)) return;
    if (config.trustedProxy && request.socket.remoteAddress !== config.trustedProxy) throw new ApiError(403, 'untrusted_proxy');
    const counts = new Map();
    for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
      const name = request.raw.rawHeaders[i].toLowerCase();
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    if (['host', 'origin', 'cookie', 'x-csrf-token', ...(config.trustedProxy ? [clientIpHeader, 'x-forwarded-proto'] : [])].some(name => counts.get(name) > 1)) throw new ApiError(400, 'ambiguous_headers');
    const ip = config.trustedProxy ? request.headers[clientIpHeader] : request.socket.remoteAddress;
    if (typeof ip !== 'string' || !isIP(ip) || ip.length > 45) throw new ApiError(400, 'invalid_client_address');
    request.clientIP = ip;
    const host = request.headers.host;
    const path = raw.split('?')[0];
    const legacyTelemetry = Boolean(config.redirectHost && host === config.redirectHost && path === '/arcade/events');
    const secureTransport = config.trustedProxy ? request.headers['x-forwarded-proto'] === 'https' : Boolean(request.socket.encrypted);
    if (!config.test && !localHttp && !secureTransport) {
      if (['GET', 'HEAD'].includes(request.method)) return reply.redirect(`${origin.origin}${raw}`, 308);
      throw new ApiError(403, 'secure_transport_required');
    }
    if (config.redirectHost && host === config.redirectHost && ['GET', 'HEAD'].includes(request.method)) return reply.redirect(`${origin.origin}${raw}`, 308);
    if (host !== origin.host && !legacyTelemetry) throw new ApiError(400, 'invalid_host');
    request.routeName = path;
    if (!config.test && !config.authEnabled && path.startsWith('/api/') && path !== '/api/leaderboard') throw new ApiError(503, 'ranked_unavailable');
    if (path.startsWith('/api/') || path === '/arcade/events') {
      budget.take('api-global', 1800, 60000);
      budget.take(`api:${ip}`, 240, 60000);
      if (raw.includes('?') && path !== '/arcade/events') throw new ApiError(400, 'query_not_allowed');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || request.headers.upgrade) {
        const detachedTelemetry = path === '/arcade/events' && request.headers.origin === 'null' && request.headers['sec-fetch-site'] === 'same-origin';
        if (request.headers.origin !== (legacyTelemetry ? `${origin.protocol}//${config.redirectHost}` : config.origin) && !detachedTelemetry) throw new ApiError(403, 'origin_rejected');
      }
      if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') throw new ApiError(403, 'cross_site_rejected');
      if (request.method === 'POST' && request.headers['content-type']?.split(';')[0].trim() !== 'application/json' && path !== '/arcade/events') throw new ApiError(415, 'json_required');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    reply.removeHeader('Set-Cookie');
    let status = error instanceof ApiError ? error.status : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    let code = error instanceof ApiError ? error.code : status < 500 ? 'invalid_request' : 'request_failed';
    if (status >= 500 && !(error instanceof ApiError)) {
      console.error('A ranked request failed internally; request contents and credentials were not logged.');
      if (typeof error.code === 'string' && error.code.startsWith('SQLITE_') && !error.code.startsWith('SQLITE_CONSTRAINT')) {
        runs.storageFailure();
        mutationsAvailable = false;
        status = 503;
        code = 'ranked_unavailable';
      }
    }
    if (request.routeName?.startsWith('/api/') && status >= 400) rejected(request, code);
    if (status === 429 || status === 503) reply.header('Retry-After', status === 429 ? '60' : '30');
    reply.code(status).send({ error: code });
  });

  app.get('/health', async () => ({ service: 'asteroid-drift', build: '1.0.0', ranked: mutationsAvailable && runs.available, auth_enabled: Boolean(config.test || config.authEnabled) }));
  app.get('/api/session', async request => view(session(request)));
  app.get('/api/leaderboard', async () => ({ entries: store.leaderboard(), rules: 'ranked-v1', maximum: 10 }));

  app.post('/api/auth/bootstrap', async (request, reply) => {
    apiBody(request);
    mutable();
    budget.take(`bootstrap:${request.clientIP}`, 12, 60000);
    const current = session(request);
    if (current) return view(current);
    const created = store.atomic(() => {
      if (store.db.prepare('SELECT count(*) AS n FROM sessions').get().n >= 2000) throw new ApiError(503, 'capacity_unavailable');
      const next = store.createSession();
      store.audit('authentication.initiated', null, request.clientIP);
      return next;
    });
    reply.header('Set-Cookie', cookie(created.value, 300));
    return view(created);
  });

  async function registrationOptions(request, adding) {
    apiBody(request, adding ? [] : ['username']);
    mutable();
    const auth = session(request, adding, true);
    if (adding) recent(auth);
    else if (auth.accountId) throw new ApiError(409, 'already_authenticated');
    budget.take(`register:${request.clientIP}`, 10, 3600000);
    const handle = adding ? auth.account.username : username(request.body.username).display;
    if (!adding) store.audit('account.registration_attempted', null, request.clientIP, { attempted_username: handle });
    if (!adding && !store.available(handle)) throw new ApiError(409, 'username_unavailable');
    const accountId = adding ? auth.accountId : randomUUID();
    const options = await generateRegistrationOptions({
      rpName: 'Asteroid Drift', rpID, userID: new Uint8Array(Buffer.from(accountId)),
      userName: handle, userDisplayName: handle, timeout: 120000, attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: adding ? store.credentials(accountId).map(key => ({ id: key.id, transports: key.transports })) : [],
    });
    store.atomic(() => {
      store.challenge(auth, adding ? 'add_key' : 'register', options.challenge, { accountId, handle });
      store.audit(adding ? 'passkey.add_requested' : 'account.registration_requested', adding ? auth.account : null, request.clientIP, adding ? {} : { attempted_username: handle });
    });
    return { options };
  }
  app.post('/api/auth/register/options', request => registrationOptions(request, false));
  app.post('/api/auth/passkey/options', request => registrationOptions(request, true));

  async function registrationVerify(request, reply, adding) {
    apiBody(request, ['credential']);
    mutable();
    const auth = session(request, adding, true);
    if (adding) recent(auth);
    const response = webauthnCredential(request.body.credential, true);
    budget.take(`verify:${request.clientIP}`, 20, 60000);
    const challenge = store.consumeChallenge(auth, adding ? 'add_key' : 'register');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response, expectedChallenge: value => tokenMatches(value, challenge.hash),
        expectedOrigin: config.origin, expectedRPID: rpID, requireUserVerification: true, requireUserPresence: true,
      });
    } catch {
      store.audit('authentication.failed', adding ? auth.account : null, request.clientIP, { reason: 'invalid_registration', ...(adding ? {} : { attempted_username: challenge.context.handle }) });
      throw new ApiError(401, 'passkey_verification_failed');
    }
    if (!verification.verified || !verification.registrationInfo) throw new ApiError(401, 'passkey_verification_failed');
    return store.atomic(() => {
      const info = verification.registrationInfo;
      if (info.credential.id !== response.id) throw new ApiError(400, 'invalid_credential');
      if (adding) {
        if (challenge.context.accountId !== auth.accountId) throw new ApiError(403, 'account_mismatch');
        store.addCredential(auth.accountId, info.credential, info.credentialDeviceType, info.credentialBackedUp);
        store.audit('passkey.added', auth.account, request.clientIP, { user_verification: true, count: store.credentials(auth.accountId).length });
        return view(auth);
      }
      const account = store.register({ id: challenge.context.accountId, handle: challenge.context.handle, credential: info.credential, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, ip: request.clientIP });
      return rotate(request, reply, account);
    });
  }
  app.post('/api/auth/register/verify', (request, reply) => registrationVerify(request, reply, false));
  app.post('/api/auth/passkey/verify', (request, reply) => registrationVerify(request, reply, true));

  async function authenticationOptions(request, deleting) {
    apiBody(request);
    mutable();
    const auth = session(request, deleting, true);
    budget.take(`login:${request.clientIP}`, 20, 60000);
    const options = await generateAuthenticationOptions({
      rpID, timeout: 120000, userVerification: 'required',
      allowCredentials: deleting ? store.credentials(auth.accountId).map(key => ({ id: key.id, transports: key.transports })) : [],
    });
    store.atomic(() => {
      store.challenge(auth, deleting ? 'delete_account' : 'login', options.challenge, { accountId: deleting ? auth.accountId : null });
      store.audit(deleting ? 'account.deletion_requested' : 'authentication.requested', deleting ? auth.account : null, request.clientIP, { method: 'passkey' });
    });
    return { options };
  }
  app.post('/api/auth/login/options', request => authenticationOptions(request, false));
  app.post('/api/auth/delete/options', request => authenticationOptions(request, true));

  async function authenticationVerify(request, reply, deleting) {
    apiBody(request, deleting ? ['credential', 'confirmation'] : ['credential']);
    mutable();
    const auth = session(request, deleting, true);
    const response = webauthnCredential(request.body.credential, false);
    budget.take(`verify:${request.clientIP}`, 20, 60000);
    const challenge = store.consumeChallenge(auth, deleting ? 'delete_account' : 'login');
    const credential = store.credential(base64url(response.id));
    if (!credential || (deleting && credential.accountId !== auth.accountId)) {
      store.audit('authentication.failed', null, request.clientIP, { reason: 'invalid_assertion' });
      throw new ApiError(401, 'passkey_verification_failed');
    }
    const account = store.account(credential.accountId);
    let verification;
    try {
      if (response.response.userHandle != null && Buffer.from(response.response.userHandle, 'base64url').toString('utf8') !== account.id) throw new ApiError(401, 'invalid_assertion');
      verification = await verifyAuthenticationResponse({
        response, credential, expectedChallenge: value => tokenMatches(value, challenge.hash),
        expectedOrigin: config.origin, expectedRPID: rpID, requireUserVerification: true,
      });
    } catch {
      store.audit('authentication.failed', account, request.clientIP, { reason: 'invalid_assertion' });
      throw new ApiError(401, 'passkey_verification_failed');
    }
    if (!verification.verified) throw new ApiError(401, 'passkey_verification_failed');
    const result = store.atomic(() => {
      const changed = store.db.prepare('UPDATE credentials SET counter=? WHERE id=? AND counter=?').run(verification.authenticationInfo.newCounter, credential.id, credential.counter);
      if (changed.changes !== 1) throw new ApiError(401, 'passkey_state_changed');
      store.audit('authentication.succeeded', account, request.clientIP, { user_verification: true });
      if (!deleting) return rotate(request, reply, account);
      if (request.body.confirmation !== account.username || challenge.context.accountId !== account.id) throw new ApiError(400, 'confirmation_mismatch');
      store.db.prepare('INSERT OR REPLACE INTO tombstones(handle_lookup,expires_at) VALUES (?,?)').run(store.secrets.lookup(account.username.toLowerCase()), now() + 90 * 86400000);
      store.audit('account.deleted', account, request.clientIP, { public_score_removed: true, private_audit_retention_days: 90 });
      store.db.prepare('DELETE FROM accounts WHERE id=?').run(account.id);
      reply.header('Set-Cookie', cookie('', 0));
      return { authenticated: false, user: null, csrf: null };
    });
    if (deleting) runs.remove(account.id);
    return result;
  }
  app.post('/api/auth/login/verify', (request, reply) => authenticationVerify(request, reply, false));
  app.post('/api/auth/delete/verify', (request, reply) => authenticationVerify(request, reply, true));

  app.post('/api/auth/logout', async (request, reply) => {
    apiBody(request);
    mutable();
    const auth = session(request, true, true);
    const run = runs.mine(auth.accountId);
    if (run) {
      runs.pause(run, 'signed_out');
      run.socket?.close(4001, 'Signed out');
    }
    store.atomic(() => {
      store.audit('session.signed_out', auth.account, request.clientIP);
      store.dropSession(auth.hash);
    });
    reply.header('Set-Cookie', cookie('', 0));
    return { authenticated: false, user: null, csrf: null };
  });
  app.get('/api/ranked/current', async request => {
    const auth = session(request, true);
    return { run: runs.info(runs.mine(auth.accountId)) };
  });
  app.post('/api/ranked/start', async request => {
    apiBody(request);
    mutable();
    const auth = session(request, true, true);
    budget.take(`start:${auth.accountId}`, 10, 60000);
    return { run: runs.start(auth.account, request.clientIP) };
  });
  app.post('/api/ranked/ticket', async request => {
    apiBody(request, ['runId']);
    mutable();
    const auth = session(request, true, true);
    if (typeof request.body.runId !== 'string' || request.body.runId.length !== 36 || !/^[a-f0-9-]{36}$/.test(request.body.runId)) throw new ApiError(400, 'invalid_run');
    budget.take(`ticket:${auth.accountId}`, 12, 60000);
    return { ticket: runs.ticket(auth, request.body.runId, request.clientIP) };
  });
  app.get('/api/ranked/live', {
    websocket: true,
    preValidation: async request => {
      mutable();
      session(request, true);
      budget.take(`websocket:${request.auth.accountId}`, 12, 60000);
      if (app.websocketServer.clients.size >= 32) throw new ApiError(503, 'ranked_capacity');
    },
  }, (socket, request) => { runs.accept(socket, request.auth, request.clientIP); });

  app.post('/arcade/events', { bodyLimit: 1024 }, async (request, reply) => {
    mutable();
    if (Number(request.headers['content-length'] || 0) > 1024) throw new ApiError(413, 'telemetry_too_large');
    const query = request.raw.url.split('?')[1] || '';
    const pairs = [...new URLSearchParams(query)];
    const required = ['v', 'run', 'seq', 'event', 'reason', 'play_ms', 'active_ms', 'score', 'wave', 'shots', 'hits', 'rocks', 'deaths', 'shields', 'pickups', 'combo', 'controls', 'device', 'automated', 'cheats', 'sound', 'haptics', 'build'];
    const data = Object.fromEntries(pairs);
    if (query.length > 1536 || pairs.length !== required.length || pairs.some(([key, value], i) => key !== required[i] || /[^A-Za-z0-9_.-]/.test(value))) throw new ApiError(400, 'invalid_telemetry');
    const reasons = { start: ['qualified'], progress: ['heartbeat', 'pause', 'hidden', 'console'], end: ['pagehide', 'gameover', 'restart'] };
    if (data.v !== '1' || !/^\d{8}\.\d{1,3}$/.test(data.build) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.run) || !Object.hasOwn(reasons, data.event) || !reasons[data.event].includes(data.reason) || !['keyboard', 'touch', 'gamepad', 'mixed'].includes(data.controls) || !['desktop', 'phone', 'tablet'].includes(data.device)) throw new ApiError(400, 'invalid_telemetry');
    const limits = { seq: [1, 9999999], play_ms: [2000, 2147483647], active_ms: [2000, 2147483647], score: [0, 9999999999], wave: [1, 999999], combo: [1, 5], cheats: [0, 127] };
    for (const key of ['shots', 'hits', 'rocks', 'deaths', 'shields', 'pickups']) limits[key] = [0, 2147483647];
    for (const [key, [low, high]] of Object.entries(limits)) {
      if (!/^\d{1,10}$/.test(data[key]) || Number(data[key]) < low || Number(data[key]) > high) throw new ApiError(400, 'invalid_telemetry');
    }
    if (['sound', 'haptics', 'automated'].some(key => !['0', '1'].includes(data[key])) || Number(data.active_ms) > Number(data.play_ms) || Number(data.hits) > Number(data.shots) || Number(data.hits) > Number(data.rocks) || Number(data.shots) > Number(data.play_ms) * 0.07 + 6 || (data.event === 'start' && data.seq !== '1')) throw new ApiError(400, 'invalid_telemetry');
    budget.take(`telemetry:${request.clientIP}`, 30, 60000);
    store.audit('gameplay.received', null, null, {
      time_iso8601: new Date(now()).toISOString(), host: request.headers.host, method: 'POST', status: '204', args: query,
      origin: request.headers.origin === 'null' ? `${origin.protocol}//${request.headers.host}` : request.headers.origin,
      origin_verification: request.headers.origin === 'null' ? 'same_origin_fetch_metadata' : 'origin_header',
      content_length: String(request.headers['content-length'] || 0),
    }, 'gameplay');
    return reply.code(204).send();
  });
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 1024 }, (request, body, done) => done(null, body));
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.route({
    method: ['GET', 'HEAD'], url: '/*',
    handler: async (request, reply) => {
      const path = request.raw.url.split('?')[0];
      const file = FILES.get(path);
      if (!file) return reply.code(404).send({ error: 'not_found' });
      const contents = readFileSync(join(config.site || SITE, file[0]));
      return reply.type(file[1]).send(contents);
    },
  });
  const timers = [];
  if (!config.test) {
    timers.push(setInterval(() => runs.tick(), 1000 / 120));
    timers.push(setInterval(() => {
      try { flushFailures(); store.cleanup(); }
      catch { runs.storageFailure(); }
    }, 30000));
  }
  app.addHook('onClose', async () => {
    timers.forEach(clearInterval);
    try {
      flushFailures();
      if (runs.available) runs.shutdown();
    } finally { store.close(); }
  });
  await app.ready();
  return { app, store, runs, flushFailures };
}

async function main() {
  const config = loadConfig();
  const { app, runs } = await buildApp(config);
  process.once('SIGTERM', () => { void app.close(); });
  process.once('SIGINT', () => { void app.close(); });
  await app.listen({ host: config.listenAddress, port: config.port });
  console.info('Asteroid Drift verified-TLS origin is ready. Request bodies, credentials, cookies, and raw access headers are not logged.');
  if (!runs.available) throw new Error('Ranked recovery failed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Asteroid Drift could not start securely. Check configuration, credential files, and database availability.');
    process.exitCode = 1;
  });
}
