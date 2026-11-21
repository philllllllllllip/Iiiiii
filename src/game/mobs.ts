// Mobs: LivingEntity travel, Goal-style AI (RandomStroll, Panic, LookAtPlayer, MeleeAttack, RangedBow,
// Swell (creeper), WaterAvoiding), A* pathfinding over walkable cells, arrows, explosions,
// NaturalSpawner using the 26.3 biome spawn data.
import { Entity, inputVector, type PhysicsWorld } from './entity';
import type { Game } from './game';

export interface MobType {
  id: string; health: number; speed: number; width: number; height: number; hostile: boolean; model: string; texture: (m: Mob) => string;
  xp: number; burnsInDay?: boolean; eye: number;
}

export const MOB_TYPES: Record<string, MobType> = {
  zombie: { id: 'zombie', health: 20, speed: 0.23, width: 0.6, height: 1.95, hostile: true, model: 'zombie', texture: () => 'entity/zombie/zombie.png', xp: 5, burnsInDay: true, eye: 1.74 },
  skeleton: { id: 'skeleton', health: 20, speed: 0.25, width: 0.6, height: 1.99, hostile: true, model: 'skeleton', texture: () => 'entity/skeleton/skeleton.png', xp: 5, burnsInDay: true, eye: 1.74 },
  creeper: { id: 'creeper', health: 20, speed: 0.25, width: 0.6, height: 1.7, hostile: true, model: 'creeper', texture: () => 'entity/creeper/creeper.png', xp: 5, eye: 1.445 },
  spider: { id: 'spider', health: 16, speed: 0.3, width: 1.4, height: 0.9, hostile: true, model: 'spider', texture: () => 'entity/spider/spider.png', xp: 5, eye: 0.65 },
  pig: { id: 'pig', health: 10, speed: 0.25, width: 0.9, height: 0.9, hostile: false, model: 'pig', texture: (m) => `entity/pig/pig_${m.variant}.png`, xp: 1, eye: 0.765 },
  cow: { id: 'cow', health: 10, speed: 0.2, width: 0.9, height: 1.4, hostile: false, model: 'cow', texture: (m) => `entity/cow/cow_${m.variant}.png`, xp: 1, eye: 1.3 },
  sheep: { id: 'sheep', health: 8, speed: 0.23, width: 0.9, height: 1.3, hostile: false, model: 'sheep', texture: () => 'entity/sheep/sheep.png', xp: 1, eye: 1.235 },
  chicken: { id: 'chicken', health: 4, speed: 0.25, width: 0.4, height: 0.7, hostile: false, model: 'chicken', texture: (m) => `entity/chicken/chicken_${m.variant}.png`, xp: 1, eye: 0.644 },
};

export class Mob extends Entity {
  health: number; hurtTime = 0; invulnerable = 0; deathTime = 0; dead = false;
  bodyYaw = 0; bodyYawO = 0; headYaw = 0; headYawO = 0;
  limbSwing = 0; limbAmount = 0; limbAmountO = 0;
  variant = 'temperate';
  target: { x: number; y: number; z: number } | null = null;
  path: [number, number, number][] = []; pathAge = 0;
  strollCooldown = 0; panicTicks = 0; attackCooldown = 0; attackAnim = 0;
  swell = 0; swellO = 0; swelling = false; noActionTime = 0; fireTicks = 0;
  sheared = false; age = 0; ambientTimer = 0;
  constructor(phys: PhysicsWorld, readonly type: MobType, readonly game: Game) {
    super(phys); this.width = type.width; this.height = type.height; this.health = type.health;
    this.ambientTimer = -Math.floor(Math.random() * 80);
  }

  tick(): void {
    this.xo = this.x; this.yo = this.y; this.zo = this.z;
    this.bodyYawO = this.bodyYaw; this.headYawO = this.headYaw; this.limbAmountO = this.limbAmount; this.swellO = this.swell;
    this.age++;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerable > 0) this.invulnerable--;
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.attackAnim > 0) this.attackAnim--;
    if (this.dead) {
      if (++this.deathTime >= 20) {
        this.removed = true;
        for (let i = 0; i < 20; i++) this.game.particles.spawn('poof', this.x + (Math.random() - 0.5) * this.width, this.y + Math.random() * this.height, this.z + (Math.random() - 0.5) * this.width, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.04);
      }
      this.vx = this.vz = 0; this.vy -= 0.08; this.move(0, this.vy, 0); this.vy *= 0.98;
      return;
    }
    this.updateFluids(this.type.eye);
    const [fwd, jump] = this.ai();
    // LivingEntity.travel (ground/air/water) with the mob's movement_speed attribute
    if (this.inWater || this.inLava) {
      if (jump || this.inWater) this.vy += 0.04;
      const [ax, az] = inputVector(0, fwd, 0.02, this.yaw); this.vx += ax; this.vz += az;
      this.move(this.vx, this.vy, this.vz);
      const f = this.inWater ? 0.8 : 0.5; this.vx *= f; this.vy *= 0.8; this.vz *= f; this.vy -= 0.02;
    } else {
      if (jump && this.onGround) this.vy = 0.42;
      const friction = this.onGround ? this.blockBelowFriction() : 1;
      const speed = this.onGround ? this.type.speed * (this.panicTicks > 0 ? 2 : 1) * (0.21600002 / (friction ** 3)) : 0.02;
      const [ax, az] = inputVector(0, fwd, speed, this.yaw); this.vx += ax; this.vz += az;
      if (this.type.id === 'spider' && this.horizontalCollision) { this.vy = 0.2; this.fallDistance = 0; }
      this.move(this.vx, this.vy, this.vz);
      this.vy -= 0.08;
      const f = this.onGround ? friction * 0.91 : 0.91;
      this.vx *= f; this.vy *= 0.98; this.vz *= f;
    }
    // body/limbs (LivingEntity.tick / WalkAnimationState)
    const dx = this.x - this.xo, dz = this.z - this.zo;
    const dist = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 4);
    this.limbAmount += (dist - this.limbAmount) * 0.4;
    this.limbSwing += this.limbAmount;
    let by = this.bodyYaw;
    const d = wrapDeg(this.yaw - by);
    by += Math.max(-50, Math.min(50, d)) * 0.3;
    this.bodyYaw = by;
    // daylight burning (Mob.isSunBurnTick)
    if (this.type.burnsInDay && this.game.isDay() && !this.inWater && this.game.client.world.sky(Math.floor(this.x), Math.floor(this.y + this.type.eye), Math.floor(this.z)) >= 15 && Math.random() * 30 < 1.5) this.fireTicks = 160;
    if (this.fireTicks > 0) { this.fireTicks--; if (this.inWater) this.fireTicks = 0; else if (this.fireTicks % 20 === 0) this.hurt(1, null); if (Math.random() < 0.3) this.game.particles.spawn('smoke', this.x, this.y + this.height * Math.random(), this.z); }
    if (this.inLava) { this.hurt(4, null); this.fireTicks = 300; }
    if (++this.ambientTimer > 0 && Math.random() * 1000 < this.ambientTimer) { this.ambientTimer = -80; this.sound('ambient'); }
    if (this.y < -128) this.hurt(4, null);
  }

  override onLand(dist: number): void {
    if (this.type.id === 'chicken') return;
    const dmg = Math.ceil(dist - 3);
    if (dmg > 0) this.hurt(dmg, null);
  }

  sound(kind: string): void {
    const evt = this.type.id === 'creeper' && kind === 'ambient' ? null : `entity.${this.type.id}.${kind}`;
    if (evt) this.game.onSound(evt, this.x, this.y, this.z, 1, (Math.random() - Math.random()) * 0.2 + 1);
  }

  /** Returns [forward input, jump]. */
  private ai(): [number, boolean] {
    const g = this.game, p = g.player;
    const dxp = p.x - this.x, dyp = p.y - this.y, dzp = p.z - this.z;
    const dp = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp);
    const playerTargetable = !p.dead && (p.gameMode === 'survival' || p.gameMode === 'adventure');
    let aggressive = false;
    if (this.type.hostile && playerTargetable && dp < (this.type.id === 'creeper' ? 16 : 35) && g.difficulty() !== 'peaceful') {
      const spiderCalm = this.type.id === 'spider' && g.isDay() && g.client.world.sky(Math.floor(this.x), Math.floor(this.y + 1), Math.floor(this.z)) > 11;
      if (!spiderCalm) aggressive = true;
    }
    this.headYaw = this.yaw;
    if (dp < 8) { this.headYaw = (Math.atan2(-dxp, dzp) * 180) / Math.PI; this.pitch = (-Math.atan2(dyp + p.eyeHeight - this.type.eye, Math.hypot(dxp, dzp)) * 180) / Math.PI; }
    if (this.panicTicks > 0) {
      this.panicTicks--;
      if (!this.target || this.path.length === 0) this.target = { x: this.x + (Math.random() - 0.5) * 10, y: this.y, z: this.z + (Math.random() - 0.5) * 10 };
    } else if (aggressive) {
      if (this.type.id === 'skeleton') {
        // RangedBowAttackGoal: keep ~15 blocks, strafe, shoot every 20-40 ticks when visible
        this.headYaw = this.yaw = (Math.atan2(-dxp, dzp) * 180) / Math.PI;
        if (dp > 12) this.target = { x: p.x, y: p.y, z: p.z }; else this.target = null;
        if (this.attackCooldown <= 0 && dp < 15 && g.canSee(this, p)) { g.shootArrow(this, p); this.attackCooldown = 20 + Math.floor(Math.random() * 20); }
        if (!this.target) return [dp < 6 ? -0.5 : 0, false];
      } else if (this.type.id === 'creeper') {
        // SwellGoal: fuse when within 3 blocks and visible, explode after 30 ticks
        this.swelling = dp < 3 && g.canSee(this, p);
        if (this.swelling) { if (this.swell === 0) g.onSound('entity.creeper.primed', this.x, this.y, this.z, 1, 0.5); this.swell++; this.target = null; }
        else { this.swell = Math.max(0, this.swell - 1); this.target = { x: p.x, y: p.y, z: p.z }; }
        if (this.swell >= 30) { this.removed = true; this.dead = true; g.explode(this.x, this.y + 0.5, this.z, 3, this); return [0, false]; }
      } else {
        this.target = { x: p.x, y: p.y, z: p.z };
        const reach = this.width * 2 * (this.width * 2) + p.width;
        if (dxp * dxp + dzp * dzp + dyp * dyp <= reach + 1 && this.attackCooldown <= 0) {
          this.attackCooldown = 20; this.attackAnim = 10;
          const dmg = this.type.id === 'spider' ? 2 : ({ easy: 2.5, normal: 3, hard: 4.5 } as Record<string, number>)[g.difficulty()] ?? 3;
          g.damagePlayer(dmg, this);
        }
      }
    } else {
      // WaterAvoidingRandomStrollGoal: interval 120 ticks (1/120 chance per tick)
      if (!this.target && --this.strollCooldown <= 0 && Math.random() < 1 / 120) {
        this.target = { x: this.x + (Math.random() - 0.5) * 20, y: this.y, z: this.z + (Math.random() - 0.5) * 20 };
        this.strollCooldown = 40;
      }
    }
    if (!this.target) return [0, false];
    // A* path refresh
    if (this.pathAge-- <= 0 || !this.path.length) { this.path = g.findPath(this, this.target); this.pathAge = 15 + Math.floor(Math.random() * 10); }
    let node = this.path[0];
    while (node && Math.hypot(node[0] + 0.5 - this.x, node[2] + 0.5 - this.z) < Math.max(0.5, this.width * 0.5) && Math.abs(node[1] - this.y) < 1.1) { this.path.shift(); node = this.path[0]; }
    if (!node) {
      const tx = this.target.x - this.x, tz = this.target.z - this.z;
      if (tx * tx + tz * tz < 1.5 || !aggressive) { this.target = null; return [0, false]; }
      node = [Math.floor(this.target.x), Math.floor(this.target.y), Math.floor(this.target.z)];
    }
    // MoveControl: turn towards the node (max 90 deg/tick), walk forward; JumpControl when the node is higher or blocked
    const ty = (Math.atan2(-(node[0] + 0.5 - this.x), node[2] + 0.5 - this.z) * 180) / Math.PI;
    this.yaw += Math.max(-90, Math.min(90, wrapDeg(ty - this.yaw)));
    const jump = (node[1] > Math.floor(this.y + 0.01) && this.horizontalCollision) || (this.horizontalCollision && this.onGround) || node[1] > this.y + 0.6;
    return [1, jump];
  }

  hurt(amount: number, from: { x: number; z: number } | null, knock = 0.4): boolean {
    if (this.dead || this.invulnerable > 10) return false;
    this.invulnerable = 20; this.hurtTime = 10;
    this.health -= amount;
    if (from) {
      // LivingEntity.knockback
      const dx = from.x - this.x, dz = from.z - this.z, d = Math.hypot(dx, dz) || 1;
      this.vx = this.vx / 2 - (dx / d) * knock; this.vz = this.vz / 2 - (dz / d) * knock;
      if (this.onGround) this.vy = Math.min(0.4, this.vy / 2 + knock);
    }
    if (!this.type.hostile) this.panicTicks = 100;
    if (this.health <= 0) { this.dead = true; this.deathTime = 0; this.sound('death'); this.game.onMobDeath(this); }
    else this.sound('hurt');
    return true;
  }
}

export class Arrow extends Entity {
  life = 0; stuck = false;
  constructor(phys: PhysicsWorld, readonly owner: Mob | null, readonly game: Game) { super(phys); this.width = 0.5; this.height = 0.5; this.stepHeight = 0; }
  tick(): void {
    this.xo = this.x; this.yo = this.y; this.zo = this.z;
    if (++this.life > 1200) { this.removed = true; return; }
    if (this.stuck) { if (this.life > 400) this.removed = true; return; }
    const p = this.game.player;
    // segment vs player box
    const pb = p.box;
    for (let t = 0; t <= 1; t += 0.25) {
      const x = this.x + this.vx * t, y = this.y + this.vy * t, z = this.z + this.vz * t;
      if (!p.dead && x > pb.x0 - 0.3 && x < pb.x1 + 0.3 && y > pb.y0 && y < pb.y1 && z > pb.z0 - 0.3 && z < pb.z1 + 0.3) {
        const speed = Math.hypot(this.vx, this.vy, this.vz);
        this.game.damagePlayer(Math.ceil(speed * 2), this.owner);
        this.game.onSound('entity.arrow.hit_player', x, y, z, 1, 1);
        this.removed = true; return;
      }
    }
    this.noPhysics = false;
    this.move(this.vx, this.vy, this.vz);
    if (this.horizontalCollision || this.verticalCollision) { this.stuck = true; this.life = 0; this.game.onSound('entity.arrow.hit', this.x, this.y, this.z, 1, 1.2 / (Math.random() * 0.2 + 0.9)); return; }
    this.vx *= 0.99; this.vy *= 0.99; this.vz *= 0.99; this.vy -= 0.05;
    this.yaw = (Math.atan2(this.vx, this.vz) * 180) / Math.PI;
    this.pitch = (Math.atan2(this.vy, Math.hypot(this.vx, this.vz)) * 180) / Math.PI;
  }
}

export function wrapDeg(d: number): number { d %= 360; if (d >= 180) d -= 360; if (d < -180) d += 360; return d; }
