// Aritmética compartida R.1–R.3 en BigInt. Sin Number para dinero, nunca.
//   centavos  : importes y cash           (escala 2)
//   micro-ARS : costo de posiciones       (escala 6)
// Postgres entrega numeric/int8 como string; acá se convierten a BigInt y vuelven a string.

const DECIMAL = /^-?\d+(\.\d+)?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** "100.50" → 10050n. Rechaza más de `scale` decimales (A §5.1: se rechaza, no se redondea). */
export function parseScaled(input: string, scale: number): bigint {
  if (typeof input !== 'string' || !DECIMAL.test(input)) {
    throw new MoneyError(`número decimal inválido: ${JSON.stringify(input)}`);
  }
  const neg = input.startsWith('-');
  const [intPart, fracPart = ''] = (neg ? input.slice(1) : input).split('.');
  if (fracPart.length > scale) {
    throw new MoneyError(`más de ${scale} decimales: ${input}`);
  }
  const digits = intPart + fracPart.padEnd(scale, '0');
  const value = BigInt(digits);
  return neg ? -value : value;
}

/** 10050n, 2 → "100.50". Siempre con la escala completa. */
export function formatScaled(value: bigint, scale: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale);
  return `${neg ? '-' : ''}${int}${scale > 0 ? '.' + frac : ''}`;
}

/** R.2: división entera con redondeo half-even del resto exacto. b > 0. */
export function divHalfEven(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new MoneyError('divisor debe ser > 0');
  const neg = a < 0n;
  const abs = neg ? -a : a;
  let q = abs / b;
  const r = abs % b;
  const twice = 2n * r;
  if (twice > b || (twice === b && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

export const toCents = (s: string): bigint => parseScaled(s, 2);
export const fromCents = (c: bigint): string => formatScaled(c, 2);
export const centsToMicro = (c: bigint): bigint => c * 10_000n;
export const fromMicro = (m: bigint): string => formatScaled(m, 6);

/** cost / qty con 4 decimales half-even (R.3). cost en micro-ARS. */
export function unitCost(costMicro: bigint, qty: bigint): string {
  // micro-ARS (escala 6) → escala 4: dividir por qty y por 100.
  return formatScaled(divHalfEven(costMicro, qty * 100n), 4);
}

/** (valor − costo) / costo × 100 con 2 decimales half-even. Ambos en micro-ARS. */
export function returnPct(valueMicro: bigint, costMicro: bigint): string | null {
  if (costMicro <= 0n) return null;
  const hundredths = divHalfEven((valueMicro - costMicro) * 10_000n, costMicro);
  return formatScaled(hundredths, 2);
}

/** (close − previous) / previous × 100 con 2 decimales half-even. Ambos en centavos. */
export function dailyReturnPct(closeCents: bigint, previousCents: bigint | null): string | null {
  if (previousCents === null || previousCents <= 0n) return null;
  const hundredths = divHalfEven((closeCents - previousCents) * 10_000n, previousCents);
  return formatScaled(hundredths, 2);
}

/** D-003: acciones máximas enteras que compra `amount` a `price` (ambos en centavos). */
export function sharesFor(amountCents: bigint, priceCents: bigint): bigint {
  if (priceCents <= 0n) throw new MoneyError('precio debe ser > 0');
  return amountCents / priceCents;
}

/** Límite por movimiento cash: size integer de Postgres (A §2.1). */
export const MAX_CASH_MOVE_CENTS = 2_147_483_647n;
