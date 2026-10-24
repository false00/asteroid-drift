import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../server.mjs';

const { chromium, expect } = createRequire(new URL('../../web/package.json', import.meta.url))('@playwright/test');
const directory = await mkdtemp(join(tmpdir(), 'asteroid-drift-browser-'));
const masterKey = randomBytes(32);
const config = {
  test: true, origin: 'http://localhost:4191', rpID: 'localhost',
  trustedProxy: '127.0.0.1', listenAddress: '127.0.0.1', masterKey,
  databasePath: join(directory, 'game.sqlite'),
};
let service;
let browser;
let timer;
try {
  service = await buildApp(config);
  await service.app.listen({ host: '127.0.0.1', port: 4191 });
  assert.equal((await fetch('http://127.0.0.1:4191/health')).status, 200);
  timer = setInterval(() => service.runs.tick(), 1000 / 120);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.22' } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(config.origin);
  await expect(page.locator('#launch')).toBeEnabled();
  await page.locator('#account').click();
  await page.locator('#username').fill('Verified_Pilot');
  await page.locator('#register-form button').click();
  await expect(page.locator('#pilot-name')).toHaveText('Verified_Pilot', { timeout: 15000 });
  assert.equal((await context.cookies()).filter(cookie => cookie.name === '__Host-curlred_session').length, 1);
  await page.locator('#identity-close').click();
  await page.locator('#ranked').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'playing', { timeout: 10000 });
  const run = [...service.runs.runs.values()][0];
  assert.ok(run);
  const rock = run.game.makeRock(1, run.game.ship.x, run.game.ship.y - 100);
  Object.assign(rock, { vx: 0, vy: 0 });
  run.game.asteroids = [rock];
  run.game.ship.invulnerable = 100;
  await page.keyboard.down('Space');
  await expect.poll(() => run.game.score, { timeout: 10000 }).toBeGreaterThan(0);
  await delay(2200);
  await page.keyboard.up('Space');
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  assert.equal(run.game.width, 960);
  assert.equal(run.game.height, 640);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await page.evaluate(() => localStorage.setItem('curlred.asteroid-drift.best', '9999999999'));
  const forged = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return (await fetch('/api/ranked/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
      body: JSON.stringify({ score: 9999999999, cheats: 127 }),
    })).status;
  });
  assert.equal(forged, 400);
  await page.locator('#pause').click();
  await expect.poll(() => run.game.state).toBe('paused');
  const score = run.game.score;
  assert.ok(score > 0 && score < 9999999999);
  await page.locator('#console').click();
  await expect(page.locator('#cheat-infiniteLives')).toBeDisabled();
  await page.locator('#console-close').click();
  await page.locator('#finish-ranked').click();
  await expect(page.locator('#result-eyebrow')).toHaveText('SERVER VERIFIED FLIGHT');
  assert.equal(service.store.leaderboard()[0].score, score);
  assert.equal(service.store.leaderboard()[0].username, 'Verified_Pilot');
  clearInterval(timer);
  timer = null;
  await service.app.close();
  service = await buildApp(config);
  await service.app.listen({ host: '127.0.0.1', port: 4191 });
  await page.reload();
  await expect(page.locator('#account')).toHaveText('Verified_Pilot');
  await page.locator('#account').click();
  await expect(page.locator('#leaderboard-list')).toContainText(String(score));
  await page.locator('#signout').click();
  await expect(page.locator('#signed-out')).toBeVisible();
  await page.locator('#signin').click();
  await expect(page.locator('#pilot-name')).toHaveText('Verified_Pilot');
  await page.locator('#signed-in details summary').click();
  await page.locator('#delete-confirmation').fill('Verified_Pilot');
  await page.locator('#delete-form button').click();
  await expect(page.locator('#signed-out')).toBeVisible();
  assert.equal(service.store.leaderboard().length, 0);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
  assert.ok(service.store.export(0, 100).some(event => event.payload.event_action === 'account.deleted'));
  const bytes = await readFile(config.databasePath);
  assert.equal(bytes.includes(Buffer.from('Verified_Pilot')), false);
  assert.deepEqual(errors.filter(message => !message.includes('400 (Bad Request)')), []);
  console.info('Verified real-browser resident passkeys, ranked flight, canonical fullscreen arena, forged-score rejection, atomic persistence across restart, safe records, sign-in and fresh-passkey deletion.');
} finally {
  clearInterval(timer);
  await browser?.close();
  await service?.app.close();
  await rm(directory, { recursive: true });
}
