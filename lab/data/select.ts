// Del dataset que genera el benchmark al del lab (issue #72). El generador siempre crea 10 ballenas
// (los primeros 10 usuarios); el lab se queda con las 3 cuya cantidad de órdenes ejecutadas está
// más cerca de 150.000 (empate: el id menor) y saca a las otras 7 con todas sus órdenes. Las
// historias son por usuario, así que sacar un usuario entero no cambia las de los demás.
//
//   tsx lab/data/select.ts <dir del generador> <dir de salida>
//
// Escribe users.csv, instruments.csv, marketdata.csv y orders.csv, y manifest.json con el sha256
// de cada archivo, el del dataset (de los cuatro juntos), las ballenas y una muestra de usuarios
// por cohorte para comparar las variantes (lab/check.ts).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [raw, out] = process.argv.slice(2);
if (!raw || !out) throw new Error('uso: select.ts <dir del generador> <dir de salida>');

const WHALES = 3;
const WHALE_FILLED = 150_000;
const SAMPLE_PER_COHORT = 3;

const cohorts = JSON.parse(readFileSync(join(raw, 'cohorts.json'), 'utf8')) as Record<string, number[]> & {
  summary: Record<string, unknown>;
};

const lines = (file: string) => createInterface({ input: createReadStream(file), crlfDelay: Infinity });

// orders.csv: id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq
const filled = new Map<number, number>();
for await (const l of lines(join(raw, 'orders.csv'))) {
  const f = l.split(',');
  if (f[7] === 'FILLED') filled.set(Number(f[2]), (filled.get(Number(f[2])) ?? 0) + 1);
}
const keep = [...cohorts.whale]
  .sort((a, b) => Math.abs((filled.get(a) ?? 0) - WHALE_FILLED) - Math.abs((filled.get(b) ?? 0) - WHALE_FILLED) || a - b)
  .slice(0, WHALES).sort((a, b) => a - b);
const dropped = new Set(cohorts.whale.filter((u) => !keep.includes(u)));

async function filter(file: string, useridField: number): Promise<number> {
  const w = createWriteStream(join(out, file));
  let n = 0;
  let header = true;
  for await (const l of lines(join(raw, file))) {
    if (!header && dropped.has(Number(l.split(',', useridField + 1)[useridField]))) continue;
    if (!w.write(`${l}\n`)) await new Promise<void>((r) => w.once('drain', () => r()));
    if (!header) n++;
    header = false;
  }
  await new Promise<void>((r, j) => w.end((e?: Error | null) => (e ? j(e) : r())));
  return n;
}
const users = await filter('users.csv', 0);
const orders = await filter('orders.csv', 2);
copyFileSync(join(raw, 'instruments.csv'), join(out, 'instruments.csv'));
copyFileSync(join(raw, 'marketdata.csv'), join(out, 'marketdata.csv'));

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(join(out, file))) h.update(chunk as Buffer);
  return h.digest('hex');
}
const FILES = ['users.csv', 'instruments.csv', 'marketdata.csv', 'orders.csv'];
const files: Record<string, string> = {};
for (const f of FILES) files[f] = await sha256(f);
const dataset = createHash('sha256').update(FILES.map((f) => `${files[f]}  ${f}\n`).join('')).digest('hex');

const sample = Object.fromEntries(['median', 'p90', 'p99', 'p999'].map((c) => [c, cohorts[c].slice(0, SAMPLE_PER_COHORT)]));
const manifest = {
  dataset_sha256: dataset,
  files,
  generator_summary: cohorts.summary,
  users,
  orders,
  filled: [...filled].filter(([u]) => !dropped.has(u)).reduce((t, [, n]) => t + n, 0),
  whales: keep.map((id) => ({ id, filled: filled.get(id) ?? 0 })),
  dropped_whales: [...dropped],
  sample_users: sample,
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ dataset_sha256: dataset, users, orders, filled: manifest.filled, whales: manifest.whales }, null, 2));
