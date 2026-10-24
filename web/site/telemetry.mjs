export const GAME_BUILD = '20261024.7';
export const QUALIFY_MS = 2000;
export const HEARTBEAT_MS = 30000;

export class GameplayTelemetry {
  constructor({
    navigator = globalThis.navigator,
    now = () => performance.now(),
    uuid = () => crypto.randomUUID(),
    visible = () => !globalThis.document?.hidden,
    send = url => fetch(url, { method: 'POST', credentials: 'same-origin', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true }),
    settings = () => ({ sound: false, haptics: false }),
    onWarning = () => {},
    schedule = (callback, delay) => setTimeout(callback, delay),
  } = {}) {
    Object.assign(this, { navigator, now, uuid, visible, send, settings, onWarning, schedule });
    this.run = null;
    this.queue = [];
    this.sending = false;
    this.retryScheduled = false;
    this.retryDelay = 1000;
    this.warned = false;
  }

  begin(device = 'desktop') {
    this.run = {
      id: this.uuid(), sequence: 0, activeMs: 0, lastSnapshotMs: 0,
      lastTrustedAt: -Infinity, controls: new Set(), qualified: false, ended: false,
      device, automated: Boolean(this.navigator?.webdriver),
    };
  }

  noteInput(event, kind) {
    if (!event?.isTrusted) return;
    this.recordControl(kind);
  }

  noteGamepadInput() {
    this.recordControl('gamepad');
  }

  recordControl(kind) {
    if (!this.run || this.run.ended) return;
    if (!['keyboard', 'touch', 'gamepad'].includes(kind)) throw new RangeError(`Unknown control type: ${kind}`);
    this.run.lastTrustedAt = this.now();
    this.run.controls.add(kind);
  }

  sample(game, dt, input) {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Gameplay sample time must be finite and non-negative.');
    const run = this.run;
    if (!run || run.ended || game.state !== 'playing' || !this.visible() || !run.controls.size) return;
    const held = input.left || input.right || input.thrust > 0 || input.fire || input.shield || input.manualBrake || Number.isFinite(input.aim);
    if (!held && this.now() - run.lastTrustedAt > 15000) return;
    run.activeMs = Math.min(run.activeMs + dt * 1000, game.elapsed * 1000);
    if (!run.qualified && run.activeMs >= QUALIFY_MS) {
      run.qualified = true;
      this.capture('start', 'qualified', game);
    } else if (run.qualified && run.activeMs - run.lastSnapshotMs >= HEARTBEAT_MS) {
      this.capture('progress', 'heartbeat', game);
    }
  }

  flush(reason, game) {
    if (!this.run?.qualified || this.run.ended) return;
    const end = ['gameover', 'restart', 'pagehide'].includes(reason);
    this.capture(end ? 'end' : 'progress', reason, game);
    if (['gameover', 'restart'].includes(reason)) this.run.ended = true;
  }

  capture(event, reason, game) {
    const run = this.run;
    const preferences = this.settings();
    const playMs = Math.floor(game.elapsed * 1000);
    const values = {
      v: 1, run: run.id, seq: ++run.sequence, event, reason,
      play_ms: playMs, active_ms: Math.min(playMs, Math.floor(run.activeMs)),
      score: game.score, wave: game.wave,
      shots: game.stats.shots, hits: game.stats.hits, rocks: game.stats.rocks,
      deaths: game.stats.deaths, shields: game.stats.shields, pickups: game.stats.pickups,
      combo: game.stats.maxCombo,
      controls: run.controls.size > 1 ? 'mixed' : [...run.controls][0],
      device: run.device, automated: Number(run.automated),
      cheats: game.cheatsUsed, sound: Number(preferences.sound), haptics: Number(preferences.haptics),
      build: GAME_BUILD,
    };
    const entry = { run: run.id, event, attempted: false, url: `/arcade/events?${new URLSearchParams(values)}` };
    const tail = this.queue.at(-1);
    if (event === 'progress' && tail?.event === 'progress' && tail.run === run.id && !tail.attempted) {
      this.queue[this.queue.length - 1] = entry;
    } else {
      if (this.queue.length >= 32) {
        const disposable = this.queue.findIndex(item => item.event === 'progress' && !item.attempted);
        if (disposable >= 0) this.queue.splice(disposable, 1);
        else {
          run.lastSnapshotMs = run.activeMs;
          this.warning('The gameplay statistics queue is full; this snapshot could not be queued.');
          return;
        }
      }
      this.queue.push(entry);
    }
    run.lastSnapshotMs = run.activeMs;
    void this.deliver();
  }

  warning(message, error) {
    console.warn(`Arcade gameplay stats: ${message}`, error ?? '');
    if (!this.warned) {
      this.warned = true;
      this.onWarning(message);
    }
  }

  async deliver() {
    if (this.sending || this.retryScheduled || !this.queue.length) return;
    this.sending = true;
    const item = this.queue[0];
    item.attempted = true;
    let retry = false;
    try {
      const response = await this.send(item.url);
      if (response.status === 204) {
        this.queue.shift();
        this.retryDelay = 1000;
      } else if (response.status === 429 || response.status >= 500) {
        this.warning(`The collector returned ${response.status}; the same snapshot will be retried.`);
        retry = true;
      } else {
        this.warning(`The collector rejected a snapshot (${response.status}); gameplay is unaffected.`);
        this.queue.shift();
      }
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== 'AbortError') throw error;
      this.warning('Delivery failed; the same snapshot will be retried.', error);
      retry = true;
    } finally {
      this.sending = false;
    }
    if (retry) {
      this.retryScheduled = true;
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      this.schedule(() => { this.retryScheduled = false; void this.deliver(); }, delay);
    } else if (this.queue.length) {
      void this.deliver();
    }
  }

  beacon() {
    for (const item of this.queue) {
      if (!this.navigator?.sendBeacon?.(item.url, '')) {
        this.warning('The browser could not queue the final gameplay snapshot.');
        break;
      }
    }
  }
}
