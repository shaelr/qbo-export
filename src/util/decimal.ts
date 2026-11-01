// Exact decimal arithmetic on money strings via BigInt fixed point, so no
// value ever passes through a float.

const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);
const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

export function toUnits(text: string): bigint {
  const m = DECIMAL.exec(text.trim());
  if (!m) throw new Error(`Not a decimal number: "${text}"`);
  const frac = (m[3] ?? '').padEnd(SCALE, '0');
  if (frac.length > SCALE && /[^0]/.test(frac.slice(SCALE))) throw new Error(`Too many decimal places: "${text}"`);
  const units = BigInt(m[2]!) * FACTOR + BigInt(frac.slice(0, SCALE));
  return m[1] === '-' ? -units : units;
}

/** Formats with at least `minDp` decimals, keeping any further non-zero digits. */
export function fromUnits(units: bigint, minDp = 2): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = abs / FACTOR;
  let frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  frac = frac.padEnd(minDp, '0');
  return `${negative && abs !== 0n ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export function addDecimal(...values: string[]): string {
  return fromUnits(values.reduce((sum, v) => sum + toUnits(v), 0n));
}

export function subDecimal(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function cmpDecimal(a: string, b: string): -1 | 0 | 1 {
  const d = toUnits(a) - toUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function isZero(text: string): boolean {
  return toUnits(text) === 0n;
}
