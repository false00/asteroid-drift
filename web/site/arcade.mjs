import * as THREE from './vendor/three.module.js';
import { Game, SHIELD_RECHARGE, CHEATS } from './engine.mjs?v=20261024.7';
import { Synth, Haptics, FrameRateMeter } from './feedback.mjs?v=20261024.5';
import { GameplayTelemetry } from './telemetry.mjs?v=20261024.7';
import { GamepadInput, EMPTY_GAMEPAD_INPUT } from './gamepad.mjs?v=20261024.5';
import { Identity, AccountError } from './identity.mjs?v=20261024.7';
import { RankedClient } from './ranked-client.mjs?v=20261024.7';
import { FullscreenControls, editable } from './fullscreen.mjs?v=20261024.5';

const $ = id => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing arcade element: ${id}`);
  return element;
};
const canvas = $('game');
const playfield = $('playfield');
const cabinet = playfield.closest('.cabinet');
if (!cabinet) throw new Error('Missing arcade cabinet.');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = matchMedia('(any-pointer: coarse)');
const touchMode = () => coarsePointer.matches || navigator.maxTouchPoints > 0;
const pad = (value, length = 6) => String(value).padStart(length, '0');
let noticeTimer;

function notify(message, duration = 5000) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  if (duration) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, duration);
}

let storageAvailable = true;
function storage(operation) {
  if (!storageAvailable) return null;
  try {
    return operation(localStorage);
  } catch (error) {
    if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error;
    storageAvailable = false;
    console.warn('Arcade browser storage is unavailable.', error);
    notify('Browser storage is unavailable. Your best score will last for this visit only.');
    return null;
  }
}

const BEST_KEY = 'curlred.asteroid-drift.best';
const SOUND_KEY = 'curlred.asteroid-drift.sound';
let best = 0;
const savedBest = storage(store => store.getItem(BEST_KEY));
if (savedBest !== null) {
  const value = Number(savedBest);
  if (Number.isSafeInteger(value) && value >= 0 && savedBest.trim() !== '') best = value;
  else {
    console.warn('Ignoring an invalid saved arcade score.');
    notify('The saved score was invalid. A fresh local record has been started.');
  }
}
const savedSound = storage(store => store.getItem(SOUND_KEY));
if (savedSound !== null && !['on', 'off'].includes(savedSound)) {
  console.warn('Ignoring an invalid saved sound preference.');
  notify('The saved sound setting was invalid. Sound can be changed with the speaker button.');
}

class FlightRenderer {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x090c0f);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 2000);
    this.camera.position.z = 1000;
    this.rocks = new Map();
    this.pickups = new Map();
    this.rockMaterial = new THREE.LineBasicMaterial({ color: 0xa6b5b1, transparent: true, opacity: 0.76, depthTest: false });
    this.redMaterial = new THREE.LineBasicMaterial({ color: 0xff604c, depthTest: false });
    this.shipMaterial = new THREE.LineBasicMaterial({ color: 0xf1efe5, depthTest: false });
    this.ship = new THREE.Group();
    this.shipBody = new THREE.Line(this.geometry([[17, 0], [-11, -10], [-6, 0], [-11, 10], [17, 0]]), this.shipMaterial);
    this.flame = new THREE.Line(this.geometry([[-10, -5], [-25, 0], [-10, 5]]), this.redMaterial);
    this.shield = new THREE.LineLoop(this.geometry(Array.from({ length: 48 }, (_, i) => [Math.cos(i / 48 * Math.PI * 2) * 27, Math.sin(i / 48 * Math.PI * 2) * 27])), this.redMaterial);
    this.ship.add(this.shipBody, this.flame, this.shield);
    this.scene.add(this.ship);

    this.bulletPositions = new Float32Array(80 * 6);
    this.bulletGeometry = new THREE.BufferGeometry();
    this.bulletGeometry.setAttribute('position', new THREE.BufferAttribute(this.bulletPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.bulletGeometry.setDrawRange(0, 0);
    this.bulletLines = new THREE.LineSegments(this.bulletGeometry, this.shipMaterial);
    this.bulletLines.frustumCulled = false;
    this.scene.add(this.bulletLines);

    this.particlePositions = new Float32Array(200 * 3);
    this.particleColors = new Float32Array(200 * 3);
    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setDrawRange(0, 0);
    this.particlePoints = new THREE.Points(this.particleGeometry, new THREE.PointsMaterial({ size: 2.1, sizeAttenuation: false, vertexColors: true, depthTest: false }));
    this.particlePoints.frustumCulled = false;
    this.scene.add(this.particlePoints);

    this.starPositions = new Float32Array(160 * 3);
    this.starGeometry = new THREE.BufferGeometry();
    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(this.starPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.stars = new THREE.Points(this.starGeometry, new THREE.PointsMaterial({ color: 0x829099, size: 1.25, sizeAttenuation: false, transparent: true, opacity: 0.42, depthTest: false }));
    this.scene.add(this.stars);
    this.orbits = new THREE.Group();
    const orbitMaterial = new THREE.LineBasicMaterial({ color: 0x4a5a65, transparent: true, opacity: 0.19, depthTest: false });
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.LineLoop(this.geometry(Array.from({ length: 100 }, (_, n) => [Math.cos(n / 100 * Math.PI * 2), Math.sin(n / 100 * Math.PI * 2)])), orbitMaterial);
      ring.rotation.x = 0.7 + i * 0.65;
      ring.rotation.z = -0.4 + i * 0.9;
      this.orbits.add(ring);
    }
    this.scene.add(this.orbits);
    const octahedron = new THREE.OctahedronGeometry(1);
    this.pickupGeometry = new THREE.EdgesGeometry(octahedron);
    octahedron.dispose();
  }

  geometry(points) {
    return new THREE.BufferGeometry().setFromPoints(points.map(([x, y, z = 0]) => new THREE.Vector3(x, y, z)));
  }

  resize(width, height, worldWidth = width, worldHeight = height) {
    this.renderer.setSize(width, height, false);
    this.worldWidth = Math.sqrt(worldWidth * worldHeight * width / height);
    this.worldHeight = worldWidth * worldHeight / this.worldWidth;
    this.viewport = { x: 0, y: 0, width, height };
    this.camera.right = this.worldWidth;
    this.camera.bottom = this.worldHeight;
    this.camera.updateProjectionMatrix();
    let seed = 391;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 160; i++) {
      this.starPositions[i * 3] = random() * this.worldWidth;
      this.starPositions[i * 3 + 1] = random() * this.worldHeight;
      this.starPositions[i * 3 + 2] = -100;
    }
    this.starGeometry.attributes.position.needsUpdate = true;
    this.starGeometry.computeBoundingSphere();
    this.orbits.position.set(this.worldWidth / 2, this.worldHeight / 2, -50);
    this.orbits.scale.setScalar(Math.min(this.worldWidth, this.worldHeight) * 0.45);
  }

  project(x, y, worldWidth, worldHeight) {
    return { x: x / worldWidth * this.viewport.width, y: y / worldHeight * this.viewport.height };
  }

  clearEntities() {
    for (const visual of this.rocks.values()) {
      visual.lines.forEach(line => this.scene.remove(line));
      visual.geometry.dispose();
    }
    this.rocks.clear();
    for (const line of this.pickups.values()) this.scene.remove(line);
    this.pickups.clear();
  }

  rockVisual(rock) {
    const segments = [];
    const vertex = (i, back = false) => {
      const point = rock.outline[i % rock.outline.length];
      return [Math.cos(point.angle) * point.radius * (back ? 0.65 : 1), Math.sin(point.angle) * point.radius * (back ? 0.65 : 1), back ? -0.42 : 0.16];
    };
    for (let i = 0; i < rock.outline.length; i++) {
      segments.push(vertex(i), vertex(i + 1));
      if (i % 3 === 0) segments.push(vertex(i), vertex(i, true), vertex(i, true), vertex(i + 3, true));
    }
    const geometry = this.geometry(segments);
    const lines = Array.from({ length: 4 }, () => {
      const line = new THREE.LineSegments(geometry, this.rockMaterial);
      this.scene.add(line);
      return line;
    });
    return { geometry, lines };
  }

  render(game, time, shake) {
    const scaleX = this.worldWidth / game.width;
    const scaleY = this.worldHeight / game.height;
    const activeRocks = new Set(game.asteroids.map(rock => rock.id));
    for (const [id, visual] of this.rocks) {
      if (activeRocks.has(id)) continue;
      visual.lines.forEach(line => this.scene.remove(line));
      visual.geometry.dispose();
      this.rocks.delete(id);
    }
    this.rockMaterial.opacity = game.state === 'ready' ? 0.56 : 0.82;
    for (const rock of game.asteroids) {
      if (!this.rocks.has(rock.id)) this.rocks.set(rock.id, this.rockVisual(rock));
      const visual = this.rocks.get(rock.id);
      const x = rock.x * scaleX;
      const y = rock.y * scaleY;
      const xOffset = x < rock.radius ? this.worldWidth : x > this.worldWidth - rock.radius ? -this.worldWidth : 0;
      const yOffset = y < rock.radius ? this.worldHeight : y > this.worldHeight - rock.radius ? -this.worldHeight : 0;
      const offsets = [[0, 0], [xOffset, 0], [0, yOffset], [xOffset, yOffset]];
      visual.lines.forEach((line, i) => {
        line.visible = i === 0 || (i === 1 ? xOffset !== 0 : i === 2 ? yOffset !== 0 : xOffset !== 0 && yOffset !== 0);
        line.position.set(x + offsets[i][0], y + offsets[i][1], 0);
        line.rotation.set(Math.sin(time * 0.18 + rock.id) * 0.33, Math.cos(time * 0.14 + rock.id) * 0.3, rock.angle);
        line.scale.setScalar(rock.radius);
      });
    }
    this.ship.visible = game.state !== 'ready' && game.state !== 'gameover';
    this.ship.position.set(game.ship.x * scaleX, game.ship.y * scaleY, 10);
    this.ship.rotation.z = game.ship.angle;
    this.ship.scale.setScalar(game.scale);
    this.shipBody.visible = game.ship.invulnerable === 0 || Math.floor(time * 12) % 2 === 0;
    this.flame.visible = game.ship.thrust > 0 && game.state === 'playing';
    this.flame.scale.x = 0.8 + Math.sin(time * 71) * 0.17;
    this.shield.visible = game.shieldTime > 0 || game.cheats.invincible;
    this.shield.scale.setScalar(1 + Math.sin(time * 15) * 0.035);

    const bullets = game.bullets.slice(0, 80);
    bullets.forEach((bullet, i) => {
      const speed = Math.hypot(bullet.vx, bullet.vy);
      const x = bullet.x * scaleX;
      const y = bullet.y * scaleY;
      this.bulletPositions.set([x, y, 5, x - bullet.vx / speed * 9, y - bullet.vy / speed * 9, 5], i * 6);
    });
    this.bulletGeometry.setDrawRange(0, bullets.length * 2);
    this.bulletGeometry.attributes.position.needsUpdate = true;
    const particles = reducedMotion.matches ? [] : game.particles;
    particles.forEach((particle, i) => {
      this.particlePositions.set([particle.x * scaleX, particle.y * scaleY, 5], i * 3);
      const fade = particle.life / particle.maxLife;
      this.particleColors.set(particle.color === 'red' ? [fade, 0.16 * fade, 0.08 * fade] : [0.85 * fade, 0.9 * fade, 0.72 * fade], i * 3);
    });
    this.particleGeometry.setDrawRange(0, particles.length);
    this.particleGeometry.attributes.position.needsUpdate = true;
    this.particleGeometry.attributes.color.needsUpdate = true;
    const activePickups = new Set(game.pickups.map(pickup => pickup.id));
    for (const [id, line] of this.pickups) {
      if (!activePickups.has(id)) {
        this.scene.remove(line);
        this.pickups.delete(id);
      }
    }
    for (const pickup of game.pickups) {
      if (!this.pickups.has(pickup.id)) {
        const line = new THREE.LineSegments(this.pickupGeometry, this.redMaterial);
        this.pickups.set(pickup.id, line);
        this.scene.add(line);
      }
      const line = this.pickups.get(pickup.id);
      line.position.set(pickup.x * scaleX, pickup.y * scaleY, 5);
      line.rotation.set(0.5, time, pickup.angle);
      line.scale.setScalar(pickup.radius * (1 + Math.sin(time * 5) * 0.1));
      line.visible = pickup.life > 3 || Math.floor(time * 8) % 2 === 0;
    }
    this.orbits.visible = game.state === 'ready';
    this.camera.position.x = shake ? Math.sin(time * 93) * shake : 0;
    this.camera.position.y = shake ? Math.cos(time * 87) * shake : 0;
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setViewport(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.renderer.setScissor(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
  }
}

const rect = playfield.getBoundingClientRect();
const casualGame = new Game(Math.max(1, rect.width), Math.max(1, rect.height));
let game = casualGame;
const synth = new Synth({
  muted: savedSound === 'off',
  onFailure: () => {
    updateSoundButton();
    notify('Sound could not start. Tap the speaker to retry; on iPhone also check the volume and Silent Mode.');
  },
});
const haptics = new Haptics({
  onUnavailable: () => {
    updateHapticsButton();
    notify('This browser declined vibration. Sound and visual feedback are still available.');
  },
});
const telemetry = new GameplayTelemetry({
  settings: () => ({ sound: !synth.muted, haptics: haptics.enabled }),
  onWarning: () => notify('Gameplay statistics are temporarily offline. Your game and local high score still work.'),
});
const controller = new GamepadInput({
  onError: () => {
    updateControllerHints();
    notify('This browser blocks controller access. Keyboard and touch controls still work.');
  },
  onRumbleUnavailable: () => notify('Controller rumble is unavailable in this browser/device. Flight, audio, and visuals still work.'),
});
const frameRate = new FrameRateMeter();
const keys = new Set();
const actionPointers = new Map();
const floaterNodes = new Map();
let stickPointer = null;
let stickAim = null;
let stickThrust = 0;
let tapFire = 0;
let tapShield = false;
let menuMode = 'ready';
let consoleReturnState = 'ready';
let runStartingBest = best;
let dirty = true;
let graphicsLost = false;
let view;
let lastLives = -1;
let shake = 0;
let visualTime = 0;
let frame = 0;
let previousTime = 0;
let accumulator = 0;
let keyboardFocus = !touchMode();
let controllerInput = EMPTY_GAMEPAD_INPUT;
let usingController = false;
let controllerAudioGesture = false;
let resizeView = () => {};
const identity = new Identity({
  notify,
  onPause: () => { pauseGame(); clearInput(); },
  onChange: session => {
    if (ranked.active && session.authenticated && ranked.accountId !== session.user.id) leaveRanked();
    dirty = true;
  },
});
const ranked = new RankedClient({
  identity, notify,
  onFrame: () => { dirty = true; },
  onState: state => {
    if (!ranked.active) return;
    game = ranked.game;
    if (state === 'playing') {
      $('menu').hidden = true;
      playfield.classList.remove('console-open');
      document.body.dataset.state = 'playing';
      $('pause').disabled = false;
      $('pause').setAttribute('aria-label', 'Pause game');
      previousTime = 0;
      dirty = true;
    } else if (state === 'paused' && !['manual', 'console'].includes(menuMode)) {
      clearInput();
      showMenu('paused');
    }
  },
  onFinish: result => {
    ranked.result = result;
    clearInput();
    showMenu('gameover');
    $('announcer').textContent = `Server verified score ${result.score}. ${result.rank ? `Your account is number ${result.rank} in the top ten.` : 'This score did not reach the top ten.'}`;
  },
});
new FullscreenControls({ element: cabinet, button: $('fullscreen'), notify });

function noteInput(event, kind) {
  telemetry.noteInput(event, kind);
  if (ranked.active && event.isTrusted) ranked.noteControl(kind);
}

function rankedFailure(error) {
  if (error instanceof AccountError) {
    notify(error.message);
    if (error.status === 401 || error.code === 'authentication_required') identity.open();
  } else {
    console.error('A ranked flight operation failed; account credentials were not logged.');
    notify('The ranked flight could not be completed. Your unverified browser score will not be uploaded.');
  }
}

function leaveRanked() {
  ranked.leave();
  game = casualGame;
  game.state = 'ready';
  clearInput();
  view?.clearEntities();
  resizeView(true);
  showMenu('ready');
  updateHud();
}

async function startRanked(event) {
  if (!identity.session.authenticated) { identity.open(); return; }
  if (!view || graphicsLost) { notify('Graphics must be available before starting a ranked flight.'); return; }
  haptics.activate(event);
  $('ranked').disabled = true;
  try {
    const rect = playfield.getBoundingClientRect();
    ranked.setViewport(rect.width, rect.height);
    if (ranked.active && !ranked.finished) {
      await ranked.resume();
      return;
    }
    telemetry.flush('restart', game);
    clearInput();
    ranked.leave();
    ranked.result = null;
    const starting = ranked.start();
    game = ranked.game;
    view.clearEntities();
    resizeView(true);
    showMenu('paused');
    await starting;
    void synth.unlock('launch');
    notify('RANKED FLIGHT // Server-owned physics and score. No cheats. Active flights have no duration cap.', 4500);
  } catch (error) {
    if (!ranked.runId) leaveRanked();
    rankedFailure(error);
  } finally { $('ranked').disabled = false; }
}
$('ranked').addEventListener('click', event => { void startRanked(event); });
$('finish-ranked').addEventListener('click', () => {
  try { ranked.action('finish'); }
  catch (error) { rankedFailure(error); }
});
$('leave-ranked').addEventListener('click', leaveRanked);

function resetFrameRate() {
  frameRate.reset();
  if ($('fps').textContent !== '--') $('fps').textContent = '--';
}

function updateControllerHints() {
  $('controller-help').textContent = controller.supported
    ? 'Pair a USB/Bluetooth controller with your device, focus this page, and press a pad button. Left stick: steer + thrust. A/RT: fire. B/RB: shield. X: brake. Start: launch/pause. D-pad: menus; A: select; B: back; Select: cheat console. A click, tap, or key may be required for audio.'
    : 'The Gamepad API is unavailable here. Keyboard and touch controls remain available.';
  if (view && !graphicsLost) $('system-status').textContent = controller.connected ? 'CONTROLLER READY' : 'ALL SYSTEMS GO';
  const launching = ['ready', 'gameover'].includes(menuMode);
  $('start-hint').textContent = controller.connected
    ? launching ? 'A / START TO LAUNCH' : 'A SELECT / B BACK / START CONTINUE'
    : launching ? 'OR PRESS ENTER TO LAUNCH' : 'PRESS ENTER TO CONTINUE';
  $('touch-start-hint').textContent = controller.connected
    ? launching ? 'A / START TO LAUNCH' : 'A SELECT / B BACK / START CONTINUE'
    : 'TWO THUMBS. INFINITE POSSIBILITIES.';
}

function unlockControllerAudio(event) {
  if (!controllerAudioGesture || !event.isTrusted || navigator.userActivation?.hasBeenActive === false) return;
  controllerAudioGesture = false;
  haptics.activate(event);
  void synth.unlock();
}

function prepareControllerAudio() {
  if (synth.muted || synth.context?.state === 'running' || navigator.userActivation?.hasBeenActive === true) return;
  if (!controllerAudioGesture) notify('Controller flight is ready. Click, tap, or press a key once to enable audio.');
  controllerAudioGesture = true;
}

function focusMenuButton(button) {
  button.focus({ preventScroll: true });
  const scroller = button.closest('.cheat-list, .menu-content');
  if (!scroller) return;
  const target = button.getBoundingClientRect();
  const bounds = scroller.getBoundingClientRect();
  if (target.top < bounds.top) scroller.scrollTop -= bounds.top - target.top;
  else if (target.bottom > bounds.bottom) scroller.scrollTop += target.bottom - bounds.bottom;
}

function processController(now) {
  const state = controller.poll(now);
  controllerInput = state.input;
  if (state.changed) {
    updateControllerHints();
    if (state.connected && !state.lost) {
      notify(state.standard ? 'Controller connected. A/RT fire, B/RB shield, Start pause.' : 'Controller detected with a custom mapping; common stick/button controls are enabled.');
    }
  }
  if (state.lost) {
    const paused = usingController && game.state === 'playing';
    if (paused) pauseGame();
    controller.suppressUntilNeutral();
    controllerInput = EMPTY_GAMEPAD_INPUT;
    usingController = false;
    notify(paused ? 'Controller disconnected. Flight paused; reconnect or use keyboard/touch.' : 'Controller disconnected. Keyboard and touch still work.');
    return;
  }
  if (!state.connected || graphicsLost) return;
  if (identity.dialog.open) return;
  const actions = state.actions;
  if (actions.pause || actions.console) {
    keyboardFocus = !touchMode();
    prepareControllerAudio();
    if (actions.console) {
      showConsole();
      if (!$('console-view').hidden) focusMenuButton($('cheat-infiniteLives'));
    } else if (game.state === 'playing') pauseGame();
    else launch();
    if (game.state === 'playing') usingController = true;
    controller.suppressUntilNeutral();
    controllerInput = EMPTY_GAMEPAD_INPUT;
    return;
  }
  if (!$('menu').hidden) {
    const buttons = [...$('menu').querySelectorAll('button')].filter(button => !button.disabled && button.getClientRects().length);
    if (actions.vertical && menuMode === 'manual') {
      $('manual').scrollTop += actions.vertical * 60;
    } else if (actions.vertical && buttons.length) {
      const current = buttons.indexOf(document.activeElement);
      const next = current < 0 ? actions.vertical > 0 ? 0 : buttons.length - 1 : (current + actions.vertical + buttons.length) % buttons.length;
      focusMenuButton(buttons[next]);
    }
    if (actions.confirm || actions.cancel) {
      keyboardFocus = !touchMode();
      prepareControllerAudio();
      if (actions.cancel) {
        if (menuMode === 'console') closeConsole();
        else if (menuMode === 'manual' || game.state === 'paused') launch();
      } else {
        const button = buttons.includes(document.activeElement) ? document.activeElement : $('launch');
        button.click();
      }
      if (game.state === 'playing') usingController = true;
      controller.suppressUntilNeutral();
      controllerInput = EMPTY_GAMEPAD_INPUT;
    }
    return;
  }
  if (game.state === 'playing' && state.hasFlightInput) {
    keyboardFocus = !touchMode();
    usingController = true;
    telemetry.noteGamepadInput();
    if (ranked.active) ranked.noteControl('gamepad');
  }
}

function focusControl(element) {
  if (document.hidden || !document.hasFocus()) return;
  if (keyboardFocus) element.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement && cabinet.contains(document.activeElement)) document.activeElement.blur();
}

function updateSoundButton() {
  $('sound').setAttribute('aria-pressed', String(!synth.muted));
  $('sound').setAttribute('aria-label', synth.muted ? 'Enable sound' : 'Mute sound');
}

function toggleSound() {
  synth.setMuted(!synth.muted);
  storage(store => store.setItem(SOUND_KEY, synth.muted ? 'off' : 'on'));
  updateSoundButton();
  if (synth.muted) synth.setThrust(0);
  else void synth.unlock();
}

function resetStick() {
  stickPointer = null;
  stickAim = null;
  stickThrust = 0;
  $('joystick').classList.remove('active');
  $('stick-thumb').style.transform = 'translate(0px, 0px)';
}

function clearInput() {
  keys.clear();
  actionPointers.clear();
  resetStick();
  tapFire = 0;
  tapShield = false;
  $('touch-fire').classList.remove('active');
  $('touch-shield').classList.remove('active');
  synth.setThrust(0);
  haptics.stop();
  controller.stopRumble();
  controller.suppressUntilNeutral();
  controllerInput = EMPTY_GAMEPAD_INPUT;
  usingController = false;
  resetFrameRate();
}

function showMenu(mode) {
  menuMode = mode;
  $('menu').hidden = false;
  $('intro').hidden = mode !== 'ready';
  $('result').hidden = !['paused', 'gameover'].includes(mode);
  $('manual').hidden = mode !== 'manual';
  $('console-view').hidden = mode !== 'console';
  $('menu').classList.toggle('console-mode', mode === 'console');
  $('menu').classList.toggle('manual-mode', mode === 'manual');
  playfield.classList.toggle('console-open', mode === 'console');
  $('menu').setAttribute('aria-labelledby', mode === 'console' ? 'console-title' : mode === 'manual' ? 'manual-title' : mode === 'ready' ? 'game-title' : 'result-title');
  $('run-stats').hidden = mode !== 'gameover';
  $('ranked').parentElement.hidden = !['ready', 'paused', 'gameover'].includes(mode);
  $('finish-ranked').hidden = !ranked.active || ranked.finished || mode !== 'paused';
  $('leave-ranked').hidden = !ranked.active;
  $('ranked').textContent = ranked.active && !ranked.finished ? 'RESUME RANKED FLIGHT' : identity.session.authenticated ? 'RANKED FLIGHT' : 'RANKED / SIGN IN';
  $('launch-label').textContent = mode === 'ready' ? 'LAUNCH GAME' : mode === 'paused' ? 'BACK TO FLIGHT' : mode === 'gameover' ? 'ONE MORE RUN' : mode === 'console' && consoleReturnState !== 'playing' ? 'BACK TO ARCADE' : game.state === 'paused' ? 'BACK TO FLIGHT' : 'BACK TO ARCADE';
  updateControllerHints();
  resetFrameRate();
  if (mode === 'paused') {
    $('result-eyebrow').textContent = 'TAKE A BREATHER';
    $('result-title').textContent = 'FLIGHT PAUSED';
    $('result-copy').textContent = 'The universe can wait.';
  } else if (mode === 'gameover') {
    $('result-eyebrow').textContent = game.cheated ? 'SANDBOX FLIGHT COMPLETE' : game.score > runStartingBest ? 'A NEW PERSONAL BEST' : 'THAT WAS A GOOD RUN';
    $('result-title').textContent = 'LOST IN SPACE';
    $('result-copy').textContent = game.cheated ? 'Cheat runs are for fun. Your normal personal best is untouched.' : game.score > runStartingBest ? 'The void is impressed. Got another one in you?' : 'Your next great run is one launch away.';
    $('final-score').textContent = pad(game.score);
    $('final-wave').textContent = pad(game.wave, 2);
    if (ranked.active) {
      $('launch-label').textContent = 'CASUAL FLIGHT';
      $('result-eyebrow').textContent = ranked.finished ? 'SERVER VERIFIED FLIGHT' : 'VERIFYING SERVER RESULT';
      $('result-copy').textContent = !ranked.finished ? 'Waiting for the server to commit the result. No browser score is accepted.' : ranked.result?.rank ? `Verified. Your account holds position ${ranked.result.rank} in the global top ten.` : 'Verified. Only the ten best per-account scores remain on the public board.';
    }
  }
  document.body.dataset.state = game.state;
  $('pause').disabled = !['playing', 'paused'].includes(game.state);
  $('pause').setAttribute('aria-label', game.state === 'paused' ? 'Resume game' : 'Pause game');
  $('wave-banner').hidden = true;
  $('flight-status').hidden = true;
  dirty = true;
}

function pauseGame(reason = 'pause') {
  if (!game.pause()) return;
  if (ranked.active) {
    try { ranked.action('pause'); }
    catch (error) { rankedFailure(error); }
  } else telemetry.flush(reason, game);
  clearInput();
  synth.play('pause');
  showMenu('paused');
  focusControl($('launch'));
  $('announcer').textContent = 'Flight paused.';
}

function resumeGame(event) {
  if (ranked.active) {
    if (!graphicsLost) {
      haptics.activate(event);
      clearInput();
      void ranked.resume().catch(rankedFailure);
    }
    return;
  }
  if (graphicsLost || !game.resume()) return;
  haptics.activate(event);
  clearInput();
  $('menu').hidden = true;
  playfield.classList.remove('console-open');
  document.body.dataset.state = game.state;
  $('pause').setAttribute('aria-label', 'Pause game');
  focusControl(canvas);
  void synth.unlock('resume');
  accumulator = 0;
  dirty = true;
}

function launch(event) {
  if (!view || graphicsLost) return;
  haptics.activate(event);
  if (menuMode === 'console' && !$('menu').hidden) {
    closeConsole(event);
    return;
  }
  if (menuMode === 'manual') {
    if (game.state === 'paused') resumeGame(event);
    else showMenu(game.state);
    return;
  }
  if (game.state === 'paused') {
    resumeGame(event);
    return;
  }
  if (ranked.active) leaveRanked();
  telemetry.flush('restart', game);
  clearInput();
  runStartingBest = best;
  game.start();
  synth.lastCombo = 1;
  telemetry.begin(touchMode() ? Math.min(screen.width, screen.height) < 700 ? 'phone' : 'tablet' : 'desktop');
  $('menu').hidden = true;
  document.body.dataset.state = game.state;
  $('pause').disabled = false;
  $('pause').setAttribute('aria-label', 'Pause game');
  focusControl(canvas);
  void synth.unlock('launch');
  accumulator = 0;
  dirty = true;
}

function showManual() {
  if (menuMode === 'manual' && !$('menu').hidden) {
    launch();
    return;
  }
  if (ranked.active) pauseGame();
  else if (game.pause()) telemetry.flush('pause', game);
  clearInput();
  showMenu('manual');
  focusControl($('launch'));
}

function updateHapticsButton() {
  $('haptics-toggle').disabled = !haptics.supported;
  $('haptics-toggle').setAttribute('aria-pressed', String(haptics.enabled));
  $('haptics-label').textContent = !haptics.supported ? 'UNAVAILABLE' : haptics.enabled ? 'ON' : 'OFF';
  $('haptics-help').textContent = haptics.supported ? 'Short firing pulses and size-scaled impacts. Supported controllers rumble on hits, with the strongest blast for ship destruction.' : 'iPhone Safari exposes neither phone vibration nor controller rumble. Supported desktop browsers/controllers can rumble on impacts; sound and visuals always remain available.';
}

function updateConsole() {
  for (const cheat of CHEATS) {
    const button = $(`cheat-${cheat.key}`);
    button.disabled = ranked.active;
    button.setAttribute('aria-pressed', String(game.cheats[cheat.key]));
    button.querySelector('.cheat-state').textContent = game.cheats[cheat.key] ? 'ON' : 'OFF';
  }
  $('console-mode').textContent = ranked.active ? 'RANKED: CHEATS LOCKED BY THE SERVER' : game.cheated || game.cheatMask() ? 'SANDBOX OVERRIDES ACTIVE' : 'ALL SYSTEMS NOMINAL';
  updateHapticsButton();
}

function closeConsole(event) {
  if (consoleReturnState === 'playing') resumeGame(event);
  else {
    showMenu(consoleReturnState);
    focusControl($('console'));
  }
}

function showConsole(event) {
  if (menuMode === 'console' && !$('menu').hidden) {
    closeConsole(event);
    return;
  }
  consoleReturnState = game.state;
  if (ranked.active) pauseGame();
  else if (game.pause()) telemetry.flush('console', game);
  clearInput();
  haptics.activate(event);
  void synth.unlock('console');
  updateConsole();
  showMenu('console');
  focusControl($('cheat-infiniteLives'));
}

for (const [i, cheat] of CHEATS.entries()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cheat-toggle';
  button.id = `cheat-${cheat.key}`;
  button.setAttribute('aria-pressed', 'false');
  const number = document.createElement('span');
  number.className = 'cheat-number';
  number.textContent = pad(i + 1, 2);
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = cheat.title;
  const description = document.createElement('small');
  description.textContent = cheat.description;
  copy.append(title, description);
  const state = document.createElement('span');
  state.className = 'cheat-state';
  state.textContent = 'OFF';
  button.append(number, copy, state);
  button.addEventListener('click', () => {
    if (ranked.active) { notify('Ranked cheats are disabled. Return to casual flight to use local overrides.'); return; }
    game.setCheat(cheat.key, !game.cheats[cheat.key]);
    synth.play('toggle');
    updateConsole();
    updateHud();
    dirty = true;
    $('announcer').textContent = `${cheat.title} ${game.cheats[cheat.key] ? 'enabled' : 'disabled'}. Sandbox scores do not replace your normal best.`;
  });
  $('cheat-list').append(button);
}
$('console').addEventListener('click', showConsole);
$('console-close').addEventListener('click', closeConsole);
$('haptics-toggle').addEventListener('click', event => {
  haptics.activate(event);
  haptics.setEnabled(!haptics.enabled);
  if (haptics.enabled) haptics.pulse();
  updateHapticsButton();
});

function handleEvents() {
  let impact = 0;
  for (const event of game.drainEvents()) {
    if (event.type === 'hit') {
      impact = Math.max(impact, event.size);
      if (ranked.active) {
        game.burst(event.x, event.y, 8 + event.size * 5, 'cream');
        game.addFloater(event.x, event.y, `+${event.points}`, event.multiplier > 1 ? 'red' : 'cream');
      }
    } else if (event.type === 'death') {
      impact = 4;
      if (ranked.active) game.burst(event.x, event.y, 45, 'red');
    }
    if (event.type === 'wave') {
      $('wave-message').textContent = `WAVE ${pad(event.wave, 2)}`;
      $('wave-subtitle').textContent = event.wave === 1 ? 'MAKE YOURSELF SOME SPACE' : 'CLEAR THE BELT';
      $('announcer').textContent = `Wave ${event.wave}. ${game.lives} ships remaining.`;
      if (event.wave > 1) synth.play('wave');
    } else if (event.type === 'clear') {
      $('wave-message').textContent = 'BELT CLEARED';
      $('wave-subtitle').textContent = 'CATCH YOUR BREATH. MORE INCOMING.';
      synth.play('clear');
    } else if (event.type === 'gameover') {
      if (!ranked.active) telemetry.flush('gameover', game);
      synth.play('gameover');
      showMenu('gameover');
      focusControl($('launch'));
      $('announcer').textContent = `Run complete. Score ${event.score}. Wave ${event.wave}.`;
    } else if (event.type === 'extra-life') {
      notify('10,000 POINTS // EXTRA SHIP', 2500);
      synth.play('extra-life');
    } else if (event.type === 'pickup') {
      notify(event.kind === 'triple' ? 'TRIPLE SHOT // 10 SECONDS' : 'SHIELD RECHARGED // GO MAKE TROUBLE', 2500);
      synth.play('pickup');
    } else {
      synth.play(event.type, event.size);
      if (event.type === 'shot') haptics.pulse();
      if (event.type === 'hit') {
        if (event.multiplier > synth.lastCombo) synth.play('combo');
        synth.lastCombo = event.multiplier;
      }
      if (!reducedMotion.matches && ['hit', 'death'].includes(event.type)) shake = event.type === 'death' ? 7 : event.size;
      if (event.type === 'death' && event.lives > 0) $('announcer').textContent = `${event.lives} ships remaining. Respawn shield active.`;
    }
    if (impact && game.state !== 'paused' && !document.hidden) {
      controller.rumble(impact);
      if (touchMode()) haptics.pulse(impact);
    }
  }
}

function updateHud() {
  $('score').textContent = pad(game.score);
  if (!ranked.active && !game.cheated && game.score > best) {
    best = game.score;
    storage(store => store.setItem(BEST_KEY, String(best)));
  }
  $('best').textContent = pad(best);
  $('wave').textContent = pad(Math.max(1, game.wave), 2);
  $('sector').textContent = pad(Math.max(1, game.wave), 2);
  const livesKey = `${game.lives}:${game.cheats.infiniteLives}`;
  if (lastLives !== livesKey) {
    const icons = [];
    for (let i = 0; i < Math.max(3, game.lives); i++) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 20 24');
      icon.setAttribute('aria-hidden', 'true');
      if (i >= game.lives) icon.classList.add('lost');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M10 2 18 21 10 16 2 21Z');
      icon.append(path);
      icons.push(icon);
    }
    if (game.cheats.infiniteLives) $('lives').textContent = 'INF';
    else $('lives').replaceChildren(...icons);
    $('lives').setAttribute('aria-label', game.cheats.infiniteLives ? 'Infinite ships' : `${game.lives} ships remaining`);
    lastLives = livesKey;
  }
  const playing = game.state === 'playing';
  $('flight-status').hidden = !playing;
  $('shield-status').textContent = game.cheats.invincible ? 'GOD MODE' : game.shieldTime > 0 ? 'SHIELD ACTIVE' : game.shieldCooldown > 0 ? 'RECHARGING' : 'SHIELD READY';
  $('shield-charge').style.transform = `scaleX(${1 - game.shieldCooldown / SHIELD_RECHARGE})`;
  $('weapon-status').hidden = game.tripleTime <= 0 && !game.cheats.tripleShot;
  $('weapon-status').textContent = game.cheats.tripleShot ? 'TRIPLE // OVERRIDE' : `TRIPLE SHOT ${Math.ceil(game.tripleTime)}s`;
  $('sandbox-badge').hidden = !game.cheated;
  $('ranked-badge').hidden = !ranked.active;
  $('console').classList.toggle('sandbox', game.cheated || game.cheatMask() !== 0);
  $('touch-shield').classList.toggle('recharging', game.shieldCooldown > 0);
  $('touch-shield').setAttribute('aria-label', game.shieldCooldown > 0 ? `Shield recharging, ${Math.ceil(game.shieldCooldown)} seconds` : 'Activate shield');
  $('wave-banner').hidden = !playing || game.waveBanner <= 0;
  const multiplier = 1 + Math.min(4, Math.floor((game.combo - 1) / 4));
  $('combo').hidden = !playing || multiplier < 2 || game.comboTime === 0;
  $('combo-multiplier').textContent = `${multiplier}x`;

  const activeFloaters = new Set(game.floaters.map(floater => floater.id));
  for (const [id, node] of floaterNodes) {
    if (!activeFloaters.has(id)) {
      node.remove();
      floaterNodes.delete(id);
    }
  }
  for (const floater of game.floaters) {
    if (!floaterNodes.has(floater.id)) {
      const node = document.createElement('span');
      node.className = `floater ${floater.color}`;
      node.textContent = floater.text;
      $('floaters').append(node);
      floaterNodes.set(floater.id, node);
    }
    const node = floaterNodes.get(floater.id);
    const point = view ? view.project(floater.x, floater.y, game.width, game.height) : floater;
    node.style.transform = `translate(${point.x}px, ${point.y}px)`;
    node.style.opacity = String(Math.min(1, floater.life * 2));
  }
}

function getInput(dt) {
  tapFire = Math.max(0, tapFire - dt);
  const actions = [...actionPointers.values()];
  const keyboardThrust = keys.has('KeyW') || keys.has('ArrowUp');
  const keyboardSteering = keys.has('KeyA') || keys.has('ArrowLeft') || keys.has('KeyD') || keys.has('ArrowRight');
  const thrust = Math.max(keyboardThrust ? 1 : 0, stickThrust, controllerInput.thrust);
  const aim = stickAim ?? (keyboardSteering ? null : controllerInput.aim);
  const input = {
    left: keys.has('KeyA') || keys.has('ArrowLeft') || controllerInput.left,
    right: keys.has('KeyD') || keys.has('ArrowRight') || controllerInput.right,
    thrust,
    brake: keys.has('KeyS') || keys.has('ArrowDown') || controllerInput.brake || (touchMode() && stickPointer === null && thrust === 0),
    manualBrake: keys.has('KeyS') || keys.has('ArrowDown') || controllerInput.brake,
    fire: keys.has('Space') || actions.includes('fire') || tapFire > 0 || controllerInput.fire,
    shield: keys.has('ShiftLeft') || keys.has('ShiftRight') || actions.includes('shield') || tapShield || controllerInput.shield,
    aim,
  };
  tapShield = false;
  return input;
}

const flightKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);
addEventListener('pointerdown', event => {
  if (event.isTrusted) keyboardFocus = event.pointerType === 'mouse';
  unlockControllerAudio(event);
}, { capture: true });
addEventListener('pointerup', unlockControllerAudio, { capture: true });
addEventListener('click', unlockControllerAudio, { capture: true });
addEventListener('keydown', event => {
  if (editable(event.target) || identity.dialog.open) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  unlockControllerAudio(event);
  if (event.isTrusted) keyboardFocus = true;
  if (event.target instanceof HTMLElement && event.target.closest('button, a') && ['Space', 'Enter'].includes(event.code)) return;
  if (['Enter', 'Escape', 'KeyP', 'KeyM', 'Backquote'].includes(event.code)) {
    if (event.repeat) return;
    event.preventDefault();
    if (event.code === 'Backquote') showConsole(event);
    else if (event.code === 'KeyM') toggleSound();
    else if (event.code === 'Enter' && game.state !== 'playing') launch(event);
    else if (['Escape', 'KeyP'].includes(event.code)) {
      if (menuMode === 'console' && !$('menu').hidden) closeConsole(event);
      else if (game.state === 'playing') pauseGame();
      else if (game.state === 'paused' || menuMode === 'manual') launch(event);
    }
  } else if (flightKeys.has(event.code) && game.state === 'playing') {
    event.preventDefault();
    keys.add(event.code);
    noteInput(event, 'keyboard');
    if (event.isTrusted) usingController = false;
    haptics.activate(event);
  }
});
addEventListener('keyup', event => { keys.delete(event.code); });
$('launch').addEventListener('click', launch);
$('sound').addEventListener('click', toggleSound);
$('pause').addEventListener('click', event => { if (game.state === 'playing') pauseGame(); else resumeGame(event); });
$('help').addEventListener('click', showManual);
const activelyPlaying = () => game.state === 'playing' && $('menu').hidden;
for (const type of ['selectstart', 'dragstart', 'contextmenu']) {
  cabinet.addEventListener(type, event => { if (!editable(event.target)) event.preventDefault(); });
}
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, event => {
    if (!editable(event.target) && event.cancelable) event.preventDefault();
  }, { passive: false });
}
document.addEventListener('touchmove', event => {
  if (activelyPlaying() && event.cancelable) event.preventDefault();
}, { passive: false, capture: true });
playfield.addEventListener('touchend', event => {
  if (activelyPlaying() && event.cancelable) event.preventDefault();
}, { passive: false });
document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  if (activelyPlaying() && selection && !selection.isCollapsed && cabinet.contains(selection.anchorNode)) selection.removeAllRanges();
});

function moveStick(event) {
  if (event.pointerId !== stickPointer) return;
  noteInput(event, 'touch');
  if (event.isTrusted) usingController = false;
  const rect = $('joystick').getBoundingClientRect();
  const radius = rect.width * 0.34;
  let x = event.clientX - rect.left - rect.width / 2;
  let y = event.clientY - rect.top - rect.height / 2;
  const distance = Math.hypot(x, y);
  if (distance > radius) { x *= radius / distance; y *= radius / distance; }
  const amount = Math.min(1, distance / radius);
  stickAim = amount > 0.14 ? Math.atan2(y, x) : null;
  stickThrust = Math.max(0, Math.min(1, (amount - 0.14) / 0.75));
  $('stick-thumb').style.transform = `translate(${x}px, ${y}px)`;
}
$('joystick').addEventListener('pointerdown', event => {
  if (game.state !== 'playing' || stickPointer !== null || event.button > 0) return;
  event.preventDefault();
  stickPointer = event.pointerId;
  noteInput(event, 'touch');
  if (event.isTrusted) usingController = false;
  haptics.activate(event);
  $('joystick').setPointerCapture(event.pointerId);
  $('joystick').classList.add('active');
  moveStick(event);
});
$('joystick').addEventListener('pointermove', moveStick);
for (const [id, action] of [['touch-fire', 'fire'], ['touch-shield', 'shield']]) {
  const button = $(id);
  button.addEventListener('pointerdown', event => {
    if (game.state !== 'playing' || event.button > 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    noteInput(event, 'touch');
    haptics.activate(event);
    actionPointers.set(event.pointerId, action);
    button.classList.add('active');
    if (action === 'fire') tapFire = 0.12;
    else tapShield = true;
  });
  button.addEventListener('click', event => {
    if (event.detail !== 0 || game.state !== 'playing') return;
    noteInput(event, 'touch');
    haptics.activate(event);
    if (action === 'fire') tapFire = 0.2;
    else tapShield = true;
  });
}
function releasePointer(event) {
  if (event.pointerId === stickPointer) resetStick();
  actionPointers.delete(event.pointerId);
  const actions = [...actionPointers.values()];
  $('touch-fire').classList.toggle('active', actions.includes('fire'));
  $('touch-shield').classList.toggle('active', actions.includes('shield'));
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) addEventListener(event, releasePointer);
addEventListener('blur', () => { clearInput(); pauseGame(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearInput(); pauseGame('hidden'); }
});
coarsePointer.addEventListener('change', () => { document.body.classList.toggle('touch-mode', touchMode()); clearInput(); resizeView(true); dirty = true; });
reducedMotion.addEventListener('change', () => { shake = 0; dirty = true; resetFrameRate(); });
document.body.classList.toggle('touch-mode', touchMode());
updateSoundButton();
updateHapticsButton();
updateControllerHints();
updateHud();
void identity.init();

try {
  view = new FlightRenderer();
} catch (error) {
  console.error('The Three.js WebGL renderer could not start.', error);
  $('system-status').textContent = 'GRAPHICS UNAVAILABLE';
  $('launch-label').textContent = 'WEBGL REQUIRED';
  notify('WebGL graphics could not start. Enable hardware graphics or try a current Safari, Chrome, or Firefox browser.', 0);
}

if (view) {
  let renderedWidth = 0;
  let renderedHeight = 0;
  const resize = (force = false) => {
    const rect = playfield.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    if (!force && rect.width === renderedWidth && rect.height === renderedHeight) return;
    if (ranked.active) {
      try { ranked.setViewport(rect.width, rect.height); }
      catch (error) {
        if (!(error instanceof AccountError)) throw error;
        pauseGame();
        rankedFailure(error);
      }
    } else game.resize(rect.width, rect.height);
    view.resize(rect.width, rect.height, game.width, game.height);
    renderedWidth = rect.width;
    renderedHeight = rect.height;
    clearInput();
    dirty = true;
  };
  resizeView = resize;
  new ResizeObserver(() => resize()).observe(playfield);
  resize();
  updateControllerHints();
  $('launch-label').textContent = 'LAUNCH GAME';
  $('launch').disabled = false;
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    graphicsLost = true;
    clearInput();
    pauseGame();
    $('launch').disabled = true;
    $('system-status').textContent = 'GRAPHICS INTERRUPTED';
    notify('Graphics were interrupted. Your flight is paused while the browser restores them.', 0);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    graphicsLost = false;
    $('launch').disabled = false;
    updateControllerHints();
    notify('Graphics restored. Resume whenever you are ready.', 3000);
    dirty = true;
  });

  function animate(now) {
    frame = requestAnimationFrame(animate);
    if (document.hidden) return;
    if (document.hasFocus()) processController(now);
    const interval = game.state === 'playing' ? 1000 / 60 : 1000 / 30;
    if (now - previousTime < interval - 1) return;
    const dt = Math.min((now - (previousTime || now)) / 1000, 0.1);
    previousTime = now;
    if (graphicsLost) return;
    const frozen = game.state === 'paused' || (game.state === 'ready' && reducedMotion.matches);
    if (ranked.active) {
      ranked.advance(now, dt, getInput(dt));
      handleEvents();
      updateHud();
      synth.setThrust(game.state === 'playing' ? game.ship.thrust : 0);
    }
    if (!frozen) {
      visualTime += dt;
      accumulator += dt;
      const input = ranked.active ? null : getInput(dt);
      while (!ranked.active && accumulator >= 1 / 120) {
        game.update(1 / 120, input);
        telemetry.sample(game, 1 / 120, input);
        accumulator -= 1 / 120;
      }
      if (ranked.active) accumulator = 0;
      shake = Math.max(0, shake - dt * 22);
      if (!ranked.active) {
        handleEvents();
        updateHud();
        synth.setThrust(game.state === 'playing' ? game.ship.thrust : 0);
      }
    }
    if (!frozen || dirty) {
      view.render(game, visualTime, reducedMotion.matches ? 0 : shake);
      const fps = frameRate.record(now);
      if (fps !== null) $('fps').textContent = String(fps);
      dirty = false;
    }
  }
  frame = requestAnimationFrame(animate);
  addEventListener('pagehide', () => {
    if (!ranked.active) { telemetry.flush('pagehide', game); telemetry.beacon(); }
    clearInput();
    pauseGame();
    cancelAnimationFrame(frame);
    frame = 0;
  });
  addEventListener('pageshow', () => {
    previousTime = 0;
    accumulator = 0;
    dirty = true;
    if (!frame) frame = requestAnimationFrame(animate);
  });
}
