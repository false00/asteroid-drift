const MELODIES = {
  launch: [261.63, 392, 523.25, 659.25],
  wave: [329.63, 440, 659.25],
  clear: [523.25, 659.25, 783.99, 1046.5],
  pickup: [880, 1318.5],
  'extra-life': [659.25, 830.61, 987.77, 1318.5],
  gameover: [392, 329.63, 261.63, 196],
  combo: [783.99, 987.77],
  console: [220, 440],
  toggle: [660],
  pause: [440, 330],
  resume: [330, 440],
  record: [523.25, 659.25, 783.99, 1046.5, 1318.5],
  'rank-up': [392, 523.25, 659.25, 783.99, 1046.5, 1568],
  leader: [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5, 1568],
};

export class Synth {
  constructor({ muted = false, onFailure = () => {}, AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
    this.context = null;
    this.muted = muted;
    this.onFailure = onFailure;
    this.AudioContext = AudioContext;
    this.pending = [];
    this.lastCombo = 1;
  }

  async unlock(cue) {
    if (this.muted) return;
    if (!this.AudioContext) {
      this.fail(new Error('Web Audio is not supported.'));
      return;
    }
    try {
      if (!this.context) this.initialize();
      await this.context.resume();
      if (this.context.state !== 'running') throw new Error(`Audio is ${this.context.state}, not running.`);
      if (cue) this.play(cue);
      const pending = this.pending.splice(0);
      for (const [type, size] of pending) this.play(type, size);
    } catch (error) {
      this.fail(error);
    }
  }

  initialize() {
    const ctx = this.context = new this.AudioContext();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.25;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 5;
    this.master.connect(compressor).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
    const samples = this.noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    this.engineNoise = ctx.createBufferSource();
    this.engineNoise.buffer = this.noise;
    this.engineNoise.loop = true;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 280;
    this.thrustGain = ctx.createGain();
    this.thrustGain.gain.value = 0;
    this.engineNoise.connect(this.engineFilter).connect(this.thrustGain).connect(this.master);
    this.engineNoise.start();
  }

  fail(error) {
    console.warn('Arcade audio could not start.', error);
    this.muted = true;
    this.pending = [];
    this.setThrust(0);
    this.onFailure(error);
  }

  setMuted(muted) {
    this.muted = muted;
    this.pending = [];
    if (this.context && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.25, this.context.currentTime, 0.02);
    if (muted) this.setThrust(0);
  }

  setThrust(amount) {
    if (!this.context || !this.thrustGain) return;
    this.thrustGain.gain.setTargetAtTime(this.muted ? 0 : amount * 0.45, this.context.currentTime, 0.06);
    this.engineFilter.frequency.setTargetAtTime(200 + amount * 500, this.context.currentTime, 0.08);
  }

  tone(frequency, endFrequency, duration, volume, delay = 0, type = 'triangle') {
    const ctx = this.context;
    const start = ctx.currentTime + delay;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(15, endFrequency), start + duration);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.005);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }

  explosion(size, death = false) {
    const ctx = this.context;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = this.noise;
    filter.type = 'lowpass';
    filter.frequency.value = death ? 420 : 2000 / size;
    const duration = death ? 0.5 : 0.12 + size * 0.05;
    gain.gain.setValueAtTime(death ? 0.9 : 0.6, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
    source.stop(now + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
    this.tone(death ? 130 : 90 / size, 22, duration, 0.35, 0, 'sawtooth');
  }

  play(type, size = 1) {
    if (this.muted) return;
    if (!this.context || this.context.state !== 'running') {
      if (['wave', 'clear', 'pickup', 'extra-life', 'gameover'].includes(type)) this.pending = [...this.pending, [type, size]].slice(-4);
      return;
    }
    if (type === 'shot') {
      this.tone(1180, 120, 0.065, 0.3, 0, 'sawtooth');
    } else if (type === 'hit' || type === 'death') {
      this.explosion(size, type === 'death');
    } else if (type === 'shield') {
      this.tone(160, 1500, 0.18, 0.4, 0, 'sine');
      this.tone(1200, 420, 0.22, 0.18, 0.1, 'sine');
    } else {
      const notes = MELODIES[type];
      if (!notes) throw new RangeError(`Unknown sound effect: ${type}`);
      notes.forEach((frequency, i) => this.tone(frequency, frequency * 0.98, type === 'gameover' ? 0.25 : 0.12, 0.28, i * 0.085, 'square'));
    }
  }
}

export class FrameRateMeter {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.lastAt = null;
    this.frames = 0;
  }

  record(now) {
    if (!Number.isFinite(now) || now < 0 || (this.lastAt !== null && now < this.lastAt)) {
      throw new RangeError('Frame timestamps must be finite, non-negative, and monotonic.');
    }
    this.lastAt = now;
    if (this.startedAt === null) {
      this.startedAt = now;
      return null;
    }
    this.frames++;
    const elapsed = now - this.startedAt;
    if (elapsed < 1000) return null;
    const fps = Math.round(this.frames * 1000 / elapsed);
    this.startedAt = now;
    this.frames = 0;
    return fps;
  }
}

export class Haptics {
  constructor({ navigator = globalThis.navigator, onUnavailable = () => {}, now = () => performance.now() } = {}) {
    this.navigator = navigator;
    this.supported = typeof navigator?.vibrate === 'function';
    this.enabled = this.supported;
    this.onUnavailable = onUnavailable;
    this.now = now;
    this.lastPulse = -Infinity;
    this.impactUntil = 0;
    this.impactLevel = 0;
    this.activated = false;
  }

  activate(event) {
    if (event?.isTrusted) this.activated = true;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled && this.supported);
    if (!this.enabled && this.supported) this.navigator.vibrate(0);
  }

  pulse(level = 0) {
    if (!Number.isInteger(level) || level < 0 || level > 4) throw new RangeError('Haptic impact size must be 0 through 4.');
    const now = this.now();
    if (!this.supported || !this.enabled || !this.activated || (now < this.impactUntil && level <= this.impactLevel) || (now - this.lastPulse < (level ? 35 : 90) && level <= this.impactLevel)) return false;
    this.lastPulse = now;
    const duration = [8, 20, 38, 65, 120][level];
    this.impactLevel = level;
    this.impactUntil = now + duration;
    if (!this.navigator.vibrate(duration)) {
      this.enabled = false;
      this.onUnavailable();
      return false;
    }
    return true;
  }

  stop() {
    this.impactUntil = 0;
    this.impactLevel = 0;
    if (this.supported && this.activated) this.navigator.vibrate(0);
  }
}
