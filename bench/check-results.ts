// Cada número de las tablas de resultados sale de una salida cruda versionada en bench/results
// (issue #70). Compara, celda por celda:
//   - docs/decision-snapshot.md §4 (p99 GET / POST, colapsos, descartadas) contra los JSON de k6;
//   - docs/benchmark/resultados.md: la tabla por corrida (cada fila enlaza su JSON) y la de
//     calentamiento de C (cada fila enlaza su -restore.txt), y que estén todas las corridas.
// No corre en el CI de cada PR (el benchmark no es parte de él): se corre a mano después de tocar
// esos docs o bench/results.
//   pnpm exec tsx bench/check-results.ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RESULTS = join(ROOT, 'bench/results');
const SNAPSHOT_DOC = 'docs/decision-snapshot.md';
const RESULTS_DOC = 'docs/benchmark/resultados.md';

interface Run { file: string; scenario: string; rps: number; variant: string; getP: Record<string, number>; postP: Record<string, number>; failedPct: number; dropped: number; iterations: number }

/** Las corridas medidas: <perfil>-<escenario>-<rps>-<variante>.json (sin los -warmup). */
function runs(): Run[] {
  const out: Run[] = [];
  for (const file of readdirSync(RESULTS).sort()) {
    const m = /^medium-([a-z-]+?)-(\d+)-([A-Z][\w-]*)\.json$/.exec(file);
    if (!m || m[3].endsWith('-warmup')) continue;
    const metrics = JSON.parse(readFileSync(join(RESULTS, file), 'utf8')).metrics;
    out.push({
      file, scenario: m[1], rps: Number(m[2]), variant: m[3],
      getP: metrics['http_req_duration{op:get}']?.values ?? {},
      postP: metrics['http_req_duration{op:post}']?.values ?? {},
      failedPct: (metrics.http_req_failed?.values?.rate ?? 0) * 100,
      dropped: metrics.dropped_iterations?.values?.count ?? 0,
      iterations: metrics.iterations?.values?.count ?? 0,
    });
  }
  return out;
}

/** Las filas de la tabla Markdown cuyo encabezado empieza con `head`, como celdas. */
function table(text: string, head: string): string[][] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows;
}

const plain = (cell: string) => cell.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
const links = (cell: string) => [...cell.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]);
const ms = (v: number | undefined) => (v == null ? '-' : String(Math.round(v)));
/** El número como lo escriben los docs: coma decimal y la cantidad de decimales que muestra. */
const sameNumber = (written: string, value: number) => {
  const decimals = written.split(',')[1]?.length ?? 0;
  return value.toFixed(decimals).replace('.', ',') === written;
};

const problems: string[] = [];
const all = runs();
const find = (scenario: string, rps: number, variant: string) => all.find((r) => r.scenario === scenario && r.rps === rps && r.variant === variant);

// "colapso" = más del 95 % de las requests falló, venciendo a los 60 s (GET p50 en el timeout).
const collapsed = (r: Run) => r.failedPct > 95 && (r.getP.med ?? 0) >= 59_000;

// ---------- docs/decision-snapshot.md §4 ----------
{
  const text = readFileSync(join(ROOT, SNAPSHOT_DOC), 'utf8');
  const rows = table(text, '| Escenario / RPS |');
  if (rows.length === 0) problems.push(`${SNAPSHOT_DOC}: no encuentro la tabla "Escenario / RPS"`);
  const variants = ['Z', 'A', 'C-frio', 'C-caliente'];
  for (const [label, ...cells] of rows) {
    const m = /^(\S+) (\d+)(?:–(\d+))?$/.exec(plain(label));
    if (!m) { problems.push(`${SNAPSHOT_DOC}: fila "${label}" no es "<escenario> <rps>" ni "<escenario> <a>–<b>"`); continue; }
    const [, scenario, lo, hi] = m;
    cells.forEach((raw, i) => {
      const where = `${SNAPSHOT_DOC} ${plain(label)} / ${variants[i]}`;
      const cell = plain(raw);
      const inRange = all.filter((r) => r.scenario === scenario && r.variant === variants[i] && r.rps >= Number(lo) && r.rps <= Number(hi ?? lo));
      if (cell === '—') {
        if (inRange.length) problems.push(`${where}: dice "—" pero existe ${inRange.map((r) => r.file).join(', ')}`);
        return;
      }
      if (inRange.length === 0) { problems.push(`${where}: "${cell}" sin salida cruda`); return; }
      const collapse = /^colapso(?: \(([\d,]+) %\))?$/.exec(cell);
      if (collapse) {
        for (const r of inRange) {
          if (!collapsed(r)) problems.push(`${where}: dice colapso, ${r.file} tiene ${r.failedPct.toFixed(3)} % de fallos`);
          if (collapse[1] && !sameNumber(collapse[1], r.failedPct)) problems.push(`${where}: dice ${collapse[1]} %, ${r.file} da ${r.failedPct.toFixed(3)} %`);
        }
        return;
      }
      const value = /^(\d+) \/ (\d+)(?: \((\d+) descartadas\))?$/.exec(cell);
      if (!value || inRange.length !== 1) { problems.push(`${where}: no entiendo "${cell}" (${inRange.length} corridas)`); return; }
      const [r] = inRange;
      if (ms(r.getP['p(99)']) !== value[1] || ms(r.postP['p(99)']) !== value[2]) {
        problems.push(`${where}: dice ${value[1]} / ${value[2]}, ${r.file} da ${ms(r.getP['p(99)'])} / ${ms(r.postP['p(99)'])}`);
      }
      // Sin marca: menos de 0,01 % de fallos y ninguna descartada (lo que dice el doc debajo de la tabla).
      if (value[3] ? r.dropped !== Number(value[3]) : r.dropped !== 0 || r.failedPct >= 0.01) {
        problems.push(`${where}: ${r.file} tiene ${r.dropped} descartadas y ${r.failedPct.toFixed(3)} % de fallos`);
      }
    });
  }
}

// ---------- docs/benchmark/resultados.md ----------
{
  const text = readFileSync(join(ROOT, RESULTS_DOC), 'utf8');
  const docDir = dirname(join(ROOT, RESULTS_DOC));
  const target = (cell: string, where: string) => {
    const [href] = links(cell);
    if (!href) { problems.push(`${where}: la celda no enlaza su salida cruda`); return null; }
    const path = resolve(docDir, href);
    if (!existsSync(path)) { problems.push(`${where}: ${href} no existe`); return null; }
    return path;
  };

  const rows = table(text, '| Escenario | RPS | Variante |');
  if (rows.length === 0) problems.push(`${RESULTS_DOC}: no encuentro la tabla por corrida`);
  const listed = new Set<string>();
  for (const cells of rows) {
    const [scenario, rps, variant, getMed, getP95, getP99, postMed, postP99, failed, dropped, iterations] = cells.map(plain);
    const where = `${RESULTS_DOC} ${scenario} ${rps} ${variant}`;
    const r = find(scenario, Number(rps), variant);
    if (!r) { problems.push(`${where}: no hay salida cruda`); continue; }
    listed.add(r.file);
    const path = target(cells[11], where);
    if (path && basename(path) !== r.file) problems.push(`${where}: enlaza ${basename(path)}, la corrida es ${r.file}`);
    const expected = [ms(r.getP.med), ms(r.getP['p(95)']), ms(r.getP['p(99)']), ms(r.postP.med), ms(r.postP['p(99)']), r.failedPct.toFixed(3).replace('.', ','), String(r.dropped), String(r.iterations)];
    const written = [getMed, getP95, getP99, postMed, postP99, failed, dropped, iterations];
    if (expected.join(' ') !== written.join(' ')) problems.push(`${where}: dice ${written.join(' ')}, ${r.file} da ${expected.join(' ')}`);
  }
  for (const r of all) if (rows.length && !listed.has(r.file)) problems.push(`${RESULTS_DOC}: falta la corrida ${r.file}`);

  // Calentamiento de C: segundos, snapshots publicados y tamaño, como los imprimió bench/warm.sh, y el
  // tiempo de restore que anotó bench/run.sh.
  for (const cells of table(text, '| Corrida de C caliente |')) {
    const [, seconds, snapshots, size, restore] = cells.map(plain);
    const where = `${RESULTS_DOC} calentamiento ${plain(cells[0])}`;
    const path = target(cells[0], where);
    if (!path) continue;
    const txt = readFileSync(path, 'utf8');
    const warm = /calentamiento: (\d+) s/.exec(txt)?.[1];
    const restored = /restore\+vacuum: (\d+) s/.exec(txt)?.[1];
    const snap = [...txt.matchAll(/^\s+(\d+) \| (.+?)\s*$/gm)].at(-1);
    if (warm !== seconds.replace(/ s$/, '') || snap?.[1] !== snapshots.replace(/\./g, '') || snap?.[2] !== size || restored !== restore.replace(/ s$/, '')) {
      problems.push(`${where}: dice ${seconds} / ${snapshots} / ${size} / ${restore}, ${basename(path)} da ${warm} s / ${snap?.[1]} / ${snap?.[2]} / ${restored} s`);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} diferencia(s) entre los docs y bench/results:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ las tablas coinciden con las ${all.length} corridas de bench/results`);
