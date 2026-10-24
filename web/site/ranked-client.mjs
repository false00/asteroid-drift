import { Game, wrappedDelta } from './engine.mjs?v=20261024.5';
import { AccountError } from './identity.mjs?v=20261024.5';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerpWrapped = (a, b, amount, size) => ((a + wrappedDelta(b - a, size) * amount) % size + size) % size;

export class RankedClient {
  constructor({ identity, onState, onFinish, notify, onFrame }) {
    Object.assign(this, { identity, onState, onFinish, notify, onFrame });
    this.active = false;
    this.finished = false;
    this.socket = null;
    this.game = new Game(960, 640, Math.random, { resumeProtection: false });
    this.controlModes = new Set();
    this.snapshots = [];
    this.inputSequence = 0;
    this.lastInput = -Infinity;
  }

  noteControl(kind) { this.controlModes.add(kind); }

  async start() {
    this.runId = null;
    this.accountId = this.identity.session.user.id;
    this.active = true;
    this.finished = false;
    this.snapshots = [];
    this.controlModes.clear();
    this.game = new Game(960, 640, Math.random, { resumeProtection: false });
    this.game.state = 'paused';
    const { run: existing } = await this.identity.request('/api/ranked/current');
    const { run } = existing ? { run: existing } : await this.identity.request('/api/ranked/start', {});
    this.runId = run.id;
    await this.connect();
    this.action('resume');
  }

  async connect() {
    const { ticket } = await this.identity.request('/api/ranked/ticket', { runId: this.runId });
    const url = new URL('/api/ranked/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const old = this.socket;
    this.socket = socket;
    old?.close();
    this.inputSequence = 0;
    await new Promise((resolve, reject) => {
      let attached = false;
      const timeout = setTimeout(() => { socket.close(); reject(new AccountError('connection_lost')); }, 10000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'attach', ticket, runId: this.runId })));
      socket.addEventListener('message', event => {
        if (socket !== this.socket) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('Invalid ranked response.');
          const message = JSON.parse(event.data);
          if (message.type === 'attached') {
            attached = true;
            clearTimeout(timeout);
            resolve();
          } else if (message.type === 'snapshot') this.receive(message);
          else if (message.type === 'finished') {
            if (!Number.isSafeInteger(message.result?.score) || message.result.score < 0) throw new Error('Invalid ranked result.');
            this.finished = true;
            this.game.state = 'gameover';
            this.onFinish(message.result);
          } else if (message.type === 'paused') {
            this.game.state = 'paused';
            this.onState('paused');
            if (message.reason !== 'player') this.notify(`Ranked flight paused (${message.reason.replaceAll('_', ' ')}). Reconnect or resume within ten minutes.`);
          } else if (message.type === 'unavailable') {
            this.game.state = 'paused';
            this.onState('paused');
            this.notify('Ranked flight is unavailable. No unverified score is reported as saved.');
          }
        } catch {
          console.error('The ranked server returned an invalid response; flight was stopped.');
          socket.close(4002, 'Invalid ranked response');
          this.game.state = 'paused';
          this.onState('paused');
          this.notify('The ranked response could not be verified. Please reload before retrying.');
        }
      });
      socket.addEventListener('close', event => {
        clearTimeout(timeout);
        if (!attached) reject(new AccountError(event.code === 4001 ? 'authentication_required' : 'connection_lost'));
        if (socket !== this.socket || !this.active || this.finished) return;
        this.game.state = 'paused';
        this.onState('paused');
        this.notify(event.code === 4001 ? 'Sign in again with your passkey, then resume this ranked flight within ten minutes.' : 'Ranked connection lost. Use Back to flight to reconnect within ten minutes.');
      });
      socket.addEventListener('error', () => {
        console.warn('The ranked websocket could not connect; casual flight remains available.');
      });
    });
  }

  receive(message) {
    const world = message.game;
    if (!world || world.width !== 960 || world.height !== 640 || !['playing', 'paused', 'gameover'].includes(world.state) || !Number.isSafeInteger(world.score) || world.score < 0 || !world.ship || !Number.isFinite(world.ship.x) || !Number.isFinite(world.ship.y) || !Array.isArray(message.events) || message.events.length > 128) throw new Error('Invalid authoritative state.');
    for (const field of ['asteroids', 'bullets', 'pickups']) if (!Array.isArray(world[field]) || world[field].length > 128) throw new Error('Invalid authoritative entities.');
    const previousState = this.game.state;
    this.snapshots.push({ world, at: performance.now(), tick: message.tick });
    if (this.snapshots.length > 2) this.snapshots.shift();
    Object.assign(this.game, world, {
      ship: { ...world.ship }, asteroids: world.asteroids.map(item => ({ ...item })),
      bullets: world.bullets.map(item => ({ ...item })), pickups: world.pickups.map(item => ({ ...item })),
    });
    this.game.events.push(...message.events);
    if (this.game.events.length > 128) this.game.events.splice(0, this.game.events.length - 128);
    if (this.game.state !== previousState) this.onState(this.game.state);
    this.onFrame();
  }

  advance(now, dt, input) {
    this.game.updateEffects(dt);
    const newest = this.snapshots.at(-1);
    const previous = this.snapshots.at(-2);
    if (newest && previous) {
      const interval = Math.max(1, (newest.tick - previous.tick) / 120 * 1000);
      const amount = clamp((now - newest.at) / interval, 0, 1);
      const interpolate = (visual, old, next) => {
        if (!old || !next) return;
        visual.x = lerpWrapped(old.x, next.x, amount, 960);
        visual.y = lerpWrapped(old.y, next.y, amount, 640);
        if (Number.isFinite(next.angle) && Number.isFinite(old.angle)) visual.angle = old.angle + wrappedDelta(next.angle - old.angle, TAU) * amount;
      };
      interpolate(this.game.ship, previous.world.ship, newest.world.ship);
      for (const field of ['asteroids', 'bullets', 'pickups']) {
        const older = new Map(previous.world[field].map(item => [item.id, item]));
        const latest = new Map(newest.world[field].map(item => [item.id, item]));
        for (const item of this.game[field]) interpolate(item, older.get(item.id), latest.get(item.id));
      }
    }
    if (this.game.state !== 'playing' || this.socket?.readyState !== WebSocket.OPEN || now - this.lastInput < 1000 / 30) return;
    this.lastInput = now;
    this.socket.send(JSON.stringify({
      type: 'input', seq: ++this.inputSequence,
      keys: (input.left ? 1 : 0) | (input.right ? 2 : 0) | (input.fire ? 4 : 0) | (input.shield ? 8 : 0) | (input.brake ? 16 : 0),
      thrust: Math.round(clamp(input.thrust, 0, 1) * 255),
      aim: Number.isFinite(input.aim) ? Math.round(((input.aim + Math.PI) % TAU + TAU) % TAU / TAU * 65535) : null,
      controls: this.controlModes.size > 1 ? 'mixed' : [...this.controlModes][0] || 'keyboard',
    }));
  }

  action(type) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new AccountError('connection_lost');
    this.socket.send(JSON.stringify({ type }));
  }

  async resume() {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
    this.action('resume');
  }

  leave() {
    this.active = false;
    this.socket?.close();
    this.socket = null;
    this.snapshots = [];
    this.runId = null;
  }
}
