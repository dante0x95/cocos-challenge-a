// Lee bench/results/*.json de k6 y arma bench/results/summary-<variant>.md (o summary-compare.md con --compare).
//   pnpm exec tsx bench/summarize.ts --variant A
//   pnpm exec tsx bench/summarize.ts --compare A,Z,C-frio,C-caliente
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const argv = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => a.startsWith('--') ? [a.slice(2), xs[i + 1] ?? 'true'] : []).filter((x) => x.length));
const DIR = String(argv.dir ?? 'bench/results');
const variants = argv.compare ? String(argv.compare).split(',') : [String(argv.variant ?? 'A')];

interface Row { profile: string; scenario: string; rps: number; variant: string; get: any; post: any; failed: number; dropped: number; iters: number; codes: Record<string, number>; statuses: Record<string, number>; restore?: string }

function load(): Row[] {
  const rows: Row[] = [];
  for (const f of readdirSync(DIR)) {
    // <perfil>-<escenario>-<rps>-<variante>.json; la variante admite guiones (C-frio, C-caliente).
    const m = f.match(/^(\w+)-([\w-]+?)-(\d+)-([A-Za-z][\w-]*)\.json$/);
    if (!m) continue;
    const [, profile, scenario, rps, variant] = m;
    if (!variants.includes(variant)) continue;
    const d = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
    const mt = d.metrics ?? {};
    const sub = (name: string) => Object.fromEntries(Object.entries(mt).filter(([k]) => k.startsWith(name + '{')).map(([k, v]: any) => [k.slice(name.length + 1, -1).split(':')[1], v.values?.count ?? 0]));
    let restore: string | undefined;
    try {
      // El archivo puede traer salida extra de warm.sh; solo las dos cifras.
      const txt = readFileSync(`${DIR}/${profile}-${scenario}-${rps}-${variant}-restore.txt`, 'utf8');
      restore = (txt.match(/(restore\+vacuum|calentamiento): \d+ s/g) ?? []).join(', ');
    } catch { /* opcional */ }
    rows.push({
      profile, scenario, rps: Number(rps), variant,
      get: mt['http_req_duration{op:get}']?.values ?? {}, post: mt['http_req_duration{op:post}']?.values ?? {},
      failed: (mt.http_req_failed?.values?.rate ?? 0) * 100, dropped: mt.dropped_iterations?.values?.count ?? 0,
      iters: mt.iterations?.values?.count ?? 0, codes: sub('http_status_code'), statuses: sub('order_status'), restore,
    });
  }
  return rows.sort((a, b) => a.profile.localeCompare(b.profile) || a.scenario.localeCompare(b.scenario) || a.rps - b.rps || a.variant.localeCompare(b.variant));
}

const ms = (v: any, k: string) => (v && v[k] != null ? Math.round(v[k]).toString() : '-');
const rows = load();
const lines: string[] = [];
lines.push(`# Resumen del benchmark — ${variants.join(' vs ')}`, '');
lines.push(`Generado ${new Date().toISOString().slice(0, 16)} desde ${rows.length} corrida(s) en \`${DIR}\`. Latencias en ms. SLA de referencia: p99 < 500 ms, fallos < 0,1 %, 0 descartadas.`, '');
lines.push('| perfil | escenario | RPS | var | GET p50 | GET p95 | GET p99 | POST p50 | POST p99 | fallos % | descartadas | iteraciones | códigos | órdenes | restore |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const ok = r.failed < 0.1 && r.dropped === 0 && (r.get['p(99)'] ?? 0) < 500 && (r.post['p(99)'] ?? 0) < 500;
  lines.push(`| ${r.profile} | ${r.scenario} | ${r.rps} | ${r.variant} | ${ms(r.get, 'med')} | ${ms(r.get, 'p(95)')} | ${ok ? '**' : ''}${ms(r.get, 'p(99)')}${ok ? '**' : ''} | ${ms(r.post, 'med')} | ${ms(r.post, 'p(99)')} | ${r.failed.toFixed(3)} | ${r.dropped} | ${r.iters} | ${Object.entries(r.codes).map(([k, v]) => `${k}:${v}`).join(' ')} | ${Object.entries(r.statuses).map(([k, v]) => `${k}:${v}`).join(' ')} | ${r.restore ?? ''} |`);
}
lines.push('', 'Negrita en GET p99 = la corrida cumple el SLA completo (p99, fallos y descartadas).');
const out = `${DIR}/summary-${argv.compare ? 'compare' : variants[0]}.md`;
writeFileSync(out, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\n→ ${out}`);
