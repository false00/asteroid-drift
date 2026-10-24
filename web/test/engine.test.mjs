import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, SHIELD_RECHARGE, CHEATS, wrappedDelta } from '../site/engine.mjs';

function random(seed = 73) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function running(width = 1000, height = 650) {
  const game = new Game(width, height, random());
  game.start();
  return game;
}

function advance(game, seconds, input = {}) {
  for (let i = 0; i < Math.round(seconds * 120); i++) game.update(1 / 120, input);
}

function stationaryRock(game, size, x, y) {
  return { ...game.makeRock(size, x, y), vx: 0, vy: 0 };
}

test('a new run resets progress and starts away from the rocks', () => {
  const game = running();
  assert.equal(game.state, 'playing');
  assert.equal(game.lives, 3);
  assert.equal(game.wave, 1);
  assert.equal(game.asteroids.length, 4);
  assert.ok(game.asteroids.every(rock => game.distance(rock, game.ship) > 150));
  game.score = 2345;
  game.start();
  assert.equal(game.score, 0);
  assert.equal(game.bullets.length, 0);
});

test('attract mode cannot shoot, score, or lose lives', () => {
  const game = new Game(900, 600, random());
  advance(game, 4, { fire: true, thrust: 1, shield: true });
  assert.equal(game.state, 'ready');
  assert.equal(game.score, 0);
  assert.equal(game.lives, 3);
  assert.equal(game.bullets.length, 0);
});

test('keyboard rotation, thrust, inertia, and braking work', () => {
  const game = running();
  game.asteroids = [];
  const angle = game.ship.angle;
  advance(game, 0.3, { right: true });
  assert.ok(game.ship.angle > angle);
  advance(game, 0.5, { thrust: 1 });
  const speed = Math.hypot(game.ship.vx, game.ship.vy);
  assert.ok(speed > 100);
  advance(game, 0.2);
  assert.ok(Math.hypot(game.ship.vx, game.ship.vy) > speed * 0.9);
  advance(game, 0.5, { brake: true });
  assert.ok(Math.hypot(game.ship.vx, game.ship.vy) < speed * 0.3);
});

test('touch aim takes the shortest turn and thrust is analog', () => {
  const game = running();
  game.ship.angle = Math.PI - 0.1;
  game.update(0.02, { aim: -Math.PI + 0.1, thrust: 0.5 });
  assert.ok(game.ship.angle > Math.PI - 0.1);
  assert.equal(game.ship.thrust, 0.5);
});

test('held fire has a bounded, continuous cadence', () => {
  const game = running(2000, 1200);
  game.asteroids = [stationaryRock(game, 1, 30, 30)];
  game.drainEvents();
  advance(game, 1, { fire: true });
  const shots = game.drainEvents().filter(event => event.type === 'shot');
  assert.ok(shots.length >= 7 && shots.length <= 8);
  assert.ok(game.bullets.length <= 8);
});

test('hits split large rocks and award the expected score', () => {
  const game = running();
  game.asteroids = [stationaryRock(game, 3, 200, 200)];
  game.destroyRock(0);
  assert.equal(game.asteroids.length, 2);
  assert.ok(game.asteroids.every(rock => rock.size === 2));
  assert.equal(game.score, 20);
  game.destroyRock(0);
  assert.equal(game.asteroids.length, 3);
  assert.equal(game.score, 70);
});

test('a swept bullet hits small rocks instead of tunneling through them', () => {
  const game = running();
  game.asteroids = [stationaryRock(game, 1, 150, 100)];
  game.bullets = [{ x: 100, y: 100, vx: 2000, vy: 0, life: 1 }];
  game.update(0.05);
  assert.equal(game.score, 100);
  assert.equal(game.bullets.length, 0);
});

test('bullet collisions and ship collisions wrap across the screen seam', () => {
  const game = running();
  game.asteroids = [stationaryRock(game, 1, 4, 100)];
  game.bullets = [{ x: 990, y: 100, vx: 600, vy: 0, life: 1 }];
  game.update(1 / 60);
  assert.equal(game.score, 100);
  game.asteroids = [stationaryRock(game, 1, 2, 300)];
  Object.assign(game.ship, { x: 998, y: 300, invulnerable: 0 });
  game.update(1 / 60);
  assert.equal(game.lives, 2);
});

test('combos increase the multiplier and expire', () => {
  const game = running();
  for (let i = 0; i < 5; i++) {
    game.asteroids = [stationaryRock(game, 1, 100, 100)];
    game.destroyRock(0);
  }
  assert.equal(game.score, 600);
  assert.equal(game.combo, 5);
  game.asteroids = [stationaryRock(game, 1, 20, 20)];
  advance(game, 2.7);
  assert.equal(game.combo, 0);
});

test('shield protects the ship, breaks rocks, and must recharge', () => {
  const game = running();
  game.ship.invulnerable = 0;
  game.asteroids = [stationaryRock(game, 1, game.ship.x, game.ship.y)];
  game.update(1 / 60, { shield: true });
  assert.equal(game.lives, 3);
  assert.equal(game.score, 100);
  assert.equal(game.shieldCooldown, SHIELD_RECHARGE);
  advance(game, 1);
  assert.ok(game.shieldTime > 0);
  assert.ok(game.shieldCooldown > 5);
});

test('a collision costs one life and respawn protection prevents repeated deaths', () => {
  const game = running();
  game.ship.invulnerable = 0;
  game.asteroids = [stationaryRock(game, 3, game.ship.x, game.ship.y)];
  game.update(1 / 60);
  assert.equal(game.lives, 2);
  assert.equal(game.ship.invulnerable, 3);
  game.asteroids[0].x = game.ship.x;
  game.asteroids[0].y = game.ship.y;
  game.update(1 / 60);
  assert.equal(game.lives, 2);
});

test('three deaths end the run and restarting works', () => {
  const game = running();
  for (let i = 0; i < 3; i++) {
    game.ship.invulnerable = 0;
    game.asteroids = [stationaryRock(game, 1, game.ship.x, game.ship.y)];
    game.update(1 / 60);
  }
  assert.equal(game.state, 'gameover');
  assert.equal(game.lives, 0);
  const score = game.score;
  advance(game, 1, { fire: true });
  assert.equal(game.score, score);
  game.start();
  assert.equal(game.state, 'playing');
  assert.equal(game.lives, 3);
});

test('pause freezes the simulation and resume preserves progress', () => {
  const game = running();
  game.score = 420;
  assert.equal(game.pause(), true);
  const before = JSON.stringify([game.ship, game.asteroids, game.elapsed]);
  advance(game, 1, { fire: true, thrust: 1 });
  assert.equal(JSON.stringify([game.ship, game.asteroids, game.elapsed]), before);
  assert.equal(game.resume(), true);
  assert.equal(game.score, 420);
  assert.equal(game.state, 'playing');
});

test('clearing the field advances to a harder wave after a breather', () => {
  const game = running();
  game.asteroids = [];
  advance(game, 1);
  assert.equal(game.wave, 1);
  advance(game, 1.3);
  assert.equal(game.wave, 2);
  assert.equal(game.asteroids.length, 5);
});

test('triple-shot and shield-charge pickups work', () => {
  const game = running();
  game.pickups = [{
    id: 1, x: game.ship.x, y: game.ship.y, vx: 0, vy: 0,
    radius: 12, angle: 0, life: 10, kind: 'triple',
  }];
  game.update(1 / 60);
  assert.equal(game.tripleTime, 10);
  game.fire();
  assert.equal(game.bullets.length, 3);
  game.shieldCooldown = 5;
  game.pickups = [{
    id: 2, x: game.ship.x, y: game.ship.y, vx: 0, vy: 0,
    radius: 12, angle: 0, life: 10, kind: 'charge',
  }];
  game.update(1 / 60);
  assert.equal(game.shieldCooldown, 0);
});

test('extra lives are earned at score thresholds and capped at five', () => {
  const game = running();
  game.score = 9990;
  game.asteroids = [stationaryRock(game, 1, 100, 100)];
  game.destroyRock(0);
  assert.equal(game.lives, 4);
  assert.equal(game.nextLife, 20000);
  game.lives = 5;
  game.score = 19990;
  game.asteroids = [stationaryRock(game, 1, 100, 100)];
  game.destroyRock(0);
  assert.equal(game.lives, 5);
});

test('resize preserves the run and keeps entities within the new bounds', () => {
  const game = running();
  game.score = 1234;
  game.resize(390, 500);
  assert.equal(game.score, 1234);
  assert.equal(game.wave, 1);
  assert.equal(game.state, 'playing');
  for (const item of [game.ship, ...game.asteroids]) {
    assert.ok(item.x >= 0 && item.x < 390);
    assert.ok(item.y >= 0 && item.y < 500);
  }
});

test('invalid dimensions and invalid frame times fail explicitly', () => {
  assert.throws(() => new Game(0, 400), RangeError);
  const game = running();
  assert.throws(() => game.resize(NaN, 400), RangeError);
  assert.throws(() => game.update(-1), RangeError);
  assert.throws(() => game.update(Infinity), RangeError);
  assert.equal(wrappedDelta(995, 1000), -5);
});

test('effects remain bounded during sustained play', () => {
  const game = running();
  game.ship.invulnerable = 1000;
  for (let i = 0; i < 100; i++) {
    game.asteroids = [stationaryRock(game, 1, 100, 100)];
    game.destroyRock(0);
    game.update(1 / 60, { fire: true, thrust: 1 });
  }
  assert.ok(game.particles.length <= 200);
  assert.ok(game.floaters.length <= 20);
  assert.ok(game.bullets.length <= 8);
});

test('exactly seven reversible cheats exist, with infinite lives first', () => {
  const game = running();
  assert.equal(CHEATS.length, 7);
  assert.equal(CHEATS[0].key, 'infiniteLives');
  assert.ok(CHEATS.every(cheat => game.cheats[cheat.key] === false));
  for (const cheat of CHEATS) game.setCheat(cheat.key, true);
  assert.equal(game.cheatMask(), 127);
  assert.equal(game.cheatsUsed, 127);
  for (const cheat of CHEATS) game.setCheat(cheat.key, false);
  assert.equal(game.cheatMask(), 0);
  assert.equal(game.cheated, true);
  game.start();
  assert.equal(game.cheated, false);
  assert.throws(() => game.setCheat('eval', true), RangeError);
  assert.throws(() => game.setCheat('infiniteLives', 'true'), TypeError);
});

test('infinite lives respawns forever but disabling restores normal life loss', () => {
  const game = running();
  game.setCheat('infiniteLives', true);
  for (let i = 0; i < 7; i++) game.loseLife();
  assert.equal(game.lives, 3);
  assert.equal(game.state, 'playing');
  assert.equal(game.stats.deaths, 7);
  game.setCheat('infiniteLives', false);
  game.loseLife();
  assert.equal(game.lives, 2);
});

test('god mode blocks collisions until disabled', () => {
  const game = running();
  game.setCheat('invincible', true);
  game.ship.invulnerable = 0;
  game.asteroids = [stationaryRock(game, 1, game.ship.x, game.ship.y)];
  game.update(1 / 60);
  assert.equal(game.lives, 3);
  game.setCheat('invincible', false);
  game.update(1 / 60);
  assert.equal(game.lives, 2);
});

test('rapid fire increases cadence and permanent triple shot toggles independently', () => {
  const game = running(2000, 1200);
  game.asteroids = [stationaryRock(game, 1, 30, 30)];
  game.setCheat('rapidFire', true);
  game.setCheat('tripleShot', true);
  advance(game, 1, { fire: true });
  assert.ok(game.stats.shots >= 54 && game.stats.shots <= 66);
  assert.ok(game.bullets.length <= 80);
  game.setCheat('tripleShot', false);
  const before = game.stats.shots;
  game.fire();
  assert.equal(game.stats.shots - before, 1);
  game.setCheat('rapidFire', false);
  game.fireCooldown = 0;
  const previous = game.stats.shots;
  advance(game, 1, { fire: true });
  assert.ok(game.stats.shots - previous <= 8);
});

test('bullet time slows rocks to exactly 35% without changing their velocities', () => {
  const normal = running();
  const slow = running();
  normal.asteroids = [stationaryRock(normal, 1, 100, 100)];
  slow.asteroids = [stationaryRock(slow, 1, 100, 100)];
  normal.asteroids[0].vx = slow.asteroids[0].vx = 100;
  slow.setCheat('slowRocks', true);
  normal.update(0.05);
  slow.update(0.05);
  assert.ok(Math.abs((slow.asteroids[0].x - 100) / (normal.asteroids[0].x - 100) - 0.35) < 1e-9);
  assert.equal(slow.asteroids[0].vx, 100);
});

test('pickup magnet attracts across the seam and stops attracting when disabled', () => {
  const game = running();
  Object.assign(game.ship, { x: 995, y: 300 });
  game.pickups = [{ id: 77, x: 100, y: 300, vx: 0, vy: 0, angle: 0, radius: 12, life: 10, kind: 'triple' }];
  game.setCheat('pickupMagnet', true);
  const distance = game.distance(game.ship, game.pickups[0]);
  game.update(0.05);
  assert.ok(game.distance(game.ship, game.pickups[0]) < distance);
  game.setCheat('pickupMagnet', false);
  const x = game.pickups[0].x;
  game.update(0.05);
  assert.equal(game.pickups[0].x, x);
});

test('homing shots steer toward targets while preserving speed', () => {
  const game = running();
  game.asteroids = [stationaryRock(game, 1, 300, 250)];
  game.bullets = [{ id: 5, x: 100, y: 100, vx: 500, vy: 0, life: 1 }];
  game.setCheat('homingShots', true);
  game.update(0.03);
  assert.ok(game.bullets[0].vy > 0);
  assert.ok(Math.abs(Math.hypot(game.bullets[0].vx, game.bullets[0].vy) - 500) < 1e-9);
  game.setCheat('homingShots', false);
  const vy = game.bullets[0].vy;
  game.update(0.03);
  assert.equal(game.bullets[0].vy, vy);
});

test('gameplay counters distinguish bullet hits from shield destruction and reset on restart', () => {
  const game = running();
  game.fire();
  assert.equal(game.stats.shots, 1);
  game.asteroids = [stationaryRock(game, 1, 100, 100)];
  game.destroyRock(0, 'shield');
  assert.equal(game.stats.rocks, 1);
  assert.equal(game.stats.hits, 0);
  game.asteroids = [stationaryRock(game, 1, 100, 100)];
  game.destroyRock(0);
  assert.equal(game.stats.hits, 1);
  game.start();
  assert.deepEqual(game.stats, { shots: 0, hits: 0, rocks: 0, deaths: 0, shields: 0, pickups: 0, maxCombo: 1 });
});
