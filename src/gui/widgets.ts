// AbstractWidget family with vanilla sprites, sizes and text colours.
import type { GuiRenderer } from './renderer';
import { tr } from './i18n';

export interface UiCtx { g: GuiRenderer; mx: number; my: number; time: number; playClick: () => void; tooltip: (lines: string[]) => void }

export abstract class Widget {
  active = true; visible = true; focused = false; tooltipLines: string[] | null = null;
  hoverTime = 0;
  constructor(public x: number, public y: number, public w: number, public h: number) {}
  hovered(c: UiCtx): boolean { return this.visible && c.mx >= this.x && c.my >= this.y && c.mx < this.x + this.w && c.my < this.y + this.h; }
  abstract render(c: UiCtx): void;
  mouseDown(_c: UiCtx, _b: number): boolean { return false; }
  mouseUp(_c: UiCtx, _b: number): void {}
  mouseDrag(_c: UiCtx): void {}
  key(_e: KeyboardEvent): boolean { return false; }
  char(_ch: string): boolean { return false; }
  tick(): void {}
  /** Tooltip after 500 ms hover (Tooltip delay for widgets; item tooltips are immediate). */
  renderTooltip(c: UiCtx, dt: number): void {
    if (this.tooltipLines && this.hovered(c)) { this.hoverTime += dt; if (this.hoverTime >= 0.5) c.tooltip(this.tooltipLines); }
    else this.hoverTime = 0;
  }
}

export function drawScrollingText(c: UiCtx, text: string, x0: number, x1: number, y: number, color: number): void {
  const w = c.g.textWidth(text), avail = x1 - x0;
  if (w <= avail) { c.g.centered(text, (x0 + x1) / 2, y, color); return; }
  // AbstractWidget.renderScrollingString: ping-pong scroll
  const over = w - avail;
  const t = c.time;
  const period = Math.max(over * 0.5, 3);
  const f = Math.sin((Math.PI / 2) * Math.cos((2 * Math.PI * t) / period)) / 2 + 0.5;
  c.g.text(text, x0 - over * f, y, color);
}

export class Button extends Widget {
  constructor(x: number, y: number, w: number, h: number, public label: string, public onPress: () => void) { super(x, y, w, h); }
  render(c: UiCtx): void {
    const hov = this.hovered(c) || this.focused;
    const sprite = !this.active ? 'widget/button_disabled' : hov ? 'widget/button_highlighted' : 'widget/button';
    c.g.sprite(sprite, this.x, this.y, this.w, this.h);
    drawScrollingText(c, this.label, this.x + 2, this.x + this.w - 2, this.y + (this.h - 8) / 2, this.active ? 0xffffffff : 0xffa0a0a0);
  }
  mouseDown(c: UiCtx, b: number): boolean {
    if (b === 0 && this.active && this.hovered(c)) { c.playClick(); this.onPress(); return true; }
    return false;
  }
  key(e: KeyboardEvent): boolean { if (this.focused && this.active && (e.code === 'Enter' || e.code === 'Space')) { this.onPress(); return true; } return false; }
}

/** CycleButton: "Caption: Value" (or value only). */
export class CycleButton<T> extends Button {
  constructor(x: number, y: number, w: number, h: number, public caption: string, public values: T[], public index: number,
    public display: (v: T) => string, public onChange: (v: T) => void, public captionVisible = true) {
    super(x, y, w, h, '', () => {});
    this.onPress = () => { this.index = (this.index + 1) % this.values.length; this.onChange(this.value); this.update(); };
    this.update();
  }
  get value(): T { return this.values[this.index]; }
  update(): void { this.label = this.captionVisible && this.caption ? tr('options.generic_value', this.caption, this.display(this.value)) : this.display(this.value); }
  mouseDown(c: UiCtx, b: number): boolean {
    if (b === 1 && this.active && this.hovered(c)) { c.playClick(); this.index = (this.index - 1 + this.values.length) % this.values.length; this.onChange(this.value); this.update(); return true; }
    return super.mouseDown(c, b);
  }
}

export class Checkbox extends Widget {
  constructor(x: number, y: number, public label: string, public checked: boolean, public onChange: (v: boolean) => void, public maxW = 200) {
    super(x, y, 17, 17);
  }
  static boxSize = 17;
  render(c: UiCtx): void {
    const hov = this.hovered(c) || this.focused;
    const s = 'widget/checkbox' + (this.checked ? '_selected' : '') + (hov ? '_highlighted' : '');
    c.g.sprite(s, this.x, this.y, 17, 17);
    c.g.text(this.label, this.x + 17 + 4, this.y + (17 - 8) / 2 + 1, this.active ? 0xffe0e0e0 : 0xffa0a0a0);
    this.w = 17 + 4 + c.g.textWidth(this.label);
  }
  mouseDown(c: UiCtx, b: number): boolean {
    if (b === 0 && this.active && this.hovered(c)) { c.playClick(); this.checked = !this.checked; this.onChange(this.checked); return true; }
    return false;
  }
}

/** AbstractSliderButton */
export class Slider extends Widget {
  dragging = false;
  constructor(x: number, y: number, w: number, h: number, public value: number, public label: (v: number) => string, public onChange: (v: number) => void, public steps = 0) {
    super(x, y, w, h);
  }
  render(c: UiCtx): void {
    const hov = this.hovered(c) || this.focused;
    c.g.sprite(hov && !this.dragging ? 'widget/slider_highlighted' : 'widget/slider', this.x, this.y, this.w, this.h);
    c.g.sprite(hov ? 'widget/slider_handle_highlighted' : 'widget/slider_handle', this.x + Math.floor(this.value * (this.w - 8)), this.y, 8, this.h);
    drawScrollingText(c, this.label(this.value), this.x + 2, this.x + this.w - 2, this.y + (this.h - 8) / 2, this.active ? 0xffffffff : 0xffa0a0a0);
  }
  private setFrom(c: UiCtx): void {
    let v = (c.mx - (this.x + 4)) / (this.w - 8);
    v = Math.max(0, Math.min(1, v));
    if (this.steps > 0) v = Math.round(v * this.steps) / this.steps;
    if (v !== this.value) { this.value = v; this.onChange(v); }
  }
  mouseDown(c: UiCtx, b: number): boolean { if (b === 0 && this.active && this.hovered(c)) { this.dragging = true; this.setFrom(c); return true; } return false; }
  mouseDrag(c: UiCtx): void { if (this.dragging) this.setFrom(c); }
  mouseUp(c: UiCtx): void { if (this.dragging) { this.dragging = false; c.playClick(); } }
  key(e: KeyboardEvent): boolean {
    if (!this.focused) return false;
    const st = this.steps > 0 ? 1 / this.steps : 0.01;
    if (e.code === 'ArrowLeft') { this.value = Math.max(0, this.value - st); this.onChange(this.value); return true; }
    if (e.code === 'ArrowRight') { this.value = Math.min(1, this.value + st); this.onChange(this.value); return true; }
    return false;
  }
}

/** EditBox */
export class EditBox extends Widget {
  value = ''; cursor = 0; frame = 0; maxLength = 32;
  hint = '';
  filter: (s: string) => boolean = () => true;
  onChange: (s: string) => void = () => {};
  constructor(x: number, y: number, w: number, h: number, public narration = '') { super(x, y, w, h); }
  render(c: UiCtx): void {
    const hov = this.hovered(c) || this.focused;
    c.g.sprite(hov ? 'widget/text_field_highlighted' : 'widget/text_field', this.x, this.y, this.w, this.h);
    const tx = this.x + 4, ty = this.y + (this.h - 8) / 2;
    if (!this.value && !this.focused && this.hint) c.g.text(this.hint, tx, ty, 0xff707070);
    // display substring that fits
    let start = 0;
    while (c.g.textWidth(this.value.slice(start, this.cursor)) > this.w - 8) start++;
    let end = this.value.length;
    while (c.g.textWidth(this.value.slice(start, end)) > this.w - 8) end--;
    const shown = this.value.slice(start, end);
    c.g.text(shown, tx, ty, this.active ? 0xffe0e0e0 : 0xff707070);
    if (this.focused && Math.floor(this.frame / 6) % 2 === 0) {
      const cx = tx + c.g.textWidth(this.value.slice(start, this.cursor));
      if (this.cursor < this.value.length) c.g.fill(cx, ty - 1, cx + 1, ty + 1 + 9, 0xffd0d0d0);
      else c.g.text('_', cx, ty, 0xffe0e0e0);
    }
  }
  tick(): void { this.frame++; }
  mouseDown(c: UiCtx, b: number): boolean {
    const h = this.hovered(c);
    this.focused = h && b === 0;
    if (this.focused) {
      let i = 0; const rel = c.mx - this.x - 4;
      while (i < this.value.length && c.g.textWidth(this.value.slice(0, i + 1)) < rel) i++;
      this.cursor = i;
    }
    return h;
  }
  set(s: string): void { this.value = s.slice(0, this.maxLength); this.cursor = this.value.length; this.onChange(this.value); }
  key(e: KeyboardEvent): boolean {
    if (!this.focused) return false;
    const v = this.value;
    if (e.code === 'Backspace') { if (this.cursor > 0) { this.value = v.slice(0, this.cursor - 1) + v.slice(this.cursor); this.cursor--; this.onChange(this.value); } return true; }
    if (e.code === 'Delete') { this.value = v.slice(0, this.cursor) + v.slice(this.cursor + 1); this.onChange(this.value); return true; }
    if (e.code === 'ArrowLeft') { this.cursor = Math.max(0, this.cursor - 1); return true; }
    if (e.code === 'ArrowRight') { this.cursor = Math.min(v.length, this.cursor + 1); return true; }
    if (e.code === 'Home') { this.cursor = 0; return true; }
    if (e.code === 'End') { this.cursor = v.length; return true; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') { this.cursor = v.length; return true; }
    return false;
  }
  char(ch: string): boolean {
    if (!this.focused) return false;
    if (ch < ' ' || ch === '§' || ch === '\x7f') return true;
    const nv = this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor);
    if (nv.length > this.maxLength || !this.filter(nv)) return true;
    this.value = nv; this.cursor++; this.onChange(nv); return true;
  }
}

/** TooltipRenderUtil + ClientTextTooltip: vanilla tooltip box at mouse + (12, -12), kept on screen. */
export function drawTooltip(g: GuiRenderer, lines: string[], mx: number, my: number, colorFirst = 0xffffffff): void {
  if (!lines.length) return;
  const w = Math.max(...lines.map((l) => g.textWidth(l)));
  const h = lines.length === 1 ? 8 : 8 + 2 + (lines.length - 1) * 10;
  let x = mx + 12, y = my - 12;
  if (x + w > g.width) x = Math.max(4, mx - 16 - w);
  if (y + h + 3 > g.height) y = g.height - h - 3;
  if (y < 4) y = 4;
  g.sprite('tooltip/background', x - 3 - 9, y - 3 - 9, w + 6 + 18, h + 6 + 18);
  g.sprite('tooltip/frame', x - 3 - 9, y - 3 - 9, w + 6 + 18, h + 6 + 18);
  lines.forEach((l, i) => g.text(l, x, y + (i === 0 ? 0 : 2 + i * 10), i === 0 ? colorFirst : 0xffaaaaaa));
}
