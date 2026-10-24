export const GAMEPAD_DEAD_ZONE = 0.2;
export const EMPTY_GAMEPAD_INPUT = Object.freeze({
  left: false, right: false, thrust: 0, brake: false, fire: false, shield: false, aim: null,
});

const axis = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
const pressed = button => button?.pressed === true || (Number.isFinite(button?.value) && button.value > 0.15);

export class GamepadInput {
  constructor({ navigator = globalThis.navigator, onError = () => {}, onRumbleUnavailable = () => {}, now = () => performance.now() } = {}) {
    this.navigator = navigator;
    this.onError = onError;
    this.onRumbleUnavailable = onRumbleUnavailable;
    this.now = now;
    this.actuator = null;
    this.rumbleUntil = 0;
    this.rumbleLevel = 0;
    this.rumbleEpoch = 0;
    this.rumbleBlocked = false;
    this.supported = typeof navigator?.getGamepads === 'function';
    this.key = null;
    this.index = null;
    this.previous = [];
    this.suppressed = false;
    this.navDirection = 0;
    this.navRepeatAt = 0;
    this.connected = false;
  }

  suppressUntilNeutral() {
    this.suppressed = this.connected;
  }

  poll(now) {
    let pads = [];
    if (this.supported) {
      try {
        pads = Array.from(this.navigator.getGamepads());
      } catch (error) {
        if (!['SecurityError', 'NotAllowedError'].includes(error?.name)) throw error;
        this.supported = false;
        console.warn('Browser controller access is unavailable.', error);
        this.onError(error);
      }
    }
    const connected = pads.filter(pad => pad && pad.connected);
    const pad = connected.find(pad => pad.index === this.index) || connected[0];
    const key = pad ? `${pad.index}:${pad.id}` : null;
    const changed = key !== this.key;
    const lost = this.key !== null && changed;
    if (changed) {
      this.stopRumble();
      this.rumbleBlocked = false;
      this.previous = [];
      this.navDirection = 0;
      this.suppressed = false;
    }
    this.key = key;
    this.index = pad?.index ?? null;
    this.connected = Boolean(pad);
    this.actuator = pad?.vibrationActuator || pad?.hapticActuators?.[0] || null;
    if (!pad) return { connected: false, changed, lost, input: EMPTY_GAMEPAD_INPUT, actions: {}, hasFlightInput: false };

    const buttons = Array.from(pad.buttons, pressed);
    const x = axis(pad.axes[0]);
    const y = axis(pad.axes[1]);
    const magnitude = Math.min(1, Math.hypot(x, y));
    const stickActive = magnitude > GAMEPAD_DEAD_ZONE;
    const neutral = !stickActive && !buttons.some(Boolean);
    if (this.suppressed && neutral) this.suppressed = false;
    const edge = index => Boolean(buttons[index] && !this.previous[index]);
    let input = EMPTY_GAMEPAD_INPUT;
    const actions = {};
    if (!this.suppressed) {
      input = {
        left: Boolean(buttons[14]), right: Boolean(buttons[15]),
        thrust: Math.max(buttons[12] ? 1 : 0, stickActive ? (magnitude - GAMEPAD_DEAD_ZONE) / (1 - GAMEPAD_DEAD_ZONE) : 0),
        brake: Boolean(buttons[13] || buttons[2]),
        fire: Boolean(buttons[0] || buttons[7]),
        shield: Boolean(buttons[1] || buttons[5]),
        aim: stickActive ? Math.atan2(y, x) : null,
      };
      Object.assign(actions, { confirm: edge(0), cancel: edge(1), pause: edge(9), console: edge(8), vertical: 0 });
      const direction = buttons[12] || y < -0.55 ? -1 : buttons[13] || y > 0.55 ? 1 : 0;
      if (direction && (direction !== this.navDirection || now >= this.navRepeatAt)) {
        actions.vertical = direction;
        this.navRepeatAt = now + (direction === this.navDirection ? 140 : 350);
      }
      this.navDirection = direction;
    } else {
      this.navDirection = 0;
    }
    this.previous = buttons;
    return {
      connected: true, changed, lost, standard: pad.mapping === 'standard',
      input, actions,
      hasFlightInput: Boolean(input.left || input.right || input.thrust || input.brake || input.fire || input.shield),
    };
  }

  get rumbleSupported() {
    return !this.rumbleBlocked && (typeof this.actuator?.playEffect === 'function' || typeof this.actuator?.pulse === 'function');
  }

  rumble(level) {
    if (!Number.isInteger(level) || level < 1 || level > 4) throw new RangeError('Impact size must be 1 through 4.');
    if (!this.connected || !this.rumbleSupported || (this.now() < this.rumbleUntil && level <= this.rumbleLevel)) return false;
    const profiles = [
      null,
      { duration: 65, weakMagnitude: 0.28, strongMagnitude: 0.18 },
      { duration: 115, weakMagnitude: 0.5, strongMagnitude: 0.42 },
      { duration: 180, weakMagnitude: 0.75, strongMagnitude: 0.7 },
      { duration: 340, weakMagnitude: 1, strongMagnitude: 1 },
    ];
    const effect = profiles[level];
    const actuator = this.actuator;
    const epoch = ++this.rumbleEpoch;
    this.rumbleUntil = this.now() + effect.duration;
    this.rumbleLevel = level;
    const fail = () => {
      if (epoch !== this.rumbleEpoch || actuator !== this.actuator) return;
      this.rumbleBlocked = true;
      console.warn('This controller/browser declined impact rumble.');
      this.onRumbleUnavailable();
    };
    try {
      const result = typeof actuator.playEffect === 'function'
        ? actuator.playEffect('dual-rumble', { startDelay: 0, ...effect })
        : actuator.pulse(effect.strongMagnitude, effect.duration);
      Promise.resolve(result).then(value => {
        if (value === false || value === 'not-supported') fail();
      }, fail);
    } catch { fail(); }
    return true;
  }

  stopRumble() {
    this.rumbleEpoch++;
    this.rumbleUntil = 0;
    this.rumbleLevel = 0;
    const actuator = this.actuator;
    if (!actuator) return;
    try {
      const stopped = typeof actuator.reset === 'function' ? actuator.reset() : typeof actuator.pulse === 'function' ? actuator.pulse(0, 0) : actuator.playEffect?.('dual-rumble', { duration: 0, weakMagnitude: 0, strongMagnitude: 0 });
      Promise.resolve(stopped).catch(() => console.warn('The browser could not reset controller rumble.'));
    } catch { console.warn('The browser could not reset controller rumble.'); }
  }
}
