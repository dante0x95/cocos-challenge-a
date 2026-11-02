// Fase 8 / B.3 — Generador determinista del dataset de benchmark.
//
//   pnpm exec tsx bench/gen/generate.ts --users 70000 --instruments 1000 --seed 42 --out bench/gen/out
//
// Produce CSVs para users, instruments, marketdata y orders, más cohorts.json para k6.
// Cada usuario se simula en memoria con el oráculo R.4 (bench/app/test/oracle/fold.ts): nada se escribe
// que el oráculo no haya aceptado, así la historia es válida bajo R.2 y bajo los límites.
//
// id vs balance_seq: cada orden tiene creación y, si se ejecuta, ejecución. Las filas se
// escriben en orden de creación global (bucket por mes → ordenar → ids secuenciales), y
// balance_seq sigue la ejecución por usuario. Las LIMIT ejecutadas días después son el
// ~10 % de las FILLED con id "fuera de orden".
//
// Ids: instrumentos y usuarios desde 1000 (los del dump de Neon quedan intactos);
// órdenes desde 1000; marketdata desde 1000.
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import * as O from '../app/test/oracle/fold.js';

// ---------- parámetros ----------
const argv = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => a.startsWith('--') ? [a.slice(2), xs[i + 1]] : []).filter((x) => x.length));
const USERS = Number(argv.users ?? 70_000);
const INSTRUMENTS = Number(argv.instruments ?? 1_000);
const SEED = Number(argv.seed ?? 42);
const OUT = String(argv.out ?? 'bench/gen/out');
const END_DAY = String(argv.end ?? '2026-10-23');   // último día hábil con cotización (sin futuros)
const YEARS = Number(argv.years ?? 5);
const ID0 = 1000;
const ARS_ID = Number(argv.ars ?? 66);

// ---------- PRNG determinista ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
/** log-normal aproximada alrededor de `median` */
const lognormal = (median: number, sigma: number) => {
  const u = rnd() || 1e-9, v = rnd();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(1, Math.round(median * Math.exp(sigma * z)));
};

// ---------- calendario hábil ----------
const DAY_MS = 86_400_000;
const endMs = Date.parse(`${END_DAY}T00:00:00Z`);
const days: string[] = [];
const dayMs: number[] = [];
for (let t = endMs - Math.round(YEARS * 365.25) * DAY_MS; t <= endMs; t += DAY_MS) {
  const dow = new Date(t).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  days.push(new Date(t).toISOString().slice(0, 10));
  dayMs.push(t);
}
const NDAYS = days.length;

// ---------- salida ----------
mkdirSync(OUT, { recursive: true });
const bucketDir = join(OUT, 'buckets');
rmSync(bucketDir, { recursive: true, force: true });
mkdirSync(bucketDir);

class Out {
  private fd: number; private buf: string[] = []; private size = 0;
  constructor(path: string, header?: string) { this.fd = openSync(path, 'w'); if (header) this.write(header + '\n'); }
  write(s: string) { this.buf.push(s); this.size += s.length; if (this.size > 1 << 20) this.flush(); }
  flush() { if (this.buf.length) { writeSync(this.fd, this.buf.join('')); this.buf = []; this.size = 0; } }
  close() { this.flush(); closeSync(this.fd); }
}
const fmt2 = (c: bigint | number) => { const n = BigInt(c); return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`; };
const tsOf = (dayIdx: number, sec: number) => new Date(dayMs[dayIdx] + sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

// ---------- instrumentos y cotizaciones ----------
console.time('marketdata');
const instIds: number[] = [];
{
  const out = new Out(join(OUT, 'instruments.csv'), 'id,ticker,name,type');
  const used = new Set<string>();
  for (let i = 0; i < INSTRUMENTS; i++) {
    let t: string;
    do { t = Array.from({ length: int(3, 5) }, () => String.fromCharCode(65 + int(0, 25))).join(''); } while (used.has(t));
    used.add(t);
    const id = ID0 + i;
    instIds.push(id);
    out.write(`${id},${t},${t} S.A.,ACCIONES\n`);
  }
  out.close();
}
// closes[i * NDAYS + d] en centavos
const closes = new Int32Array(INSTRUMENTS * NDAYS);
{
  const out = new Out(join(OUT, 'marketdata.csv'), 'id,instrumentid,high,low,open,close,previousclose,date');
  let id = ID0;
  for (let i = 0; i < INSTRUMENTS; i++) {
    let c = int(10_000, 500_000);                  // 100–5.000 ARS
    let prev = c;
    for (let d = 0; d < NDAYS; d++) {
      const drift = 1 + (rnd() - 0.5) * 0.06;       // ±3 % diario
      c = Math.max(100, Math.round(c * drift));
      const hi = Math.round(c * (1 + rnd() * 0.02)), lo = Math.round(c * (1 - rnd() * 0.02));
      const open = int(lo, hi);
      closes[i * NDAYS + d] = c;
      out.write(`${id++},${instIds[i]},${fmt2(hi)},${fmt2(lo)},${fmt2(open)},${fmt2(c)},${fmt2(prev)},${days[d]}\n`);
      prev = c;
    }
  }
  out.close();
}
console.timeEnd('marketdata');

// ---------- usuarios y cohortes ----------
type Cohort = 'median' | 'p90' | 'p99' | 'p999' | 'whale';
interface UserSpec { id: number; cohort: Cohort; target: number; openNew: number }
const users: UserSpec[] = [];
for (let u = 0; u < USERS; u++) {
  const id = ID0 + u;
  let cohort: Cohort, target: number;
  if (u < 10) { cohort = 'whale'; target = int(100_000, 250_000); }
  else {
    const r = rnd();
    if (r < 0.80) { cohort = 'median'; target = lognormal(50, 0.6); }
    else if (r < 0.95) { cohort = 'p90'; target = lognormal(500, 0.4); }
    else if (r < 0.99) { cohort = 'p99'; target = lognormal(2000, 0.3); }
    else { cohort = 'p999'; target = lognormal(5000, 0.25); }
  }
  // 20 % con 1–50 NEW vigentes; 5 ballenas con 2.000
  const openNew = u < 5 ? 2000 : (rnd() < 0.2 ? int(1, 50) : 0);
  users.push({ id, cohort, target, openNew });
}
{
  const out = new Out(join(OUT, 'users.csv'), 'id,email,accountnumber');
  for (const u of users) out.write(`${u.id},user${u.id}@bench.local,${String(u.id).padStart(10, '0')}\n`);
  out.close();
}

// ---------- simulación por usuario ----------
interface Row { day: number; sec: number; ii: number; instrumentid: number; size: bigint; priceCents: bigint; type: 'MARKET' | 'LIMIT'; side: string; status: string; seq: bigint | null }
const buckets = new Map<string, Out>();
function writeRow(userid: number, r: Row) {
  const key = days[r.day].slice(0, 7);
  let o = buckets.get(key);
  if (!o) { o = new Out(join(bucketDir, `${key}.txt`)); buckets.set(key, o); }
  // ts|userid|instrumentid|size|price|type|side|status|seq
  o.write(`${tsOf(r.day, r.sec)}|${userid}|${r.instrumentid}|${r.size}|${fmt2(r.priceCents)}|${r.type}|${r.side}|${r.status}|${r.seq ?? ''}\n`);
}

const stats = { filled: 0, rejected: 0, cancelled: 0, new: 0, lateLimit: 0 };
const cohorts: Record<string, number[]> = { median: [], p90: [], p99: [], p999: [], whale: [], withNew: [] };

console.time('orders');
for (const u of users) {
  const s = O.newState();
  const rows: Row[] = [];
  const emit = (_uid: number, r: Row) => { rows.push(r); };
  let seq = 0n;
  let tmpId = 0n;
  const pendingRows = new Map<bigint, Row>();          // tmpId → fila NEW
  const execQueue: { day: number; tmpId: bigint; cancel: boolean }[] = [];
  const myInst = Array.from({ length: Math.min(INSTRUMENTS, u.cohort === 'whale' ? 200 : int(3, 25)) }, () => int(0, INSTRUMENTS - 1));
  const startDay = u.cohort === 'whale' ? 0 : int(0, Math.floor(NDAYS * 0.8));
  // días de evento: target * ~1.35 intentos (REJECTED, CANCELLED, cash), repartidos desde startDay
  const nEvents = Math.ceil(u.target * 1.35) + 2;
  const eventDays = Array.from({ length: nEvents }, () => int(startDay, NDAYS - 1)).sort((a, b) => a - b);
  eventDays[0] = startDay;
  let filled = 0;
  let prevDay = -1, prevSec = 0;
  let cashSeedCents = u.cohort === 'whale' ? 50_000_000_00n : BigInt(int(200_000, 5_000_000)) * 100n;

  const closeAt = (ii: number, d: number) => BigInt(closes[ii * NDAYS + d]);
  const fill = (r: Row) => { r.status = 'FILLED'; r.seq = ++seq; filled++; stats.filled++; };

  const runExec = (q: { day: number; tmpId: bigint; cancel: boolean }) => {
    const r = pendingRows.get(q.tmpId)!;
    pendingRows.delete(q.tmpId);
    if (q.cancel) { O.cancelOrder(s, q.tmpId); r.status = 'CANCELLED'; stats.cancelled++; return; }
    const ok = O.executeLimit(s, q.tmpId, closeAt(r.ii, q.day));
    if (ok) { fill(r); stats.lateLimit++; } else { O.cancelOrder(s, q.tmpId); r.status = 'CANCELLED'; stats.cancelled++; }
  };

  let ei = 0;
  while (ei < eventDays.length || execQueue.length) {
    const nextEv = ei < eventDays.length ? eventDays[ei] : Infinity;
    const nextEx = execQueue.length ? execQueue[0].day : Infinity;
    if (nextEx < nextEv) { runExec(execQueue.shift()!); continue; }       // ejecuciones al cierre (17:00) de días anteriores
    const day = eventDays[ei++];
    if (filled >= u.target) { continue; }
    // dentro del día los segundos crecen: las MARKET se ejecutan al crearse, así que su
    // balance_seq sigue el datetime; solo las LIMIT ejecutadas tarde rompen el orden.
    const sec = day === prevDay ? Math.min(prevSec + int(1, 600), 16 * 3600 + 3599) : int(10 * 3600, 12 * 3600);
    prevDay = day; prevSec = sec;
    const kind = rnd();
    const ii = pick(myInst);
    const instrumentid = instIds[ii];
    const close = closeAt(ii, day);

    if (ei === 1 || kind < 0.06) {                                           // CASH_IN
      const amt = ei === 1 ? cashSeedCents : BigInt(int(10_000, 500_000)) * 100n;
      if (amt > 2_147_483_647n) { for (let k = 0n; k < amt; k += 2_000_000_000n) { const part = amt - k < 2_000_000_000n ? amt - k : 2_000_000_000n; O.placeOrder(s, { side: 'CASH_IN', type: 'MARKET', instrumentid: ARS_ID, size: part, priceCents: 1n }, 0n); const r: Row = { day, sec, ii: -1, instrumentid: ARS_ID, size: part, priceCents: 1n, type: 'MARKET', side: 'CASH_IN', status: '', seq: null }; fill(r); emit(u.id, r); } continue; }
      O.placeOrder(s, { side: 'CASH_IN', type: 'MARKET', instrumentid: ARS_ID, size: amt, priceCents: 1n }, 0n);
      const r: Row = { day, sec, ii: -1, instrumentid: ARS_ID, size: amt, priceCents: 1n, type: 'MARKET', side: 'CASH_IN', status: '', seq: null };
      fill(r); emit(u.id, r);
    } else if (kind < 0.10) {                                               // CASH_OUT (a veces por encima → REJECTED)
      const avail = O.available(s);
      let amt = rnd() < 0.3 ? avail + 100n : (avail * BigInt(int(1, 30))) / 100n;
      if (amt > 2_147_483_647n) amt = 2_147_483_647n;        // límite por movimiento cash (A §2.1)
      if (amt <= 0n) continue;
      const st = O.placeOrder(s, { side: 'CASH_OUT', type: 'MARKET', instrumentid: ARS_ID, size: amt, priceCents: 1n }, 0n);
      const r: Row = { day, sec, ii: -1, instrumentid: ARS_ID, size: amt, priceCents: 1n, type: 'MARKET', side: 'CASH_OUT', status: st, seq: null };
      if (st === 'FILLED') fill(r); else stats.rejected++;
      emit(u.id, r);
    } else if (kind < 0.50) {                                               // BUY MARKET (5 % a propósito por encima → REJECTED)
      const avail = O.available(s);
      let size = rnd() < 0.05 ? avail / close + 1n : (avail * BigInt(int(1, 20))) / 100n / close;
      if (size <= 0n) size = 1n;
      const st = O.placeOrder(s, { side: 'BUY', type: 'MARKET', instrumentid, size, priceCents: close }, 0n);
      const r: Row = { day, sec, ii, instrumentid, size, priceCents: close, type: 'MARKET', side: 'BUY', status: st, seq: null };
      if (st === 'FILLED') fill(r); else stats.rejected++;
      emit(u.id, r);
    } else if (kind < 0.86) {                                               // SELL MARKET
      const p = O.position(s, instrumentid);
      const avail = p.qty - O.reservedShares(s, instrumentid);
      if (avail <= 0n) continue;
      const size = rnd() < 0.04 ? avail + 1n : (avail * BigInt(int(10, 100))) / 100n || 1n;
      const st = O.placeOrder(s, { side: 'SELL', type: 'MARKET', instrumentid, size, priceCents: close }, 0n);
      const r: Row = { day, sec, ii, instrumentid, size, priceCents: close, type: 'MARKET', side: 'SELL', status: st, seq: null };
      if (st === 'FILLED') fill(r); else stats.rejected++;
      emit(u.id, r);
    } else {                                                                // LIMIT (BUY o SELL), ejecuta en 1–30 días si cruza, si no se cancela
      const side = rnd() < 0.6 ? 'BUY' : 'SELL';
      let size: bigint;
      let limit: bigint;
      if (side === 'BUY') {
        size = (O.available(s) * BigInt(int(1, 10))) / 100n / close; if (size <= 0n) continue;
        limit = (close * BigInt(int(95, 103))) / 100n;                     // cerca del close: a veces cruza
      } else {
        const avail = O.position(s, instrumentid).qty - O.reservedShares(s, instrumentid); if (avail <= 0n) continue;
        size = (avail * BigInt(int(10, 60))) / 100n || 1n;
        limit = (close * BigInt(int(97, 105))) / 100n;
      }
      const id = ++tmpId;
      const st = O.placeOrder(s, { side, type: 'LIMIT', instrumentid, size, priceCents: limit }, id);
      const r: Row = { day, sec, ii, instrumentid, size, priceCents: limit, type: 'LIMIT', side, status: st, seq: null };
      if (st !== 'NEW') { stats.rejected++; emit(u.id, r); continue; }
      // ¿cuándo cruza? primer día d' > day con close ≤ límite (BUY) / ≥ límite (SELL), ventana 30 días
      let execDay = -1;
      for (let d = day + 1; d < Math.min(NDAYS, day + 31); d++) {
        const c = closeAt(ii, d);
        if ((side === 'BUY' && c <= limit) || (side === 'SELL' && c >= limit)) { execDay = d; break; }
      }
      pendingRows.set(id, r);
      if (execDay >= 0) execQueue.push({ day: execDay, tmpId: id, cancel: false });
      else execQueue.push({ day: Math.min(NDAYS - 1, day + int(5, 40)), tmpId: id, cancel: true });
      execQueue.sort((a, b) => a.day - b.day);
      emit(u.id, r);   // se emite ya: el status final se fija por referencia antes de cerrar el usuario
    }
  }
  // NEW vigentes al final: LIMITs lejos del close, con cash reservado garantizado
  if (u.openNew > 0) {
    const day = NDAYS - 1, sec = int(10 * 3600, 16 * 3600);
    const need = BigInt(u.openNew) * 100_00n * 10n;   // 10 acciones × ~100 ARS cada una, con margen
    O.placeOrder(s, { side: 'CASH_IN', type: 'MARKET', instrumentid: ARS_ID, size: need, priceCents: 1n }, 0n);
    const r: Row = { day, sec: sec - 1, ii: -1, instrumentid: ARS_ID, size: need, priceCents: 1n, type: 'MARKET', side: 'CASH_IN', status: '', seq: null };
    fill(r); emit(u.id, r);
    for (let k = 0; k < u.openNew; k++) {
      const ii = pick(myInst), instrumentid = instIds[ii], close = closeAt(ii, day);
      const limit = close / 2n || 1n;   // BUY muy por debajo: nunca cruza en estos datos
      const size = 1n;
      const id = ++tmpId;
      const st = O.placeOrder(s, { side: 'BUY', type: 'LIMIT', instrumentid, size, priceCents: limit }, id);
      if (st !== 'NEW') break;
      emit(u.id, { day, sec, ii, instrumentid, size, priceCents: limit, type: 'LIMIT', side: 'BUY', status: 'NEW', seq: null });
      stats.new++;
    }
    cohorts.withNew.push(u.id);
  }
  // las LIMIT pendientes que no llegaron a ejecutarse ni cancelarse quedan NEW (su reserva ya está en el oráculo)
  for (const r of pendingRows.values()) { r.status = 'NEW'; stats.new++; }
  cohorts[u.cohort].push(u.id);
  // Recién ahora todas las filas tienen status y seq finales.
  for (const r of rows) writeRow(u.id, r);
  if ((u.id - ID0) % 10_000 === 0) console.log(`  usuario ${u.id - ID0}/${USERS}, FILLED acumuladas ${stats.filled}`);
}
for (const o of buckets.values()) o.close();
console.timeEnd('orders');

// ---------- pase 2: buckets por mes → orders.csv con ids en orden de creación ----------
console.time('ids');
{
  const out = new Out(join(OUT, 'orders.csv'), 'id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq');
  let id = ID0;
  let total = 0;
  for (const f of readdirSync(bucketDir).sort()) {
    const lines = readFileSync(join(bucketDir, f), 'utf8').split('\n');
    lines.pop();
    const keyed = lines.map((l, i) => [l.slice(0, 19), i, l] as const);
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    for (const [, , l] of keyed) {
      const [ts, userid, instrumentid, size, price, type, side, status, seq] = l.split('|');
      out.write(`${id++},${instrumentid},${userid},${size},${price},${type},${side},${status},${ts},${seq}\n`);
      total++;
    }
  }
  out.close();
  rmSync(bucketDir, { recursive: true, force: true });
  console.log(`orders.csv: ${total} filas (ids ${ID0}..${id - 1})`);
}
console.timeEnd('ids');

// ---------- cohorts.json y resumen ----------
const summary = {
  seed: SEED, users: USERS, instruments: INSTRUMENTS, days: NDAYS, firstDay: days[0], lastDay: days[NDAYS - 1],
  orders: stats, lateLimitPctOfFilled: Number((100 * stats.lateLimit / stats.filled).toFixed(2)),
  whales: cohorts.whale, counts: Object.fromEntries(Object.entries(cohorts).map(([k, v]) => [k, v.length])),
};
import('node:fs').then(({ writeFileSync }) => {
  writeFileSync(join(OUT, 'cohorts.json'), JSON.stringify({ ...cohorts, summary }, null, 1));
  console.log(JSON.stringify(summary, null, 2));
});
