import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store } from '../store.mjs';
import { ARENA, LEASE_MS, Runs, controls } from '../runs.mjs';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.messages = []; }
  send(value) { this.messages.push(JSON.parse(value)); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
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
  return { store, account, session, pool, run, socket, step, advance: ms => { now += ms; }, clock: ms => { clock += ms; } };
}

test('ranked controls accept only quantized controls, not score/dt/positions/cheats or non-finite values', () => {
  const valid = { type: 'input', seq: 1, keys: 13, thrust: 255, aim: 32768, controls: 'gamepad' };
  assert.equal(controls(valid).thrust, 1);
  for (const extra of [{ score: 99999 }, { dt: 50 }, { x: 10 }, { cheats: 127 }, { lives: 999 }]) assert.throws(() => controls({ ...valid, ...extra }), /invalid_payload/);
  for (const thrust of [-1, 256, Infinity, NaN, '255', 1.2]) assert.throws(() => controls({ ...valid, thrust }));
  assert.throws(() => controls({ ...valid, aim: 65536 }));
  assert.throws(() => controls({ ...valid, keys: 32 }));
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
