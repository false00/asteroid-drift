import { test, expect } from '@playwright/test';
import { Game } from '../site/engine.mjs';
import { RANKED_AREA, RANKED_SCALE, arenaForViewport } from '../site/arena.mjs';

test('native fullscreen offers Exit/Esc on desktop without pausing and stays off iPhone', async ({ page }, testInfo) => {
  const { errors } = await openArcade(page);
  if (testInfo.project.name !== 'desktop') {
    await expect(page.locator('#fullscreen')).toBeHidden();
    return;
  }
  await start(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.locator('#fullscreen')).toHaveText('EXIT / ESC');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(errors).toEqual([]);
});

test('pilot forms allow native editing and selection without firing shortcuts or iPhone focus zoom', async ({ page }) => {
  const { errors } = await openArcade(page);
  await start(page);
  await page.locator('#account').click();
  await expect(page.locator('#identity-dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  const input = page.locator('#username');
  await input.scrollIntoViewIfNeeded();
  await input.pressSequentially('Pilot_WASD_123');
  await expect(input).toHaveValue('Pilot_WASD_123');
  const selection = await input.evaluate(element => {
    element.setSelectionRange(0, element.value.length);
    return { start: element.selectionStart, end: element.selectionEnd, font: getComputedStyle(element).fontSize, selection: getComputedStyle(element).userSelect, scale: visualViewport.scale };
  });
  expect(selection).toEqual({ start: 0, end: 14, font: '16px', selection: 'text', scale: 1 });
  await expect(page.locator('#console-view')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await page.locator('#identity-close').click();
  await expect(page.locator('#identity-dialog')).not.toBeVisible();
  expect(errors).toEqual([]);
});

async function openArcade(page, options = {}) {
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(options => {
    let seed = 73;
    Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    window.__arcadeDrawCalls = 0;
    window.__arcadeLastDrawState = null;
    if (options.gamepadAccess === 'missing') {
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: undefined });
    } else if (options.gamepadAccess === 'blocked') {
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => { throw new DOMException('Controller access blocked', 'SecurityError'); } });
    } else if (options.virtualGamepad || typeof navigator.getGamepads === 'function') {
      window.__virtualPad = null;
      window.__arcadePadPolls = 0;
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => {
        window.__arcadePadPolls++;
        return window.__virtualPad ? [window.__virtualPad] : [];
      } });
    }
    for (const method of ['drawArrays', 'drawElements']) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) {
        window.__arcadeDrawCalls++;
        window.__arcadeLastDrawState = document.body?.dataset.state;
        return original.apply(this, args);
      };
    }
    const viewport = WebGL2RenderingContext.prototype.viewport;
    WebGL2RenderingContext.prototype.viewport = function (x, y, width, height) {
      window.__arcadeViewport = { x, y, width, height };
      return viewport.call(this, x, y, width, height);
    };
    const uniformNames = new WeakMap();
    const getUniformLocation = WebGL2RenderingContext.prototype.getUniformLocation;
    WebGL2RenderingContext.prototype.getUniformLocation = function (...args) {
      const location = getUniformLocation.apply(this, args);
      if (location) uniformNames.set(location, args[1]);
      return location;
    };
    const uniformMatrix = WebGL2RenderingContext.prototype.uniformMatrix4fv;
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (...args) {
      if (uniformNames.get(args[0]) === 'projectionMatrix') window.__arcadeProjection = Array.from(args[2]);
      return uniformMatrix.apply(this, args);
    };
    window.__arcadeAudio = { contexts: [], starts: 0 };
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const resume = AudioContext.prototype.resume;
      AudioContext.prototype.resume = function (...args) {
        if (!window.__arcadeAudio.contexts.includes(this)) window.__arcadeAudio.contexts.push(this);
        return resume.apply(this, args);
      };
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (...args) {
        const oscillator = create.apply(this, args);
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...args) => { window.__arcadeAudio.starts++; return start(...args); };
        return oscillator;
      };
    }
    if (options.mockHaptics) {
      window.__arcadePulses = [];
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: pattern => { window.__arcadePulses.push({ pattern, at: performance.now() }); return true; },
      });
    }
  }, options);
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#launch')).toBeEnabled();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => page.evaluate(() => window.__arcadeDrawCalls)).toBeGreaterThan(0);
  return { errors, requests };
}

async function start(page) {
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator('.cabinet').boundingBox();
  const height = await page.evaluate(() => innerHeight);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1);
}

async function mockRanked(page, { personalBest = 0, entries = [] } = {}) {
  const game = new Game(960, 640, () => 0.4, { resumeProtection: false, fixedScale: RANKED_SCALE });
  game.start();
  game.asteroids = [];
  game.waveBanner = 0;
  Object.assign(game.ship, { x: 240, y: 160, invulnerable: 0 });
  const inputs = [];
  const starts = [];
  const restarts = [];
  const pauses = [];
  let current = null;
  let ticketFailure = false;
  const viewports = [];
  const resize = viewport => {
    const arena = arenaForViewport(viewport.width, viewport.height);
    game.resize(arena.width, arena.height);
    viewports.push(viewport);
  };
  const run = { id: '00000000-0000-4000-8000-000000000001' };
  await page.route('**/api/session', route => route.fulfill({ json: {
    authenticated: true, csrf: 'p'.repeat(43),
    user: { id: '00000000-0000-4000-8000-000000000002', username: 'Portrait_Pilot', passkeys: 1, personalBest },
  } }));
  await page.route('**/api/leaderboard', route => route.fulfill({ json: { entries } }));
  await page.route('**/api/ranked/current', route => route.fulfill({ json: { run: current } }));
  const begin = body => {
    if (starts.length + restarts.length > 1) {
      game.start();
      game.asteroids = [];
      game.waveBanner = 0;
    }
    run.id = `00000000-0000-4000-8000-${String(starts.length + restarts.length).padStart(12, '0')}`;
    resize(body.viewport);
    current = { ...run };
  };
  await page.route('**/api/ranked/start', route => {
    const body = route.request().postDataJSON();
    starts.push(body);
    begin(body);
    return route.fulfill({ json: { run } });
  });
  await page.route('**/api/ranked/restart', route => {
    const body = route.request().postDataJSON();
    if (body.runId !== (current?.id ?? null)) return route.fulfill({ status: 409, json: { error: 'run_changed' } });
    restarts.push(body);
    begin(body);
    return route.fulfill({ json: { run } });
  });
  await page.route('**/api/ranked/ticket', route => {
    if (ticketFailure) {
      ticketFailure = false;
      return route.fulfill({ status: 404, json: { error: 'run_not_found' } });
    }
    return route.fulfill({ json: { ticket: 'test-only-portrait-ticket' } });
  });
  let socket;
  let tick = 0;
  const snapshot = (events = []) => socket.send(JSON.stringify({ type: 'snapshot', tick: ++tick, game, events }));
  await page.routeWebSocket('**/api/ranked/live', connection => {
    socket = connection;
    connection.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'attach') {
        resize(message.viewport);
        connection.send(JSON.stringify({ type: 'attached' }));
      }
      else if (message.type === 'resume') {
        game.state = 'playing';
        snapshot();
      } else if (message.type === 'pause') {
        pauses.push(message.reason);
        game.state = 'paused';
        snapshot();
      } else if (message.type === 'viewport') {
        resize(message.viewport);
        snapshot();
      } else if (message.type === 'input') inputs.push(message);
    });
  });
  const finish = ({ rank = null, previousRank = null, qualified = true } = {}) => {
    const previousBest = personalBest;
    personalBest = Math.max(personalBest, qualified ? game.score : 0);
    current = null;
    game.state = 'gameover';
    snapshot([{ type: 'gameover', score: game.score, wave: game.wave }]);
    const result = {
      score: game.score, wave: game.wave, durationMs: Math.floor(game.elapsed * 1000), qualified,
      personalBest, previousBest, newPersonalBest: personalBest > previousBest, rank, previousRank,
      rankImproved: qualified && rank !== null && (previousRank === null || rank < previousRank),
    };
    socket.send(JSON.stringify({ type: 'finished', result }));
    return result;
  };
  return {
    game, inputs, starts, restarts, pauses, viewports, snapshot, finish,
    failNextTicket: () => { ticketFailure = true; },
    disconnect: (code = 1011) => socket.close({ code, reason: 'Local test transport interruption' }),
  };
}

test('ranked failures offer a non-destructive retry and an explicit new-flight recovery', async ({ page }) => {
  const ranked = await mockRanked(page, { personalBest: 500 });
  ranked.failNextTicket();
  const { errors } = await openArcade(page);
  await page.locator('#ranked').click();
  await expect(page.locator('#result-title')).toHaveText('FLIGHT INTERRUPTED');
  await expect(page.locator('#result-copy')).toContainText('no longer available');
  await expect(page.locator('#launch-label')).toHaveText('RETRY CONNECTION');
  await expect(page.locator('#restart-ranked')).toBeVisible();
  await expect(page.locator('#ranked-recovery-copy')).toContainText('discards unfinished progress');
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(ranked.starts).toHaveLength(1);
  expect(ranked.restarts).toHaveLength(0);
  ranked.game.score = 400;
  ranked.snapshot();
  await expect(page.locator('#score')).toHaveText('000400');
  ranked.disconnect();
  await expect(page.locator('#result-title')).toHaveText('FLIGHT INTERRUPTED');
  await expect(page.locator('#restart-ranked')).toBeInViewport();
  await page.locator('#restart-ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(ranked.restarts).toHaveLength(1);
  expect(ranked.restarts[0].runId).toBe('00000000-0000-4000-8000-000000000001');
  await expect(page.locator('#score')).toHaveText('000000');
  await expect(page.locator('#best')).toHaveText('000500');
  await expect(page.locator('#record-celebration')).toBeHidden();
  expect(errors.filter(message => !message.includes('404 (Not Found)'))).toEqual([]);
});

test('ranked pause diagnostics distinguish manual, focus, tab, help, account and console actions', async ({ page }) => {
  const ranked = await mockRanked(page);
  const { errors } = await openArcade(page);
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.keyboard.press('p');
  await expect.poll(() => ranked.pauses.at(-1)).toBe('player');
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await expect.poll(() => ranked.pauses.at(-1)).toBe('blur');
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => ranked.pauses.at(-1)).toBe('hidden');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.locator('#help').click();
  await expect.poll(() => ranked.pauses.at(-1)).toBe('manual');
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.locator('#account').click();
  await expect.poll(() => ranked.pauses.at(-1)).toBe('account');
  await page.locator('#identity-close').click();
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.locator('#console').click();
  await expect.poll(() => ranked.pauses.at(-1)).toBe('console');
  expect(ranked.starts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('ranked recovery distinguishes a device handoff from a slow-receiver closure', async ({ page }) => {
  const ranked = await mockRanked(page);
  const { errors } = await openArcade(page);
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  for (const [code, copy] of [[4003, 'another window or device'], [4004, 'could not keep up']]) {
    ranked.disconnect(code);
    await expect(page.locator('#result-title')).toHaveText('FLIGHT INTERRUPTED');
    await expect(page.locator('#result-copy')).toContainText(copy);
    await page.locator('#launch').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  }
  expect(ranked.starts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('ranked records update immediately and the main replay button stays ranked without touching casual best', async ({ page }) => {
  const ranked = await mockRanked(page, { personalBest: 172220 });
  await page.addInitScript(() => localStorage.setItem('curlred.asteroid-drift.best', '12345'));
  const { errors } = await openArcade(page);
  await expect(page.locator('#best-label')).toHaveText('RANKED BEST');
  await expect(page.locator('#best')).toHaveText('172220');
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  Object.assign(ranked.game, { score: 1077520, wave: 44, elapsed: 300 });
  ranked.snapshot();
  await expect(page.locator('#best')).toHaveText('1077520');
  ranked.finish({ rank: 1 });
  await expect(page.locator('#launch')).toBeEnabled();
  await expect(page.locator('#launch-label')).toHaveText('ANOTHER RANKED FLIGHT');
  await expect(page.locator('#ranked')).toBeHidden();
  await expect(page.locator('#result-title')).toHaveText('NEW #1 PILOT');
  await expect(page.locator('#record-result')).toContainText('1,077,520');
  await expect(page.locator('#record-result')).toContainText('#1 GLOBAL');
  expect(await page.evaluate(() => localStorage.getItem('curlred.asteroid-drift.best'))).toBe('12345');
  await page.locator('#launch').evaluate(button => { button.click(); button.click(); });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(ranked.starts).toHaveLength(2);
  await expect(page.locator('#ranked-badge')).toBeVisible();
  await expect(page.locator('#score')).toHaveText('000000');
  await expect(page.locator('#best')).toHaveText('1077520');
  await expect(page.locator('#record-celebration')).toBeHidden();
  await page.locator('#pause').click();
  await page.locator('#leave-ranked').click();
  await expect(page.locator('#best')).toHaveText('1077520');
  await page.locator('#launch').click();
  await expect(page.locator('#best-label')).toHaveText('CASUAL BEST');
  await expect(page.locator('#best')).toHaveText('012345');
  await page.reload();
  await expect(page.locator('#best')).toHaveText('1077520');
  expect(errors).toEqual([]);
});

test('live verified records and leaderboard overtakes celebrate once without blocking flight controls', async ({ page, isMobile }) => {
  const ranked = await mockRanked(page, { personalBest: 500, entries: [
    { rank: 1, username: 'First_Pilot', score: 1500 },
    { rank: 2, username: 'Second_Pilot', score: 900 },
    { rank: 3, username: 'Portrait_Pilot', score: 500 },
  ] });
  const { errors } = await openArcade(page);
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  ranked.game.score = 501;
  ranked.snapshot();
  await expect(page.locator('#record-title')).toHaveText('NEW PERSONAL BEST');
  await expect(page.locator('#record-eyebrow')).toContainText('FINISH TO SAVE');
  const first = await page.locator('#record-celebration').getAttribute('data-sequence');
  ranked.game.score = 900;
  ranked.snapshot();
  await expect(page.locator('#best')).toHaveText('000900');
  expect(await page.locator('#record-celebration').getAttribute('data-sequence')).toBe(first);
  ranked.game.score = 901;
  ranked.snapshot();
  await expect(page.locator('#record-title')).toHaveText('TOP 2 PACE');
  await expect(page.locator('#record-detail')).toHaveText('1 PILOT PASSED');
  ranked.game.score = 1501;
  ranked.snapshot();
  await expect(page.locator('#record-celebration')).toHaveAttribute('data-kind', 'leader');
  await expect(page.locator('#record-title')).toHaveText('NUMBER ONE PACE');
  const sequence = await page.locator('#record-celebration').getAttribute('data-sequence');
  ranked.snapshot();
  await page.waitForTimeout(120);
  expect(await page.locator('#record-celebration').getAttribute('data-sequence')).toBe(sequence);
  expect(await page.locator('#record-celebration').evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  if (isMobile) await page.locator('#touch-fire').tap();
  else await page.keyboard.down('Space');
  await expect.poll(() => ranked.inputs.some(input => (input.keys & 4) !== 0)).toBe(true);
  if (!isMobile) await page.keyboard.up('Space');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(await page.evaluate(() => ({ scale: visualViewport.scale, text: getSelection().toString() }))).toEqual({ scale: 1, text: '' });
  ranked.game.state = 'gameover';
  ranked.snapshot([{ type: 'gameover', score: 1501, wave: 1 }]);
  await expect(page.locator('#launch')).toBeDisabled();
  await expect(page.locator('#launch-label')).toHaveText('VERIFYING RESULT...');
  ranked.finish({ rank: 1, previousRank: 3 });
  await expect(page.locator('#record-result')).toContainText('#3 TO #1 GLOBAL');
  await expect(page.locator('#record-celebration')).toHaveAttribute('data-phase', 'saved');
  await expect(page.locator('#launch')).toBeInViewport();
  if (isMobile) await page.setViewportSize({ width: 320, height: 568 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test('reduced-motion record feedback stays readable without animation and controller Start replays ranked', async ({ page }) => {
  const ranked = await mockRanked(page, { personalBest: 500 });
  const { errors } = await openArcade(page, { reducedMotion: true, virtualGamepad: true });
  await connectVirtualPad(page);
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  ranked.game.score = 600;
  ranked.snapshot();
  await expect(page.locator('#record-celebration')).toBeVisible();
  await expect(page.locator('#record-title')).toHaveText('NEW PERSONAL BEST');
  expect(await page.locator('#record-celebration').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  ranked.finish();
  await expect(page.locator('#result-title')).toHaveText('NEW PERSONAL BEST');
  expect(await page.locator('#result-title').evaluate(node => node.getAnimations().length)).toBe(0);
  const neutralPoll = await page.evaluate(() => window.__arcadePadPolls);
  await expect.poll(() => page.evaluate(() => window.__arcadePadPolls)).toBeGreaterThan(neutralPoll);
  await padButton(page, 9, true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(ranked.starts).toHaveLength(2);
  await padButton(page, 9, false);
  expect(errors).toEqual([]);
});

async function drawnArena(page) {
  return page.locator('canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const viewport = window.__arcadeViewport;
    const projection = window.__arcadeProjection;
    return {
      x: viewport.x * scaleX, y: viewport.y * scaleY,
      width: viewport.width * scaleX, height: viewport.height * scaleY,
      fieldWidth: rect.width, fieldHeight: rect.height,
      uniformScaleRatio: Math.abs(projection[0] * viewport.width / (projection[5] * viewport.height)),
    };
  });
}

test('ranked and casual fill the same complete playfield across phone, landscape and desktop sizes', async ({ page }) => {
  const ranked = await mockRanked(page);
  const { errors } = await openArcade(page);
  const fullCanvas = async () => {
    await expect.poll(async () => {
      const arena = await drawnArena(page);
      return Math.max(Math.abs(arena.x), Math.abs(arena.y), Math.abs(arena.width - arena.fieldWidth), Math.abs(arena.height - arena.fieldHeight));
    }).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs((await drawnArena(page)).uniformScaleRatio - 1)).toBeLessThan(0.001);
  };
  await fullCanvas();
  const casualBox = await page.locator('#playfield').boundingBox();
  await expect(page.locator('#ranked')).toHaveText('RANKED FLIGHT');
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(await page.locator('#playfield').boundingBox()).toEqual(casualBox);
  Object.assign(ranked.game, { score: 1234, lives: 2, elapsed: 42 });
  ranked.snapshot();
  for (const [width, height] of [[390, 844], [844, 390], [1440, 1000], [1024, 768], [390, 664]]) {
    await page.setViewportSize({ width, height });
    await fullCanvas();
    await expect.poll(async () => {
      const box = await page.locator('#playfield').boundingBox();
      return Math.abs(ranked.game.width / ranked.game.height - box.width / box.height);
    }).toBeLessThan(0.0001);
    expect(Math.abs(ranked.game.width * ranked.game.height - RANKED_AREA)).toBeLessThan(0.000001);
    expect(ranked.game.scale).toBe(RANKED_SCALE);
    expect([ranked.game.score, ranked.game.lives, ranked.game.elapsed]).toEqual([1234, 2, 42]);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
    await noOverflow(page);
  }
  const field = await drawnArena(page);
  ranked.snapshot([{ type: 'hit', x: ranked.game.width / 4, y: ranked.game.height / 4, points: 100, multiplier: 1, size: 1 }]);
  const floater = page.locator('#floaters .floater');
  await expect(floater).toBeVisible();
  const position = await floater.evaluate(node => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
  expect(Math.abs(position.x - field.fieldWidth / 4)).toBeLessThan(1);
  expect(position.y).toBeLessThanOrEqual(field.fieldHeight / 4 + 1);
  expect(position.y).toBeGreaterThan(field.fieldHeight / 4 - 20);
  expect(ranked.starts).toHaveLength(1);
  expect(ranked.viewports.length).toBeGreaterThanOrEqual(5);
  await page.locator('#pause').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fullCanvas();
  await expect.poll(async () => {
    const box = await page.locator('#playfield').boundingBox();
    return Math.abs(ranked.game.width / ranked.game.height - box.width / box.height);
  }).toBeLessThan(0.0001);
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(ranked.starts).toHaveLength(1);
  await page.locator('#pause').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await page.locator('#leave-ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  await fullCanvas();
  expect(errors).toEqual([]);
});

test('ranked portrait steering follows the screen for both thumbs and controller sticks', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Screen-relative ranked phone steering.');
  const ranked = await mockRanked(page);
  const { errors } = await openArcade(page, { virtualGamepad: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#ranked')).toHaveText('RANKED FLIGHT');
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  const steer = async (dx, dy, aim, fire = false) => {
    const box = await page.locator('#joystick').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    ranked.inputs.length = 0;
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await expect.poll(() => ranked.inputs.at(-1)?.aim).toBe(aim);
    expect(ranked.inputs.at(-1).thrust).toBeGreaterThan(0);
    if (fire) {
      await page.locator('#touch-fire').tap();
      await expect.poll(() => ranked.inputs.some(input => input.aim === aim && (input.keys & 4) !== 0)).toBe(true);
      await expect(page.locator('#joystick')).toHaveClass(/active/);
    }
    await page.mouse.up();
  };
  await steer(0, -25, 16384, true);
  await steer(25, 0, 32768);
  await steer(0, 25, 49151);
  await steer(-25, 0, 0);
  await connectVirtualPad(page);
  await page.evaluate(() => { window.__virtualPad.axes = [0, -0.8]; });
  await expect.poll(() => ranked.inputs.at(-1)?.aim).toBe(16384);
  await page.evaluate(() => { window.__virtualPad.axes = [0, 0]; });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => {
    const arena = await drawnArena(page);
    return Math.abs(arena.uniformScaleRatio - 1);
  }).toBeLessThan(0.001);
  await steer(0, -25, 16384);
  expect(ranked.starts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('loads a working, self-contained Three.js playfield with no runtime errors', async ({ page }) => {
  const { errors, requests } = await openArcade(page);
  await expect(page).toHaveTitle('Asteroid Drift | curl.red arcade');
  await expect(page.locator('#game-title')).toBeVisible();
  await expect(page.locator('#system-status')).toHaveText('ALL SYSTEMS GO');
  expect(await page.locator('canvas').evaluate(canvas => Boolean(canvas.getContext('webgl2')))).toBe(true);
  await noOverflow(page);
  expect(requests.every(url => url.startsWith('http://127.0.0.1:4178/'))).toBe(true);
  expect(requests.some(url => url.endsWith('/vendor/three.module.js'))).toBe(true);
  expect(errors).toEqual([]);
});

test('keyboard flight scores points, pauses, resumes, and retains the best score', async ({ page }) => {
  const { errors } = await openArcade(page);
  await start(page);
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => Number(await page.locator('#score').textContent()), { timeout: 10000 }).toBeGreaterThan(0);
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowRight');
  await page.keyboard.press('p');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => page.evaluate(() => window.__arcadeLastDrawState)).toBe('paused');
  const paused = await page.evaluate(() => window.__arcadeDrawCalls);
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.__arcadeDrawCalls)).toBe(paused);
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  const score = await page.locator('#score').textContent();
  await page.reload();
  await expect(page.locator('#launch')).toBeEnabled();
  await expect(page.locator('#best')).toHaveText(score);
  await expect(page.locator('#score')).toHaveText('000000');
  expect(errors).toEqual([]);
});

test('sound preference and flight manual work without changing the run', async ({ page }) => {
  const { errors } = await openArcade(page);
  await page.locator('#sound').click();
  await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'false');
  await start(page);
  await page.locator('#help').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#manual')).toBeVisible();
  await page.locator('#launch').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(errors).toEqual([]);
});

test('reduced motion freezes the attract screen but not the playable game', async ({ page }) => {
  const { errors } = await openArcade(page, { reducedMotion: true });
  await page.waitForTimeout(80);
  const first = await page.evaluate(() => window.__arcadeDrawCalls);
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.__arcadeDrawCalls)).toBe(first);
  await start(page);
  await expect(page.locator('#wave-banner')).toBeVisible();
  expect(errors).toEqual([]);
});

test('touch controls support independent pointers and release cleanly', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch layout only.');
  const { errors } = await openArcade(page);
  await start(page);
  const stick = await page.locator('#joystick').boundingBox();
  const fire = await page.locator('#touch-fire').boundingBox();
  const shield = await page.locator('#touch-shield').boundingBox();
  await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
  await page.mouse.down();
  await page.mouse.move(stick.x + stick.width / 2 + 20, stick.y + stick.height / 2 - 25);
  await expect(page.locator('#joystick')).toHaveClass(/active/);
  await page.touchscreen.tap(fire.x + fire.width / 2, fire.y + fire.height / 2);
  await expect(page.locator('#joystick')).toHaveClass(/active/);
  await page.touchscreen.tap(shield.x + shield.width / 2, shield.y + shield.height / 2);
  await expect(page.locator('#shield-status')).toHaveText('SHIELD ACTIVE');
  await page.mouse.up();
  await expect(page.locator('#joystick')).not.toHaveClass(/active/);
  await expect(page.locator('#touch-fire')).not.toHaveClass(/active/);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test('native simultaneous multitouch can steer and hold fire, including cancellation', async ({ page, browserName, isMobile }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Native multi-contact injection requires Chromium CDP.');
  const { errors } = await openArcade(page);
  await start(page);
  const stick = await page.locator('#joystick').boundingBox();
  const fire = await page.locator('#touch-fire').boundingBox();
  const left = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 - 24, id: 1 };
  const right = { x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left, right] });
  await expect(page.locator('#joystick')).toHaveClass(/active/);
  await expect(page.locator('#touch-fire')).toHaveClass(/active/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...left, x: left.x + 12 }, right] });
  await expect(page.locator('#stick-thumb')).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('#joystick')).not.toHaveClass(/active/);
  await expect(page.locator('#touch-fire')).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('phone portrait and landscape keep the playfield and controls on screen', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone layout only.');
  const { errors } = await openArcade(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await noOverflow(page);
  await expect(page.locator('#launch')).toBeInViewport();
  await start(page);
  await expect(page.locator('#touch-fire')).toBeInViewport();
  await page.setViewportSize({ width: 844, height: 390 });
  await noOverflow(page);
  await expect(page.locator('#touch-fire')).toBeInViewport();
  await expect(page.locator('#joystick')).toBeInViewport();
  await page.locator('#help').click();
  await expect(page.locator('#launch')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('unavailable WebGL is an explicit failure, not a broken launch button', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.includes('webgl') ? null : original.call(this, type, ...args);
    };
  });
  await page.goto('/');
  await expect(page.locator('#system-status')).toHaveText('GRAPHICS UNAVAILABLE');
  await expect(page.locator('#launch')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('WebGL graphics could not start');
});

test('the console offers seven live cheats and protects the normal high score', async ({ page }) => {
  const { errors, requests } = await openArcade(page);
  await page.locator('#console').click();
  await expect(page.locator('#console-view')).toBeVisible();
  await expect(page.locator('.cheat-toggle')).toHaveCount(7);
  await expect(page.locator('.cheat-toggle').first()).toContainText('Infinite lives');
  for (const button of await page.locator('.cheat-toggle').all()) {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await page.locator('#console-close').click();
  await start(page);
  await expect(page.locator('#lives')).toHaveText('INF');
  await expect(page.locator('#sandbox-badge')).toBeVisible();
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => Number(await page.locator('#score').textContent()), { timeout: 10000 }).toBeGreaterThan(0);
  await expect.poll(() => requests.filter(url => url.includes('/arcade/events?')).length, { timeout: 6000 }).toBeGreaterThan(0);
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowRight');
  await expect(page.locator('#best')).toHaveText('000000');
  const payload = new URL(requests.find(url => url.includes('/arcade/events?'))).searchParams;
  expect(payload.get('cheats')).toBe('127');
  await page.locator('#console').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  for (const button of await page.locator('.cheat-toggle').all()) {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
  await page.locator('#console-close').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await expect(page.locator('#sandbox-badge')).toBeVisible();
  await expect(page.locator('#best')).toHaveText('000000');
  expect(errors).toEqual([]);
});

test('idle visits and synthetic controls do not emit gameplay, but sustained trusted play does', async ({ page }) => {
  const { errors, requests } = await openArcade(page);
  expect(requests.some(url => url.includes('/arcade/events?'))).toBe(false);
  await start(page);
  await page.evaluate(() => {
    dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
  });
  await page.waitForTimeout(2300);
  expect(requests.some(url => url.includes('/arcade/events?'))).toBe(false);
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowRight');
  const response = await page.waitForResponse(response => response.url().includes('/arcade/events?'), { timeout: 6000 });
  expect(response.status()).toBe(204);
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowRight');
  const payload = new URL(response.url()).searchParams;
  expect(payload.get('event')).toBe('start');
  expect(Number(payload.get('active_ms'))).toBeGreaterThanOrEqual(2000);
  expect(payload.get('controls')).toBe('keyboard');
  expect(payload.get('cheats')).toBe('0');
  await page.keyboard.press('p');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  expect(errors).toEqual([]);
});

test('native Web Audio plays real sources when available and otherwise reports its absence', async ({ page }) => {
  const { errors } = await openArcade(page);
  const supported = await page.evaluate(() => Boolean(window.AudioContext || window.webkitAudioContext));
  await start(page);
  if (!supported) {
    await expect(page.locator('#notice')).toContainText('Sound could not start');
    await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
    return;
  }
  await expect.poll(() => page.evaluate(() => window.__arcadeAudio.contexts.some(context => context.state === 'running'))).toBe(true);
  const launchNotes = await page.evaluate(() => window.__arcadeAudio.starts);
  expect(launchNotes).toBeGreaterThanOrEqual(4);
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => window.__arcadeAudio.starts)).toBeGreaterThan(launchNotes + 2);
  await page.keyboard.up('Space');
  await page.locator('#sound').click();
  await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'false');
  const muted = await page.evaluate(() => window.__arcadeAudio.starts);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => window.__arcadeAudio.starts)).toBe(muted);
  expect(errors).toEqual([]);
});

test('firing haptics are connected and can be disabled when the browser supports them', async ({ page }) => {
  const { errors } = await openArcade(page, { mockHaptics: true });
  await start(page);
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => window.__arcadePulses.filter(pulse => pulse.pattern === 8).length)).toBeGreaterThan(0);
  await page.keyboard.up('Space');
  await page.locator('#console').click();
  await page.locator('#haptics-toggle').click();
  await expect(page.locator('#haptics-label')).toHaveText('OFF');
  await page.locator('#console-close').click();
  const before = await page.evaluate(() => window.__arcadePulses.filter(pulse => pulse.pattern === 8).length);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => window.__arcadePulses.filter(pulse => pulse.pattern === 8).length)).toBe(before);
  expect(errors).toEqual([]);
});

test('iPhone WebKit honestly reports that website vibration is unavailable', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'Native Safari capability check.');
  const { errors } = await openArcade(page);
  await page.locator('#console').click();
  await expect(page.locator('#haptics-toggle')).toBeDisabled();
  await expect(page.locator('#haptics-label')).toHaveText('UNAVAILABLE');
  await expect(page.locator('#haptics-help')).toContainText('iPhone Safari');
  expect(errors).toEqual([]);
});

test('the cheat console remains scrollable and reachable on small phones and in landscape', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone console layout.');
  const { errors } = await openArcade(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('#console').click();
  await noOverflow(page);
  await expect(page.locator('#playfield')).toHaveCSS('touch-action', 'pan-y');
  await page.locator('#cheat-homingShots').scrollIntoViewIfNeeded();
  await expect(page.locator('#cheat-homingShots')).toBeInViewport();
  await expect(page.locator('#console-close')).toBeInViewport();
  await page.setViewportSize({ width: 844, height: 390 });
  await noOverflow(page);
  await page.locator('#cheat-infiniteLives').scrollIntoViewIfNeeded();
  await expect(page.locator('#cheat-infiniteLives')).toBeInViewport();
  await expect(page.locator('#console-close')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('touch launch avoids focus jumps and cancels Safari gesture and selection defaults', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch interaction guards.');
  const { errors } = await openArcade(page);
  await page.locator('#launch').tap();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(await page.evaluate(() => document.activeElement.id)).not.toBe('game');
  const results = await page.evaluate(() => {
    const fire = document.getElementById('touch-fire');
    const score = document.getElementById('score');
    const outcomes = {};
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'touchend']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      fire.dispatchEvent(event);
      outcomes[type] = event.defaultPrevented;
    }
    for (const type of ['selectstart', 'dragstart', 'contextmenu']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      score.dispatchEvent(event);
      outcomes[type] = event.defaultPrevented;
    }
    const range = document.createRange();
    range.selectNodeContents(score);
    getSelection().addRange(range);
    return outcomes;
  });
  expect(Object.values(results).every(Boolean)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const selection = getSelection();
    return { collapsed: selection.isCollapsed, text: selection.toString() };
  })).toEqual({ collapsed: true, text: '' });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  for (const selector of ['#score', '.label', '.touch-label', '#touch-fire span', '.brand']) {
    expect(await page.locator(selector).first().evaluate(node => getComputedStyle(node).userSelect)).toBe('none');
  }
  await page.locator('#touch-fire').tap();
  await page.locator('#touch-fire').tap();
  await page.locator('#pause').tap();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await page.locator('#launch').tap();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  expect(await page.evaluate(() => document.activeElement.id)).not.toBe('game');
  await page.keyboard.press('p');
  await expect(page.locator('#launch')).toBeFocused();
  expect(errors).toEqual([]);
});

test('native two-thumb pinches and long presses cannot zoom, pan, select, or drop held controls', async ({ page, browserName, isMobile }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Native multi-contact injection requires CDP.');
  const { errors } = await openArcade(page);
  await page.locator('#launch').tap();
  const stick = await page.locator('#joystick').boundingBox();
  const fire = await page.locator('#touch-fire').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const left = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 - 15, id: 1 };
  const right = { x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left, right] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ ...left, x: left.x - i * 2 }, { ...right, x: right.x + i * 2 }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(750);
  await expect(page.locator('#joystick')).toHaveClass(/active/);
  await expect(page.locator('#touch-fire')).toHaveClass(/active/);
  expect(await page.locator('#joystick').boundingBox()).toEqual(stick);
  expect(await page.locator('#touch-fire').boundingBox()).toEqual(fire);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const score = await page.locator('#score').boundingBox();
  const label = { x: score.x + score.width / 2, y: score.y + score.height / 2, id: 3 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [right] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [right, label] });
  await page.waitForTimeout(800);
  await expect(page.locator('#touch-fire')).toHaveClass(/active/);
  const geometry = await page.evaluate(() => ({
    scale: visualViewport.scale, x: scrollX, y: scrollY, selected: getSelection().toString(),
  }));
  expect(geometry).toEqual({ scale: 1, x: 0, y: 0, selected: '' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('#touch-fire')).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('browser-chrome-only height changes leave the stable cabinet and held input unchanged', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Stable mobile viewport layout.');
  const { errors } = await openArcade(page);
  await page.setViewportSize({ width: 390, height: 820 });
  await page.locator('.cabinet').evaluate(node => { node.style.height = '500px'; });
  await start(page);
  const fire = await page.locator('#touch-fire').boundingBox();
  const stick = await page.locator('#joystick').boundingBox();
  const hud = await page.locator('.hud').boundingBox();
  await expect(page.locator('#notice')).toHaveCSS('pointer-events', 'none');
  expect(await page.locator('#touch-fire').evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  await page.mouse.move(fire.x + fire.width / 2, fire.y + fire.height / 2);
  await page.mouse.down();
  await expect(page.locator('#touch-fire')).toHaveClass(/active/);
  await page.setViewportSize({ width: 390, height: 540 });
  await page.evaluate(() => {
    dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('resize'));
  });
  expect(await page.locator('#touch-fire').boundingBox()).toEqual(fire);
  expect(await page.locator('#joystick').boundingBox()).toEqual(stick);
  expect(await page.locator('.hud').boundingBox()).toEqual(hud);
  await expect(page.locator('#touch-fire')).toHaveClass(/active/);
  await page.mouse.up();
  expect(errors).toEqual([]);
});

test('the paused console still accepts native one-finger scrolling without moving the page', async ({ page, browserName, isMobile }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Native touch scrolling requires CDP.');
  const { errors } = await openArcade(page);
  await page.locator('#launch').tap();
  await page.locator('#console').tap();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  expect(await page.locator('#cheat-list').evaluate(node => {
    const event = new Event('touchmove', { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
  const box = await page.locator('#cheat-list').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width * 0.6, y: box.y + box.height - 8, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - (box.height - 18) * i / 8 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.locator('#cheat-list').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY, text: getSelection().toString() }))).toEqual({ x: 0, y: 0, text: '' });
  expect(errors).toEqual([]);
});

test('short Safari-sized viewports keep launch, both thumbs, and console controls visible', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Small usable iPhone viewport sizes.');
  const { errors } = await openArcade(page);
  await page.setViewportSize({ width: 320, height: 480 });
  await noOverflow(page);
  await expect(page.locator('#launch')).toBeInViewport();
  await page.locator('#launch').tap();
  await expect(page.locator('#joystick')).toBeInViewport();
  await expect(page.locator('#touch-fire')).toBeInViewport();
  await page.setViewportSize({ width: 844, height: 244 });
  await noOverflow(page);
  await expect(page.locator('#joystick')).toBeInViewport();
  await expect(page.locator('#touch-fire')).toBeInViewport();
  await page.locator('#console').tap();
  await expect(page.locator('#console-close')).toBeInViewport();
  await page.locator('#cheat-infiniteLives').scrollIntoViewIfNeeded();
  await expect(page.locator('#cheat-infiniteLives')).toBeInViewport();
  expect(errors).toEqual([]);
});

async function connectVirtualPad(page) {
  await page.evaluate(() => {
    window.__virtualPad = {
      index: 0, id: 'Virtual Standard Controller - not telemetry', mapping: 'standard', connected: true,
      axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
    };
  });
  await expect(page.locator('#system-status')).toHaveText('CONTROLLER READY');
}

async function padButton(page, index, pressed) {
  await page.evaluate(({ index, pressed }) => {
    window.__virtualPad.buttons[index] = { value: Number(pressed), pressed };
  }, { index, pressed });
  await page.waitForTimeout(50);
}

test('the small FPS counter measures drawing, pauses cleanly, and fits mobile chrome', async ({ page, isMobile }) => {
  const { errors } = await openArcade(page, { virtualGamepad: true });
  if (isMobile) await page.setViewportSize({ width: 320, height: 568 });
  await connectVirtualPad(page);
  await start(page);
  await expect(page.locator('.fps-meter')).toBeVisible();
  await expect.poll(async () => Number(await page.locator('#fps').textContent()), { timeout: 4000 }).toBeGreaterThan(0);
  expect(Number(await page.locator('#fps').textContent())).toBeLessThanOrEqual(66);
  await noOverflow(page);
  if (isMobile) {
    const fps = await page.locator('.fps-meter').boundingBox();
    const lives = await page.locator('#lives').boundingBox();
    const console = await page.locator('#console').boundingBox();
    expect(lives.x + lives.width).toBeLessThanOrEqual(fps.x);
    expect(fps.x + fps.width).toBeLessThanOrEqual(console.x);
  }
  await page.keyboard.press('p');
  await expect(page.locator('#fps')).toHaveText('--');
  expect(errors).toEqual([]);
});

test('a detected standard controller launches, flies, shields, pauses and disconnects safely', async ({ page }) => {
  const { errors, requests } = await openArcade(page, { virtualGamepad: true });
  await connectVirtualPad(page);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready');
  await padButton(page, 0, true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await page.waitForTimeout(2100);
  expect(requests.some(url => url.includes('/arcade/events?'))).toBe(false);
  await padButton(page, 0, false);
  const qualified = page.waitForResponse(response => response.url().includes('/arcade/events?'), { timeout: 6000 });
  await page.evaluate(() => {
    window.__virtualPad.axes = [0, -0.8];
    window.__virtualPad.buttons[7] = { value: 1, pressed: true };
  });
  const response = await qualified;
  expect(response.status()).toBe(204);
  const payload = new URL(response.url()).searchParams;
  expect(payload.get('controls')).toBe('gamepad');
  expect(response.url()).not.toContain('Virtual');
  await page.evaluate(() => {
    window.__virtualPad.axes = [0, 0];
    window.__virtualPad.buttons[7] = { value: 0, pressed: false };
  });
  await padButton(page, 1, true);
  await expect(page.locator('#shield-status')).toHaveText('SHIELD ACTIVE');
  await padButton(page, 1, false);
  await padButton(page, 9, true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await page.waitForTimeout(200);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await padButton(page, 9, false);
  await padButton(page, 9, true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await padButton(page, 9, false);
  await page.evaluate(() => { window.__virtualPad = null; });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#notice')).toContainText('Controller disconnected');
  await expect(page.locator('#fps')).toHaveText('--');
  expect(errors).toEqual([]);
});

test('controller menu navigation can enable cheats and return to flight without mouse input', async ({ page }) => {
  const { errors, requests } = await openArcade(page, { virtualGamepad: true });
  await connectVirtualPad(page);
  await padButton(page, 9, true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await padButton(page, 9, false);
  await padButton(page, 8, true);
  await expect(page.locator('#console-view')).toBeVisible();
  await padButton(page, 8, false);
  await expect(page.locator('#cheat-infiniteLives')).toBeFocused();
  await padButton(page, 0, true);
  await expect(page.locator('#cheat-infiniteLives')).toHaveAttribute('aria-pressed', 'true');
  await padButton(page, 0, false);
  await padButton(page, 13, true);
  await expect(page.locator('#cheat-invincible')).toBeFocused();
  await padButton(page, 13, false);
  await padButton(page, 0, true);
  await expect(page.locator('#cheat-invincible')).toHaveAttribute('aria-pressed', 'true');
  await padButton(page, 0, false);
  await padButton(page, 1, true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await padButton(page, 1, false);
  await expect(page.locator('#lives')).toHaveText('INF');
  expect(requests.some(url => url.includes('/arcade/events?'))).toBe(false);
  expect(errors).toEqual([]);
});

for (const access of ['missing', 'blocked']) {
  test(`keyboard/touch and FPS keep working when controller access is ${access}`, async ({ page }) => {
    const { errors } = await openArcade(page, { gamepadAccess: access });
    await start(page);
    await expect.poll(async () => Number(await page.locator('#fps').textContent()), { timeout: 4000 }).toBeGreaterThan(0);
    await page.locator('#help').click();
    await expect(page.locator('#controller-help')).toContainText('Gamepad API is unavailable');
    expect(errors).toEqual([]);
  });
}

test('an idle connected controller does not hijack keyboard flight or pause it on removal', async ({ page }) => {
  const { errors } = await openArcade(page, { virtualGamepad: true });
  await connectVirtualPad(page);
  await start(page);
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => { window.__virtualPad = null; });
  await expect(page.locator('#system-status')).toHaveText('ALL SYSTEMS GO');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing');
  await expect.poll(async () => Number(await page.locator('#score').textContent()), { timeout: 8000 }).toBeGreaterThan(0);
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowRight');
  expect(errors).toEqual([]);
});
