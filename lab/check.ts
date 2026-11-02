// Verificación del lab de punta a punta (issue #72), contra el proxy:
//
//   tsx lab/check.ts <url base> [dir del dataset]        (dir: lab/.data)
//
// Para las 3 ballenas y la muestra de usuarios de manifest.json:
//   - v2 coincide con el oráculo de los tests (test/oracle/fold.ts), plegado acá desde orders.csv
//     del dataset: cash, reservas, cantidades y costo de cada posición.
//   - v3 responde exactamente el mismo JSON que v2.
//   - v1 coincide con v2 en todo lo que no depende del método de costo: cash, cantidades,
//     reservas, precio, valor y valor total. Costo, resultado y rendimiento de Z son el promedio
//     de todas las compras (lab/z/server.ts): se informan cuántas posiciones difieren, no fallan.
// Además: un usuario inexistente da 404 en las tres, GET /orders/:id y /instruments coinciden, y un
// POST responde 403 en v1 y v3 y llega a la API en v2 (sin Idempotency-Key: 400, no crea nada).
// Tiempos: la primera request (fría) y la mediana de 5 más, por variante. Sale con 1 si algo no
// coincide.
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import * as O from '../test/oracle/fold.js';

const [base, dir = 'lab/.data'] = process.argv.slice(2);
if (!base) throw new Error('uso: check.ts <url base> [dir del dataset]');

interface Manifest { whales: { id: number; filled: number }[]; sample_users: Record<string, number[]> }
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
const users = [
  ...manifest.whales.map((w) => ({ id: w.id, cohort: 'ballena' })),
  ...Object.entries(manifest.sample_users).flatMap(([cohort, ids]) => ids.map((id) => ({ id, cohort }))),
];

const VARIANTS = ['v1', 'v2', 'v3'] as const;
type Variant = (typeof VARIANTS)[number];
const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); console.log(`  FALLA ${msg}`); };

async function get(path: string): Promise<{ status: number; body: any; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, ms: performance.now() - t0 };
}

// ---------- oráculo, desde orders.csv ----------
const cents = (price: string) => {
  const [i, f = ''] = price.split('.');
  return BigInt(i + f.padEnd(2, '0'));
};
const fmt = (v: bigint, scale: number) => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
};
interface Expected { cash: string; reserved: string; positions: Map<number, { qty: string; cost: string; reserved: string }> }

async function oracle(ids: Set<number>): Promise<Map<number, Expected>> {
  // orders.csv: id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq
  const filled = new Map<number, { seq: bigint; side: string; instrumentid: number; size: bigint; price: bigint }[]>();
  const reservedCash = new Map<number, bigint>();
  const reservedShares = new Map<string, bigint>();
  let header = true;
  for await (const l of createInterface({ input: createReadStream(join(dir, 'orders.csv')), crlfDelay: Infinity })) {
    if (header) { header = false; continue; }
    const f = l.split(',');
    const userid = Number(f[2]);
    if (!ids.has(userid)) continue;
    const [instrumentid, size, price, side, status] = [Number(f[1]), BigInt(f[3]), cents(f[4]), f[6], f[7]];
    if (status === 'FILLED') {
      if (!filled.has(userid)) filled.set(userid, []);
      filled.get(userid)!.push({ seq: BigInt(f[9]), side, instrumentid, size, price });
    } else if (status === 'NEW' && side === 'BUY') {
      reservedCash.set(userid, (reservedCash.get(userid) ?? 0n) + size * price);
    } else if (status === 'NEW' && side === 'SELL') {
      const k = `${userid}:${instrumentid}`;
      reservedShares.set(k, (reservedShares.get(k) ?? 0n) + size);
    }
  }
  const out = new Map<number, Expected>();
  for (const userid of ids) {
    const s = O.newState();
    for (const o of (filled.get(userid) ?? []).sort((a, b) => (a.seq < b.seq ? -1 : 1))) {
      if (o.side === 'CASH_IN') s.cashCents += o.size * o.price;
      else if (o.side === 'CASH_OUT') s.cashCents -= o.size * o.price;
      else O.fill(s, o.side as 'BUY' | 'SELL', o.instrumentid, o.size, o.price);
    }
    const positions = new Map<number, { qty: string; cost: string; reserved: string }>();
    for (const [i, p] of s.positions) {
      if (p.qty !== 0n) positions.set(i, { qty: p.qty.toString(), cost: fmt(p.cost, 6), reserved: (reservedShares.get(`${userid}:${i}`) ?? 0n).toString() });
    }
    out.set(userid, { cash: fmt(s.cashCents, 2), reserved: fmt(reservedCash.get(userid) ?? 0n, 2), positions });
  }
  return out;
}

// ---------- comparaciones ----------
const SAME_IN_Z = ['qty', 'acciones_reservadas', 'acciones_disponibles', 'price', 'price_date', 'valor', 'retorno_diario_pct'] as const;
const COST_FIELDS = ['costo_total', 'costo_unitario', 'resultado', 'rendimiento_pct'] as const;

function compareOracle(id: number, p: any, e: Expected) {
  if (p.cash.neto !== e.cash) fail(`${id}: v2 cash.neto ${p.cash.neto}, oráculo ${e.cash}`);
  if (p.cash.reservado !== e.reserved) fail(`${id}: v2 cash.reservado ${p.cash.reservado}, oráculo ${e.reserved}`);
  if (p.positions.length !== e.positions.size) fail(`${id}: v2 tiene ${p.positions.length} posiciones, el oráculo ${e.positions.size}`);
  for (const pos of p.positions) {
    const x = e.positions.get(pos.instrumentid);
    if (!x) { fail(`${id}: v2 tiene el instrumento ${pos.instrumentid}, el oráculo no`); continue; }
    if (pos.qty !== x.qty || pos.costo_total !== x.cost || pos.acciones_reservadas !== x.reserved) {
      fail(`${id}/${pos.instrumentid}: v2 qty ${pos.qty} costo ${pos.costo_total} reservadas ${pos.acciones_reservadas}, oráculo ${x.qty} ${x.cost} ${x.reserved}`);
    }
  }
}

/** Posiciones de Z con costo distinto del de A (informativo). */
function compareZ(id: number, z: any, a: any): number {
  for (const k of ['valor_total', 'valuation_complete', 'has_inconsistent_history'] as const) {
    if (z[k] !== a[k]) fail(`${id}: v1 ${k} ${z[k]}, v2 ${a[k]}`);
  }
  for (const k of ['neto', 'reservado', 'disponible'] as const) {
    if (z.cash[k] !== a.cash[k]) fail(`${id}: v1 cash.${k} ${z.cash[k]}, v2 ${a.cash[k]}`);
  }
  if (z.positions.length !== a.positions.length) { fail(`${id}: v1 tiene ${z.positions.length} posiciones, v2 ${a.positions.length}`); return 0; }
  let costDiff = 0;
  z.positions.forEach((zp: any, i: number) => {
    const ap = a.positions[i];
    if (zp.instrumentid !== ap.instrumentid) { fail(`${id}: posición ${i}: v1 instrumento ${zp.instrumentid}, v2 ${ap.instrumentid}`); return; }
    for (const k of SAME_IN_Z) if (zp[k] !== ap[k]) fail(`${id}/${zp.instrumentid}: v1 ${k} ${zp[k]}, v2 ${ap[k]}`);
    if (COST_FIELDS.some((k) => zp[k] !== ap[k])) costDiff++;
  });
  return costDiff;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString()).padStart(6);

console.log(`oráculo: plegando ${users.length} usuarios desde ${join(dir, 'orders.csv')}`);
const expected = await oracle(new Set(users.map((u) => u.id)));

console.log('\nGET /vN/portfolio/<id>: primera request y mediana de 5 (ms)');
console.log(`${'usuario'.padEnd(8)} ${'cohorte'.padEnd(8)} ${'ejec.'.padStart(7)} ${VARIANTS.map((v) => `${v} 1ª`.padStart(7) + `${v} med`.padStart(8)).join(' ')}  costo Z distinto`);
for (const u of users) {
  const bodies = {} as Record<Variant, any>;
  const times = {} as Record<Variant, { first: number; median: number }>;
  for (const v of VARIANTS) {
    const first = await get(`/${v}/portfolio/${u.id}`);
    if (first.status !== 200) { fail(`${u.id}: ${v} respondió ${first.status}`); continue; }
    const rest: number[] = [];
    for (let i = 0; i < 5; i++) rest.push((await get(`/${v}/portfolio/${u.id}`)).ms);
    bodies[v] = first.body;
    times[v] = { first: first.ms, median: median(rest) };
  }
  if (!bodies.v1 || !bodies.v2 || !bodies.v3) continue;
  compareOracle(u.id, bodies.v2, expected.get(u.id)!);
  if (JSON.stringify(bodies.v3) !== JSON.stringify(bodies.v2)) fail(`${u.id}: v3 no responde lo mismo que v2`);
  const costDiff = compareZ(u.id, bodies.v1, bodies.v2);
  const filled = manifest.whales.find((w) => w.id === u.id)?.filled;
  console.log(`${String(u.id).padEnd(8)} ${u.cohort.padEnd(8)} ${(filled ? String(filled) : '').padStart(7)} ${VARIANTS.map((v) => `${ms(times[v].first)} ${ms(times[v].median)}  `).join(' ')}  ${costDiff}/${bodies.v2.positions.length}`);
}

console.log('\notros endpoints');
const missing = await Promise.all(VARIANTS.map((v) => get(`/${v}/portfolio/999999`)));
if (missing.some((r) => r.status !== 404)) fail(`usuario inexistente: ${missing.map((r) => r.status).join(', ')} (se espera 404 en las tres)`);

const whale = manifest.whales[0].id;
const anOrder = await firstOrderOf(whale);
async function firstOrderOf(userid: number): Promise<string | null> {
  let header = true;
  for await (const l of createInterface({ input: createReadStream(join(dir, 'orders.csv')), crlfDelay: Infinity })) {
    if (header) { header = false; continue; }
    const f = l.split(',');
    if (Number(f[2]) === userid && f[6] === 'SELL' && f[7] === 'FILLED') return f[0];
  }
  return null;
}
if (anOrder) {
  const [z, a, c] = await Promise.all(VARIANTS.map((v) => get(`/${v}/orders/${anOrder}?userid=${whale}`)));
  if (JSON.stringify(c.body) !== JSON.stringify(a.body)) fail(`GET /orders/${anOrder}: v3 no responde lo mismo que v2`);
  for (const k of ['id', 'userid', 'instrumentid', 'side', 'type', 'size', 'price', 'amount', 'status', 'datetime']) {
    if (z.body?.[k] !== a.body?.[k]) fail(`GET /orders/${anOrder}: v1 ${k} ${z.body?.[k]}, v2 ${a.body?.[k]}`);
  }
}
const ticker = (await get(`/v2/portfolio/${whale}`)).body.positions[0].ticker as string;
const search = await Promise.all(VARIANTS.map((v) => get(`/${v}/instruments?q=${ticker}`)));
if (search.some((r) => r.body?.results?.[0]?.ticker !== ticker)) fail(`GET /instruments?q=${ticker}: el primero no es ${ticker} en alguna variante`);

const posts = await Promise.all(VARIANTS.map((v) => fetch(`${base}/${v}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })));
const codes = posts.map((r) => r.status);
if (codes[0] !== 403 || codes[2] !== 403) fail(`POST /orders: v1 ${codes[0]}, v3 ${codes[2]} (se espera 403)`);
if (codes[1] !== 400) fail(`POST /v2/orders sin Idempotency-Key: ${codes[1]} (se espera el 400 de A)`);
console.log(`  404 del usuario inexistente, GET /orders/${anOrder}, GET /instruments?q=${ticker}; POST /orders: ${codes.join(' / ')}`);

console.log(failures.length ? `\n${failures.length} diferencia(s)` : '\nOK: v2 = oráculo, v3 = v2, v1 = v2 salvo el costo; POST 403 en v1 y v3');
process.exit(failures.length ? 1 : 0);
