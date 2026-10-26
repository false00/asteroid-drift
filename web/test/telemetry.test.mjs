import test from 'node:test';
import assert from 'node:assert/strict';
import { GameplayTelemetry, QUALIFY_MS, HEARTBEAT_MS } from '../site/telemetry.mjs';
import { FlightDiagnostics } from '../site/diagnostics.mjs';

const RUN = '11111111-1111-4111-8111-111111111111';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('ranked diagnostic windows separate frame stalls, snapshot gaps, input gaps and bounded state transitions', () => {
  let now = 0;
  const diagnostics = new FlightDiagnostics({ now: () => now, wall: () => 1900000000000 });
  diagnostics.frame(0, true);
  diagnostics.frame(16, true);
  diagnostics.frame(116, true);
  diagnostics.task(88);
  diagnostics.input(0);
  diagnostics.input(70);
  diagnostics.snapshot(4, 2);
  now = 500;
  diagnostics.snapshot(8, 3);
  diagnostics.event('offline');
  diagnostics.event('private-url-and-error');
  const sample = diagnostics.sample({ game_state: 'playing', visible: true, online: false, browser: 'chromium', cookie: 'never-log' });
  assert.equal(sample.frames, 3);
  assert.equal(sample.frame_gap_max_ms, 100);
  assert.equal(sample.slow_frames, 1);
  assert.equal(sample.long_task_max_ms, 88);
  assert.equal(sample.snapshot_gap_max_ms, 500);
  assert.equal(sample.ack_backlog_max, 5);
  assert.equal(sample.input_gap_max_ms, 70);
  assert.deepEqual(sample.events, [{ type: 'offline', at_ms: 500 }]);
  assert.doesNotMatch(JSON.stringify(sample), /never-log|private-url|cookie/);
  assert.equal(diagnostics.sample().frames, 0);
  for (let index = 0; index < 100; index++) diagnostics.event('focus');
  assert.equal(diagnostics.sample().events.length, 12);
});

function setup(overrides = {}) {
  const requests = [];
  let clock = 0;
  const game = {
    state: 'playing', elapsed: 0, score: 0, wave: 1, cheatsUsed: 0,
    stats: { shots: 0, hits: 0, rocks: 0, deaths: 0, shields: 0, pickups: 0, maxCombo: 1 },
  };
  const telemetry = new GameplayTelemetry({
    navigator: { webdriver: false },
    now: () => clock, uuid: () => RUN, visible: () => true,
    send: async url => { requests.push(new URL(url, 'https://arcade.example')); return { status: 204 }; },
    ...overrides,
  });
  const tick = (ms, input = { fire: true }) => {
    clock += ms;
    game.elapsed = clock / 1000;
    telemetry.sample(game, ms / 1000, input);
  };
  return { telemetry, game, tick, requests };
}

test('idle visits, launch-only visits, and synthetic flight events never count as players', async () => {
  const { telemetry, game, tick, requests } = setup();
  tick(5000);
  telemetry.begin();
  tick(5000);
  telemetry.noteInput({ isTrusted: false }, 'keyboard');
  tick(5000);
  telemetry.flush('pagehide', game);
  await settle();
  assert.equal(requests.length, 0);
});

test('a run qualifies only at the exact sustained-play threshold with trusted controls', async () => {
  const { telemetry, tick, requests } = setup();
  telemetry.begin();
  telemetry.noteInput({ isTrusted: true }, 'keyboard');
  tick(QUALIFY_MS - 1);
  assert.equal(requests.length, 0);
  tick(1);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('event'), 'start');
  assert.equal(requests[0].searchParams.get('active_ms'), String(QUALIFY_MS));
  assert.equal(requests[0].searchParams.get('seq'), '1');
});

test('heartbeats are bounded, cumulative, and contain no IP, cookie, user-agent, or player identity', async () => {
  const { telemetry, game, tick, requests } = setup();
  telemetry.begin('phone');
  telemetry.noteInput({ isTrusted: true }, 'touch');
  tick(QUALIFY_MS);
  await settle();
  game.stats.shots = 50;
  tick(HEARTBEAT_MS - 1);
  assert.equal(requests.length, 1);
  tick(1);
  await settle();
  assert.equal(requests.length, 2);
  const payload = requests[1].searchParams;
  assert.equal(payload.get('event'), 'progress');
  assert.equal(payload.get('active_ms'), '32000');
  assert.equal(payload.get('shots'), '50');
  assert.equal(payload.get('controls'), 'touch');
  assert.equal(payload.get('device'), 'phone');
  assert.equal(payload.get('automated'), '0');
  assert.doesNotMatch(requests[1].search, /user_agent|cookie|ip=|player_id/);
});

test('hidden, paused, and long-idle time do not accumulate active play', () => {
  const { telemetry, game, tick } = setup({ visible: () => false });
  telemetry.begin();
  telemetry.noteInput({ isTrusted: true }, 'keyboard');
  tick(5000);
  assert.equal(telemetry.run.activeMs, 0);
  const visible = setup();
  visible.telemetry.begin();
  visible.telemetry.noteInput({ isTrusted: true }, 'keyboard');
  visible.game.state = 'paused';
  visible.tick(3000);
  assert.equal(visible.telemetry.run.activeMs, 0);
  visible.game.state = 'playing';
  visible.tick(20000, {});
  assert.equal(visible.telemetry.run.activeMs, 0);
  assert.equal(game.state, 'playing');
});

test('sandbox and automation classifications are explicit and counters capture real outcomes', async () => {
  const { telemetry, game, tick, requests } = setup({ navigator: { webdriver: true } });
  telemetry.begin();
  telemetry.noteInput({ isTrusted: true }, 'keyboard');
  telemetry.noteInput({ isTrusted: true }, 'touch');
  game.cheatsUsed = 127;
  game.score = 1000;
  game.stats = { shots: 20, hits: 10, rocks: 12, deaths: 1, shields: 2, pickups: 1, maxCombo: 3 };
  tick(2000);
  await settle();
  const payload = requests[0].searchParams;
  assert.equal(payload.get('automated'), '1');
  assert.equal(payload.get('cheats'), '127');
  assert.equal(payload.get('controls'), 'mixed');
  assert.equal(payload.get('hits'), '10');
  telemetry.flush('gameover', game);
  await settle();
  assert.equal(requests.at(-1).searchParams.get('reason'), 'gameover');
});

test('transient delivery retries the same event identity, preventing duplicate historical totals', async () => {
  let attempts = 0;
  const urls = [];
  const scheduled = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { telemetry, tick } = setup({
      send: async url => { urls.push(url); return { status: ++attempts === 1 ? 503 : 204 }; },
      schedule: (callback, delay) => scheduled.push({ callback, delay }),
    });
    telemetry.begin();
    telemetry.noteInput({ isTrusted: true }, 'keyboard');
    tick(2000);
    await settle();
    assert.equal(scheduled[0].delay, 1000);
    scheduled[0].callback();
    await settle();
    assert.equal(urls.length, 2);
    assert.equal(urls[0], urls[1]);
    assert.equal(telemetry.queue.length, 0);
  } finally { console.warn = warn; }
});

test('page-exit beacons preserve event identities for server-side deduplication', () => {
  const beacons = [];
  const { telemetry, game, tick } = setup({
    navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    send: () => new Promise(() => {}),
  });
  telemetry.begin();
  telemetry.noteInput({ isTrusted: true }, 'touch');
  tick(2000);
  telemetry.flush('pagehide', game);
  telemetry.beacon();
  assert.equal(beacons.length, 2);
  assert.equal(new URL(beacons[0].url, 'https://arcade.example').searchParams.get('seq'), '1');
  assert.equal(new URL(beacons[1].url, 'https://arcade.example').searchParams.get('reason'), 'pagehide');
});

test('active controller input is classified as gamepad, or mixed with trusted keyboard/touch', async () => {
  const { telemetry, tick, requests } = setup();
  telemetry.begin();
  telemetry.noteGamepadInput();
  tick(2000);
  await settle();
  assert.equal(requests[0].searchParams.get('controls'), 'gamepad');
  telemetry.noteInput({ isTrusted: true }, 'keyboard');
  tick(30000);
  await settle();
  assert.equal(requests[1].searchParams.get('controls'), 'mixed');
});
