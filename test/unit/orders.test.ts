// Validación de forma de POST /orders, hash de idempotencia y guard de parsers de pg.
import { describe, expect, it } from 'vitest';
import { OrderBody, legacyRequestHash, orderView, requestHash, validateOrder } from '../../src/domain/orders.js';
import { parserFor } from '../../src/db/pool.js';

const parse = (b: unknown) => OrderBody.safeParse(b);

describe('OrderBody (zod)', () => {
  it('price con 3 decimales se rechaza', () => expect(parse({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price: '1.005' }).success).toBe(false));
  it('price como número decimal se rechaza (un float no garantiza la escala)', () => expect(parse({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price: 1.5 }).success).toBe(false));
  it('price como número entero se acepta', () => expect(parse({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price: 2 }).success).toBe(true));
  it('amount 0 se rechaza', () => expect(parse({ userid: 1, side: 'CASH_IN', amount: '0' }).success).toBe(false));
  it('campo desconocido se rechaza', () => expect(parse({ userid: 1, side: 'CASH_IN', amount: '1', foo: 1 }).success).toBe(false));
  it('type por defecto es MARKET', () => expect(parse({ userid: 1, side: 'CASH_IN', amount: '1' }).data?.type).toBe('MARKET'));
});

// Issue #8: un entero JSON fuera de ±2⁵³ ya llega redondeado desde JSON.parse; como number solo se
// acepta dentro de ese rango, y la magnitud mayor va como string. Los ids del body tienen el tope de int4.
describe('OrderBody (zod) — enteros JSON fuera de ±2⁵³ y topes de los ids (issue #8)', () => {
  const RANGE = 'entero fuera del rango exacto de JSON (±2^53); enviarlo como string';
  const limit = (price: unknown) => parse({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price });
  const cash = (amount: unknown) => parse({ userid: 1, side: 'CASH_IN', amount });
  const messageOf = (r: ReturnType<typeof parse>, path: string) =>
    r.error?.issues.filter((i) => i.path.join('.') === path).map((i) => i.message);

  it('price 9007199254740993 y amount 12345678901234567890 como número → rechazados con el mensaje de rango', () => {
    const p = limit(9007199254740993);
    expect(p.success).toBe(false);
    expect(messageOf(p, 'price')).toEqual([RANGE]);
    const a = cash(12345678901234567890);
    expect(a.success).toBe(false);
    expect(messageOf(a, 'amount')).toEqual([RANGE]);
  });
  it('los mismos valores como string → aceptados exactos (el tope de magnitud lo pone place_order, D-14)', () => {
    expect(limit('9007199254740993').data?.price).toBe('9007199254740993.00');
    expect(cash('12345678901234567890').data?.amount).toBe('12345678901234567890.00');
  });
  it('price 9007199254740991 (2⁵³ − 1) → "9007199254740991.00"; 9007199254740992 (2⁵³) → rechazado', () => {
    expect(limit(9007199254740991).data?.price).toBe('9007199254740991.00');
    const r = limit(9007199254740992);
    expect(r.success).toBe(false);
    expect(messageOf(r, 'price')).toEqual([RANGE]);
  });
  it('price 1e3 → "1000.00"; price 1e21 → el mensaje de rango, no el de formato', () => {
    expect(limit(1e3).data?.price).toBe('1000.00');
    const r = limit(1e21);
    expect(r.success).toBe(false);
    expect(messageOf(r, 'price')).toEqual([RANGE]);
  });
  it('userid e instrumentid: 2147483647 se acepta, 2147483648 se rechaza', () => {
    const base = { side: 'BUY', type: 'MARKET', size: 1 };
    expect(parse({ ...base, userid: 2_147_483_647, instrumentid: 2_147_483_647 }).success).toBe(true);
    const u = parse({ ...base, userid: 2_147_483_648, instrumentid: 1 });
    expect(u.success).toBe(false);
    expect(u.error?.issues.map((i) => i.path.join('.'))).toEqual(['userid']);
    expect(messageOf(u, 'userid')).toEqual(['debe ser ≤ 2147483647']);
    const i = parse({ ...base, userid: 1, instrumentid: 2_147_483_648 });
    expect(i.success).toBe(false);
    expect(i.error?.issues.map((i) => i.path.join('.'))).toEqual(['instrumentid']);
    expect(messageOf(i, 'instrumentid')).toEqual(['debe ser ≤ 2147483647']);
  });
  it('size 1e9 se acepta; 1e10 se rechaza por el tope', () => {
    expect(parse({ userid: 1, side: 'BUY', instrumentid: 1, size: 1e9 }).data?.size).toBe(1_000_000_000);
    const r = parse({ userid: 1, side: 'BUY', instrumentid: 1, size: 1e10 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['size']);
    expect(messageOf(r, 'size')).toEqual(['debe ser ≤ 2147483647']);
  });
  it('ids y size: 0 y 1.5 se rechazan con mensajes en español', () => {
    const base = { side: 'BUY', type: 'MARKET', userid: 1, instrumentid: 1, size: 1 };
    expect(messageOf(parse({ ...base, userid: 0 }), 'userid')).toEqual(['debe ser > 0']);
    expect(messageOf(parse({ ...base, instrumentid: 1.5 }), 'instrumentid')).toEqual(['debe ser un entero']);
    expect(messageOf(parse({ ...base, size: -1 }), 'size')).toEqual(['debe ser > 0']);
  });
});

describe('validateOrder', () => {
  const base = { userid: 1, side: 'BUY', type: 'MARKET', instrumentid: 47 } as const;
  it('size y amount a la vez → error', () => expect(validateOrder({ ...base, size: 1, amount: '1' })).toMatch(/exactamente uno/));
  it('ni size ni amount → error', () => expect(validateOrder({ ...base })).toMatch(/exactamente uno/));
  it('MARKET con price → error', () => expect(validateOrder({ ...base, size: 1, price: '1' })).toMatch(/MARKET/));
  it('LIMIT sin price → error', () => expect(validateOrder({ ...base, type: 'LIMIT', size: 1 })).toMatch(/LIMIT/));
  it('BUY sin instrumentid → error', () => expect(validateOrder({ userid: 1, side: 'BUY', type: 'MARKET', size: 1 })).toMatch(/instrumentid/));
  it('cash con size → error', () => expect(validateOrder({ userid: 1, side: 'CASH_IN', type: 'MARKET', size: 1 })).toMatch(/amount/));
  it('cash con instrumentid → error', () => expect(validateOrder({ userid: 1, side: 'CASH_IN', type: 'MARKET', amount: '1', instrumentid: 66 })).toMatch(/instrumentid/));
  it('cash por encima del máximo por movimiento → error', () =>
    expect(validateOrder({ userid: 1, side: 'CASH_IN', type: 'MARKET', amount: '21474836.48' })).toMatch(/máximo/));
  it('cash en el máximo → ok', () =>
    expect(validateOrder({ userid: 1, side: 'CASH_IN', type: 'MARKET', amount: '21474836.47' })).toBeNull());
  it('BUY válido → ok', () => expect(validateOrder({ ...base, size: 1 })).toBeNull());
});

describe('requestHash', () => {
  it('no depende del orden de las claves', () => expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 })));
  it('cambia con el contenido', () => expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 })));

  // Issue #4: el mismo monto en otra escala es el mismo request (D-19).
  const hashOf = (b: Record<string, unknown>) => requestHash(parse(b).data!);
  it('amount 100, "100", "100.0", "100.00" y " 100.00 " → mismo hash', () => {
    const hashes = [100, '100', '100.0', '100.00', ' 100.00 '].map((amount) => hashOf({ userid: 1, side: 'CASH_IN', amount }));
    expect(new Set(hashes).size).toBe(1);
  });
  it('price 900, "900", "900.0" y "900.00" → mismo hash', () => {
    const hashes = [900, '900', '900.0', '900.00'].map((price) =>
      hashOf({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price }));
    expect(new Set(hashes).size).toBe(1);
  });
  it('amount y price quedan canonizados a 2 decimales', () => {
    expect(parse({ userid: 1, side: 'CASH_IN', amount: ' 007.5 ' }).data?.amount).toBe('7.50');
    expect(parse({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price: 900 }).data?.price).toBe('900.00');
  });
  it('price 100 y "100.00", y 9007199254740991 y "9007199254740991", siguen dando el mismo hash (issue #8)', () => {
    const limit = (price: unknown) => hashOf({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price });
    expect(limit(100)).toBe(limit('100.00'));
    expect(limit(9007199254740991)).toBe(limit('9007199254740991'));
    expect(limit(9007199254740991)).not.toBe(limit('9007199254740990'));
  });
  it('otro monto sigue dando otro hash', () =>
    expect(hashOf({ userid: 1, side: 'CASH_IN', amount: '100.00' })).not.toBe(hashOf({ userid: 1, side: 'CASH_IN', amount: '100.01' })));
  it('"100.001" se sigue rechazando, no se redondea', () =>
    expect(parse({ userid: 1, side: 'CASH_IN', amount: '100.001' }).success).toBe(false));
  it('por encima de 2⁵³ centavos la canonización no pierde precisión: un centavo de diferencia es otro request', () => {
    const big = ['90071992547409.92', '90071992547409.93'];
    const buy = big.map((amount) => ({ userid: 1, side: 'BUY', type: 'MARKET', instrumentid: 1, amount }));
    const limit = big.map((price) => ({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price }));
    expect(buy.map((b) => parse(b).data?.amount)).toEqual(big);
    expect(limit.map((b) => parse(b).data?.price)).toEqual(big);
    expect(hashOf(buy[0])).not.toBe(hashOf(buy[1]));
    expect(hashOf(limit[0])).not.toBe(hashOf(limit[1]));
  });
  it('transición: legacyRequestHash da el hash sin canonizar de la versión anterior, o null si es el mismo', () => {
    const legacyOf = (b: Record<string, any>) => legacyRequestHash(parse(b).data!, b);
    const asBefore = requestHash({ userid: 1, side: 'CASH_IN', type: 'MARKET', amount: '100' });
    expect(legacyOf({ userid: 1, side: 'CASH_IN', amount: 100 })).toBe(asBefore);
    expect(legacyOf({ userid: 1, side: 'CASH_IN', amount: ' 100 ' })).toBe(asBefore);
    expect(legacyOf({ userid: 1, side: 'CASH_IN', amount: '100.00' })).toBeNull();
    expect(legacyOf({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price: '900.5' }))
      .toBe(requestHash({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: 1, size: 1, price: '900.5' }));
  });
});

describe('orderView', () => {
  it('amount = size × price; datetime en ISO UTC', () => {
    expect(orderView({ id: 1, userid: 1, instrumentid: 47, side: 'BUY', type: 'MARKET', size: 10, price: '925.85',
      status: 'FILLED', balance_seq: '3', datetime: '2023-07-13 12:31:20.123456', cancel_reason: null }))
      .toMatchObject({ amount: '9258.50', datetime: '2023-07-13T12:31:20Z' });
  });
  it('cancel_reason va siempre: el motivo en una CANCELLED, null en las demás (issue #21)', () => {
    const row = { id: 1, userid: 1, instrumentid: 47, side: 'BUY', type: 'LIMIT', size: 10, price: '925.85',
      balance_seq: null, datetime: '2023-07-13 12:31:20' };
    expect(orderView({ ...row, status: 'CANCELLED', cancel_reason: 'LIMIT' }).cancel_reason).toBe('LIMIT');
    expect(orderView({ ...row, status: 'NEW', cancel_reason: null })).toHaveProperty('cancel_reason', null);
  });
});

describe('guard de parsers de node-postgres (D-13)', () => {
  it('int8 (OID 20) llega como string intacto', () => expect(parserFor(20)('9007199254740993')).toBe('9007199254740993'));
  it('numeric (OID 1700) llega como string intacto', () => expect(parserFor(1700)('1.10')).toBe('1.10'));
});
