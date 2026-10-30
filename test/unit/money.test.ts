// Aritmética de dinero (D-09, D-10, D-11, D-13): los bordes del redondeo y del formato.
import { describe, expect, it } from 'vitest';
import {
  dailyReturnPct, divHalfEven, formatScaled, parseScaled, resultCents, returnPct, sharesFor, toCents, unitCost,
} from '../../src/domain/money.js';

describe('divHalfEven', () => {
  it('2r < b → trunca', () => expect(divHalfEven(9n, 4n)).toBe(2n));          // 2,25
  it('2r > b → sube', () => expect(divHalfEven(11n, 4n)).toBe(3n));           // 2,75
  it('empate con cociente par → queda', () => expect(divHalfEven(10n, 4n)).toBe(2n));   // 2,5 → 2
  it('empate con cociente impar → sube', () => expect(divHalfEven(14n, 4n)).toBe(4n));  // 3,5 → 4
  it('negativo: simétrico', () => expect(divHalfEven(-14n, 4n)).toBe(-4n));
  it('venta parcial: 3 acciones a costo 302, vendo 1 → 201,333333', () => {
    expect(divHalfEven(302_000_000n * 2n, 3n)).toBe(201_333_333n);
  });
});

describe('parse / format', () => {
  it('"100.50" → 10050 centavos', () => expect(toCents('100.50')).toBe(10050n));
  it('"100" → 10000', () => expect(toCents('100')).toBe(10000n));
  it('3 decimales se rechaza, no se redondea', () => expect(() => toCents('1.005')).toThrow(/decimales/));
  it('notación científica se rechaza', () => expect(() => toCents('1e3')).toThrow());
  it('formato con escala completa', () => {
    expect(formatScaled(5n, 2)).toBe('0.05');
    expect(formatScaled(-10050n, 2)).toBe('-100.50');
    expect(formatScaled(0n, 6)).toBe('0.000000');
  });
  it('ida y vuelta', () => expect(formatScaled(parseScaled('12345.67', 2), 2)).toBe('12345.67'));
  it('un entero mayor que 2^53 no pierde precisión', () => {
    expect(formatScaled(parseScaled('90071992547409.93', 2), 2)).toBe('90071992547409.93');
  });
});

describe('rendimiento y resultado', () => {
  it('costo 100, valor 110 → "10.00" y resultado 10,00', () => {
    expect(returnPct(110_000_000n, 100_000_000n)).toBe('10.00');
    expect(resultCents(110_000_000n, 100_000_000n)).toBe(1000n);
  });
  it('costo 0 → null', () => expect(returnPct(1n, 0n)).toBeNull());
  it('pérdida → negativo', () => expect(returnPct(90_000_000n, 100_000_000n)).toBe('-10.00'));
  it('resultado con fracción de centavo redondea half-even', () => {
    expect(resultCents(5_000n, 0n)).toBe(0n);        // 0,005 → 0,00 (empate, par)
    expect(resultCents(15_000n, 0n)).toBe(2n);       // 0,015 → 0,02 (empate, impar)
  });
  it('costo unitario con 4 decimales: 100 / 3', () => expect(unitCost(100_000_000n, 3n)).toBe('33.3333'));
  it('2 a 33,33 + 1 a 33,34 → costo 100,000000, unitario 33.3333', () => {
    const cost = 2n * 3333n * 10_000n + 1n * 3334n * 10_000n;
    expect(formatScaled(cost, 6)).toBe('100.000000');
    expect(unitCost(cost, 3n)).toBe('33.3333');
  });
  it('retorno diario: 232 vs 230 → "0.87"', () => expect(dailyReturnPct(23200n, 23000n)).toBe('0.87'));
  it('retorno diario sin previousClose → null', () => expect(dailyReturnPct(1n, null)).toBeNull());
});

describe('orden por monto (D-11)', () => {
  it('10.000 ARS a 232 → 43 acciones', () => expect(sharesFor(1_000_000n, 23200n)).toBe(43n));
  it('monto menor al precio → 0', () => expect(sharesFor(100n, 23200n)).toBe(0n));
});

describe('oráculo: cubrir un corto heredado (D-03)', () => {
  it('−10 y compra 15 → 5 al costo de 5; compra 10 → 0; compra 5 → −5', async () => {
    const O = await import('../oracle/fold.js');
    const mk = () => { const s = O.newState(); s.positions.set(7, { qty: -10n, cost: 0n, short: true }); s.cashCents = 10_000_000n; return s; };
    let s = mk(); O.placeOrder(s, { side: 'BUY', type: 'MARKET', instrumentid: 7, size: 15n, priceCents: 10000n }, 0n);
    expect(O.position(s, 7)).toEqual({ qty: 5n, cost: 5n * 10000n * 10_000n, short: false });
    s = mk(); O.placeOrder(s, { side: 'BUY', type: 'MARKET', instrumentid: 7, size: 10n, priceCents: 10000n }, 0n);
    expect(O.position(s, 7)).toEqual({ qty: 0n, cost: 0n, short: false });
    s = mk(); O.placeOrder(s, { side: 'BUY', type: 'MARKET', instrumentid: 7, size: 5n, priceCents: 10000n }, 0n);
    expect(O.position(s, 7)).toEqual({ qty: -5n, cost: 0n, short: true });
  });
});
