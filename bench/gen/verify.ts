// Checkpoint 8 — muestra de usuarios: oráculo R.4 (replay por balance_seq) == app.read_portfolio.
//   DATABASE_ADMIN_URL=... pnpm exec tsx bench/gen/verify.ts --sample 100
import pg from 'pg';
import { readFileSync } from 'node:fs';
import * as O from '../app/test/oracle/fold.js';

const argv = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => a.startsWith('--') ? [a.slice(2), xs[i + 1]] : []).filter((x) => x.length));
const SAMPLE = Number(argv.sample ?? 100);
const OUT = String(argv.out ?? 'bench/gen/out');
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5434/trading' });
pg.types.setTypeParser(1082, (v: string) => v);

const cents = (s: string) => BigInt(s.replace('.', ''));

async function check(userid: number): Promise<string[]> {
  const errs: string[] = [];
  const s = O.newState();
  const { rows } = await admin.query<{ id: string; instrumentid: number; size: string; price: string; type: string; side: string; status: string; balance_seq: string | null }>(
    // OJO: el alias balance_seq::text sombrearía a la columna en ORDER BY y ordenaría como texto
    // ("1","10","11",…,"2"); por eso el ORDER BY califica con el alias de tabla.
    `SELECT o.id, o.instrumentid, o.size::text, o.price::text, o.type, o.side, o.status, o.balance_seq::text
       FROM app.orders o WHERE o.userid = $1 AND o.status IN ('FILLED','NEW') ORDER BY o.balance_seq NULLS LAST, o.id`, [userid]);
  if (rows.length === 0) return [`usuario ${userid} sin órdenes en la DB (¿se cargó el dataset?)`];
  // Replay de la historia efectiva: FILLED en orden de balance_seq (una LIMIT FILLED se crea y se
  // ejecuta a su precio límite en ese punto), y después las NEW vigentes. Verifica que la historia
  // es válida bajo R.2 (sin cortos, fondos suficientes en orden de ejecución) y que el estado final
  // coincide. Las decisiones REJECTED se validaron contra place_order en P.2.
  for (const r of rows) {
    const o = { side: r.side as any, type: r.type as any, instrumentid: r.instrumentid, size: BigInt(r.size), priceCents: cents(r.price) };
    const id = BigInt(r.id);
    const st = O.placeOrder(s, o, id);
    if (r.status === 'FILLED') {
      if (r.type === 'LIMIT') {
        if (st !== 'NEW' || !O.executeLimit(s, id, o.priceCents)) errs.push(`orden ${r.id}: LIMIT FILLED que el oráculo no acepta (${st})`);
      } else if (st !== 'FILLED') errs.push(`orden ${r.id}: FILLED en DB, oráculo ${st}`);
    } else if (st !== 'NEW') errs.push(`orden ${r.id}: NEW en DB, oráculo ${st}`);
  }
  const p = await admin.query<{ kind: number; instrumentid: number | null; qty: string; cost_total: string; reserved: string; inconsistent: boolean }>(
    'SELECT * FROM app.read_portfolio($1)', [userid]);
  const cash = p.rows.find((x) => x.kind === 0)!;
  if (BigInt(cash.qty) !== s.cashCents) errs.push(`cash: DB ${cash.qty}, oráculo ${s.cashCents}`);
  if (BigInt(cash.reserved) !== O.reservedCash(s)) errs.push(`reservado: DB ${cash.reserved}, oráculo ${O.reservedCash(s)}`);
  for (const x of p.rows.filter((x) => x.kind === 1)) {
    const op = O.position(s, x.instrumentid!);
    if (BigInt(x.qty) !== op.qty || BigInt(x.cost_total) !== op.cost || x.inconsistent !== op.short) {
      errs.push(`pos ${x.instrumentid}: DB ${x.qty}/${x.cost_total}/${x.inconsistent}, oráculo ${op.qty}/${op.cost}/${op.short}`);
    }
    if (BigInt(x.reserved) !== O.reservedShares(s, x.instrumentid!)) errs.push(`reservadas ${x.instrumentid}`);
  }
  // Y al revés: cada posición del oráculo (qty <> 0 o con historia en corto, lo que emite fold_user)
  // tiene su fila. Sin esto, un read_portfolio que perdiera posiciones pasaría con el cash correcto.
  const returned = new Set(p.rows.filter((x) => x.kind === 1).map((x) => x.instrumentid));
  for (const [instrumentid, op] of s.positions) {
    if ((op.qty !== 0n || op.short) && !returned.has(instrumentid)) errs.push(`pos ${instrumentid}: falta en la DB, oráculo ${op.qty}/${op.cost}/${op.short}`);
  }
  return errs;
}

const cohorts = JSON.parse(readFileSync(`${OUT}/cohorts.json`, 'utf8'));
const sample: number[] = [...cohorts.whale];
for (const k of ['median', 'p90', 'p99', 'p999', 'withNew']) {
  const xs: number[] = cohorts[k];
  for (let i = 0; i < Math.min(xs.length, Math.ceil(SAMPLE / 5)); i++) sample.push(xs[Math.floor((i * 7919) % xs.length)]);
}
if (sample.length === 0) { console.error(`${OUT}/cohorts.json no tiene usuarios para verificar`); process.exit(1); }
let bad = 0;
console.time('verify');
for (const u of new Set(sample)) {
  const t0 = Date.now();
  const errs = await check(u);
  const ms = Date.now() - t0;
  if (errs.length) { bad++; console.log(`✗ user ${u}: ${errs.slice(0, 3).join('; ')}`); }
  else if (cohorts.whale.includes(u)) console.log(`✓ ballena ${u} (${ms} ms)`);
}
console.timeEnd('verify');
console.log(`${new Set(sample).size} usuarios verificados, ${bad} con diferencias`);
await admin.end();
process.exit(bad ? 1 : 0);
