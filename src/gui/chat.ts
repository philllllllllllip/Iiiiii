// ChatScreen with the vanilla command subset needed for a single-player world with cheats:
// /gamemode, /time set|add, /tp, /give, /difficulty, /gamerule, /weather, /kill, /summon, /seed, /help.
import { Screen, type AppApi } from './screens';
import { EditBox, type UiCtx } from './widgets';
import { tr } from './i18n';
import type { Game } from '../game/game';
import type { Hud } from './hud';
import { MOB_TYPES } from '../game/mobs';

export class ChatScreen extends Screen {
  private box!: EditBox;
  transparentInWorld = false;
  constructor(app: AppApi, readonly game: Game, readonly hud: Hud, readonly seed: string, readonly cheats: boolean, readonly initial = '') { super(app); }
  isPauseScreen(): boolean { return false; }
  typing(): boolean { return true; }
  build(): void {
    this.box = this.add(new EditBox(4, this.height - 12, this.width - 4, 12));
    this.box.maxLength = 256; this.box.focused = true; this.box.set(this.initial);
  }
  renderBackground(): void {}
  render(c: UiCtx, partial: number): void {
    c.g.fill(2, this.height - 14, this.width - 2, this.height - 2, 0x80000000);
    this.hud.renderChat(true);
    c.g.text(this.box.value + (Math.floor(this.box.frame / 6) % 2 === 0 ? '_' : ''), 4, this.height - 12, 0xffe0e0e0);
    void partial;
  }
  key(e: KeyboardEvent): boolean {
    if (e.code === 'Enter') { const v = this.box.value.trim(); if (v) this.submit(v); this.app.setScreen(null); return true; }
    if (e.code === 'Escape') { this.app.setScreen(null); return true; }
    return this.box.key(e);
  }
  char(ch: string): boolean { return this.box.char(ch); }
  private say(t: string): void { this.hud.chat.push({ text: t, time: this.game.tickNo }); }
  private submit(v: string): void {
    if (!v.startsWith('/')) { this.say(`<Player> ${v}`); return; }
    const [cmd, ...a] = v.slice(1).split(/\s+/);
    const g = this.game, p = g.player;
    if (!this.cheats && cmd !== 'seed' && cmd !== 'help') { this.say('§c' + tr('command.unknown.command')); return; }
    try {
      switch (cmd) {
        case 'gamemode': {
          const m = ({ survival: 'survival', creative: 'creative', adventure: 'adventure', spectator: 'spectator', s: 'survival', c: 'creative', '0': 'survival', '1': 'creative' } as Record<string, any>)[a[0]];
          if (!m) throw new Error(); p.gameMode = m; this.say(tr('commands.gamemode.success.self', tr('gameMode.' + m))); break;
        }
        case 'time': {
          const names: Record<string, number> = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };
          const n = names[a[1]] ?? parseInt(a[1]);
          if (isNaN(n)) throw new Error();
          if (a[0] === 'set') g.dayTime = n; else if (a[0] === 'add') g.dayTime += n; else throw new Error();
          this.say(tr('commands.time.set', g.dayTime)); break;
        }
        case 'tp': case 'teleport': {
          const c = (s: string, base: number) => (s.startsWith('~') ? base + (parseFloat(s.slice(1)) || 0) : parseFloat(s));
          const x = c(a[0], p.x), y = c(a[1], p.y), z = c(a[2], p.z);
          if ([x, y, z].some(isNaN)) throw new Error();
          p.setPos(x, y, z); p.xo = x; p.yo = y; p.zo = z; p.vx = p.vy = p.vz = 0; p.fallDistance = 0;
          this.say(tr('commands.teleport.success.location.single', 'Player', x.toFixed(2), y.toFixed(2), z.toFixed(2))); break;
        }
        case 'give': {
          const name = (a[1] ?? a[0]).replace('minecraft:', ''), count = parseInt(a[2] ?? a[1]) || 1;
          const id = g.items.id(name);
          g.addToInventory({ id, count });
          this.say(tr('commands.give.success.single', count, name, 'Player')); break;
        }
        case 'difficulty': { const d = a[0] as any; if (!['peaceful', 'easy', 'normal', 'hard'].includes(d)) throw new Error(); p.difficulty = d; this.say(tr('commands.difficulty.success', tr('options.difficulty.' + d))); break; }
        case 'gamerule': { const k = a[0]; if (!(k in g.gameRules)) throw new Error(); if (a[1] !== undefined) g.gameRules[k] = a[1] === 'true' ? true : a[1] === 'false' ? false : +a[1]; this.say(tr('commands.gamerule.query', k, String(g.gameRules[k]))); break; }
        case 'weather': { g.wr.rain = a[0] === 'rain' || a[0] === 'thunder' ? 1 : 0; this.say(tr('commands.weather.set.' + (a[0] === 'clear' ? 'clear' : a[0]))); break; }
        case 'kill': p.hurt(1e9, 'outOfWorld'); break;
        case 'summon': { const id = a[0].replace('minecraft:', ''); if (!MOB_TYPES[id]) throw new Error(); g.spawnMob(id, p.x + 2, p.y, p.z); this.say(tr('commands.summon.success', id)); break; }
        case 'seed': this.say(tr('commands.seed.success', '[' + this.seed + ']')); break;
        case 'help': this.say('/gamemode /time /tp /give /difficulty /gamerule /weather /kill /summon /seed'); break;
        default: this.say('§c' + tr('command.unknown.command'));
      }
    } catch { this.say('§c' + tr('command.unknown.argument')); }
  }
}
