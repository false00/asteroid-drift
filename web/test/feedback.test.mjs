import test from 'node:test';
import assert from 'node:assert/strict';
import { Synth, Haptics, FrameRateMeter } from '../site/feedback.mjs';

function parameter(value = 0) {
  return {
    value, values: [],
    setValueAtTime(value) { this.value = value; this.values.push(value); },
    exponentialRampToValueAtTime(value) { this.value = value; this.values.push(value); },
    setTargetAtTime(value) { this.value = value; this.values.push(value); },
  };
}

class AudioContext {
  constructor() {
    this.state = 'suspended';
    this.sampleRate = 8000;
    this.currentTime = 1;
    this.destination = {};
    this.nodes = [];
  }
  node(kind) {
    const node = {
      kind, gain: parameter(), frequency: parameter(),
      threshold: parameter(), knee: parameter(), ratio: parameter(),
      connect(target) { return target; },
      disconnect() { this.disconnected = true; },
      start(...args) { this.started = args; },
      stop(...args) { this.stopped = args; },
    };
    this.nodes.push(node);
    return node;
  }
  createGain() { return this.node('gain'); }
  createDynamicsCompressor() { return this.node('compressor'); }
  createOscillator() { return this.node('oscillator'); }
  createBufferSource() { return this.node('buffer'); }
  createBiquadFilter() { return this.node('filter'); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  async resume() { this.state = 'running'; }
}

test('audio is gesture-unlocked, compressed, and starts with an audible launch cue', async () => {
  const synth = new Synth({ AudioContext });
  synth.play('shot');
  assert.equal(synth.context, null);
  await synth.unlock('launch');
  assert.equal(synth.context.state, 'running');
  assert.equal(synth.master.gain.value, 0.25);
  assert.ok(synth.context.nodes.some(node => node.kind === 'compressor'));
  assert.equal(synth.context.nodes.filter(node => node.kind === 'oscillator').length, 4);
  assert.ok(synth.context.nodes.filter(node => node.kind === 'oscillator').every(node => node.started && node.stopped));
});

test('all gameplay and console cues have real oscillator or noise output', async () => {
  const synth = new Synth({ AudioContext });
  await synth.unlock();
  for (const cue of ['shot', 'hit', 'death', 'shield', 'wave', 'clear', 'pickup', 'extra-life', 'gameover', 'combo', 'console', 'toggle', 'pause', 'resume']) {
    const count = synth.context.nodes.length;
    synth.play(cue, 2);
    assert.ok(synth.context.nodes.length > count, cue);
  }
  assert.throws(() => synth.play('unknown'), RangeError);
});

test('mute suppresses effects and thrust; unmute restores the master level', async () => {
  const synth = new Synth({ AudioContext, muted: true });
  await synth.unlock('launch');
  assert.equal(synth.context, null);
  synth.setMuted(false);
  await synth.unlock();
  synth.setThrust(1);
  assert.ok(synth.thrustGain.gain.value > 0);
  synth.setMuted(true);
  const count = synth.context.nodes.length;
  synth.play('shot');
  assert.equal(synth.context.nodes.length, count);
  assert.equal(synth.master.gain.value, 0);
  assert.equal(synth.thrustGain.gain.value, 0);
  synth.setMuted(false);
  assert.equal(synth.master.gain.value, 0.25);
});

test('one-shot nodes disconnect when their sound ends', async () => {
  const synth = new Synth({ AudioContext });
  await synth.unlock();
  synth.play('shot');
  const oscillator = synth.context.nodes.find(node => node.kind === 'oscillator');
  oscillator.onended();
  assert.equal(oscillator.disconnected, true);
});

test('firing haptics require supported hardware API and a trusted gesture, and are throttled', () => {
  const pulses = [];
  let now = 0;
  const haptics = new Haptics({ navigator: { vibrate: value => { pulses.push(value); return true; } }, now: () => now });
  assert.equal(haptics.pulse(), false);
  haptics.activate({ isTrusted: false });
  assert.equal(haptics.pulse(), false);
  haptics.activate({ isTrusted: true });
  assert.equal(haptics.pulse(), true);
  now = 50;
  assert.equal(haptics.pulse(), false);
  now = 90;
  assert.equal(haptics.pulse(), true);
  assert.deepEqual(pulses, [8, 8]);
  haptics.setEnabled(false);
  now = 200;
  assert.equal(haptics.pulse(), false);
  assert.equal(pulses.at(-1), 0);
});

test('iPhone-style missing vibration API stays explicitly unavailable', () => {
  const haptics = new Haptics({ navigator: {} });
  assert.equal(haptics.supported, false);
  haptics.setEnabled(true);
  haptics.activate({ isTrusted: true });
  assert.equal(haptics.enabled, false);
  assert.equal(haptics.pulse(), false);
});

test('supported-phone impacts scale, preempt firing, and cannot be overwritten by smaller blasts', () => {
  let now = 0;
  const pulses = [];
  const haptics = new Haptics({ navigator: { vibrate: value => { pulses.push(value); return true; } }, now: () => now });
  haptics.activate({ isTrusted: true });
  haptics.pulse();
  now = 5;
  assert.equal(haptics.pulse(1), true);
  assert.equal(haptics.pulse(3), true);
  assert.equal(haptics.pulse(1), false);
  assert.equal(haptics.pulse(), false);
  assert.equal(haptics.pulse(4), true);
  assert.deepEqual(pulses, [8, 20, 65, 120]);
  haptics.stop();
  assert.equal(pulses.at(-1), 0);
});

test('a rejected vibration request disables haptics and reports the failure', () => {
  let failed = 0;
  const haptics = new Haptics({ navigator: { vibrate: () => false }, onUnavailable: () => failed++ });
  haptics.activate({ isTrusted: true });
  assert.equal(haptics.pulse(), false);
  assert.equal(haptics.enabled, false);
  assert.equal(failed, 1);
});

test('FPS reports rendered frames rather than assuming a fixed display rate', () => {
  for (const rate of [30, 60, 120]) {
    const meter = new FrameRateMeter();
    let value = null;
    for (let frame = 0; frame <= rate + 1; frame++) {
      const reading = meter.record(frame * 1000 / rate);
      if (reading !== null) value = reading;
    }
    assert.equal(value, rate);
  }
});

test('FPS reset excludes paused/hidden gaps and rejects invalid timestamps', () => {
  const meter = new FrameRateMeter();
  meter.record(0);
  meter.record(500);
  assert.throws(() => meter.record(400), RangeError);
  meter.reset();
  assert.equal(meter.record(10000), null);
  assert.equal(meter.record(11000), 1);
  assert.throws(() => meter.record(NaN), RangeError);
});
