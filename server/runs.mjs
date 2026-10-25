import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Game } from '../web/site/engine.mjs';
import { DEFAULT_VIEWPORT, RANKED_SCALE, arenaForViewport, isRankedArena } from '../web/site/arena.mjs';
import { ApiError, Budget, base64url, digest, equal, integer, object, token } from './validation.mjs';

export const ARENA = Object.freeze({ width: 960, height: 640, hz: 120 });
export const LEASE_MS = 10 * 60 * 1000;
const EMPTY_INPUT = Object.freeze({ left: false, right: false, thrust: 0, brake: false, fire: false, shield: false, aim: null });
const random = () => randomBytes(4).readUInt32BE() / 4294967296;
const visibleFields = ['state', 'width', 'height', 'scale', 'score', 'lives', 'wave', 'elapsed', 'combo', 'comboTime', 'shieldTime', 'shieldCooldown', 'tripleTime', 'waveBanner', 'waveDelay', 'ship', 'asteroids', 'bullets', 'pickups', 'stats'];
const gameState = game => Object.fromEntries(visibleFields.map(key => [key, game[key]]));

export function viewportArena(value) {
  object(value, ['width', 'height']);
  try { return arenaForViewport(value.width, value.height); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ApiError(400, 'invalid_viewport');
  }
}

export function controls(message) {
  object(message, ['type', 'seq', 'keys', 'thrust', 'aim', 'controls']);
  if (message.type !== 'input' || !['keyboard', 'touch', 'gamepad', 'mixed'].includes(message.controls)) throw new ApiError(400, 'invalid_input');
  integer(message.seq, 1, Number.MAX_SAFE_INTEGER);
  integer(message.keys, 0, 31);
  integer(message.thrust, 0, 255);
  if (message.aim !== null) integer(message.aim, 0, 65535);
  return {
    left: Boolean(message.keys & 1), right: Boolean(message.keys & 2),
    fire: Boolean(message.keys & 4), shield: Boolean(message.keys & 8), brake: Boolean(message.keys & 16),
    thrust: message.thrust / 255, aim: message.aim === null ? null : message.aim / 65535 * Math.PI * 2 - Math.PI,
  };
}

class Run {
  constructor(accountId, ip, now, arena = ARENA) {
    this.id = randomUUID();
    this.accountId = accountId;
    this.ip = ip;
    this.game = new Game(arena.width, arena.height, random, { effects: false, resumeProtection: false, fixedScale: RANKED_SCALE });
    this.game.start();
    this.game.pause();
    this.socket = null;
    this.input = EMPTY_INPUT;
    this.inputAt = now;
    this.actionAt = now;
    this.leaseAt = now;
    this.summaryAt = now;
    this.checkpointAt = now;
    this.sessionAt = now;
    this.snapshotAt = 0;
    this.sequence = 0;
    this.ticks = 0;
    this.activeMs = 0;
    this.controlledMs = 0;
    this.mode = 'keyboard';
    this.finished = false;
    this.events = [];
    this.viewportChanges = 0;
  }

  checkpoint() {
    return { rules: 'ranked-v1', game: this.game, ticks: this.ticks, activeMs: this.activeMs, controlledMs: this.controlledMs, ip: this.ip, mode: this.mode, viewportChanges: this.viewportChanges, leaseAt: this.game.state === 'paused' ? this.leaseAt : null };
  }

  summary() {
    return {
      run_id: this.id, score: this.game.score, wave: this.game.wave, lives: this.game.lives,
      duration_ms: Math.floor(this.game.elapsed * 1000), controlled_ms: Math.floor(this.controlledMs),
      ticks: this.ticks, input_sequence: this.sequence, controls: this.mode,
      arena_width: Math.round(this.game.width), arena_height: Math.round(this.game.height), viewport_changes: this.viewportChanges,
      ...this.game.stats, server_authoritative: true,
    };
  }
}

export class Runs {
  constructor(store, { now = Date.now, monotonic = () => performance.now(), onStorageFailure = () => {} } = {}) {
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.onStorageFailure = onStorageFailure;
    this.runs = new Map();
    this.tickets = new Map();
    this.budget = new Budget({ maximum: 256, now });
    this.previous = monotonic();
    this.accumulator = 0;
    this.available = true;
    for (const saved of store.recover()) {
      const account = store.account(saved.accountId);
      if (!account) continue;
      const leaseAt = saved.state.game?.state === 'paused' ? saved.state.leaseAt ?? saved.updatedAt : saved.updatedAt;
      if (!Number.isSafeInteger(leaseAt) || leaseAt < 0) throw new Error('A ranked checkpoint has an invalid lease.');
      if (leaseAt + LEASE_MS <= now()) {
        store.atomic(() => {
          store.audit('ranked.expired', account, saved.state.ip, { run_id: saved.id, reason: 'restart_lease_expired' });
          store.db.prepare('DELETE FROM runs WHERE id=?').run(saved.id);
        });
        continue;
      }
      if (saved.state.rules !== 'ranked-v1') throw new Error('A ranked checkpoint uses unsupported rules.');
      if (!isRankedArena(saved.state.game?.width, saved.state.game?.height)) throw new Error('A ranked checkpoint has invalid arena dimensions.');
      const viewportChanges = saved.state.viewportChanges ?? 0;
      if (!Number.isSafeInteger(viewportChanges) || viewportChanges < 0) throw new Error('A ranked checkpoint has an invalid viewport counter.');
      const run = new Run(saved.accountId, saved.state.ip, now());
      run.id = saved.id;
      Object.assign(run.game, saved.state.game);
      run.game.random = random;
      run.game.effects = false;
      run.game.resumeProtection = false;
      run.game.fixedScale = run.game.scale = RANKED_SCALE;
      run.game.pause();
      run.game.events = [];
      run.ticks = saved.state.ticks;
      run.activeMs = saved.state.activeMs;
      run.controlledMs = saved.state.controlledMs;
      run.mode = saved.state.mode;
      run.viewportChanges = viewportChanges;
      run.leaseAt = leaseAt;
      this.runs.set(run.id, run);
      store.audit('ranked.recovered', account, run.ip, { run_id: run.id, score: run.game.score });
    }
  }

  actor(run) { return this.store.account(run.accountId); }
  mine(accountId) { return [...this.runs.values()].find(run => run.accountId === accountId) || null; }

  info(run) {
    return run ? { id: run.id, state: run.game.state, score: run.game.score, wave: run.game.wave, expiresAt: run.game.state === 'paused' ? run.leaseAt + LEASE_MS : null } : null;
  }

  start(account, ip, viewport = DEFAULT_VIEWPORT) {
    if (!this.available) throw new ApiError(503, 'ranked_unavailable');
    if (this.mine(account.id)) throw new ApiError(409, 'run_exists');
    return this.create(account, ip, viewport);
  }

  restart(account, ip, expectedRunId, viewport = DEFAULT_VIEWPORT) {
    const previous = this.mine(account.id);
    if ((previous?.id ?? null) !== expectedRunId) throw new ApiError(409, 'run_changed');
    return this.create(account, ip, viewport, previous);
  }

  create(account, ip, viewport, previous = null) {
    if (!this.available) throw new ApiError(503, 'ranked_unavailable');
    if (this.runs.size >= 16 && !previous) throw new ApiError(503, 'ranked_capacity');
    const arena = viewportArena(viewport);
    const run = new Run(account.id, ip, this.now(), arena);
    this.store.atomic(() => {
      if (previous) {
        this.store.audit('ranked.abandoned', account, ip, { ...previous.summary(), reason: 'player_restart' });
        this.store.db.prepare('DELETE FROM runs WHERE id=? AND account_id=?').run(previous.id, account.id);
      }
      this.store.checkpoint(run);
      this.store.audit('ranked.started', account, ip, { run_id: run.id, rules: 'ranked-v1', arena_width: Math.round(arena.width), arena_height: Math.round(arena.height) });
    });
    if (previous) {
      previous.finished = true;
      this.runs.delete(previous.id);
      for (const [id, ticket] of this.tickets) if (ticket.runId === previous.id) this.tickets.delete(id);
      previous.socket?.close(4000, 'Flight restarted by its pilot');
    }
    this.runs.set(run.id, run);
    return this.info(run);
  }

  ticket(session, runId, ip) {
    const run = this.runs.get(runId);
    if (!run || run.accountId !== session.accountId) throw new ApiError(404, 'run_not_found');
    for (const [id, entry] of this.tickets) if (entry.until <= this.now()) this.tickets.delete(id);
    if (this.tickets.size >= 64) throw new ApiError(503, 'capacity_unavailable');
    const value = token();
    this.tickets.set(digest(value).toString('hex'), { runId, sessionHash: session.hash, until: this.now() + 20000 });
    this.store.audit('ranked.connection_requested', session.account, ip, { run_id: runId });
    return value;
  }

  accept(socket, session, ip) {
    let run = null;
    let messages = 0;
    let windowAt = this.now();
    const timeout = setTimeout(() => {
      if (!run) socket.close(4000, 'Attach timeout');
    }, 3000);
    socket.on('error', () => {
      console.warn('A ranked websocket transport failed.');
    });
    socket.on('message', data => {
      try {
        if (!this.available) throw new ApiError(503, 'ranked_unavailable');
        if (this.now() - windowAt >= 1000) { messages = 0; windowAt = this.now(); }
        if (++messages > 45 || data.length > 1024) throw new ApiError(429, 'input_rate_limited');
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        if (!run) {
          object(message, ['type', 'ticket', 'runId', 'viewport'], ['type', 'ticket', 'runId']);
          if (message.type !== 'attach') throw new ApiError(400, 'attach_required');
          const value = base64url(message.ticket, 43);
          const key = digest(value).toString('hex');
          const ticket = this.tickets.get(key);
          this.tickets.delete(key);
          if (!ticket || ticket.until <= this.now() || ticket.runId !== message.runId || !equal(ticket.sessionHash, session.hash)) throw new ApiError(403, 'invalid_ticket');
          run = this.runs.get(ticket.runId);
          if (!run || run.accountId !== session.accountId || !this.store.session(session.value)) throw new ApiError(401, 'authentication_required');
          this.resize(run, message.viewport ?? DEFAULT_VIEWPORT);
          if (run.socket) run.socket.close(4003, 'Connected elsewhere');
          clearTimeout(timeout);
          run.socket = socket;
          run.session = session;
          run.sequence = 0;
          run.ip = ip;
          run.inputAt = this.now();
          this.store.audit('ranked.connected', this.actor(run), ip, { run_id: run.id });
          this.send(run, { type: 'attached', run: this.info(run), arena: { width: run.game.width, height: run.game.height, hz: ARENA.hz } });
          this.snapshot(run);
          return;
        }
        if (run.socket !== socket || run.finished) throw new ApiError(409, 'run_not_active');
        if (!this.store.session(session.value)) {
          this.pause(run, 'authentication_expired');
          socket.close(4001, 'Sign in again');
          return;
        }
        if (message.type === 'input') {
          const input = controls(message);
          if (message.seq !== run.sequence + 1) throw new ApiError(409, 'input_sequence_rejected');
          run.sequence = message.seq;
          run.input = input;
          run.inputAt = this.now();
          run.mode = message.controls;
          if (input.left || input.right || input.thrust || input.fire || input.shield || input.brake) run.actionAt = this.now();
        } else if (message.type === 'viewport') {
          object(message, ['type', 'viewport']);
          if (this.resize(run, message.viewport)) this.snapshot(run);
        } else {
          object(message, ['type']);
          this.budget.take(`${run.id}:actions`, 20, 60000);
          if (message.type === 'pause') this.pause(run, 'player');
          else if (message.type === 'resume') this.resume(run);
          else if (message.type === 'finish') this.finish(run, 'player_finished');
          else throw new ApiError(400, 'invalid_action');
        }
      } catch (error) {
        if (error instanceof ApiError || error instanceof SyntaxError || error instanceof TypeError) {
          try {
            this.store.audit('ranked.input_rejected', run ? this.actor(run) : session.account, ip, { run_id: run?.id || null, reason: error instanceof ApiError ? error.code : 'invalid_encoding' });
          } catch { this.storageFailure(); return; }
          if (error instanceof ApiError && error.status === 503) {
            if (run) this.send(run, { type: 'unavailable', reason: error.code });
            return;
          }
          socket.close(4002, 'Invalid ranked message');
        } else this.storageFailure(error);
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (run && run.socket === socket && !run.finished) {
        run.socket = null;
        try { this.pause(run, 'disconnected'); }
        catch (error) { this.storageFailure(error); }
      }
    });
  }

  send(run, payload) {
    if (!run.socket || run.socket.readyState !== 1) return false;
    if (run.socket.bufferedAmount > 131072) {
      run.socket.close(4004, 'Connection too slow');
      return false;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 65536) throw new Error('Ranked output exceeds its fixed budget.');
    run.socket.send(body);
    return true;
  }

  snapshot(run) {
    this.send(run, { type: 'snapshot', tick: run.ticks, game: gameState(run.game), events: run.events.splice(0, 128) });
    run.snapshotAt = this.now();
  }

  resize(run, viewport) {
    if (!this.available) throw new ApiError(503, 'ranked_unavailable');
    if (run.finished || !this.runs.has(run.id)) throw new ApiError(409, 'run_not_active');
    if (run.game.state === 'paused' && run.leaseAt + LEASE_MS <= this.now()) throw new ApiError(409, 'run_expired');
    const arena = viewportArena(viewport);
    if (Math.abs(run.game.width - arena.width) < 0.0000001 && Math.abs(run.game.height - arena.height) < 0.0000001) return false;
    this.budget.take(`${run.id}:viewport`, 12, 2000);
    run.game.resize(arena.width, arena.height, run.events);
    run.viewportChanges++;
    this.store.checkpoint(run);
    return true;
  }

  pause(run, reason) {
    run.input = EMPTY_INPUT;
    if (!run.game.pause()) return;
    run.leaseAt = this.now();
    this.store.atomic(() => {
      this.store.checkpoint(run);
      this.store.audit('ranked.paused', this.actor(run), run.ip, { ...run.summary(), reason });
    });
    this.send(run, { type: 'paused', reason, expiresAt: run.leaseAt + LEASE_MS });
    this.snapshot(run);
  }

  resume(run) {
    if (run.game.state !== 'paused') return;
    if (!this.available) throw new ApiError(503, 'ranked_unavailable');
    if ([...this.runs.values()].filter(item => item.game.state === 'playing').length >= 8) throw new ApiError(503, 'ranked_capacity');
    if (run.leaseAt + LEASE_MS <= this.now()) throw new ApiError(409, 'run_expired');
    run.game.resume();
    run.input = EMPTY_INPUT;
    run.inputAt = run.actionAt = this.now();
    this.store.audit('ranked.resumed', this.actor(run), run.ip, { run_id: run.id });
    this.snapshot(run);
  }

  finish(run, reason) {
    if (run.finished) return;
    const result = this.store.finalize(run, reason);
    run.finished = true;
    run.game.state = 'gameover';
    this.snapshot(run);
    this.send(run, { type: 'finished', result });
    this.runs.delete(run.id);
    run.socket?.close(1000, 'Score verified');
  }

  remove(accountId) {
    const run = this.mine(accountId);
    if (!run) return;
    run.finished = true;
    this.runs.delete(run.id);
    run.socket?.close(4001, 'Account signed out');
  }

  storageFailure() {
    if (!this.available) return;
    this.available = false;
    console.error('Ranked storage failed. Account mutations and ranked play are disabled; no score is reported as saved.');
    for (const run of this.runs.values()) {
      run.game.pause();
      run.input = EMPTY_INPUT;
      this.send(run, { type: 'unavailable', reason: 'storage_failure' });
      run.socket?.close(4010, 'Ranked storage unavailable');
    }
    this.onStorageFailure();
  }

  tick() {
    const now = this.now();
    const clock = this.monotonic();
    const gap = clock - this.previous;
    this.previous = clock;
    if (!this.available) return;
    try {
      if (gap > 100 || gap < 0) {
        this.accumulator = 0;
        for (const run of this.runs.values()) this.pause(run, 'server_lag');
      } else this.accumulator += gap;
      let steps = 0;
      while (this.accumulator >= 1000 / ARENA.hz && steps++ < 12) {
        this.accumulator -= 1000 / ARENA.hz;
        for (const run of this.runs.values()) {
          if (run.game.state !== 'playing') continue;
          if (now - run.inputAt > 2000 || now - run.actionAt > 60000) {
            this.pause(run, 'idle');
            continue;
          }
          run.game.update(1 / ARENA.hz, run.input);
          run.ticks++;
          run.activeMs += 1000 / ARENA.hz;
          if (run.input.left || run.input.right || run.input.thrust || run.input.fire || run.input.shield || Number.isFinite(run.input.aim)) run.controlledMs += 1000 / ARENA.hz;
          run.events.push(...run.game.drainEvents());
          if (run.events.length > 128) throw new Error('Ranked event queue exceeded its fixed budget.');
          if (run.game.state === 'gameover') this.finish(run, 'ship_destroyed');
        }
      }
      for (const run of this.runs.values()) {
        if (run.game.state === 'paused' && run.leaseAt + LEASE_MS <= now) {
          this.store.atomic(() => {
            this.store.audit('ranked.expired', this.actor(run), run.ip, { ...run.summary(), reason: 'paused_or_disconnected' });
            this.store.db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
          });
          run.finished = true;
          run.socket?.close(4000, 'Run expired');
          this.runs.delete(run.id);
          continue;
        }
        if (run.game.state !== 'playing') continue;
        if (now - run.sessionAt >= 15000) {
          if (!this.store.session(run.session?.value)) {
            this.pause(run, 'authentication_expired');
            run.socket?.close(4001, 'Sign in again');
            continue;
          }
          this.store.touchSession(run.session.hash);
          run.sessionAt = now;
        }
        if (now - run.summaryAt >= 30000) {
          this.store.atomic(() => {
            this.store.checkpoint(run);
            this.store.audit('ranked.summary', this.actor(run), run.ip, run.summary());
          });
          run.summaryAt = now;
        }
        if (now - run.snapshotAt >= 50) this.snapshot(run);
      }
    } catch (error) { this.storageFailure(error); }
  }

  shutdown() {
    for (const run of this.runs.values()) this.pause(run, 'server_shutdown');
  }
}
