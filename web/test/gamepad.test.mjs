import test from 'node:test';
import assert from 'node:assert/strict';
import { GamepadInput, GAMEPAD_DEAD_ZONE } from '../site/gamepad.mjs';

test('controller impact rumble scales with blast size, preserves stronger effects and resets on disconnect', async () => {
  let now = 0;
  const effects = [];
  let resets = 0;
  const device = pad();
  device.vibrationActuator = {
    playEffect: async (type, options) => { effects.push({ type, ...options }); return 'complete'; },
    reset: async () => { resets++; },
  };
  const devices = [device];
  const input = new GamepadInput({ navigator: { getGamepads: () => devices }, now: () => now });
  input.poll(0);
  assert.equal(input.rumble(1), true);
  now = 5;
  assert.equal(input.rumble(3), true);
  assert.equal(input.rumble(1), false);
  assert.equal(input.rumble(4), true);
  assert.ok(effects[0].duration < effects[1].duration && effects[1].duration < effects[2].duration);
  assert.ok(effects[0].strongMagnitude < effects[1].strongMagnitude && effects[1].strongMagnitude < effects[2].strongMagnitude);
  assert.equal(effects[2].strongMagnitude, 1);
  devices.length = 0;
  input.poll(10);
  assert.equal(resets, 1);
  assert.equal(input.rumble(4), false);
  assert.throws(() => input.rumble(5), RangeError);
});

test('missing or declined controller rumble never disables flight and is explicitly reported', async () => {
  const { input } = rig();
  input.poll(0);
  assert.equal(input.rumbleSupported, false);
  assert.equal(input.rumble(1), false);
  let unavailable = 0;
  const device = pad();
  device.vibrationActuator = { playEffect: async () => 'not-supported' };
  const controller = new GamepadInput({ navigator: { getGamepads: () => [device] }, onRumbleUnavailable: () => unavailable++ });
  controller.poll(0);
  controller.rumble(2);
  await Promise.resolve();
  assert.equal(unavailable, 1);
  assert.equal(controller.rumbleSupported, false);
  device.buttons[0].pressed = true;
  assert.equal(controller.poll(1).input.fire, true);
});

function pad(index = 0) {
  return {
    index, id: `Virtual standard pad ${index}`, connected: true, mapping: 'standard',
    axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}

function rig() {
  const device = pad();
  const devices = [device];
  const input = new GamepadInput({ navigator: { getGamepads: () => devices } });
  return { device, devices, input };
}

test('controller support is optional and connection/disconnection is detected', () => {
  const unavailable = new GamepadInput({ navigator: {} });
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.poll(0).connected, false);
  const { devices, input } = rig();
  assert.equal(input.poll(0).changed, true);
  assert.equal(input.poll(1).changed, false);
  devices.length = 0;
  const lost = input.poll(2);
  assert.equal(lost.lost, true);
  assert.equal(lost.connected, false);
  assert.equal(lost.input.fire, false);
});

test('stick dead zone suppresses drift and produces analog aim/thrust', () => {
  const { device, input } = rig();
  device.axes = [0.12, -0.1];
  assert.equal(input.poll(0).hasFlightInput, false);
  device.axes = [0, -0.6];
  const flight = input.poll(1).input;
  assert.ok(Math.abs(flight.thrust - 0.5) < 1e-9);
  assert.equal(flight.aim, -Math.PI / 2);
  device.axes = [1, -1];
  assert.equal(input.poll(2).input.thrust, 1);
  device.axes = [GAMEPAD_DEAD_ZONE, 0];
  assert.equal(input.poll(3).hasFlightInput, false);
});

test('standard A/RT fire, B/RB shield, X brake and D-pad mappings work', () => {
  const { device, input } = rig();
  device.buttons[0].pressed = true;
  device.buttons[1].pressed = true;
  device.buttons[2].pressed = true;
  device.buttons[12].pressed = true;
  device.buttons[14].pressed = true;
  const result = input.poll(0).input;
  assert.equal(result.fire, true);
  assert.equal(result.shield, true);
  assert.equal(result.brake, true);
  assert.equal(result.thrust, 1);
  assert.equal(result.left, true);
  device.buttons[0].pressed = device.buttons[1].pressed = false;
  device.buttons[7].value = 0.4;
  device.buttons[5].pressed = true;
  const triggers = input.poll(1).input;
  assert.equal(triggers.fire, true);
  assert.equal(triggers.shield, true);
});

test('menu actions are rising edges, not continuous held-button actions', () => {
  const { device, input } = rig();
  device.buttons[9].pressed = true;
  device.buttons[8].pressed = true;
  const first = input.poll(0);
  assert.equal(first.actions.pause, true);
  assert.equal(first.actions.console, true);
  assert.equal(input.poll(1).actions.pause, false);
  device.buttons[9].pressed = false;
  input.poll(2);
  device.buttons[9].pressed = true;
  assert.equal(input.poll(3).actions.pause, true);
});

test('launch/resume latching requires neutral before flight and prevents launch-only metrics', () => {
  const { device, input } = rig();
  device.buttons[0].pressed = true;
  input.poll(0);
  input.suppressUntilNeutral();
  assert.equal(input.poll(1).hasFlightInput, false);
  device.axes = [0, -0.8];
  device.buttons[0].pressed = false;
  assert.equal(input.poll(2).hasFlightInput, false);
  device.axes = [0, 0];
  assert.equal(input.poll(3).hasFlightInput, false);
  device.buttons[0].pressed = true;
  assert.equal(input.poll(4).hasFlightInput, true);
});

test('menu stick/D-pad navigation has bounded key-repeat cadence', () => {
  const { device, input } = rig();
  device.axes[1] = 0.9;
  assert.equal(input.poll(0).actions.vertical, 1);
  assert.equal(input.poll(100).actions.vertical, 0);
  assert.equal(input.poll(350).actions.vertical, 1);
  assert.equal(input.poll(400).actions.vertical, 0);
  assert.equal(input.poll(490).actions.vertical, 1);
  device.axes[1] = -0.9;
  assert.equal(input.poll(500).actions.vertical, -1);
});

test('the active controller is retained until it disconnects', () => {
  const { device, devices, input } = rig();
  input.poll(0);
  const second = pad(1);
  devices.unshift(second);
  assert.equal(input.poll(1).changed, false);
  device.connected = false;
  const switched = input.poll(2);
  assert.equal(switched.connected, true);
  assert.equal(switched.lost, true);
  assert.equal(input.index, 1);
});

test('custom mappings retain common axes/buttons and permission failures are surfaced once', () => {
  const { device, input } = rig();
  device.mapping = '';
  device.buttons[0].pressed = true;
  const custom = input.poll(0);
  assert.equal(custom.standard, false);
  assert.equal(custom.input.fire, true);
  let failures = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const blocked = new GamepadInput({
      navigator: { getGamepads: () => { throw new DOMException('blocked', 'SecurityError'); } },
      onError: () => failures++,
    });
    assert.equal(blocked.poll(0).connected, false);
    assert.equal(blocked.poll(1).connected, false);
    assert.equal(blocked.supported, false);
    assert.equal(failures, 1);
  } finally { console.warn = warn; }
});
