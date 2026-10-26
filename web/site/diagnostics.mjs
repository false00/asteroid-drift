export const DIAGNOSTIC_INTERVAL_MS = 15000;
export const DIAGNOSTIC_BUILD = '20261026.1';
export const DIAGNOSTIC_NUMBERS = Object.freeze({
  window_ms: 600000, observed_at_ms: Number.MAX_SAFE_INTEGER,
  frames: 240000, frame_time_ms: 600000, frame_gap_max_ms: 600000, slow_frames: 240000,
  long_tasks: 10000, long_task_max_ms: 600000,
  snapshots: 20000, snapshot_gap_max_ms: 600000, snapshot_age_ms: 600000,
  inputs: 20000, input_gap_max_ms: 600000, input_age_ms: 600000,
  input_sequence: Number.MAX_SAFE_INTEGER, ack_backlog_max: 100000,
  buffered_bytes: 16777216, http_rtt_ms: 600000,
  socket_errors: 1000, response_errors: 1000, runtime_errors: 1000,
  render_width: 32768, render_height: 32768, pixel_ratio_x100: 1600, close_code: 4999,
});
export const DIAGNOSTIC_NULLABLE = Object.freeze(['snapshot_age_ms', 'input_age_ms', 'http_rtt_ms', 'close_code']);
export const DIAGNOSTIC_FLAGS = Object.freeze(['visible', 'focused', 'online', 'fullscreen', 'long_tasks_supported']);
export const DIAGNOSTIC_ENUMS = Object.freeze({
  browser: ['chromium', 'firefox', 'webkit', 'other'],
  network: ['slow-2g', '2g', '3g', '4g', 'unknown'],
  game_state: ['playing', 'paused', 'gameover'],
});
export const DIAGNOSTIC_EVENTS = Object.freeze(['blur', 'focus', 'hidden', 'visible', 'offline', 'online', 'pagehide', 'pageshow', 'freeze', 'resume', 'socket_error', 'invalid_response']);
export const DIAGNOSTIC_REASONS = Object.freeze(['sample', 'state', 'close', 'error', 'pagehide', 'retry']);

const bounded = (value, maximum) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.round(value))) : 0;

export class FlightDiagnostics {
  constructor({ now = () => performance.now(), wall = Date.now } = {}) {
    this.now = now;
    this.wall = wall;
    this.startedAt = this.windowAt = now();
    this.lastFrame = this.lastSnapshot = this.lastInput = null;
    this.values = {};
    this.events = [];
  }

  count(name, amount = 1) {
    this.values[name] = bounded((this.values[name] || 0) + amount, DIAGNOSTIC_NUMBERS[name]);
  }

  maximum(name, value) {
    this.values[name] = Math.max(this.values[name] || 0, bounded(value, DIAGNOSTIC_NUMBERS[name]));
  }

  frame(now, playing) {
    if (!playing) { this.lastFrame = null; return; }
    this.count('frames');
    if (this.lastFrame !== null) {
      const gap = Math.max(0, now - this.lastFrame);
      this.count('frame_time_ms', gap);
      this.maximum('frame_gap_max_ms', gap);
      if (gap >= 50) this.count('slow_frames');
    }
    this.lastFrame = now;
  }

  snapshot(inputSequence, acknowledged) {
    const now = this.now();
    if (this.lastSnapshot !== null) this.maximum('snapshot_gap_max_ms', now - this.lastSnapshot);
    if (Number.isSafeInteger(acknowledged)) this.maximum('ack_backlog_max', inputSequence - acknowledged);
    this.lastSnapshot = now;
    this.count('snapshots');
  }

  input(now) {
    if (this.lastInput !== null) this.maximum('input_gap_max_ms', now - this.lastInput);
    this.lastInput = now;
    this.count('inputs');
  }

  task(duration) {
    this.count('long_tasks');
    this.maximum('long_task_max_ms', duration);
  }

  event(type) {
    if (!DIAGNOSTIC_EVENTS.includes(type)) return;
    this.events.push({ type, at_ms: bounded(this.now() - this.startedAt, 2147483647) });
    if (this.events.length > 12) this.events.shift();
    this.lastFrame = null;
  }

  sample(state = {}) {
    const now = this.now();
    const sample = Object.fromEntries(Object.entries(DIAGNOSTIC_NUMBERS).map(([name, maximum]) => [name, bounded(state[name] ?? this.values[name] ?? 0, maximum)]));
    for (const name of DIAGNOSTIC_NULLABLE) if (state[name] == null) sample[name] = null;
    sample.window_ms = bounded(now - this.windowAt, DIAGNOSTIC_NUMBERS.window_ms);
    sample.observed_at_ms = bounded(this.wall(), DIAGNOSTIC_NUMBERS.observed_at_ms);
    sample.snapshot_age_ms = this.lastSnapshot === null ? null : bounded(now - this.lastSnapshot, DIAGNOSTIC_NUMBERS.snapshot_age_ms);
    sample.input_age_ms = this.lastInput === null ? null : bounded(now - this.lastInput, DIAGNOSTIC_NUMBERS.input_age_ms);
    for (const name of DIAGNOSTIC_FLAGS) sample[name] = state[name] === true;
    for (const [name, choices] of Object.entries(DIAGNOSTIC_ENUMS)) sample[name] = choices.includes(state[name]) ? state[name] : choices.at(-1);
    sample.close_clean = typeof state.close_clean === 'boolean' ? state.close_clean : null;
    sample.build = DIAGNOSTIC_BUILD;
    sample.events = this.events.slice();
    this.values = {};
    this.events = [];
    this.windowAt = now;
    this.lastFrame = null;
    return sample;
  }
}