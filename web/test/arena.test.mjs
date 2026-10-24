import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../site/engine.mjs';
import { DEFAULT_VIEWPORT, MAX_VIEWPORT_EDGE, RANKED_AREA, RANKED_SCALE, arenaForViewport, isRankedArena, viewportForSize } from '../site/arena.mjs';

test('ranked shapes follow the viewport while keeping the same total gameplay area', () => {
  for (const [width, height] of [[390, 620], [1440, 700], [844, 220], [800, 800], [2400, 300], [300, 2400]]) {
    const arena = arenaForViewport(width, height);
    assert.ok(Math.abs(arena.width / arena.height - width / height) < 0.000000001);
    assert.ok(Math.abs(arena.width * arena.height - RANKED_AREA) < 0.000001);
    assert.equal(isRankedArena(arena.width, arena.height), true);
  }
  assert.deepEqual(arenaForViewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height), { width: 960, height: 640 });
});

test('viewport serialization preserves fractional CSS sizes without trusting arbitrary dimensions', () => {
  const viewport = viewportForSize(360.666, 592.666);
  assert.ok(Number.isSafeInteger(viewport.width) && Number.isSafeInteger(viewport.height));
  assert.ok(Math.abs(viewport.width / viewport.height - 360.666 / 592.666) < 0.00001);
  const large = viewportForSize(40000, 20000);
  assert.equal(large.width, MAX_VIEWPORT_EDGE);
  assert.equal(large.width / large.height, 2);
  for (const value of [0, -1, NaN, Infinity, '390']) assert.throws(() => viewportForSize(value, 600), RangeError);
});

test('ranked geometry rejects non-finite, oversized, fractional, or extreme viewport inputs', () => {
  for (const value of [0, -1, NaN, Infinity, '390', 390.5, MAX_VIEWPORT_EDGE + 1]) assert.throws(() => arenaForViewport(value, 600), RangeError);
  assert.throws(() => arenaForViewport(1, 600), RangeError);
  assert.throws(() => arenaForViewport(600, 1), RangeError);
  for (const [width, height] of [[960, 641], [NaN, 640], [960, Infinity], [0, 0]]) assert.equal(isRankedArena(width, height), false);
});

test('ranked resizing retains object sizes, velocities, game state, and randomness', () => {
  let randomCalls = 0;
  const random = () => { randomCalls++; return 0.4; };
  const game = new Game(960, 640, random, { fixedScale: RANKED_SCALE, resumeProtection: false });
  game.start();
  Object.assign(game, { score: 1234, lives: 2, elapsed: 42, fireCooldown: 0.1, shieldCooldown: 3, tripleTime: 4 });
  game.ship.invulnerable = 0;
  const before = game.asteroids.map(rock => [rock.radius, rock.vx, rock.vy]);
  const calls = randomCalls;
  const arena = arenaForViewport(390, 620);
  game.resize(arena.width, arena.height);
  assert.deepEqual(game.asteroids.map(rock => [rock.radius, rock.vx, rock.vy]), before);
  assert.equal(game.scale, RANKED_SCALE);
  assert.equal(game.ship.radius, 11 * RANKED_SCALE);
  assert.equal(game.ship.invulnerable, 0);
  assert.equal(randomCalls, calls);
  assert.deepEqual([game.score, game.lives, game.elapsed, game.fireCooldown, game.shieldCooldown, game.tripleTime], [1234, 2, 42, 0.1, 3, 4]);
});

test('queued authoritative effects and existing floating labels follow the resized coordinates', () => {
  const game = new Game(960, 640, () => 0.4, { fixedScale: RANKED_SCALE });
  game.events = [{ type: 'hit', x: 240, y: 160, points: 100 }, { type: 'wave', wave: 1 }];
  game.addFloater(240, 160, '+100');
  const pending = [{ type: 'death', x: 480, y: 320 }];
  const arena = arenaForViewport(390, 620);
  game.resize(arena.width, arena.height, pending);
  assert.ok(Math.abs(game.events[0].x - arena.width / 4) < 0.000000001);
  assert.ok(Math.abs(game.events[0].y - arena.height / 4) < 0.000000001);
  assert.deepEqual(game.events[1], { type: 'wave', wave: 1 });
  assert.ok(Math.abs(game.floaters[0].x - arena.width / 4) < 0.000000001);
  assert.ok(Math.abs(pending[0].x - arena.width / 2) < 0.000000001);
  assert.ok(Math.abs(pending[0].y - arena.height / 2) < 0.000000001);
});

test('casual scaling retains its existing viewport behavior', () => {
  const game = new Game(960, 640, () => 0.4);
  game.resize(320, 568);
  assert.equal(game.scale, 0.72);
  game.resize(1440, 900);
  assert.equal(game.scale, 1.1);
  for (const fixedScale of [0, -1, Infinity, NaN]) assert.throws(() => new Game(960, 640, Math.random, { fixedScale }), RangeError);
});
