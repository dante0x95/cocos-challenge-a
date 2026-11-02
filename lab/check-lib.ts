// Lo que lab/check.ts espera de cada variante, sin red ni archivos: así lo prueban test/unit/lab con
// datos chicos y controles que lo hacen fallar.
//   - expectedA: el oráculo de los tests (test/oracle/fold.ts) plegado sobre las órdenes del dataset:
//     lo que tiene que responder v2, y v3 byte a byte.
//   - expectedZ: la definición de costo de Z (lab/z/server.ts), calculada acá con enteros: Σ importes
//     de compra / Σ acciones compradas × cantidad, redondeado como round() de Postgres (los empates
//     hacia afuera). Z calcula en numeric, así que se compara exacto, string contra string.
import * as O from '../test/oracle/fold.js';

/** Una fila de orders.csv del dataset, ya parseada. price en centavos. */
export interface Row { id: string; userid: number; instrumentid: number; size: bigint; price: bigint; side: string; status: string; seq: bigint | null }

export const ORDERS_HEADER = 'id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq';

export const cents = (price: string): bigint => {
  const [i, f = ''] = price.split('.');
  return BigInt(i + f.padEnd(2, '0'));
};

export function parseRow(line: string): Row {
  const f = line.split(',');
  return {
    id: f[0], instrumentid: Number(f[1]), userid: Number(f[2]), size: BigInt(f[3]), price: cents(f[4]),
    side: f[6], status: f[7], seq: f[9] ? BigInt(f[9]) : null,
  };
}

export const fmt = (v: bigint, scale: number): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
};

export interface ExpectedA {
  cash: string;
  reserved: string;
  positions: Map<number, { qty: string; cost: string; reserved: string }>;
}

/** El oráculo sobre las órdenes de un usuario: FILLED en orden de balance_seq; NEW como reservas. */
export function expectedA(rows: Row[]): ExpectedA {
  const s = O.newState();
  let reservedCash = 0n;
  const reservedShares = new Map<number, bigint>();
  const filled = rows.filter((r) => r.status === 'FILLED').sort((a, b) => (a.seq! < b.seq! ? -1 : 1));
  for (const r of filled) {
    if (r.side === 'CASH_IN') s.cashCents += r.size * r.price;
    else if (r.side === 'CASH_OUT') s.cashCents -= r.size * r.price;
    else O.fill(s, r.side as 'BUY' | 'SELL', r.instrumentid, r.size, r.price);
  }
  for (const r of rows.filter((x) => x.status === 'NEW')) {
    if (r.side === 'BUY') reservedCash += r.size * r.price;
    if (r.side === 'SELL') reservedShares.set(r.instrumentid, (reservedShares.get(r.instrumentid) ?? 0n) + r.size);
  }
  const positions = new Map<number, { qty: string; cost: string; reserved: string }>();
  for (const [i, p] of s.positions) {
    if (p.qty !== 0n) positions.set(i, { qty: p.qty.toString(), cost: fmt(p.cost, 6), reserved: (reservedShares.get(i) ?? 0n).toString() });
  }
  return { cash: fmt(s.cashCents, 2), reserved: fmt(reservedCash, 2), positions };
}

/** Costo de Z por instrumento, exacto: Σ importes de BUY FILLED (centavos) y Σ acciones compradas. */
export function expectedZ(rows: Row[]): Map<number, { boughtCents: bigint; boughtQty: bigint }> {
  const out = new Map<number, { boughtCents: bigint; boughtQty: bigint }>();
  for (const r of rows) {
    if (r.status !== 'FILLED' || r.side !== 'BUY') continue;
    const x = out.get(r.instrumentid) ?? { boughtCents: 0n, boughtQty: 0n };
    out.set(r.instrumentid, { boughtCents: x.boughtCents + r.size * r.price, boughtQty: x.boughtQty + r.size });
  }
  return out;
}

/** v2 (o v3) contra el oráculo. Devuelve las diferencias. */
export function compareA(id: number, p: any, e: ExpectedA): string[] {
  const out: string[] = [];
  if (p.cash?.neto !== e.cash) out.push(`${id}: cash.neto ${p.cash?.neto}, oráculo ${e.cash}`);
  if (p.cash?.reservado !== e.reserved) out.push(`${id}: cash.reservado ${p.cash?.reservado}, oráculo ${e.reserved}`);
  if (p.positions?.length !== e.positions.size) out.push(`${id}: ${p.positions?.length} posiciones, el oráculo ${e.positions.size}`);
  for (const pos of p.positions ?? []) {
    const x = e.positions.get(pos.instrumentid);
    if (!x) { out.push(`${id}: el instrumento ${pos.instrumentid} no está en el oráculo`); continue; }
    if (pos.qty !== x.qty || pos.costo_total !== x.cost || pos.acciones_reservadas !== x.reserved) {
      out.push(`${id}/${pos.instrumentid}: qty ${pos.qty} costo ${pos.costo_total} reservadas ${pos.acciones_reservadas}, oráculo ${x.qty} ${x.cost} ${x.reserved}`);
    }
  }
  return out;
}

const SAME_IN_Z = ['instrumentid', 'ticker', 'name', 'qty', 'acciones_reservadas', 'acciones_disponibles', 'price', 'price_date', 'valor', 'retorno_diario_pct', 'inconsistent'] as const;

/** num / den redondeado a entero, con los empates hacia afuera (round() de numeric en Postgres). den > 0. */
export function roundHalfAway(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const q = (2n * abs + den) / (2n * den);
  return neg ? -q : q;
}

/** Los campos de costo de una posición de Z, según su definición. */
export function zCostFields(b: { boughtCents: bigint; boughtQty: bigint }, qty: bigint, valor: string | null) {
  // costo = bought / boughtQty × qty, en micro-ARS: centavos × qty × 10^4 / boughtQty
  const costMicro = roundHalfAway(b.boughtCents * qty * 10_000n, b.boughtQty);
  const out = {
    costo_total: fmt(costMicro, 6),
    costo_unitario: qty > 0n ? fmt(roundHalfAway(b.boughtCents * 100n, b.boughtQty), 4) : null,
    resultado: null as string | null,
    rendimiento_pct: null as string | null,
  };
  if (valor !== null && costMicro > 0n) {
    const diffMicro = cents(valor) * 10_000n - costMicro;
    out.resultado = fmt(roundHalfAway(diffMicro, 10_000n), 2);
    out.rendimiento_pct = fmt(roundHalfAway(diffMicro * 10_000n, costMicro), 2);
  }
  return out;
}

/**
 * v1 contra v2 y contra la definición de costo de Z. Todo lo que no depende del costo, igual a v2;
 * costo_total, costo_unitario, resultado y rendimiento_pct, exactamente los del promedio de compras.
 */
export function compareZ(id: number, z: any, a: any, ez: Map<number, { boughtCents: bigint; boughtQty: bigint }>): string[] {
  const out: string[] = [];
  for (const k of ['userid', 'valor_total', 'valuation_complete', 'has_inconsistent_history'] as const) {
    if (z[k] !== a[k]) out.push(`${id}: v1 ${k} ${z[k]}, v2 ${a[k]}`);
  }
  for (const k of ['neto', 'reservado', 'disponible'] as const) {
    if (z.cash?.[k] !== a.cash?.[k]) out.push(`${id}: v1 cash.${k} ${z.cash?.[k]}, v2 ${a.cash?.[k]}`);
  }
  if (z.positions?.length !== a.positions?.length) {
    out.push(`${id}: v1 tiene ${z.positions?.length} posiciones, v2 ${a.positions?.length}`);
    return out;
  }
  z.positions.forEach((zp: any, i: number) => {
    const ap = a.positions[i];
    for (const k of SAME_IN_Z) if (zp[k] !== ap[k]) out.push(`${id}/${ap.instrumentid}: v1 ${k} ${zp[k]}, v2 ${ap[k]}`);
    const b = ez.get(zp.instrumentid);
    if (!b || b.boughtQty === 0n) { out.push(`${id}/${zp.instrumentid}: v1 tiene una posición sin compras`); return; }
    const want = zCostFields(b, BigInt(zp.qty), zp.valor);
    for (const [k, v] of Object.entries(want)) {
      if (zp[k] !== v) out.push(`${id}/${zp.instrumentid}: v1 ${k} ${zp[k]}, el promedio de compras da ${v}`);
    }
  });
  return out;
}

/** Posiciones en que el costo de Z difiere del de A (informativo: es la diferencia de método). */
export const zCostDiffers = (z: any, a: any): number =>
  z.positions.filter((zp: any, i: number) => zp.costo_total !== a.positions[i]?.costo_total).length;

/** Cada respuesta cronometrada: 200 y el mismo cuerpo que la primera. */
export function compareTimed(label: string, responses: { status: number; text: string }[]): string[] {
  const out: string[] = [];
  responses.forEach((r, i) => {
    if (r.status !== 200) out.push(`${label}: la request ${i + 1} respondió ${r.status}`);
    else if (r.text !== responses[0].text) out.push(`${label}: la request ${i + 1} no responde lo mismo que la primera`);
  });
  return out;
}

export interface Instrument { id: number; ticker: string; name: string; type: string }

/** Los instrumentos de database.sql (db/migrations/000_seed.sql), con sus ids: 1, 2, … en orden. */
export function seedInstruments(sql: string): Instrument[] {
  return [...sql.matchAll(/^\s*\('([^']*)','([^']*)','([^']*)'\)[,;]/gm)]
    .map((m, i) => ({ id: i + 1, ticker: m[1], name: m[2], type: m[3] }));
}

/** instruments.csv del dataset (id,ticker,name,type). */
export const parseInstruments = (csv: string): Instrument[] => csv.trim().split('\n').slice(1).map((l) => {
  const [id, ticker, name, type] = l.split(',');
  return { id: Number(id), ticker, name, type };
});

/** Lo que tiene que encontrar Z: q como texto, sin distinguir mayúsculas, en ticker o nombre. Ids ordenados. */
export function expectedZSearch(all: Instrument[], q: string, includeCash: boolean): number[] {
  const needle = q.trim().toLowerCase();
  return all.filter((i) => (includeCash || i.type !== 'MONEDA')
      && (i.ticker.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle)))
    .map((i) => i.id).sort((a, b) => a - b);
}

/**
 * La respuesta de /v1/instruments contra la definición de Z: los mismos instrumentos, con sus
 * campos, ordenados por ticker y hasta `limit`. Con más candidatos que `limit`, los primeros
 * `limit` por ticker. El orden se compara por código de carácter, que coincide con el de Postgres
 * para tickers de mayúsculas y dígitos (los del dataset y los de database.sql).
 */
export function compareZSearch(label: string, results: unknown, all: Instrument[], q: string, includeCash: boolean, limit: number): string[] {
  if (!Array.isArray(results)) return [`${label}: v1 sin results`];
  const byId = new Map(all.map((i) => [i.id, i]));
  const want = expectedZSearch(all, q, includeCash).map((id) => byId.get(id)!)
    .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0)).slice(0, limit);
  const got = JSON.stringify(results);
  return got === JSON.stringify(want) ? []
    : [`${label}: v1 ${results.length} resultados, su definición da ${want.length}: ${want.slice(0, 5).map((i) => i.ticker).join(', ')}…`];
}
