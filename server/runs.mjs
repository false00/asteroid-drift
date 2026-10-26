import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Game } from '../web/site/engine.mjs';
import { DEFAULT_VIEWPORT, RANKED_SCALE, arenaForViewport, isRankedArena } from '../web/site/arena.mjs';
import { DIAGNOSTIC_NUMBERS, DIAGNOSTIC_NULLABLE, DIAGNOSTIC_FLAGS, DIAGNOSTIC_ENUMS, DIAGNOSTIC_EVENTS, DIAGNOSTIC_REASONS } from '../web/site/diagnostics.mjs';
import { ApiError, Budget, base64url, digest, equal, integer, object, token } from './validation.mjs';

export const ARENA = Object.freeze({ width: 960, height: 640, hz: 120 });
export const LEASE_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 15000;
export const HEARTBEAT_TIMEOUT_MS = 45000;
const EMPTY_INPUT = Object.freeze({ left: false, right: false, thrust: 0, brake: false, fire: false, shield: false, aim: null });
const CLIENT_PAUSES = new Set(['player', 'blur', 'hidden', 'pagehide', 'console', 'manual', 'account', 'graphics', 'viewport', 'controller_lost']);
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
    this.diagnostics = { scheduler_gap_max_ms: 0, tick_work_max_us: 0, snapshot_bytes_max: 0, queued_bytes_max: 0 };
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
      diagnostics: { ...this.diagnostics },
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
    this.connections = new WeakMap();
    this.diagnosticConnections = new Map();
    this.budget = new Budget({ maximum: 256, now });
    this.previous = monotonic();
    this.accumulator = 0;
    this.available = true;
    this.shuttingDown = false;
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
      this.close(previous.socket, 4000, 'Flight restarted by its pilot', 'player_restart');
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
    const connection = {
      id: randomUUID(), accountId: session.accountId, runId: null, closedAt: null, reportSequence: 0, client: null, server: null,
      openedAt: this.now(), receivedAt: this.now(), received: 0, sent: 0, attached: false,
      closeReason: null, closeCode: null, buffered: null, errors: 0,
      heartbeatAt: this.monotonic(), pingAt: null, pendingPing: null, pongAt: null,
      pings: 0, pongs: 0, rtt: null, maxRtt: 0,
    };
    this.connections.set(socket, connection);
    const timeout = setTimeout(() => {
      if (!run) this.close(socket, 4000, 'Attach timeout', 'attach_timeout');
    }, 3000);
    socket.on('error', () => {
      connection.errors++;
      console.warn('A ranked websocket transport failed.');
    });
    socket.on('pong', data => {
      if (!connection.pendingPing || !Buffer.isBuffer(data) || !equal(data, connection.pendingPing)) return;
      connection.rtt = Math.max(0, Math.ceil(this.monotonic() - connection.pingAt));
      connection.maxRtt = Math.max(connection.maxRtt, connection.rtt);
      connection.pongAt = this.now();
      connection.pongs++;
      connection.pendingPing = null;
      connection.pingAt = null;
      if (run?.socket === socket && !run.finished && this.available && !this.shuttingDown) {
        try { this.send(run, { type: 'latency', milliseconds: connection.rtt }); }
        catch { this.storageFailure(); }
      }
    });
    socket.on('message', data => {
      try {
        connection.received++;
        connection.receivedAt = this.now();
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
          if (run.socket) this.close(run.socket, 4003, 'Connected elsewhere', 'connected_elsewhere');
          clearTimeout(timeout);
          run.socket = socket;
          connection.attached = true;
          connection.runId = run.id;
          this.pruneDiagnostics();
          this.diagnosticConnections.set(connection.id, connection);
          run.session = session;
          run.sequence = 0;
          run.ip = ip;
          run.inputAt = this.now();
          this.store.audit('ranked.connected', this.actor(run), ip, { run_id: run.id, connection_id: connection.id });
          this.send(run, { type: 'attached', connectionId: connection.id, run: this.info(run), arena: { width: run.game.width, height: run.game.height, hz: ARENA.hz } });
          this.snapshot(run);
          return;
        }
        if (run.socket !== socket || run.finished) throw new ApiError(409, 'run_not_active');
        if (!this.store.session(session.value)) {
          this.pause(run, 'authentication_expired');
          this.close(socket, 4001, 'Sign in again', 'authentication_expired');
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
          const pausing = message.type === 'pause';
          object(message, pausing ? ['type', 'reason'] : ['type'], ['type']);
          const reason = Object.hasOwn(message, 'reason') ? message.reason : 'player';
          if (pausing && !CLIENT_PAUSES.has(reason)) throw new ApiError(400, 'invalid_pause_reason');
          this.budget.take(`${run.id}:actions`, 20, 60000);
          if (pausing) this.pause(run, reason);
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
          this.close(socket, 4002, 'Invalid ranked message', 'input_rejected');
        } else this.storageFailure(error);
      }
    });
    socket.on('close', (code, reason) => {
      clearTimeout(timeout);
      connection.closedAt = this.now();
      connection.server = run ? { ...run.diagnostics } : null;
      if (this.shuttingDown) return;
      try {
        const reportedInvalid = code === 4002 && Buffer.isBuffer(reason) && reason.equals(Buffer.from('Invalid ranked response'));
        const closedByPeer = reportedInvalid ? 'peer_invalid_response' : code === 1006 ? 'transport_lost' : code === 1000 ? 'peer_normal' : 'peer_closed';
        this.store.audit('ranked.connection_closed', run ? this.actor(run) : session.account, ip, {
          run_id: run?.id || null, connection_id: connection.id, close_code: integer(code, 1000, 4999),
          reason: connection.closeReason || closedByPeer, attached: connection.attached,
          server_initiated: connection.closeReason !== null, requested_close_code: connection.closeCode,
          connected_ms: Math.max(0, this.now() - connection.openedAt),
          last_message_age_ms: Math.max(0, this.now() - connection.receivedAt),
          last_input_age_ms: run ? Math.max(0, this.now() - run.inputAt) : null,
          buffered_bytes: connection.buffered ?? socket.bufferedAmount,
          messages_received: connection.received, messages_sent: connection.sent,
          heartbeat: {
            pings_sent: connection.pings, pongs_received: connection.pongs, round_trip_ms: connection.rtt,
            max_round_trip_ms: connection.maxRtt, last_pong_age_ms: connection.pongAt === null ? null : Math.max(0, this.now() - connection.pongAt),
            socket_errors: connection.errors,
          },
          server: connection.server, client: connection.client,
          score: run?.game.score ?? 0, wave: run?.game.wave ?? 0,
        });
        if (run && run.socket === socket && !run.finished) {
          run.socket = null;
          this.pause(run, 'disconnected');
        }
      } catch (error) { this.storageFailure(error); }
    });
  }

  pruneDiagnostics() {
    for (const [id, connection] of this.diagnosticConnections) {
      if (connection.closedAt !== null && (connection.closedAt + LEASE_MS <= this.now() || this.diagnosticConnections.size >= 128)) this.diagnosticConnections.delete(id);
    }
  }

  reportDiagnostics(account, ip, value) {
    object(value, ['runId', 'connectionId', 'sequence', 'reason', 'sample']);
    integer(value.sequence, 1, Number.MAX_SAFE_INTEGER);
    if (!DIAGNOSTIC_REASONS.includes(value.reason)) throw new ApiError(400, 'invalid_diagnostics');
    this.pruneDiagnostics();
    const connection = this.diagnosticConnections.get(value.connectionId);
    if (!connection || connection.accountId !== account.id || connection.runId !== value.runId) throw new ApiError(404, 'connection_not_found');
    const sample = value.sample;
    object(sample, [...Object.keys(DIAGNOSTIC_NUMBERS), ...DIAGNOSTIC_FLAGS, ...Object.keys(DIAGNOSTIC_ENUMS), 'close_clean', 'build', 'events']);
    for (const [name, maximum] of Object.entries(DIAGNOSTIC_NUMBERS)) {
      if (sample[name] === null && DIAGNOSTIC_NULLABLE.includes(name)) continue;
      integer(sample[name], name === 'close_code' ? 1000 : 0, maximum);
    }
    if (DIAGNOSTIC_FLAGS.some(name => typeof sample[name] !== 'boolean') || (sample.close_clean !== null && typeof sample.close_clean !== 'boolean')) throw new ApiError(400, 'invalid_diagnostics');
    if (Object.entries(DIAGNOSTIC_ENUMS).some(([name, choices]) => !choices.includes(sample[name]))) throw new ApiError(400, 'invalid_diagnostics');
    if (typeof sample.build !== 'string' || /[^0-9.]/.test(sample.build) || !/^\d{8}\.\d{1,3}$/.test(sample.build) || !Array.isArray(sample.events) || sample.events.length > 12) throw new ApiError(400, 'invalid_diagnostics');
    for (const event of sample.events) {
      object(event, ['type', 'at_ms']);
      if (!DIAGNOSTIC_EVENTS.includes(event.type)) throw new ApiError(400, 'invalid_diagnostics');
      integer(event.at_ms, 0, 2147483647);
    }
    if (value.sequence <= connection.reportSequence) return { accepted: false };
    this.budget.take(`${account.id}:diagnostics`, 12, 60000);
    const run = this.runs.get(connection.runId);
    this.store.audit('ranked.connection_diagnostics', account, ip, {
      run_id: connection.runId, connection_id: connection.id, reason: value.reason, sequence: value.sequence,
      client: sample, server: run ? { ...run.diagnostics } : connection.server,
      transport: {
        round_trip_ms: connection.rtt, max_round_trip_ms: connection.maxRtt,
        pings_sent: connection.pings, pongs_received: connection.pongs, socket_errors: connection.errors,
        last_message_age_ms: Math.max(0, this.now() - connection.receivedAt),
        last_pong_age_ms: connection.pongAt === null ? null : Math.max(0, this.now() - connection.pongAt),
      },
    });
    connection.reportSequence = value.sequence;
    connection.client = structuredClone(sample);
    return { accepted: true };
  }

  close(socket, code, message, reason) {
    if (!socket) return;
    const connection = this.connections.get(socket);
    if (connection && connection.closeReason === null) {
      connection.closeReason = reason;
      connection.closeCode = code;
      connection.buffered = socket.bufferedAmount;
    }
    socket.close(code, message);
  }

  heartbeat(run) {
    const socket = run.socket;
    const connection = socket && this.connections.get(socket);
    if (!connection || socket.readyState !== 1) return;
    const clock = this.monotonic();
    if (connection.pendingPing) {
      if (clock - connection.pingAt >= HEARTBEAT_TIMEOUT_MS) this.close(socket, 4005, 'Connection heartbeat timed out', 'heartbeat_timeout');
      return;
    }
    if (clock - connection.heartbeatAt < HEARTBEAT_MS) return;
    connection.heartbeatAt = connection.pingAt = clock;
    connection.pendingPing = randomBytes(8);
    connection.pings++;
    socket.ping(connection.pendingPing);
  }

  send(run, payload) {
    if (!run.socket || run.socket.readyState !== 1) return false;
    run.diagnostics.queued_bytes_max = Math.max(run.diagnostics.queued_bytes_max, run.socket.bufferedAmount);
    if (run.socket.bufferedAmount > 131072) {
      this.close(run.socket, 4004, 'Connection too slow', 'backpressure');
      return false;
    }
    const body = JSON.stringify(payload);
    if (payload.type === 'snapshot') run.diagnostics.snapshot_bytes_max = Math.max(run.diagnostics.snapshot_bytes_max, Buffer.byteLength(body));
    if (Buffer.byteLength(body) > 65536) throw new Error('Ranked output exceeds its fixed budget.');
    run.socket.send(body);
    const connection = this.connections.get(run.socket);
    if (connection) connection.sent++;
    return true;
  }

  snapshot(run) {
    this.send(run, { type: 'snapshot', tick: run.ticks, sequence: run.sequence, game: gameState(run.game), events: run.events.splice(0, 128) });
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
    this.close(run.socket, 1000, 'Score verified', 'verified_result');
  }

  remove(accountId) {
    const run = this.mine(accountId);
    if (!run) return;
    run.finished = true;
    this.runs.delete(run.id);
    this.close(run.socket, 4001, 'Account signed out', 'account_removed');
  }

  storageFailure() {
    if (!this.available) return;
    this.available = false;
    console.error('Ranked storage failed. Account mutations and ranked play are disabled; no score is reported as saved.');
    for (const run of this.runs.values()) {
      run.game.pause();
      run.input = EMPTY_INPUT;
      this.send(run, { type: 'unavailable', reason: 'storage_failure' });
      this.close(run.socket, 4010, 'Ranked storage unavailable', 'storage_unavailable');
    }
    this.onStorageFailure();
  }

  tick() {
    const now = this.now();
    const clock = this.monotonic();
    const gap = clock - this.previous;
    this.previous = clock;
    if (!this.available) return;
    for (const run of this.runs.values()) run.diagnostics.scheduler_gap_max_ms = Math.max(run.diagnostics.scheduler_gap_max_ms, Math.max(0, Math.ceil(gap)));
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
        this.heartbeat(run);
        if (run.game.state === 'paused' && run.leaseAt + LEASE_MS <= now) {
          this.store.atomic(() => {
            this.store.audit('ranked.expired', this.actor(run), run.ip, { ...run.summary(), reason: 'paused_or_disconnected' });
            this.store.db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
          });
          run.finished = true;
          this.close(run.socket, 4000, 'Run expired', 'run_expired');
          this.runs.delete(run.id);
          continue;
        }
        if (run.game.state !== 'playing') continue;
        if (now - run.sessionAt >= 15000) {
          if (!this.store.session(run.session?.value)) {
            this.pause(run, 'authentication_expired');
            this.close(run.socket, 4001, 'Sign in again', 'authentication_expired');
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
    finally {
      const elapsed = Math.max(0, Math.ceil((this.monotonic() - clock) * 1000));
      for (const run of this.runs.values()) run.diagnostics.tick_work_max_us = Math.max(run.diagnostics.tick_work_max_us, elapsed);
    }
  }

  shutdown() {
    this.shuttingDown = true;
    for (const run of this.runs.values()) this.pause(run, 'server_shutdown');
  }
}
