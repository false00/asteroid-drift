import { Game, wrappedDelta } from './engine.mjs?v=20261025.2';
import { AccountError } from './identity.mjs?v=20261024.9';
import { FlightRecords, isRankedResult } from './records.mjs?v=20261024.8';
import { DEFAULT_VIEWPORT, RANKED_SCALE, arenaForViewport, isRankedArena, viewportForSize } from './arena.mjs?v=20261024.7';
import { FlightDiagnostics, DIAGNOSTIC_INTERVAL_MS } from './diagnostics.mjs?v=20261026.1';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerpWrapped = (a, b, amount, size) => ((a + wrappedDelta(b - a, size) * amount) % size + size) % size;

export class RankedClient {
  constructor({ identity, onState, onFinish, onFailure, notify, onFrame }) {
    Object.assign(this, { identity, onState, onFinish, onFailure, notify, onFrame });
    this.active = false;
    this.finished = false;
    this.socket = null;
    this.viewport = { ...DEFAULT_VIEWPORT };
    this.game = new Game(960, 640, Math.random, { resumeProtection: false, fixedScale: RANKED_SCALE });
    this.controlModes = new Set();
    this.snapshots = [];
    this.inputSequence = 0;
    this.lastInput = -Infinity;
    this.sentViewport = null;
    this.lastViewportSent = -Infinity;
    this.connectionId = null;
    this.diagnosticRunId = null;
    this.diagnostics = null;
    this.diagnosticSequence = 0;
    this.diagnosticQueue = [];
    this.diagnosticSending = false;
    this.diagnosticPending = false;
    this.diagnosticTimer = null;
    this.httpRtt = null;
    this.roundTripMs = null;
    this.roundTripAt = null;
    this.longTasksSupported = false;
    this.diagnosticStateAt = -Infinity;
    this.browser = /Firefox\//.test(navigator.userAgent) ? 'firefox' : /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent) ? 'chromium' : /AppleWebKit\//.test(navigator.userAgent) ? 'webkit' : 'other';
    const state = type => {
      if (!this.diagnostics || !this.active || this.finished) return;
      this.diagnostics.event(type);
      if (type === 'pagehide' || performance.now() - this.diagnosticStateAt >= 2000) {
        this.diagnosticStateAt = performance.now();
        this.reportDiagnostics(type === 'pagehide' ? 'pagehide' : 'state');
      } else void this.flushDiagnostics();
    };
    for (const type of ['blur', 'focus', 'offline', 'online', 'pagehide', 'pageshow']) addEventListener(type, () => state(type));
    document.addEventListener('visibilitychange', () => state(document.hidden ? 'hidden' : 'visible'));
    for (const type of ['freeze', 'resume']) document.addEventListener(type, () => state(type));
    for (const type of ['error', 'unhandledrejection']) addEventListener(type, () => {
      if (!this.diagnostics || !this.active || this.finished) return;
      this.diagnostics.count('runtime_errors');
    });
    if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
      try {
        this.longTaskObserver = new PerformanceObserver(list => {
          if (this.active && !this.finished && this.diagnostics) for (const entry of list.getEntries()) this.diagnostics.task(entry.duration);
        });
        this.longTaskObserver.observe({ type: 'longtask' });
        this.longTasksSupported = true;
      } catch { this.longTasksSupported = false; }
    }
  }

  noteControl(kind) { this.controlModes.add(kind); }

  reportDiagnostics(reason, extra = {}) {
    if (!this.connectionId || !this.diagnostics || !this.diagnosticRunId) return;
    const canvas = document.getElementById('game');
    const sample = this.diagnostics.sample({
      input_sequence: this.inputSequence, buffered_bytes: this.socket?.bufferedAmount || 0,
      http_rtt_ms: this.httpRtt, render_width: canvas?.width || 0, render_height: canvas?.height || 0,
      pixel_ratio_x100: canvas?.clientWidth ? canvas.width / canvas.clientWidth * 100 : 0,
      visible: !document.hidden, focused: document.hasFocus(), online: navigator.onLine,
      fullscreen: Boolean(document.fullscreenElement), long_tasks_supported: this.longTasksSupported,
      browser: this.browser, network: navigator.connection?.effectiveType || 'unknown',
      game_state: this.game.state, ...extra,
    });
    const report = { runId: this.diagnosticRunId, connectionId: this.connectionId, sequence: ++this.diagnosticSequence, reason, sample };
    if (this.diagnosticQueue.length >= 8) {
      const replace = this.diagnosticQueue.findIndex(entry => entry.report.reason === 'sample');
      this.diagnosticQueue.splice(Math.max(0, replace), 1);
    }
    this.diagnosticQueue.push({ report, accountId: this.accountId, until: Date.now() + 600000 });
    void this.flushDiagnostics();
  }

  async flushDiagnostics() {
    if (this.diagnosticSending) { this.diagnosticPending = true; return; }
    this.diagnosticSending = true;
    try {
      while (this.diagnosticQueue.length) {
        const entry = this.diagnosticQueue[0];
        if (entry.until <= Date.now() || this.identity.session.user?.id !== entry.accountId || !this.identity.session.csrf) {
          this.diagnosticQueue.shift();
          continue;
        }
        if (!navigator.onLine) break;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const started = performance.now();
        try {
          const response = await fetch('/api/ranked/diagnostics', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', keepalive: true, signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.identity.session.csrf }, body: JSON.stringify(entry.report),
          });
          this.httpRtt = Math.max(0, Math.round(performance.now() - started));
          if (response.status === 429 || response.status >= 500) break;
          const index = this.diagnosticQueue.indexOf(entry);
          if (index >= 0) this.diagnosticQueue.splice(index, 1);
        } catch { break; }
        finally { clearTimeout(timeout); }
      }
    } finally {
      this.diagnosticSending = false;
      if (this.diagnosticPending) {
        this.diagnosticPending = false;
        void this.flushDiagnostics();
      }
    }
  }

  setViewport(width, height) {
    try { this.viewport = viewportForSize(width, height); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new AccountError('invalid_viewport');
    }
  }

  syncViewport(now = performance.now(), immediate = false) {
    if (!this.active || this.finished || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.sentViewport?.width === this.viewport.width && this.sentViewport?.height === this.viewport.height) return;
    if (!immediate && now - this.lastViewportSent < 250) return;
    this.socket.send(JSON.stringify({ type: 'viewport', viewport: this.viewport }));
    this.sentViewport = { ...this.viewport };
    this.lastViewportSent = now;
  }

  async start({ restart = false } = {}) {
    this.runId = null;
    this.accountId = this.identity.session.user.id;
    this.active = true;
    this.finished = false;
    this.result = null;
    this.records = null;
    this.snapshots = [];
    this.controlModes.clear();
    const arena = arenaForViewport(this.viewport.width, this.viewport.height);
    this.game = new Game(arena.width, arena.height, Math.random, { resumeProtection: false, fixedScale: RANKED_SCALE });
    this.game.state = 'paused';
    const [session, entries] = await Promise.all([this.identity.request('/api/session'), this.identity.readScores()]);
    if (!session.authenticated || session.user.id !== this.accountId) throw new AccountError('authentication_required');
    this.identity.setSession(session);
    this.records = new FlightRecords({ best: session.user.personalBest, username: session.user.username, entries });
    const { run: existing } = await this.identity.request('/api/ranked/current');
    const { run } = restart ? await this.identity.request('/api/ranked/restart', { runId: existing?.id ?? null, viewport: this.viewport })
      : existing ? { run: existing } : await this.identity.request('/api/ranked/start', { viewport: this.viewport });
    this.runId = run.id;
    await this.connect();
    this.action('resume');
  }

  async connect() {
    if (this.diagnosticRunId === this.runId) this.reportDiagnostics('retry');
    clearInterval(this.diagnosticTimer);
    this.connectionId = null;
    this.diagnosticRunId = this.runId;
    this.roundTripMs = null;
    this.roundTripAt = null;
    this.diagnosticSequence = 0;
    this.diagnostics = new FlightDiagnostics();
    const { ticket } = await this.identity.request('/api/ranked/ticket', { runId: this.runId });
    const url = new URL('/api/ranked/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const old = this.socket;
    this.socket = socket;
    old?.close();
    this.inputSequence = 0;
    this.sentViewport = null;
    this.lastViewportSent = -Infinity;
    await new Promise((resolve, reject) => {
      let attached = false;
      let invalidResponse = false;
      const timeout = setTimeout(() => { socket.close(); reject(new AccountError('connection_lost')); }, 10000);
      socket.addEventListener('open', () => {
        if (socket !== this.socket) return;
        socket.send(JSON.stringify({ type: 'attach', ticket, runId: this.runId, viewport: this.viewport }));
        this.sentViewport = { ...this.viewport };
        this.lastViewportSent = performance.now();
      });
      socket.addEventListener('message', event => {
        if (socket !== this.socket || this.finished) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('Invalid ranked response.');
          const message = JSON.parse(event.data);
          if (message.type === 'attached') {
            attached = true;
            if (typeof message.connectionId === 'string' && /^[a-f0-9-]{36}$/.test(message.connectionId)) {
              this.connectionId = message.connectionId;
              this.reportDiagnostics('state');
              this.diagnosticTimer = setInterval(() => this.reportDiagnostics('sample'), DIAGNOSTIC_INTERVAL_MS);
            }
            clearTimeout(timeout);
            resolve();
          } else if (message.type === 'latency') {
            if (!Number.isSafeInteger(message.milliseconds) || message.milliseconds < 0 || message.milliseconds > 600000) throw new Error('Invalid ranked latency.');
            this.roundTripMs = message.milliseconds;
            this.roundTripAt = performance.now();
            this.onFrame();
          } else if (message.type === 'snapshot') this.receive(message);
          else if (message.type === 'finished') {
            if (!isRankedResult(message.result)) throw new Error('Invalid ranked result.');
            if (this.finished) return;
            this.finished = true;
            clearInterval(this.diagnosticTimer);
            this.result = message.result;
            this.snapshots = [];
            this.game.score = message.result.score;
            this.game.wave = message.result.wave;
            this.game.state = 'gameover';
            this.onFinish(message.result);
          } else if (message.type === 'paused') {
            this.game.state = 'paused';
            this.onState('paused');
            if (message.reason !== 'player') this.notify(`Ranked flight paused (${message.reason.replaceAll('_', ' ')}). Reconnect or resume within ten minutes.`);
          } else if (message.type === 'unavailable') {
            this.game.state = 'paused';
            this.onState('paused');
            this.onFailure(new AccountError('ranked_unavailable'));
          }
        } catch {
          console.error('The ranked server returned an invalid response; flight was stopped.');
          this.diagnostics.count('response_errors');
          this.diagnostics.event('invalid_response');
          this.reportDiagnostics('error');
          invalidResponse = true;
          socket.close(4002, 'Invalid ranked response');
          this.game.state = 'paused';
          this.onState('paused');
          this.onFailure(new AccountError('invalid_ranked_response'));
        }
      });
      socket.addEventListener('close', event => {
        clearTimeout(timeout);
        if (socket === this.socket) this.reportDiagnostics('close', { close_code: event.code, close_clean: event.wasClean });
        const failure = event.code === 4001 ? 'authentication_required' : event.code === 4010 ? 'ranked_unavailable'
          : event.code === 4000 ? 'run_not_active' : event.code === 4003 ? 'connected_elsewhere'
          : event.code === 4004 ? 'slow_connection' : 'connection_lost';
        if (!attached) {
          reject(new AccountError(failure));
          return;
        }
        if (socket !== this.socket || !this.active || this.finished) return;
        this.game.state = 'paused';
        this.onState('paused');
        if (!invalidResponse) this.onFailure(new AccountError(failure));
      });
      socket.addEventListener('error', () => {
        if (socket === this.socket) {
          this.diagnostics.count('socket_errors');
          this.diagnostics.event('socket_error');
          this.reportDiagnostics('error');
        }
        console.warn('The ranked websocket could not connect; casual flight remains available.');
      });
    });
  }

  receive(message) {
    const world = message.game;
    if (!world || !isRankedArena(world.width, world.height) || !Number.isFinite(world.scale) || Math.abs(world.scale - RANKED_SCALE) > 0.0000001 || !['playing', 'paused', 'gameover'].includes(world.state) || !Number.isSafeInteger(world.score) || world.score < 0 || !world.ship || !Number.isFinite(world.ship.x) || !Number.isFinite(world.ship.y) || !Array.isArray(message.events) || message.events.length > 128) throw new Error('Invalid authoritative state.');
    for (const field of ['asteroids', 'bullets', 'pickups']) if (!Array.isArray(world[field]) || world[field].length > 128) throw new Error('Invalid authoritative entities.');
    this.diagnostics?.snapshot(this.inputSequence, message.sequence);
    const previousState = this.game.state;
    if (this.game.width !== world.width || this.game.height !== world.height) {
      this.game.resize(world.width, world.height);
      this.snapshots = [];
    }
    this.snapshots.push({ world, at: performance.now(), tick: message.tick });
    if (this.snapshots.length > 2) this.snapshots.shift();
    Object.assign(this.game, world, {
      ship: { ...world.ship }, asteroids: world.asteroids.map(item => ({ ...item })),
      bullets: world.bullets.map(item => ({ ...item })), pickups: world.pickups.map(item => ({ ...item })),
      fixedScale: RANKED_SCALE,
    });
    this.game.events.push(...message.events);
    if (this.game.events.length > 128) this.game.events.splice(0, this.game.events.length - 128);
    if (this.game.state !== previousState) this.onState(this.game.state);
    this.onFrame();
  }

  advance(now, dt, input) {
    this.diagnostics?.frame(now, this.game.state === 'playing' && !document.hidden);
    this.game.updateEffects(dt);
    this.syncViewport(now);
    const newest = this.snapshots.at(-1);
    const previous = this.snapshots.at(-2);
    if (newest && previous) {
      const interval = Math.max(1, (newest.tick - previous.tick) / 120 * 1000);
      const amount = clamp((now - newest.at) / interval, 0, 1);
      const interpolate = (visual, old, next) => {
        if (!old || !next) return;
        visual.x = lerpWrapped(old.x, next.x, amount, newest.world.width);
        visual.y = lerpWrapped(old.y, next.y, amount, newest.world.height);
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
    this.diagnostics?.input(now);
  }

  action(type, reason = 'player') {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new AccountError('connection_lost');
    if (type === 'resume') this.syncViewport(performance.now(), true);
    this.socket.send(JSON.stringify(type === 'pause' ? { type, reason } : { type }));
  }

  async resume() {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
    this.action('resume');
  }

  leave() {
    this.reportDiagnostics('state');
    clearInterval(this.diagnosticTimer);
    this.active = false;
    this.socket?.close();
    this.socket = null;
    this.snapshots = [];
    this.runId = null;
    this.sentViewport = null;
    this.records = null;
  }
}
