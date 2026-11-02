// Verificación del lab de punta a punta (issue #72), contra el proxy:
//
//   tsx lab/check.ts <url base> [dir del dataset]        (dir: lab/.data)
//
// Para las 3 ballenas y la muestra de usuarios de manifest.json (lab/check-lib.ts):
//   - v2 coincide con el oráculo de los tests (test/oracle/fold.ts), plegado acá desde orders.csv
//     del dataset: cash, reservas, cantidades y costo de cada posición.
//   - v3 responde exactamente el mismo JSON que v2.
//   - v1 coincide con v2 en todo lo que no depende del método de costo (cash, cantidades, reservas,
//     precio, valor y valor total), y su costo, resultado y rendimiento, exactamente, con el
//     promedio de todas las compras, la definición de Z (lab/z/server.ts; decisión en #72).
//   - Tiempos: la primera request (fría) y la mediana de 5 más, por variante. Cada una tiene que
//     responder 200 y el mismo cuerpo que la primera: un tiempo de una respuesta fallida no cuenta.
// Además, en las tres: un usuario inexistente da 404; GET /orders/:id coincide; GET /instruments
// coincide entre v2 y v3, v1 encuentra exactamente lo que da su definición (q como texto, en ticker
// o nombre, sin acentos ni trigramas) y v2 también lo encuentra; las entradas inválidas dan 400; y toda escritura (crear y
// cancelar órdenes, /internal, otros métodos) da 403 sin cambiar nada. Sale con 1 si algo no coincide.
import { createReadStream, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ORDERS_HEADER, compareA, compareTimed, compareZ, compareZSearch, expectedA, expectedZ, expectedZSearch, parseInstruments, parseRow, seedInstruments,
  zCostDiffers, type Row,
} from './check-lib.js';

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
const fail = (...msgs: string[]) => { for (const m of msgs) { failures.push(m); console.log(`  FALLA ${m}`); } };

async function request(path: string, init?: RequestInit): Promise<{ status: number; text: string; body: any; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, init);
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, text, body, ms: performance.now() - t0 };
}
const all = (path: string) => Promise.all(VARIANTS.map((v) => request(`/${v}${path}`)));

// ---------- las órdenes de los usuarios a comparar, desde orders.csv ----------
const ids = new Set(users.map((u) => u.id));
const rowsOf = new Map<number, Row[]>();
{
  let header = true;
  for await (const l of createInterface({ input: createReadStream(join(dir, 'orders.csv')), crlfDelay: Infinity })) {
    if (header) {
      if (l !== ORDERS_HEADER) throw new Error(`orders.csv con otra cabecera: ${l}`);
      header = false;
      continue;
    }
    const r = parseRow(l);
    if (!ids.has(r.userid)) continue;
    if (!rowsOf.has(r.userid)) rowsOf.set(r.userid, []);
    rowsOf.get(r.userid)!.push(r);
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString()).padStart(6);

console.log(`GET /vN/portfolio/<id>: primera request y mediana de 5 más (ms); ${users.length} usuarios`);
console.log(`${'usuario'.padEnd(8)} ${'cohorte'.padEnd(8)} ${'ejec.'.padStart(7)} ${VARIANTS.map((v) => `${v} 1ª`.padStart(7) + `${v} med`.padStart(8)).join(' ')}  costo de Z ≠ A`);
const portfolios = new Map<number, Record<Variant, any>>();
for (const u of users) {
  const bodies = {} as Record<Variant, any>;
  const times = {} as Record<Variant, { first: number; median: number }>;
  let ok = true;
  for (const v of VARIANTS) {
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await request(`/${v}/portfolio/${u.id}`));
    const bad = compareTimed(`${u.id} ${v}`, runs);
    if (bad.length) { fail(...bad); ok = false; continue; }
    bodies[v] = runs[0].body;
    times[v] = { first: runs[0].ms, median: median(runs.slice(1).map((r) => r.ms)) };
  }
  if (!ok) continue;
  const rows = rowsOf.get(u.id) ?? [];
  fail(...compareA(u.id, bodies.v2, expectedA(rows)));
  if (JSON.stringify(bodies.v3) !== JSON.stringify(bodies.v2)) fail(`${u.id}: v3 no responde lo mismo que v2`);
  fail(...compareZ(u.id, bodies.v1, bodies.v2, expectedZ(rows)));
  portfolios.set(u.id, bodies);
  const filled = manifest.whales.find((w) => w.id === u.id)?.filled;
  console.log(`${String(u.id).padEnd(8)} ${u.cohort.padEnd(8)} ${(filled ? String(filled) : '').padStart(7)} ${VARIANTS.map((v) => `${ms(times[v].first)} ${ms(times[v].median)}  `).join(' ')}  ${zCostDiffers(bodies.v1, bodies.v2)}/${bodies.v2.positions.length}`);
}

console.log('\nportfolio, órdenes y búsqueda');
const missing = await all('/portfolio/999999');
if (missing.some((r) => r.status !== 404)) fail(`usuario inexistente: ${missing.map((r) => r.status).join(', ')} (se espera 404 en las tres)`);
const badId = await all('/portfolio/abc');
if (badId.some((r) => r.status !== 400)) fail(`userid inválido: ${badId.map((r) => r.status).join(', ')} (se espera 400 en las tres)`);

const whale = manifest.whales[0].id;
const sold = rowsOf.get(whale)!.find((r) => r.side === 'SELL' && r.status === 'FILLED')!;
for (const path of [`/orders/${sold.id}?userid=${whale}`, `/orders/${sold.id}?userid=${whale + 1}`, `/orders/abc?userid=${whale}`, `/orders/${sold.id}`]) {
  const [z, a, c] = await all(path);
  if (z.status !== a.status || c.status !== a.status) fail(`GET ${path}: ${z.status} / ${a.status} / ${c.status}`);
  if (c.text !== a.text) fail(`GET ${path}: v3 no responde lo mismo que v2`);
  if (a.status === 200) {
    for (const k of ['id', 'userid', 'instrumentid', 'side', 'type', 'size', 'price', 'amount', 'status', 'datetime']) {
      if (z.body?.[k] !== a.body?.[k]) fail(`GET ${path}: v1 ${k} ${z.body?.[k]}, v2 ${a.body?.[k]}`);
    }
  }
}

const ticker = portfolios.get(whale)?.v2.positions[0].ticker as string;
const instruments = [
  ...seedInstruments(readFileSync(resolve(import.meta.dirname, '../db/migrations/000_seed.sql'), 'utf8')),
  ...parseInstruments(readFileSync(join(dir, 'instruments.csv'), 'utf8')),
];
const idsOf = (r: { body: any }) => (r.body?.results ?? []).map((x: any) => x.id as number);
const searches: { q: string; limit: number; cash?: boolean; first?: string }[] = [
  { q: ticker, limit: 20, first: ticker },                  // ticker exacto: primero en v2
  { q: ticker.slice(0, 3), limit: 50 },                     // parcial
  { q: ticker.slice(1).toLowerCase(), limit: 50 },          // parcial, en minúsculas
  { q: 's.a', limit: 50 },                                  // por nombre: más de 50, Z corta en 50
  { q: '%', limit: 20 },                                    // comodines como texto: nada los contiene
  { q: '_', limit: 20 },
  { q: 'ARS', limit: 50, cash: true, first: 'ARS' },        // la moneda, solo con include_cash
  { q: 'ARS', limit: 50 },
];
for (const s of searches) {
  const path = `/instruments?q=${encodeURIComponent(s.q)}&limit=${s.limit}${s.cash ? '&include_cash=true' : ''}`;
  const [z, a, c] = await all(path);
  if (z.status !== 200 || a.status !== 200 || c.status !== 200) { fail(`GET ${path}: ${z.status} / ${a.status} / ${c.status}`); continue; }
  if (c.text !== a.text) fail(`GET ${path}: v3 no responde lo mismo que v2`);
  fail(...compareZSearch(`GET /v1${path}`, z.body?.results, instruments, s.q, !!s.cash, s.limit));
  // A encuentra todo lo que contiene q (y además, por trigramas, lo parecido), salvo que corte en el límite.
  const ga = idsOf(a);
  if (ga.length < s.limit && expectedZSearch(instruments, s.q, !!s.cash).some((id) => !ga.includes(id))) {
    fail(`GET /v2${path}: no encuentra todo lo que contiene "${s.q}"`);
  }
  if (s.first && a.body.results[0]?.ticker !== s.first) fail(`GET ${path}: el primero de v2 no es ${s.first}`);
}
for (const path of ['/instruments?q=', '/instruments', `/instruments?q=${'x'.repeat(51)}`, '/instruments?q=ab%00c', `/instruments?q=${ticker}&limit=0`, `/instruments?q=${ticker}&limit=51`]) {
  const rs = await all(path);
  if (rs.some((r) => r.status !== 400)) fail(`GET ${path}: ${rs.map((r) => r.status).join(' / ')} (se espera 400 en las tres)`);
}

console.log('\nescrituras');
const sample = users[users.length - 1].id;
const before = await all(`/portfolio/${sample}`);
const order = JSON.stringify({ userid: sample, side: 'CASH_IN', type: 'MARKET', amount: '100.00' });
const writes: { method: string; path: string; body?: string }[] = [
  { method: 'POST', path: '/orders', body: order },
  { method: 'POST', path: `/orders/${sold.id}/cancel`, body: JSON.stringify({ userid: whale }) },
  { method: 'POST', path: '/internal/execute-limits' },
  { method: 'POST', path: '/internal/cleanup-idempotency' },
  { method: 'PUT', path: '/orders', body: order },
  { method: 'PATCH', path: `/orders/${sold.id}`, body: order },
  { method: 'DELETE', path: `/orders/${sold.id}` },
];
for (const w of writes) {
  for (const v of VARIANTS) {
    const r = await request(`/${v}${w.path}`, {
      method: w.method, body: w.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `lab-check-${Date.now()}`, 'X-Internal-Token': 'x' },
    });
    if (r.status !== 403) fail(`${w.method} /${v}${w.path}: ${r.status} (se espera 403)`);
  }
}
const after = await all(`/portfolio/${sample}`);
after.forEach((r, i) => { if (r.text !== before[i].text) fail(`${VARIANTS[i]}: el portfolio de ${sample} cambió después de las escrituras`); });
console.log(`  ${writes.length} escrituras × 3 variantes`);

console.log(failures.length ? `\n${failures.length} diferencia(s)` : '\nOK: v2 = oráculo, v3 = v2, v1 = v2 salvo el costo, que es el de su definición; escrituras 403 en las tres');
process.exit(failures.length ? 1 : 0);
