import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store } from '../store.mjs';
import { ARENA, LEASE_MS, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, Runs, controls, viewportArena } from '../runs.mjs';
import { RANKED_AREA, RANKED_SCALE } from '../../web/site/arena.mjs';
import { FlightDiagnostics } from '../../web/site/diagnostics.mjs';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.messages = []; this.pings = []; }
  send(value) { this.messages.push(JSON.parse(value)); }
  ping(value) { this.pings.push(Buffer.from(value)); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.code = code;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
  input(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

function rig(t) {
  let now = 1900000000000;
  let clock = 0;
  const store = new Store({ path: ':memory:', masterKey: randomBytes(32), now: () => now });
  const account = store.register({
    id: randomUUID(), handle: 'Ranked_Pilot', ip: '198.51.100.12',
    credential: { id: randomBytes(32).toString('base64url'), publicKey: randomBytes(64), counter: 0 },
    deviceType: 'singleDevice', backedUp: false,
  });
  const created = store.createSession(account.id);
  const session = { ...store.session(created.value), value: created.value };
  const pool = new Runs(store, { now: () => now, monotonic: () => clock });
  const { id } = pool.start(account, '198.51.100.12');
  const run = pool.runs.get(id);
  const socket = new Socket();
  pool.accept(socket, session, '198.51.100.12');
  socket.input({ type: 'attach', runId: id, ticket: pool.ticket(session, id, '198.51.100.12') });
  t.after(() => { socket.close(1000); store.close(); });
  const step = (milliseconds = 10) => { now += milliseconds; clock += milliseconds; pool.tick(); };
  return { store, account, session, pool, run, socket, step, wall: () => now, advance: ms => { now += ms; }, clock: ms => { clock += ms; } };
}

test('ranked controls accept only quantized controls, not score/dt/positions/cheats or non-finite values', () => {
  const valid = { type: 'input', seq: 1, keys: 13, thrust: 255, aim: 32768, controls: 'gamepad' };
  assert.equal(controls(valid).thrust, 1);
  for (const extra of [{ score: 99999 }, { dt: 50 }, { x: 10 }, { cheats: 127 }, { lives: 999 }]) assert.throws(() => controls({ ...valid, ...extra }), /invalid_payload/);
  for (const thrust of [-1, 256, Infinity, NaN, '255', 1.2]) assert.throws(() => controls({ ...valid, thrust }));
  assert.throws(() => controls({ ...valid, aim: 65536 }));
  assert.throws(() => controls({ ...valid, keys: 32 }));
});

test('transport close diagnostics preserve the unfinished flight and exclude untrusted close text', t => {
  const { store, socket, run, advance } = rig(t);
  socket.input({ type: 'resume' });
  run.game.score = 42000;
  advance(3000);
  socket.close(1006, 'private-token-and-url-must-not-be-recorded');
  const events = store.export(0, 100).map(event => event.payload);
  const closed = events.find(event => event.event_action === 'ranked.connection_closed');
  assert.equal(closed.details.close_code, 1006);
  assert.equal(closed.details.reason, 'transport_lost');
  assert.equal(closed.details.server_initiated, false);
  assert.equal(closed.details.requested_close_code, null);
  assert.equal(closed.details.attached, true);
  assert.equal(closed.details.connected_ms, 3000);
  assert.equal(closed.details.last_message_age_ms, 3000);
  assert.equal(closed.details.score, 42000);
  assert.ok(closed.details.messages_received >= 2 && closed.details.messages_sent >= 2);
  assert.ok(!JSON.stringify(events).includes('private-token-and-url'));
  assert.equal(run.game.score, 42000);
  assert.equal(run.game.state, 'paused');
  assert.ok(store.db.prepare('SELECT id FROM runs WHERE id=?').get(run.id));
  assert.equal(store.leaderboard().length, 0);
});

test('backpressure records the server close decision and queue size without increasing its limit', t => {
  const { store, socket, run, pool } = rig(t);
  socket.input({ type: 'resume' });
  socket.bufferedAmount = 131073;
  assert.equal(pool.send(run, { type: 'snapshot' }), false);
  const closed = store.export(0, 100).find(event => event.payload.event_action === 'ranked.connection_closed').payload;
  assert.equal(socket.code, 4004);
  assert.equal(closed.details.reason, 'backpressure');
  assert.equal(closed.details.server_initiated, true);
  assert.equal(closed.details.requested_close_code, 4004);
  assert.equal(closed.details.buffered_bytes, 131073);
  assert.equal(run.game.state, 'paused');
});

test('heartbeat keeps paused flights connected, measures round trips and never renews the lease', t => {
  const { store, socket, run, step } = rig(t);
  const lease = run.leaseAt;
  step(HEARTBEAT_MS);
  assert.equal(socket.pings.length, 1);
  socket.emit('pong', Buffer.from('not-the-ping'));
  step(75);
  socket.emit('pong', socket.pings[0]);
  assert.equal(run.game.state, 'paused');
  assert.equal(run.leaseAt, lease);
  assert.equal(run.ticks, 0);
  socket.close(1006);
  const closed = store.export(0, 100).find(event => event.payload.event_action === 'ranked.connection_closed').payload;
  assert.equal(closed.details.heartbeat.pings_sent, 1);
  assert.equal(closed.details.heartbeat.pongs_received, 1);
  assert.equal(closed.details.heartbeat.round_trip_ms, 75);
  assert.equal(closed.details.heartbeat.max_round_trip_ms, 75);
});

test('heartbeat timeout preserves progress and is distinct from an unattributed transport loss', t => {
  const { store, socket, run, step, pool } = rig(t);
  run.game.score = 42000;
  step(HEARTBEAT_MS);
  step(HEARTBEAT_TIMEOUT_MS);
  assert.equal(socket.code, 4005);
  assert.equal(run.game.score, 42000);
  assert.equal(pool.runs.get(run.id), run);
  assert.equal(run.game.state, 'paused');
  assert.equal(store.leaderboard().length, 0);
  const closed = store.export(0, 100).find(event => event.payload.event_action === 'ranked.connection_closed').payload;
  assert.equal(closed.details.reason, 'heartbeat_timeout');
  assert.equal(closed.details.server_initiated, true);
  assert.equal(closed.details.heartbeat.pongs_received, 0);
});

test('peer-reported invalid snapshots are classified without keeping arbitrary close reasons', t => {
  const { store, socket } = rig(t);
  socket.close(4002, 'Invalid ranked response');
  const closed = store.export(0, 100).find(event => event.payload.event_action === 'ranked.connection_closed').payload;
  assert.equal(closed.details.reason, 'peer_invalid_response');
  assert.equal(closed.details.close_code, 4002);
});

test('bounded client diagnostics correlate an owned closed connection without trusting its score', t => {
  const { pool, run, socket, account, store, step } = rig(t);
  step(25);
  const sample = new FlightDiagnostics().sample({ game_state: 'paused', online: true, visible: true });
  const report = { runId: run.id, connectionId: socket.messages.find(message => message.type === 'attached').connectionId, sequence: 1, reason: 'close', sample };
  socket.close(1006);
  assert.deepEqual(pool.reportDiagnostics(account, run.ip, report), { accepted: true });
  assert.deepEqual(pool.reportDiagnostics(account, run.ip, report), { accepted: false });
  assert.throws(() => pool.reportDiagnostics({ id: randomUUID() }, run.ip, report), /connection_not_found/);
  const details = store.export(0, 100).find(event => event.payload.event_action === 'ranked.connection_diagnostics').payload.details;
  assert.equal(details.connection_id, report.connectionId);
  assert.equal(details.server.scheduler_gap_max_ms, 25);
  assert.ok(details.server.snapshot_bytes_max > 0);
  assert.equal(details.client.game_state, 'paused');
  assert.equal(run.game.score, 0);
  assert.equal(store.leaderboard().length, 0);
  for (const extra of [{ score: 999999 }, { url: 'https://private.invalid' }, { error: 'private-error' }]) {
    assert.throws(() => pool.reportDiagnostics(account, run.ip, { ...report, sequence: 2, sample: { ...sample, ...extra } }), /invalid_payload/);
  }
  assert.throws(() => pool.reportDiagnostics(account, run.ip, { ...report, sequence: 2, sample: { ...sample, frame_gap_max_ms: Infinity } }));
  assert.throws(() => pool.reportDiagnostics(account, run.ip, { ...report, sequence: 2, sample: { ...sample, build: '20261025.1\n' } }), /invalid_diagnostics/);
});

test('server diagnostics measure simulation work separately from scheduling delay', t => {
  const { run, socket, step, clock } = rig(t);
  const update = run.game.update.bind(run.game);
  run.game.update = (...args) => { clock(3); update(...args); };
  socket.input({ type: 'resume' });
  step(10);
  assert.equal(run.diagnostics.scheduler_gap_max_ms, 10);
  assert.equal(run.diagnostics.tick_work_max_us, 3000);
  assert.equal(run.summary().diagnostics.tick_work_max_us, 3000);
});

test('diagnostic storage and delivery budgets are bounded and expired connection reports are rejected', t => {
  const { pool, run, socket, account, advance } = rig(t);
  const report = { runId: run.id, connectionId: socket.messages[0].connectionId, sequence: 1, reason: 'sample', sample: new FlightDiagnostics().sample() };
  for (let sequence = 1; sequence <= 12; sequence++) pool.reportDiagnostics(account, run.ip, { ...report, sequence });
  assert.throws(() => pool.reportDiagnostics(account, run.ip, { ...report, sequence: 13 }), /rate_limited/);
  socket.close(1006);
  advance(LEASE_MS);
  assert.throws(() => pool.reportDiagnostics(account, run.ip, { ...report, sequence: 14 }), /connection_not_found/);
  assert.equal(pool.diagnosticConnections.size, 0);
});

test('legacy manual pauses and allowlisted client pause sources remain distinct and do not advance play', t => {
  const { store, socket, run } = rig(t);
  const reasons = ['player', 'blur', 'hidden', 'pagehide', 'console', 'manual', 'account', 'graphics', 'viewport', 'controller_lost'];
  for (const reason of reasons) {
    socket.input({ type: 'resume' });
    socket.input(reason === 'player' ? { type: 'pause' } : { type: 'pause', reason });
    assert.equal(run.game.state, 'paused');
    assert.equal(run.game.score, 0);
    assert.equal(run.ticks, 0);
  }
  const paused = store.export(0, 100).filter(event => event.payload.event_action === 'ranked.paused');
  assert.deepEqual(paused.map(event => event.payload.details.reason), reasons);
});

test('unrecognized pause metadata is rejected rather than repaired or accepted as authority', t => {
  for (const reason of [null, 'unknown', 'server_lag', 'authentication_expired', { score: 99999 }]) {
    const { store, socket } = rig(t);
    socket.input({ type: 'pause', reason });
    assert.equal(socket.code, 4002);
    const rejected = store.export(0, 100).find(event => event.payload.event_action === 'ranked.input_rejected');
    assert.equal(rejected.payload.details.reason, 'invalid_pause_reason');
    assert.equal(store.leaderboard().length, 0);
  }
});

test('normal verified completion is distinguished from an unexplained disconnect', t => {
  const { store, socket, run, pool } = rig(t);
  run.game.score = 500;
  run.activeMs = 5000;
  pool.finish(run, 'player_finished');
  const closed = store.export(0, 100).find(event => event.payload.event_action === 'ranked.connection_closed').payload;
  assert.equal(closed.details.reason, 'verified_result');
  assert.equal(closed.details.close_code, 1000);
  assert.equal(socket.code, 1000);
  assert.equal(store.account(run.accountId).personalBest, 500);
});

test('explicit restart replaces only the owned expected flight, invalidates its tickets, and never saves an unfinished score', t => {
  const { store, account, session, pool, run, socket } = rig(t);
  run.game.score = 99999;
  run.activeMs = 5000;
  const other = store.register({
    id: randomUUID(), handle: 'Other_Pilot', ip: run.ip,
    credential: { id: randomBytes(32).toString('base64url'), publicKey: randomBytes(64), counter: 0 },
    deviceType: 'singleDevice', backedUp: false,
  });
  const otherRun = pool.start(other, run.ip);
  assert.throws(() => pool.restart(other, run.ip, run.id), /run_changed/);
  pool.ticket(session, run.id, run.ip);
  assert.throws(() => pool.restart(account, run.ip, randomUUID()), /run_changed/);
  assert.equal(pool.mine(account.id), run);
  const fresh = pool.restart(account, run.ip, run.id, { width: 390 * 64, height: 620 * 64 });
  assert.notEqual(fresh.id, run.id);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.state, 'paused');
  assert.equal(pool.mine(account.id).id, fresh.id);
  assert.equal(pool.mine(other.id).id, otherRun.id);
  assert.equal(run.finished, true);
  assert.equal(socket.code, 4000);
  assert.equal([...pool.tickets.values()].some(ticket => ticket.runId === run.id), false);
  assert.equal(store.account(account.id).personalBest, 0);
  assert.deepEqual(store.leaderboard(), []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 2);
  assert.throws(() => pool.restart(account, run.ip, run.id), /run_changed/);
  assert.ok(store.export(0, 100).some(event => event.payload.event_action === 'ranked.abandoned' && event.payload.details.reason === 'player_restart'));
});

test('restart failure rolls back abandonment without closing the old flight or dropping its checkpoint', t => {
  const { store, account, pool, run, socket } = rig(t);
  const before = store.db.prepare('SELECT count(*) AS n FROM events').get().n;
  store.db.exec(`CREATE TRIGGER deny_restart BEFORE INSERT ON events
    WHEN (SELECT count(*) FROM events)=${before + 1} BEGIN SELECT RAISE(ABORT,'restart audit unavailable'); END`);
  assert.throws(() => pool.restart(account, run.ip, run.id), /restart audit unavailable/);
  assert.equal(pool.mine(account.id), run);
  assert.equal(run.finished, false);
  assert.equal(socket.readyState, 1);
  assert.equal(store.db.prepare('SELECT id FROM runs').get().id, run.id);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, before);
});

test('a replayed/out-of-order websocket input closes the channel, audits the violation and cannot add a score', t => {
  const { store, socket } = rig(t);
  const input = { type: 'input', seq: 1, keys: 4, thrust: 0, aim: null, controls: 'keyboard' };
  socket.input(input);
  socket.input(input);
  assert.equal(socket.code, 4002);
  assert.equal(store.leaderboard().length, 0);
  assert.ok(store.export(0, 100).some(event => event.payload.details?.reason === 'input_sequence_rejected'));
});

test('fixed server ticks own time, fire cadence and the canonical arena; pause does not renew immunity', t => {
  const { socket, run, step, pool } = rig(t);
  socket.input({ type: 'resume' });
  socket.input({ type: 'input', seq: 1, keys: 4, thrust: 255, aim: null, controls: 'keyboard' });
  for (let i = 0; i < 100; i++) step();
  assert.ok(run.game.elapsed >= 0.99 && run.game.elapsed <= 1.01);
  assert.ok(run.game.stats.shots >= 7 && run.game.stats.shots <= 8);
  assert.equal(run.game.width, ARENA.width);
  assert.equal(run.game.height, ARENA.height);
  run.game.ship.invulnerable = 0;
  pool.pause(run, 'player');
  pool.resume(run);
  assert.equal(run.game.ship.invulnerable, 0);
  assert.equal(run.game.effects, false);
  assert.equal(run.game.cheated, false);
  assert.equal(run.game.particles.length, 0);
});

test('scheduling stalls pause instead of accelerating ticks and paused/disconnected leases are bounded', t => {
  const { pool, run, socket, step, advance } = rig(t);
  socket.input({ type: 'resume' });
  step(5000);
  assert.equal(run.game.state, 'paused');
  assert.equal(run.ticks, 0);
  advance(LEASE_MS + 1);
  pool.tick();
  assert.equal(pool.runs.size, 0);
});

test('an actively controlled ranked game has no elapsed-duration cap and authority survives auth renewal', t => {
  const { pool, run, socket, store, account, step } = rig(t);
  socket.input({ type: 'resume' });
  run.game.elapsed = 7 * 86400;
  run.activeMs = run.game.elapsed * 1000;
  run.game.ship.invulnerable = 100;
  socket.input({ type: 'input', seq: 1, keys: 4, thrust: 255, aim: null, controls: 'keyboard' });
  step(10);
  assert.equal(run.game.state, 'playing');
  assert.ok(run.game.elapsed > 7 * 86400);
  pool.pause(run, 'authentication_expired');
  const created = store.createSession(account.id);
  const renewed = { ...store.session(created.value), value: created.value };
  const next = new Socket();
  pool.accept(next, renewed, '198.51.100.12');
  next.input({ type: 'attach', runId: run.id, ticket: pool.ticket(renewed, run.id, '198.51.100.12') });
  next.input({ type: 'resume' });
  next.input({ type: 'input', seq: 1, keys: 4, thrust: 0, aim: null, controls: 'keyboard' });
  step(10);
  assert.ok(run.game.elapsed > 7 * 86400);
  next.close(1000);
});

test('the one-use attach capability is bound to the HttpOnly session and never appears in a URL', t => {
  const { store, pool, run, account } = rig(t);
  const created = store.createSession(account.id);
  const other = { ...store.session(created.value), value: created.value };
  const first = store.createSession(account.id);
  const bound = { ...store.session(first.value), value: first.value };
  const ticket = pool.ticket(bound, run.id, '198.51.100.12');
  const wrong = new Socket();
  pool.accept(wrong, other, '198.51.100.12');
  wrong.input({ type: 'attach', runId: run.id, ticket });
  assert.equal(wrong.code, 4002);
  const replay = new Socket();
  pool.accept(replay, bound, '198.51.100.12');
  replay.input({ type: 'attach', runId: run.id, ticket });
  assert.equal(replay.code, 4002);
});

test('admission bounds active and paused rooms while preserving one run per immutable account', () => {
  const store = new Store({ path: ':memory:', masterKey: randomBytes(32) });
  const pool = new Runs(store);
  try {
    const accounts = Array.from({ length: 17 }, (_, i) => store.register({
      id: randomUUID(), handle: `Budget_${i}`, ip: '198.51.100.12',
      credential: { id: randomBytes(32).toString('base64url'), publicKey: randomBytes(64), counter: 0 },
      deviceType: 'singleDevice', backedUp: false,
    }));
    for (const account of accounts.slice(0, 16)) pool.start(account, '198.51.100.12');
    assert.throws(() => pool.start(accounts[0], '198.51.100.12'), /run_exists/);
    assert.throws(() => pool.start(accounts[16], '198.51.100.12'), /ranked_capacity/);
    const rooms = [...pool.runs.values()];
    for (const run of rooms.slice(0, 8)) pool.resume(run);
    assert.throws(() => pool.resume(rooms[8]), /ranked_capacity/);
    assert.equal(rooms.filter(run => run.game.state === 'playing').length, 8);
    assert.equal(store.db.pragma('max_page_count', { simple: true }), 65536);
  } finally {
    pool.shutdown();
    store.close();
  }
});

test('viewport requests cannot contain scores, entity state, cheats, or invalid dimensions', () => {
  const viewport = { width: 390 * 64, height: 620 * 64 };
  assert.ok(Math.abs(viewportArena(viewport).width * viewportArena(viewport).height - RANKED_AREA) < 0.000001);
  for (const extra of [{ score: 9999 }, { dt: 10 }, { x: 1 }, { cheats: 127 }]) assert.throws(() => viewportArena({ ...viewport, ...extra }), /invalid_payload/);
  for (const value of [null, {}, { width: 390, height: 0 }, { width: 390.5, height: 620 }, { width: 1, height: 100000 }, { width: 1048577, height: 620 }]) assert.throws(() => viewportArena(value));
});

test('a viewport change preserves the authoritative flight and checkpoints its new shape', t => {
  const { pool, run, socket, store, advance } = rig(t);
  socket.input({ type: 'resume' });
  socket.input({ type: 'input', seq: 1, keys: 4, thrust: 255, aim: 32768, controls: 'touch' });
  Object.assign(run.game, { score: 1234, lives: 2, elapsed: 42, fireCooldown: 0.1, shieldCooldown: 3, tripleTime: 4 });
  run.game.ship.invulnerable = 0;
  run.ticks = 5040;
  run.activeMs = 42000;
  run.events.push({ type: 'hit', x: 240, y: 160, points: 100 });
  const id = run.id;
  const lease = run.leaseAt;
  const inputAt = run.inputAt;
  const actionAt = run.actionAt;
  const velocities = run.game.asteroids.map(rock => [rock.vx, rock.vy, rock.radius]);
  advance(500);
  socket.input({ type: 'viewport', viewport: { width: 390 * 64, height: 620 * 64 } });
  assert.equal(socket.code, undefined);
  assert.equal(pool.mine(run.accountId).id, id);
  assert.deepEqual([run.game.score, run.game.lives, run.game.elapsed, run.game.fireCooldown, run.game.shieldCooldown, run.game.tripleTime], [1234, 2, 42, 0.1, 3, 4]);
  assert.equal(run.game.state, 'playing');
  assert.equal(run.game.ship.invulnerable, 0);
  assert.equal(run.game.scale, RANKED_SCALE);
  assert.deepEqual(run.game.asteroids.map(rock => [rock.vx, rock.vy, rock.radius]), velocities);
  assert.deepEqual([run.ticks, run.activeMs, run.sequence, run.leaseAt, run.inputAt, run.actionAt], [5040, 42000, 1, lease, inputAt, actionAt]);
  assert.ok(Math.abs(run.game.width * run.game.height - RANKED_AREA) < 0.000001);
  assert.ok(Math.abs(run.game.width / run.game.height - 390 / 620) < 0.0000001);
  const frame = socket.messages.at(-1);
  assert.equal(frame.type, 'snapshot');
  assert.ok(Math.abs(frame.events[0].x - run.game.width / 4) < 0.000000001);
  assert.ok(Math.abs(frame.events[0].y - run.game.height / 4) < 0.000000001);
  assert.equal(store.recover()[0].state.viewportChanges, 1);
  assert.equal(store.recover()[0].state.game.width, run.game.width);
  assert.equal(pool.resize(run, { width: 780 * 64, height: 1240 * 64 }), false);
  assert.equal(run.viewportChanges, 1);
});

test('repeated geometry requests are bounded and cannot award a score', t => {
  const { socket, run, store } = rig(t);
  for (let i = 0; i < 13; i++) socket.input({ type: 'viewport', viewport: { width: 400 + i * 10, height: 600 } });
  assert.equal(run.viewportChanges, 12);
  assert.equal(socket.code, 4002);
  assert.equal(run.game.score, 0);
  assert.equal(store.leaderboard().length, 0);
  assert.ok(store.export(0, 100).some(event => event.payload.event_action === 'ranked.input_rejected'));
});

test('resizing a paused run cannot renew its lease, including after recovery', t => {
  const { pool, run, socket, store, advance, wall } = rig(t);
  socket.input({ type: 'resume' });
  pool.pause(run, 'player');
  const lease = run.leaseAt;
  advance(LEASE_MS / 2);
  socket.input({ type: 'viewport', viewport: { width: 390, height: 620 } });
  assert.equal(run.leaseAt, lease);
  assert.equal(store.recover()[0].state.leaseAt, lease);
  run.finished = true;
  const recovered = new Runs(store, { now: wall });
  assert.equal(recovered.mine(run.accountId).leaseAt, lease);
  advance(LEASE_MS / 2 + 1);
  assert.throws(() => recovered.resize(recovered.mine(run.accountId), { width: 600, height: 400 }), /run_expired/);
  recovered.tick();
  assert.equal(recovered.runs.size, 0);
});

test('legacy checkpoints and clients keep their flight while receiving supported arena dimensions', t => {
  const { store, run, session, pool, wall, socket } = rig(t);
  const legacy = JSON.parse(JSON.stringify(run.checkpoint()));
  delete legacy.viewportChanges;
  delete legacy.leaseAt;
  delete legacy.game.fixedScale;
  store.db.prepare('UPDATE runs SET state_cipher=? WHERE id=?').run(store.secrets.seal(JSON.stringify(legacy), `run:${run.id}`), run.id);
  run.finished = true;
  const recovered = new Runs(store, { now: wall });
  const saved = recovered.mine(run.accountId);
  assert.equal(saved.game.fixedScale, RANKED_SCALE);
  recovered.resize(saved, { width: 390, height: 620 });
  const replacement = new Socket();
  recovered.accept(replacement, session, '198.51.100.12');
  replacement.input({ type: 'attach', runId: saved.id, ticket: recovered.ticket(session, saved.id, '198.51.100.12') });
  assert.equal(saved.game.width, 960);
  assert.equal(saved.game.height, 640);
  assert.equal(saved.id, run.id);
  replacement.close(1000);
  socket.close(1000);
  pool.runs.clear();
});
