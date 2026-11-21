// Player: LivingEntity.travel / Player.aiStep movement, FoodData, air supply, fall damage, XP.
import { Entity, inputVector, type PhysicsWorld } from './entity';
import type { ItemStack } from './items';

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export interface Input { forward: number; strafe: number; jump: boolean; sneak: boolean; sprint: boolean }

export class Inventory {
  /** 0-8 hotbar, 9-35 main, 36-39 armour (feet, legs, chest, head), 40 offhand */
  readonly slots: (ItemStack | null)[] = new Array(41).fill(null);
  selected = 0;
  get held(): ItemStack | null { return this.slots[this.selected]; }
  set held(s: ItemStack | null) { this.slots[this.selected] = s; }
}

export class Player extends Entity {
  gameMode: GameMode = 'survival';
  difficulty: Difficulty = 'normal';
  health = 20; maxHealth = 20; absorption = 0;
  food = 20; saturation = 5; exhaustion = 0; foodTimer = 0;
  air = 300; maxAir = 300;
  xpLevel = 0; xpProgress = 0; xpTotal = 0;
  invulnerableTime = 0; hurtTime = 0; deathTime = 0;
  dead = false; lastDamageSource = '';
  sprinting = false; sneaking = false; swimming = false; flying = false; mayFly = false;
  walkDist = 0; walkDistO = 0; bob = 0; bobO = 0;
  noJumpDelay = 0;
  fovModifier = 1; fovModifierO = 1;
  readonly inventory = new Inventory();
  /** set by game: naturalRegeneration gamerule etc. */
  naturalRegeneration = true;
  keepInventory = false;
  onDamage: (amount: number, source: string) => void = () => {};
  onDeath: (source: string) => void = () => {};
  /** set by game for flying double-tap */
  private lastJumpPress = -100;

  constructor(phys: PhysicsWorld) { super(phys); }

  get eyeHeight(): number { return this.sneaking && !this.flying ? 1.27 : 1.62; }
  get creative(): boolean { return this.gameMode === 'creative' || this.gameMode === 'spectator'; }

  /** movement_speed attribute incl. sprint modifier (+30% multiply_total). */
  speed(): number { return 0.1 * (this.sprinting ? 1.3 : 1); }

  tick(input: Input, tickNo: number): void {
    this.xo = this.x; this.yo = this.y; this.zo = this.z;
    this.yawO = this.yaw; this.pitchO = this.pitch;
    this.walkDistO = this.walkDist; this.bobO = this.bob;
    this.fovModifierO = this.fovModifier;
    this.tickCount++;
    if (this.dead) { this.deathTime++; return; }
    if (this.invulnerableTime > 0) this.invulnerableTime--;
    if (this.hurtTime > 0) this.hurtTime--;
    this.noPhysics = this.gameMode === 'spectator';
    this.mayFly = this.creative;
    if (!this.mayFly) this.flying = false;
    if (this.gameMode === 'spectator') this.flying = true;

    // sneak & sprint state (LocalPlayer.aiStep)
    this.sneaking = input.sneak && !this.flying && !this.swimming;
    this.height = this.sneaking ? 1.5 : this.swimming ? 0.6 : 1.8;
    const canSprint = this.food > 6 || this.mayFly;
    if (input.sprint && input.forward > 0 && canSprint && !this.sneaking) this.sprinting = true;
    if (this.sprinting && (input.forward <= 0 || this.horizontalCollision && !this.inWater || !canSprint || this.sneaking)) this.sprinting = false;

    // creative flight toggle: double tap jump
    if (this.mayFly && input.jump && !this.prevJump) {
      if (tickNo - this.lastJumpPress < 7) { this.flying = !this.flying && this.gameMode !== 'spectator' ? true : this.gameMode === 'spectator'; this.lastJumpPress = -100; }
      else this.lastJumpPress = tickNo;
    }
    this.prevJump = input.jump;

    this.updateFluids(this.eyeHeight);
    this.swimming = this.sprinting && this.inWater && this.eyeInWater;

    // input scaling (LivingEntity.aiStep: xxa/zza * 0.98, sneaking * 0.3)
    let fwd = input.forward * 0.98, str = input.strafe * 0.98;
    if (this.sneaking) { fwd *= 0.3; str *= 0.3; }

    if (this.noJumpDelay > 0) this.noJumpDelay--;
    if (this.flying) this.travelFlying(fwd, str, input);
    else {
      if (input.jump) {
        if (this.inWater || this.inLava) this.vy += 0.04;
        else if (this.onGround && this.noJumpDelay === 0) { this.jumpFromGround(); this.noJumpDelay = 10; }
      } else this.noJumpDelay = 0;
      this.travel(fwd, str);
    }
    if (this.onGround && this.flying && this.gameMode !== 'spectator') this.flying = false;

    // walk distance / view bobbing (Player.aiStep, LocalPlayer)
    const dxw = this.x - this.xo, dzw = this.z - this.zo;
    const hd = Math.sqrt(dxw * dxw + dzw * dzw);
    this.walkDist += hd * 0.6;
    const targetBob = this.onGround && !this.dead ? Math.min(0.1, hd) : 0;
    this.bob += (targetBob - this.bob) * 0.4;
    // FOV modifier (AbstractClientPlayer.getFieldOfViewModifier): speed ratio, flying x1.1
    let fm = 1;
    if (this.flying) fm *= 1.1;
    fm *= (this.speed() / 0.1 + 1) / 2;
    if (!isFinite(fm) || fm > 1.5) fm = 1.5;
    this.fovModifier += (fm - this.fovModifier) * 0.5;

    // exhaustion from movement (Player.checkMovementStatistics)
    if (!this.creative) {
      const dist = Math.sqrt(dxw * dxw + (this.y - this.yo) ** 2 + dzw * dzw);
      if (this.swimming || (this.eyeInWater && this.inWater)) this.causeExhaustion(0.01 * dist);
      else if (this.inWater) this.causeExhaustion(0.01 * hd);
      else if (this.onGround && this.sprinting) this.causeExhaustion(0.1 * hd);
    }
    this.tickAir();
    if (this.inLava && !this.creative) { this.hurt(4, 'lava'); }
    if (this.y < -128) this.hurt(4, 'outOfWorld');
    this.tickFood();
  }
  private prevJump = false;

  private jumpFromGround(): void {
    const below = this.phys.world.getState(Math.floor(this.x), Math.floor(this.y - 0.5000001), Math.floor(this.z));
    const jf = this.phys.props.jumpFactor[this.phys.reg.stateBlock[below]];
    this.vy = Math.max(0.42 * jf, this.vy);
    if (this.sprinting) {
      const g = (this.yaw * Math.PI) / 180;
      this.vx += -Math.sin(g) * 0.2; this.vz += Math.cos(g) * 0.2;
      if (!this.creative) this.causeExhaustion(0.2);
    } else if (!this.creative) this.causeExhaustion(0.05);
  }

  /** LivingEntity.travel */
  private travel(fwd: number, str: number): void {
    const gravity = 0.08;
    if (this.inWater && !this.flying) {
      const y0 = this.y;
      const slow = this.sprinting ? 0.9 : 0.8;
      const [ax, az] = inputVector(str, fwd, 0.02, this.yaw);
      this.vx += ax; this.vz += az;
      if (this.swimming) {
        // swimming follows the look direction (LivingEntity.travelInFluid / Player.travel)
        const look = -Math.sin((this.pitch * Math.PI) / 180);
        const e = look < -0.2 ? 0.085 : 0.06;
        const above = this.phys.reg.name(this.phys.world.getState(Math.floor(this.x), Math.floor(this.y + 1 - 0.1), Math.floor(this.z)));
        if (look <= 0 || this.prevJump || above === 'water') this.vy += (look - this.vy) * e;
      }
      this.move(this.vx, this.vy, this.vz);
      this.vx *= slow; this.vy *= 0.8; this.vz *= slow;
      if (!this.sprinting) this.vy -= gravity / 16;
      if (this.horizontalCollision && this.isFree(this.vx, this.vy + 0.6 - this.y + y0, this.vz)) this.vy = 0.3;
    } else if (this.inLava && !this.flying) {
      const y0 = this.y;
      const [ax, az] = inputVector(str, fwd, 0.02, this.yaw);
      this.vx += ax; this.vz += az;
      this.move(this.vx, this.vy, this.vz);
      this.vx *= 0.5; this.vy *= this.lavaHeight <= 0.4 ? 0.8 : 0.5; this.vz *= 0.5;
      this.vy -= gravity / 4;
      if (this.horizontalCollision && this.isFree(this.vx, this.vy + 0.6 - this.y + y0, this.vz)) this.vy = 0.3;
    } else {
      const friction = this.onGround ? this.blockBelowFriction() : 1;
      const f = this.onGround ? friction * 0.91 : 0.91;
      const speed = this.onGround ? this.speed() * (0.21600002 / (friction * friction * friction)) : this.sprinting ? 0.025999999 : 0.02;
      const [ax, az] = inputVector(str, fwd, speed, this.yaw);
      this.vx += ax; this.vz += az;
      const climbing = this.onClimbable();
      if (climbing) {
        this.fallDistance = 0;
        this.vx = Math.max(-0.15, Math.min(0.15, this.vx)); this.vz = Math.max(-0.15, Math.min(0.15, this.vz));
        this.vy = Math.max(this.vy, -0.15);
        if (this.vy < 0 && this.sneaking) this.vy = 0;
      }
      this.move(this.vx, this.vy, this.vz, this.sneaking);
      if ((this.horizontalCollision || this.prevJump) && climbing) this.vy = 0.2;
      this.vy -= gravity;
      this.vx *= f; this.vy *= 0.98; this.vz *= f;
    }
  }

  /** Creative/spectator flight (LivingEntity.travel with abilities.flying). */
  private travelFlying(fwd: number, str: number, input: Input): void {
    const flySpeed = 0.05 * (this.sprinting ? 2 : 1);
    if (input.jump) this.vy += flySpeed * 3;
    if (input.sneak) this.vy -= flySpeed * 3;
    const [ax, az] = inputVector(str, fwd, flySpeed, this.yaw);
    this.vx += ax; this.vz += az;
    this.move(this.vx, this.vy, this.vz);
    this.vx *= 0.91; this.vz *= 0.91; this.vy *= 0.6;
    this.fallDistance = 0;
  }

  private isFree(dx: number, dy: number, dz: number): boolean {
    const b = this.box;
    return this.phys.boxes({ x0: b.x0 + dx, y0: b.y0 + dy, z0: b.z0 + dz, x1: b.x1 + dx, y1: b.y1 + dy, z1: b.z1 + dz }, []).length === 0;
  }

  override onLand(dist: number): void {
    if (this.creative) return;
    const below = this.phys.reg.name(this.phys.world.getState(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z)));
    let mult = 1;
    if (below.endsWith('_bed') || below === 'slime_block') mult = below === 'slime_block' ? 0 : 0.5;
    if (below === 'hay_block') mult = 0.2;
    if (below === 'powder_snow' || this.inWater) mult = 0;
    const dmg = Math.ceil((dist - 3) * mult);
    if (dmg > 0) this.hurt(dmg, 'fall');
  }

  private tickAir(): void {
    if (this.creative) { this.air = this.maxAir; return; }
    if (this.eyeInWater) {
      this.air--;
      if (this.air <= -20) { this.air = 0; this.hurt(2, 'drown'); }
    } else if (this.air < this.maxAir) this.air = Math.min(this.maxAir, this.air + 4);
  }

  causeExhaustion(v: number): void { if (!this.creative) this.exhaustion = Math.min(this.exhaustion + v, 40); }

  /** FoodData.tick */
  private tickFood(): void {
    if (this.difficulty === 'peaceful') {
      if (this.health < this.maxHealth && this.tickCount % 20 === 0) this.heal(1);
      if (this.food < 20 && this.tickCount % 10 === 0) this.food++;
    }
    if (this.creative) return;
    if (this.exhaustion > 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(this.saturation - 1, 0);
      else if (this.difficulty !== 'peaceful') this.food = Math.max(this.food - 1, 0);
    }
    const hurt = this.health > 0 && this.health < this.maxHealth;
    if (this.naturalRegeneration && this.saturation > 0 && hurt && this.food >= 20) {
      if (++this.foodTimer >= 10) { const f = Math.min(this.saturation, 6); this.heal(f / 6); this.causeExhaustion(f); this.foodTimer = 0; }
    } else if (this.naturalRegeneration && this.food >= 18 && hurt) {
      if (++this.foodTimer >= 80) { this.heal(1); this.causeExhaustion(6); this.foodTimer = 0; }
    } else if (this.food <= 0) {
      if (++this.foodTimer >= 80) {
        if (this.health > 10 || this.difficulty === 'hard' || (this.health > 1 && this.difficulty === 'normal')) this.hurt(1, 'starve');
        this.foodTimer = 0;
      }
    } else this.foodTimer = 0;
  }

  eat(nutrition: number, saturationMod: number): void {
    this.food = Math.min(20, this.food + nutrition);
    this.saturation = Math.min(this.saturation + nutrition * saturationMod * 2, this.food);
  }

  heal(v: number): void { if (!this.dead) this.health = Math.min(this.maxHealth, this.health + v); }

  /** LivingEntity.hurt (armour/enchantment reduction applied by the caller). */
  hurt(amount: number, source: string): boolean {
    if (this.dead || amount <= 0) return false;
    if (this.creative && source !== 'outOfWorld') return false;
    if (this.invulnerableTime > 10) return false;
    if (this.difficulty === 'peaceful' && source === 'mob') return false;
    this.invulnerableTime = 20; this.hurtTime = 10;
    this.lastDamageSource = source;
    if (source !== 'starve' && source !== 'drown') this.causeExhaustion(0.1);
    this.health = Math.max(0, this.health - amount);
    this.onDamage(amount, source);
    if (this.health <= 0) { this.dead = true; this.deathTime = 0; this.onDeath(source); }
    return true;
  }

  /** Player.getXpNeededForNextLevel */
  static xpNeeded(level: number): number { return level >= 30 ? 112 + (level - 30) * 9 : level >= 15 ? 37 + (level - 15) * 5 : 7 + level * 2; }
  giveXp(points: number): void {
    this.xpProgress += points / Player.xpNeeded(this.xpLevel);
    this.xpTotal += points;
    while (this.xpProgress >= 1) { this.xpProgress = (this.xpProgress - 1) * Player.xpNeeded(this.xpLevel); this.xpLevel++; this.xpProgress /= Player.xpNeeded(this.xpLevel); }
  }

  respawn(x: number, y: number, z: number): void {
    this.dead = false; this.health = this.maxHealth; this.food = 20; this.saturation = 5; this.exhaustion = 0; this.air = this.maxAir;
    this.fallDistance = 0; this.vx = this.vy = this.vz = 0; this.deathTime = 0;
    if (!this.keepInventory) { this.xpLevel = 0; this.xpProgress = 0; this.xpTotal = 0; }
    this.setPos(x, y, z); this.xo = x; this.yo = y; this.zo = z;
  }
}
