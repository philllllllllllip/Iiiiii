// Language lookup from en_us.json with vanilla %s / %1$s substitution.
let lang: Record<string, string> = {};
export function setLang(l: Record<string, string>): void { lang = l; }
export function tr(key: string, ...args: (string | number)[]): string {
  const f = lang[key];
  if (f === undefined) return key;
  let i = 0;
  return f.replace(/%(?:(\d+)\$)?([sd%])/g, (_m, idx, t) => (t === '%' ? '%' : String(args[idx ? +idx - 1 : i++] ?? '')));
}
export function has(key: string): boolean { return key in lang; }
