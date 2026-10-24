export const SHIELD_RECHARGE = 7;
export const CHEATS = [
  { key: 'infiniteLives', title: 'Infinite lives', description: 'Crash, respawn, repeat. Never run out of ships.' },
  { key: 'invincible', title: 'God mode', description: 'Let asteroids pass through your indestructible ship.' },
  { key: 'rapidFire', title: 'Rapid fire', description: 'Trade your laser for a very unreasonable laser.' },
  { key: 'tripleShot', title: 'Permanent triple shot', description: 'Three shots. Every volley. No pickup required.' },
  { key: 'slowRocks', title: 'Bullet time', description: 'Asteroids move at 35% speed. You do not.' },
  { key: 'pickupMagnet', title: 'Pickup magnet', description: 'Nearby power-ups come to you, not the other way around.' },
  { key: 'homingShots', title: 'Homing shots', description: 'Your lasers politely chase the nearest asteroid.' },
];

const TAU = Math.PI * 2;
const RADII = [0, 15, 28, 47];
const POINTS = [0, 100, 50, 20];
const wrap = (value, size) => ((value % size) + size) % size;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const emptyStats = () => ({ shots: 0, hits: 0, rocks: 0, deaths: 0, shields: 0, pickups: 0, maxCombo: 1 });

export function wrappedDelta(value, size) {
  return wrap(value + size / 2, size) - size / 2;
}

export class Game {
  constructor(width, height, random = Math.random, { effects = true, resumeProtection = true } = {}) {
    this.random = random;
    this.effects = effects;
    this.resumeProtection = resumeProtection;
    this.nextId = 1;
    this.cheats = Object.fromEntries(CHEATS.map(cheat => [cheat.key, false]));
    this.cheatsUsed = 0;
    this.stats = emptyStats();
    this.state = 'ready';
    this.width = 0;
    this.height = 0;
    this.scale = 1;
    this.score = 0;
    this.lives = 3;
    this.wave = 0;
    this.elapsed = 0;
    this.combo = 0;
    this.comboTime = 0;
    this.shieldTime = 0;
    this.shieldCooldown = 0;
    this.tripleTime = 0;
    this.fireCooldown = 0;
    this.waveDelay = 0;
    this.waveBanner = 0;
    this.nextLife = 10000;
    this.asteroids = [];
    this.bullets = [];
    this.pickups = [];
    this.particles = [];
    this.floaters = [];
    this.events = [];
    this.ship = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, radius: 11, thrust: 0, invulnerable: 0 };
    this.resize(width, height);
    this.ship.x = width / 2;
    this.ship.y = height / 2;
    for (let i = 0; i < 7; i++) {
      this.asteroids.push(this.makeRock(i % 3 + 1, random() * width, random() * height));
    }
  }

  resize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError('The playfield must have positive, finite dimensions.');
    }
    const oldScale = this.scale;
    this.scale = clamp(Math.min(width, height) / 600, 0.72, 1.1);
    if (this.width && this.height) {
      for (const item of [this.ship, ...this.asteroids, ...this.bullets, ...this.pickups, ...this.particles, ...this.floaters]) {
        item.x = wrap(item.x * width / this.width, width);
        item.y = wrap(item.y * height / this.height, height);
        if ('radius' in item) item.radius *= this.scale / oldScale;
        if ('vx' in item) {
          item.vx *= this.scale / oldScale;
          item.vy *= this.scale / oldScale;
        }
      }
    }
    this.width = width;
    this.height = height;
    this.ship.radius = 11 * this.scale;
  }

  distance(a, b) {
    return Math.hypot(wrappedDelta(a.x - b.x, this.width), wrappedDelta(a.y - b.y, this.height));
  }

  get cheated() {
    return this.cheatsUsed !== 0;
  }

  cheatMask() {
    return CHEATS.reduce((mask, cheat, i) => mask | (this.cheats[cheat.key] ? 1 << i : 0), 0);
  }

  setCheat(key, enabled) {
    if (!Object.hasOwn(this.cheats, key)) throw new RangeError(`Unknown cheat: ${key}`);
    if (typeof enabled !== 'boolean') throw new TypeError('Cheat settings must be boolean.');
    this.cheats[key] = enabled;
    if (['playing', 'paused'].includes(this.state)) this.cheatsUsed |= this.cheatMask();
    if (key === 'rapidFire' && enabled) this.fireCooldown = Math.min(this.fireCooldown, 0.045);
  }

  makeRock(size, x, y) {
    const direction = this.random() * TAU;
    const speed = (22 + this.random() * 28 + this.wave * 5 + (3 - size) * 13) * this.scale;
    const sides = 9 + Math.floor(this.random() * 3);
    return {
      id: this.nextId++,
      size,
      x: wrap(x, this.width),
      y: wrap(y, this.height),
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      radius: RADII[size] * this.scale,
      angle: this.random() * TAU,
      spin: (this.random() - 0.5) * 0.8,
      outline: Array.from({ length: sides }, (_, i) => ({
        angle: i / sides * TAU,
        radius: 0.76 + this.random() * 0.24,
      })),
    };
  }

  start() {
    this.state = 'playing';
    this.cheatsUsed = this.cheatMask();
    this.stats = emptyStats();
    this.score = 0;
    this.lives = 3;
    this.wave = 1;
    this.elapsed = 0;
    this.combo = 0;
    this.comboTime = 0;
    this.shieldTime = 0;
    this.shieldCooldown = 0;
    this.tripleTime = 0;
    this.fireCooldown = 0;
    this.waveDelay = 0;
    this.nextLife = 10000;
    this.bullets = [];
    this.pickups = [];
    this.particles = [];
    this.floaters = [];
    this.events = [];
    Object.assign(this.ship, {
      x: this.width / 2, y: this.height / 2, vx: 0, vy: 0,
      angle: -Math.PI / 2, thrust: 0, invulnerable: 3,
    });
    this.spawnWave();
  }

  spawnWave() {
    this.asteroids = [];
    const clearance = Math.min(180 * this.scale, Math.min(this.width, this.height) * 0.36);
    for (let i = 0; i < Math.min(4 + this.wave - 1, 12); i++) {
      let candidate = { x: 0, y: 0 };
      let bestDistance = -1;
      for (let attempt = 0; attempt < 40; attempt++) {
        const point = { x: this.random() * this.width, y: this.random() * this.height };
        const distance = this.distance(point, this.ship);
        if (distance > bestDistance) {
          candidate = point;
          bestDistance = distance;
        }
        if (distance > clearance) break;
      }
      this.asteroids.push(this.makeRock(3, candidate.x, candidate.y));
    }
    this.waveDelay = 0;
    this.waveBanner = 2;
    this.ship.invulnerable = Math.max(this.ship.invulnerable, 1.5);
    this.events.push({ type: 'wave', wave: this.wave });
  }

  pause() {
    if (this.state !== 'playing') return false;
    this.state = 'paused';
    this.ship.thrust = 0;
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'playing';
    if (this.resumeProtection) this.ship.invulnerable = Math.max(this.ship.invulnerable, 0.8);
    return true;
  }

  fire() {
    const angles = this.tripleTime > 0 || this.cheats.tripleShot ? [-0.17, 0, 0.17] : [0];
    for (const offset of angles) {
      const angle = this.ship.angle + offset;
      this.bullets.push({
        id: this.nextId++,
        x: wrap(this.ship.x + Math.cos(angle) * 18 * this.scale, this.width),
        y: wrap(this.ship.y + Math.sin(angle) * 18 * this.scale, this.height),
        vx: this.ship.vx + Math.cos(angle) * 640 * this.scale,
        vy: this.ship.vy + Math.sin(angle) * 640 * this.scale,
        life: 1.1,
      });
    }
    this.stats.shots += angles.length;
    this.events.push({ type: 'shot', count: angles.length });
  }

  burst(x, y, count, color) {
    if (!this.effects) return;
    for (let i = 0; i < count; i++) {
      const angle = this.random() * TAU;
      const speed = (25 + this.random() * 150) * this.scale;
      const life = 0.25 + this.random() * 0.65;
      this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, maxLife: life, color });
    }
    if (this.particles.length > 200) this.particles.splice(0, this.particles.length - 200);
  }

  addFloater(x, y, text, color = 'cream') {
    if (!this.effects) return;
    this.floaters.push({ id: this.nextId++, x, y, text, color, life: 1.1 });
    if (this.floaters.length > 20) this.floaters.shift();
  }

  destroyRock(index, source = 'bullet') {
    const [rock] = this.asteroids.splice(index, 1);
    this.stats.rocks++;
    if (source === 'bullet') this.stats.hits++;
    if (rock.size > 1) {
      for (let side = -1; side <= 1; side += 2) {
        const angle = rock.angle + side * Math.PI / 2;
        const child = this.makeRock(rock.size - 1, rock.x + Math.cos(angle) * 8, rock.y + Math.sin(angle) * 8);
        child.vx = rock.vx + Math.cos(angle) * (45 + this.wave * 3) * this.scale;
        child.vy = rock.vy + Math.sin(angle) * (45 + this.wave * 3) * this.scale;
        this.asteroids.push(child);
      }
    } else if (this.random() < 0.13 && this.pickups.length < 2) {
      this.pickups.push({
        id: this.nextId++, x: rock.x, y: rock.y, vx: rock.vx * 0.25, vy: rock.vy * 0.25,
        radius: 12 * this.scale, angle: 0, life: 13,
        kind: this.random() < 0.65 ? 'triple' : 'charge',
      });
    }
    this.combo++;
    this.comboTime = 2.6;
    const multiplier = 1 + Math.min(4, Math.floor((this.combo - 1) / 4));
    this.stats.maxCombo = Math.max(this.stats.maxCombo, multiplier);
    const points = POINTS[rock.size] * multiplier;
    this.score += points;
    this.addFloater(rock.x, rock.y, `+${points}`, multiplier > 1 ? 'red' : 'cream');
    this.burst(rock.x, rock.y, 8 + rock.size * 5, 'cream');
    this.events.push({ type: 'hit', size: rock.size, multiplier, x: rock.x, y: rock.y, points });
    while (this.score >= this.nextLife) {
      this.nextLife += 10000;
      if (this.lives < 5) {
        this.lives++;
        this.events.push({ type: 'extra-life' });
      }
    }
  }

  loseLife() {
    this.burst(this.ship.x, this.ship.y, 45, 'red');
    if (!this.cheats.infiniteLives) this.lives--;
    this.stats.deaths++;
    this.combo = 0;
    this.comboTime = 0;
    this.tripleTime = 0;
    this.shieldTime = 0;
    this.ship.thrust = 0;
    this.events.push({ type: 'death', lives: this.lives, x: this.ship.x, y: this.ship.y });
    if (this.lives === 0) {
      this.state = 'gameover';
      this.events.push({ type: 'gameover', score: this.score, wave: this.wave });
      return;
    }
    let safest = { x: this.width / 2, y: this.height / 2 };
    let clearance = -Infinity;
    for (let i = 0; i < 30; i++) {
      const candidate = i === 0 ? safest : { x: this.random() * this.width, y: this.random() * this.height };
      const distance = Math.min(...this.asteroids.map(rock => this.distance(candidate, rock) - rock.radius));
      if (distance > clearance) {
        safest = candidate;
        clearance = distance;
      }
    }
    Object.assign(this.ship, { ...safest, vx: 0, vy: 0, angle: -Math.PI / 2, invulnerable: 3 });
    this.shieldCooldown = Math.min(this.shieldCooldown, 3);
  }

  moveRocks(dt) {
    for (const rock of this.asteroids) {
      rock.x = wrap(rock.x + rock.vx * dt, this.width);
      rock.y = wrap(rock.y + rock.vy * dt, this.height);
      rock.angle += rock.spin * dt;
    }
  }

  updateEffects(dt) {
    for (const particle of this.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt;
    }
    this.particles = this.particles.filter(particle => particle.life > 0);
    for (const floater of this.floaters) {
      floater.y -= dt * 25;
      floater.life -= dt;
    }
    this.floaters = this.floaters.filter(floater => floater.life > 0);
  }

  update(dt, input = {}) {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Frame time must be finite and non-negative.');
    dt = Math.min(dt, 0.05);
    if (this.state === 'paused' || dt === 0) return;
    this.moveRocks(dt * (this.state === 'ready' ? 0.3 : this.cheats.slowRocks ? 0.35 : 1));
    this.updateEffects(dt);
    if (this.state !== 'playing') return;

    this.elapsed += dt;
    this.ship.invulnerable = Math.max(0, this.ship.invulnerable - dt);
    this.shieldTime = Math.max(0, this.shieldTime - dt);
    this.shieldCooldown = Math.max(0, this.shieldCooldown - dt);
    this.tripleTime = Math.max(0, this.tripleTime - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.waveBanner = Math.max(0, this.waveBanner - dt);
    this.comboTime = Math.max(0, this.comboTime - dt);
    if (this.comboTime === 0) this.combo = 0;

    if (input.shield && this.shieldCooldown === 0) {
      this.shieldTime = 1.65;
      this.shieldCooldown = SHIELD_RECHARGE;
      this.stats.shields++;
      this.events.push({ type: 'shield' });
    }
    if (Number.isFinite(input.aim)) {
      this.ship.angle += clamp(wrappedDelta(input.aim - this.ship.angle, TAU), -6.5 * dt, 6.5 * dt);
    } else {
      this.ship.angle += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 4.8 * dt;
    }
    const thrust = clamp(Number(input.thrust) || 0, 0, 1);
    this.ship.thrust = thrust;
    this.ship.vx += Math.cos(this.ship.angle) * thrust * 310 * this.scale * dt;
    this.ship.vy += Math.sin(this.ship.angle) * thrust * 310 * this.scale * dt;
    const drag = Math.exp(-(input.brake ? 3.5 : 0.22) * dt);
    this.ship.vx *= drag;
    this.ship.vy *= drag;
    const speed = Math.hypot(this.ship.vx, this.ship.vy);
    const maxSpeed = 390 * this.scale;
    if (speed > maxSpeed) {
      this.ship.vx *= maxSpeed / speed;
      this.ship.vy *= maxSpeed / speed;
    }
    this.ship.x = wrap(this.ship.x + this.ship.vx * dt, this.width);
    this.ship.y = wrap(this.ship.y + this.ship.vy * dt, this.height);
    if (input.fire && this.fireCooldown === 0) {
      this.fire();
      this.fireCooldown = this.cheats.rapidFire ? 0.045 : 0.14;
    }

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      if (this.cheats.homingShots && this.asteroids.length) {
        let target = this.asteroids[0];
        let nearest = this.distance(bullet, target);
        for (const rock of this.asteroids) {
          const distance = this.distance(bullet, rock);
          if (distance < nearest) { target = rock; nearest = distance; }
        }
        const targetAngle = Math.atan2(wrappedDelta(target.y - bullet.y, this.height), wrappedDelta(target.x - bullet.x, this.width));
        const angle = Math.atan2(bullet.vy, bullet.vx) + clamp(wrappedDelta(targetAngle - Math.atan2(bullet.vy, bullet.vx), TAU), -4.5 * dt, 4.5 * dt);
        const speed = Math.hypot(bullet.vx, bullet.vy);
        bullet.vx = Math.cos(angle) * speed;
        bullet.vy = Math.sin(angle) * speed;
      }
      const dx = bullet.vx * dt;
      const dy = bullet.vy * dt;
      const lengthSquared = dx * dx + dy * dy;
      let hit = -1;
      for (let j = 0; j < this.asteroids.length; j++) {
        const rock = this.asteroids[j];
        const rx = wrappedDelta(rock.x - bullet.x, this.width);
        const ry = wrappedDelta(rock.y - bullet.y, this.height);
        const t = lengthSquared ? clamp((rx * dx + ry * dy) / lengthSquared, 0, 1) : 0;
        if (Math.hypot(rx - dx * t, ry - dy * t) < rock.radius * 0.86 + 2 * this.scale) {
          hit = j;
          break;
        }
      }
      bullet.x = wrap(bullet.x + dx, this.width);
      bullet.y = wrap(bullet.y + dy, this.height);
      bullet.life -= dt;
      if (hit >= 0 || bullet.life <= 0) this.bullets.splice(i, 1);
      if (hit >= 0) this.destroyRock(hit);
    }

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pickup = this.pickups[i];
      const distance = this.distance(this.ship, pickup);
      const pull = this.cheats.pickupMagnet && distance > 0 && distance < 230 * this.scale ? 240 * this.scale / distance : 0;
      pickup.x = wrap(pickup.x + (pickup.vx + wrappedDelta(this.ship.x - pickup.x, this.width) * pull) * dt, this.width);
      pickup.y = wrap(pickup.y + (pickup.vy + wrappedDelta(this.ship.y - pickup.y, this.height) * pull) * dt, this.height);
      pickup.angle += dt;
      pickup.life -= dt;
      if (this.distance(this.ship, pickup) < this.ship.radius + pickup.radius) {
        if (pickup.kind === 'triple') this.tripleTime = 10;
        else this.shieldCooldown = 0;
        this.stats.pickups++;
        this.addFloater(pickup.x, pickup.y, pickup.kind === 'triple' ? 'TRIPLE SHOT' : 'SHIELD READY', 'red');
        this.events.push({ type: 'pickup', kind: pickup.kind });
        this.pickups.splice(i, 1);
      } else if (pickup.life <= 0) this.pickups.splice(i, 1);
    }

    for (let i = this.asteroids.length - 1; i >= 0; i--) {
      const rock = this.asteroids[i];
      if (this.distance(this.ship, rock) >= this.ship.radius + rock.radius * 0.8) continue;
      if (this.shieldTime > 0) this.destroyRock(i, 'shield');
      else if (this.ship.invulnerable === 0 && !this.cheats.invincible) {
        this.loseLife();
        break;
      }
    }

    if (this.state === 'playing' && this.asteroids.length === 0) {
      if (this.waveDelay === 0) {
        this.waveDelay = 2.2;
        this.waveBanner = 2.2;
        this.events.push({ type: 'clear', wave: this.wave });
      }
      this.waveDelay -= dt;
      if (this.waveDelay <= 0) {
        this.wave++;
        this.spawnWave();
      }
    }
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}
