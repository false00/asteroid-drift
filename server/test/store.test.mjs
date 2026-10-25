import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Runs } from '../runs.mjs';
import { username, cookieToken, base64url, Budget } from '../validation.mjs';

const account = (store, handle = 'Pilot_01') => store.register({
  id: randomUUID(), handle,
  credential: { id: randomBytes(32).toString('base64url'), publicKey: randomBytes(64), counter: 0, transports: ['internal'] },
  deviceType: 'singleDevice', backedUp: false, ip: '198.51.100.12',
});
const make = (now = Date.now) => new Store({ path: ':memory:', masterKey: randomBytes(32), now });

test('handles reject markup, SQL fragments, whitespace, controls, confusables and overlong values instead of repairing them', () => {
  for (const input of ['', 'ab', 'a'.repeat(21), ' admin', 'admin', 'Ａlice', 'Al\u0000ice', 'Al\nice', 'Alice\n', 'Alice\r', 'Alice\u2028', 'Alice\u2029', 'admin\n', '<script>', "a';DROP TABLE accounts;--", 'alice-bob', {}, 123]) assert.throws(() => username(input), undefined, String(input));
  assert.deepEqual(username('MiXeD_123'), { display: 'MiXeD_123', canonical: 'mixed_123' });
});

test('username ownership is case insensitive, immutable-ID based, parameterized and encrypted at rest', () => {
  const store = make();
  const pilot = account(store, 'MiXeD_123');
  assert.equal(store.account(pilot.id).username, 'MiXeD_123');
  assert.equal(store.available('mixed_123'), false);
  assert.throws(() => account(store, 'MIXED_123'), /username_unavailable/);
  const row = store.db.prepare('SELECT * FROM accounts').get();
  assert.equal(Buffer.from(row.handle_lookup).length, 32);
  assert.ok(!Buffer.from(row.handle_cipher).includes(Buffer.from('MiXeD_123')));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 1);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM events').all()).includes('MiXeD_123'));
  assert.equal(store.export(0, 10)[0].payload.actor.username, 'MiXeD_123');
  store.close();
});

test('encrypted records authenticate their context and reject tampering or a wrong key', () => {
  const store = make();
  const cipher = store.secrets.seal('Private_123', 'account:one');
  assert.throws(() => store.secrets.open(cipher, 'account:two'));
  const broken = Buffer.from(cipher);
  broken[broken.length - 1] ^= 1;
  assert.throws(() => store.secrets.open(broken, 'account:one'));
  const other = make();
  assert.throws(() => other.secrets.open(cipher, 'account:one'));
  store.close();
  other.close();
});

test('only ten best-per-account rows survive, ties are stable and finalization cannot be replayed', () => {
  let now = 1900000000000;
  const store = make(() => now);
  const pool = new Runs(store, { now: () => now, monotonic: () => now });
  const pilots = Array.from({ length: 13 }, (_, i) => account(store, `Pilot_${i}`));
  for (let i = 0; i < pilots.length; i++) {
    const info = pool.start(pilots[i], '198.51.100.12');
    const run = pool.runs.get(info.id);
    run.game.score = i * 100 + 100;
    run.game.elapsed = 10;
    run.activeMs = 10000;
    pool.finish(run, 'player_finished');
    assert.ok(store.leaderboard().length <= 10);
    assert.equal(store.account(pilots[i].id).personalBest, i * 100 + 100);
    assert.throws(() => store.finalize(run, 'player_finished'), /run_not_active/);
    now++;
  }
  assert.equal(store.leaderboard().length, 10);
  assert.equal(store.leaderboard()[0].score, 1300);
  assert.equal(store.leaderboard().at(-1).score, 400);
  assert.equal(store.account(pilots[0].id).personalBest, 100);
  assert.equal(store.leaderboard().some(entry => entry.username === pilots[0].username), false);
  const newRun = pool.start(pilots[12], '198.51.100.12');
  const run = pool.runs.get(newRun.id);
  run.game.score = 50;
  run.activeMs = 5000;
  pool.finish(run, 'player_finished');
  assert.equal(store.leaderboard()[0].score, 1300);
  assert.equal(store.account(pilots[12].id).personalBest, 1300);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM leaderboard WHERE account_id=?').get(pilots[12].id).n, 1);
  store.close();
});

test('failed score/audit transactions cannot publish a success-shaped result', () => {
  const store = make();
  const pilot = account(store);
  const pool = new Runs(store);
  const { id } = pool.start(pilot, '198.51.100.12');
  const run = pool.runs.get(id);
  run.game.score = 500;
  run.activeMs = 5000;
  store.db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  assert.throws(() => store.finalize(run, 'player_finished'), /audit unavailable/);
  assert.equal(store.leaderboard().length, 0);
  assert.equal(store.account(pilot.id).personalBest, 0);
  assert.ok(store.db.prepare('SELECT id FROM runs WHERE id=?').get(id));
  store.close();
});

test('best and placement receipts change only for qualified authoritative improvements, with stable ties', () => {
  const store = make();
  const pool = new Runs(store);
  const first = account(store, 'First_Pilot');
  const second = account(store, 'Second_Pilot');
  const finish = (pilot, score, activeMs = 3000) => {
    const { id } = pool.start(pilot, '198.51.100.12');
    const run = pool.runs.get(id);
    Object.assign(run.game, { score, elapsed: activeMs / 1000 });
    run.activeMs = activeMs;
    const result = store.finalize(run, 'player_finished');
    pool.runs.delete(id);
    return result;
  };
  assert.deepEqual(finish(first, 500), {
    score: 500, wave: 1, durationMs: 3000, qualified: true, rank: 1, previousRank: null,
    personalBest: 500, previousBest: 0, newPersonalBest: true, rankImproved: true,
  });
  assert.equal(finish(second, 500).rank, 2);
  const tied = finish(second, 500);
  assert.equal(tied.newPersonalBest, false);
  assert.equal(tied.rankImproved, false);
  const improved = finish(second, 501);
  assert.equal(improved.previousRank, 2);
  assert.equal(improved.rank, 1);
  assert.equal(improved.newPersonalBest, true);
  assert.equal(improved.rankImproved, true);
  const short = finish(second, 999999, 1999);
  assert.equal(short.qualified, false);
  assert.equal(short.personalBest, 501);
  assert.equal(short.newPersonalBest, false);
  assert.equal(short.rankImproved, false);
  assert.equal(store.leaderboard()[0].score, 501);
  assert.equal(finish(first, 0).personalBest, 500);
  store.close();
});

test('a later audit failure rolls back personal best, leaderboard and run deletion together', () => {
  const store = make();
  const pilot = account(store);
  const pool = new Runs(store);
  const { id } = pool.start(pilot, '198.51.100.12');
  const run = pool.runs.get(id);
  run.game.score = 1234;
  run.activeMs = 5000;
  const before = store.db.prepare('SELECT count(*) AS n FROM events').get().n;
  store.db.exec(`CREATE TRIGGER deny_evaluation BEFORE INSERT ON events
    WHEN (SELECT count(*) FROM events)=${before + 1} BEGIN SELECT RAISE(ABORT,'evaluation audit unavailable'); END`);
  assert.throws(() => store.finalize(run, 'player_finished'), /evaluation audit unavailable/);
  assert.equal(store.account(pilot.id).personalBest, 0);
  assert.equal(store.leaderboard().length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, before);
  assert.ok(store.db.prepare('SELECT id FROM runs WHERE id=?').get(id));
  store.close();
});

test('legacy databases seed one account best from retained scores and preserve it across restarts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'asteroid-drift-records-'));
  const config = { path: join(directory, 'game.sqlite'), masterKey: randomBytes(32) };
  let store = new Store(config);
  t.after(() => { if (store.db.open) store.close(); rmSync(directory, { recursive: true }); });
  const pilot = account(store);
  const pool = new Runs(store);
  const { id } = pool.start(pilot, '198.51.100.12');
  const run = pool.runs.get(id);
  run.game.score = 1077520;
  run.activeMs = 5000;
  store.finalize(run, 'player_finished');
  store.db.exec('ALTER TABLE accounts DROP COLUMN personal_best');
  store.close();
  store = new Store(config);
  assert.equal(store.account(pilot.id).personalBest, 1077520);
  assert.equal(store.account(pilot.id).username, pilot.username);
  assert.equal(store.credentials(pilot.id).length, 1);
  store.db.prepare('DELETE FROM leaderboard').run();
  store.close();
  store = new Store(config);
  assert.equal(store.account(pilot.id).personalBest, 1077520);
  assert.equal(store.leaderboard().length, 0);
});

test('opaque sessions are hashed, expire, and do not use usernames or browser storage as authority', () => {
  let now = 1900000000000;
  const store = make(() => now);
  const pilot = account(store);
  const session = store.createSession(pilot.id);
  assert.equal(session.value.length, 43);
  assert.equal(store.session(session.value).accountId, pilot.id);
  assert.notEqual(Buffer.from(store.db.prepare('SELECT hash FROM sessions').get().hash).toString(), session.value);
  now += 30 * 60000 + 1;
  assert.equal(store.session(session.value), null);
  assert.throws(() => cookieToken(`__Host-curlred_session=${session.value}; __Host-curlred_session=${session.value}`), /ambiguous_cookie/);
  assert.throws(() => cookieToken('__Host-curlred_session=invalid'), /invalid_cookie/);
  assert.throws(() => cookieToken(`__Host-curlred_session=${session.value}\n`), /invalid_cookie/);
  assert.throws(() => base64url('YWJj\n'), /invalid_encoding/);
  store.close();
});

test('one-use challenges are hashed, bound to the session/purpose and expire', () => {
  let now = 1900000000000;
  const store = make(() => now);
  const session = store.createSession();
  store.challenge(session, 'login', 'OneTimeChallenge');
  assert.equal(store.consumeChallenge(session, 'login').hash.length, 32);
  assert.throws(() => store.consumeChallenge(session, 'login'), /challenge_expired/);
  store.challenge(session, 'login', 'AnotherChallenge');
  now += 120001;
  assert.throws(() => store.consumeChallenge(session, 'login'), /challenge_expired/);
  store.close();
});

test('rate-limiter source tracking is bounded and does not silently reset when full', () => {
  let now = 1;
  const budget = new Budget({ maximum: 2, now: () => now });
  budget.take('a', 1, 100);
  assert.throws(() => budget.take('a', 1, 100), /rate_limited/);
  budget.take('b', 1, 100);
  assert.throws(() => budget.take('c', 1, 100), /capacity_unavailable/);
  now = 102;
  budget.take('c', 1, 100);
  assert.ok(budget.entries.size <= 2);
});
