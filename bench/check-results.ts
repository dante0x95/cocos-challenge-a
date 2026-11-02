// Cada número de las tablas de resultados sale de una salida cruda versionada en bench/results
// (issue #70). Compara, celda por celda:
//   - docs/decision-snapshot.md §4 (p99 GET / POST, colapsos, descartadas) contra los JSON de k6;
//   - docs/benchmark/resultados.md: la tabla por corrida (cada fila enlaza su JSON) y la de
//     calentamiento de C (cada fila enlaza su -restore.txt), y que estén todas las corridas.
// Exige también la cobertura: cada corrida en la tabla por corrida y en una celda de §4 (salvo las
// de OUT_OF_SNAPSHOT), cuatro variantes por fila y una fila de calentamiento por corrida de C
// caliente. Antes de dar el resultado se controla a sí mismo: aplica en memoria las mutaciones de
// MUTATIONS (un número cambiado, una fila o una tabla borrada…) y falla si alguna pasa.
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

const all = runs();
const find = (scenario: string, rps: number, variant: string) => all.find((r) => r.scenario === scenario && r.rps === rps && r.variant === variant);
/** Corridas que no van en la tabla de §4, con el motivo. */
const OUT_OF_SNAPSHOT: Record<string, string> = {
  'medium-read-heavy-50-A.json': 'humo de A a 50 RPS, fuera de la matriz (docs/benchmark/corridas.md)',
};
const VARIANTS = ['Z', 'A', 'C-frio', 'C-caliente'];

// "colapso" = más del 95 % de las requests falló, venciendo a los 60 s (GET p50 en el timeout).
const collapsed = (r: Run) => r.failedPct > 95 && (r.getP.med ?? 0) >= 59_000;

/** docs/decision-snapshot.md §4: cada celda contra su JSON, y cada corrida en alguna celda. */
function checkSnapshot(text: string): string[] {
  const problems: string[] = [];
  const rows = table(text, '| Escenario / RPS |');
  if (rows.length === 0) problems.push(`${SNAPSHOT_DOC}: no encuentro la tabla "Escenario / RPS"`);
  const covered = new Set<string>();
  const labels = new Set<string>();
  for (const [label, ...cells] of rows) {
    const m = /^(\S+) (\d+)(?:–(\d+))?$/.exec(plain(label));
    if (!m) { problems.push(`${SNAPSHOT_DOC}: fila "${label}" no es "<escenario> <rps>" ni "<escenario> <a>–<b>"`); continue; }
    if (labels.has(plain(label))) problems.push(`${SNAPSHOT_DOC}: la fila "${plain(label)}" está repetida`);
    labels.add(plain(label));
    if (cells.length !== VARIANTS.length) { problems.push(`${SNAPSHOT_DOC} ${plain(label)}: tiene ${cells.length} celdas, una por variante son ${VARIANTS.length}`); continue; }
    const [, scenario, lo, hi] = m;
    cells.forEach((raw, i) => {
      const where = `${SNAPSHOT_DOC} ${plain(label)} / ${VARIANTS[i]}`;
      const cell = plain(raw);
      const inRange = all.filter((r) => r.scenario === scenario && r.variant === VARIANTS[i] && r.rps >= Number(lo) && r.rps <= Number(hi ?? lo));
      if (cell === '—') {
        const unexpected = inRange.filter((r) => !OUT_OF_SNAPSHOT[r.file]);
        if (unexpected.length) problems.push(`${where}: dice "—" pero existe ${unexpected.map((r) => r.file).join(', ')}`);
        return;
      }
      if (inRange.length === 0) { problems.push(`${where}: "${cell}" sin salida cruda`); return; }
      for (const r of inRange) covered.add(r.file);
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
  for (const r of all) {
    if (!OUT_OF_SNAPSHOT[r.file] && !covered.has(r.file)) problems.push(`${SNAPSHOT_DOC}: ninguna celda muestra ${r.file}`);
  }
  return problems;
}

/** docs/benchmark/resultados.md: la tabla por corrida y la de calentamiento, completas. */
function checkResults(text: string): string[] {
  const problems: string[] = [];
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
    if (cells.length !== 12) { problems.push(`${where}: tiene ${cells.length} celdas, son 12`); continue; }
    const r = find(scenario, Number(rps), variant);
    if (!r) { problems.push(`${where}: no hay salida cruda`); continue; }
    if (listed.has(r.file)) problems.push(`${where}: la corrida está repetida`);
    listed.add(r.file);
    const path = target(cells[11], where);
    if (path && basename(path) !== r.file) problems.push(`${where}: enlaza ${basename(path)}, la corrida es ${r.file}`);
    const expected = [ms(r.getP.med), ms(r.getP['p(95)']), ms(r.getP['p(99)']), ms(r.postP.med), ms(r.postP['p(99)']), r.failedPct.toFixed(3).replace('.', ','), String(r.dropped), String(r.iterations)];
    const written = [getMed, getP95, getP99, postMed, postP99, failed, dropped, iterations];
    if (expected.join(' ') !== written.join(' ')) problems.push(`${where}: dice ${written.join(' ')}, ${r.file} da ${expected.join(' ')}`);
  }
  for (const r of all) if (!listed.has(r.file)) problems.push(`${RESULTS_DOC}: falta la corrida ${r.file}`);

  // Calentamiento de C: segundos, snapshots publicados y tamaño, como los imprimió bench/warm.sh, y el
  // tiempo de restore que anotó bench/run.sh. Una fila por corrida de C caliente.
  const warmRows = table(text, '| Corrida de C caliente |');
  if (warmRows.length === 0) problems.push(`${RESULTS_DOC}: no encuentro la tabla de calentamiento`);
  const warmListed = new Set<string>();
  for (const cells of warmRows) {
    const where = `${RESULTS_DOC} calentamiento ${plain(cells[0])}`;
    if (cells.length !== 5) { problems.push(`${where}: tiene ${cells.length} celdas, son 5`); continue; }
    const [, seconds, snapshots, size, restore] = cells.map(plain);
    const path = target(cells[0], where);
    if (!path) continue;
    if (!/-C-caliente-restore\.txt$/.test(path)) { problems.push(`${where}: enlaza ${basename(path)}, no un -C-caliente-restore.txt`); continue; }
    if (warmListed.has(basename(path))) problems.push(`${where}: la corrida está repetida`);
    warmListed.add(basename(path));
    const txt = readFileSync(path, 'utf8');
    const warm = /calentamiento: (\d+) s/.exec(txt)?.[1];
    const restored = /restore\+vacuum: (\d+) s/.exec(txt)?.[1];
    const snap = [...txt.matchAll(/^\s+(\d+) \| (.+?)\s*$/gm)].at(-1);
    if (warm !== seconds.replace(/ s$/, '') || snap?.[1] !== snapshots.replace(/\./g, '') || snap?.[2] !== size || restored !== restore.replace(/ s$/, '')) {
      problems.push(`${where}: dice ${seconds} / ${snapshots} / ${size} / ${restore}, ${basename(path)} da ${warm} s / ${snap?.[1]} / ${snap?.[2]} / ${restored} s`);
    }
  }
  for (const r of all.filter((r) => r.variant === 'C-caliente')) {
    const restoreFile = r.file.replace(/\.json$/, '-restore.txt');
    if (!warmListed.has(restoreFile)) problems.push(`${RESULTS_DOC}: falta el calentamiento de ${restoreFile}`);
  }
  return problems;
}

// ---------- autocontrol: cada mutación tiene que hacer fallar el control ----------
const replaceOnce = (a: string, b: string) => (t: string) => {
  if (!t.includes(a)) throw new Error(`mutación sin efecto: no encuentro "${a}"`);
  return t.replace(a, b);
};
const dropLines = (prefix: string) => (t: string) => {
  const lines = t.split('\n');
  if (!lines.some((l) => l.startsWith(prefix))) throw new Error(`mutación sin efecto: ninguna línea empieza con "${prefix}"`);
  return lines.filter((l) => !l.startsWith(prefix)).join('\n');
};
const MUTATIONS: { doc: 'snapshot' | 'results'; what: string; apply: (t: string) => string }[] = [
  { doc: 'snapshot', what: 'un p99 de POST cambiado', apply: replaceOnce('| read-heavy 100 | — | 19 / 11 |', '| read-heavy 100 | — | 19 / 12 |') },
  { doc: 'snapshot', what: 'el % de un colapso', apply: replaceOnce('colapso (97 %)', 'colapso (96 %)') },
  { doc: 'snapshot', what: 'una celda con número sin corrida', apply: replaceOnce('| whale 100 | — | — |', '| whale 100 | — | 11 / 7 |') },
  { doc: 'snapshot', what: 'un "—" donde hay corrida', apply: replaceOnce('| whale 1 | colapso | — |', '| whale 1 | — | — |') },
  { doc: 'snapshot', what: 'las descartadas omitidas', apply: replaceOnce('87 / 149 (148 descartadas)', '87 / 149') },
  { doc: 'snapshot', what: 'la fila whale 2 borrada', apply: dropLines('| whale 2 |') },
  { doc: 'snapshot', what: 'la celda de C caliente de whale 2 borrada', apply: replaceOnce('| whale 2 | — | 795 / 91 | 62 / 30 | **20 / 15** |', '| whale 2 | — | 795 / 91 | 62 / 30 |') },
  { doc: 'results', what: 'un p50 de la tabla por corrida', apply: replaceOnce('| whale | 2 | A | 557 |', '| whale | 2 | A | 556 |') },
  { doc: 'results', what: 'el link a otro JSON', apply: replaceOnce('[json](../../bench/results/medium-whale-2-A.json)', '[json](../../bench/results/medium-whale-5-A.json)') },
  { doc: 'results', what: 'una fila de la tabla por corrida borrada', apply: dropLines('| whale | 20 | A |') },
  { doc: 'results', what: 'una fila de la tabla por corrida repetida', apply: (t) => t.replace(/^(\| whale \| 2 \| A \|.*)$/m, '$1\n$1') },
  { doc: 'results', what: 'un tiempo de calentamiento', apply: replaceOnce('| 300 s | 70.001 | 81 MB | 81 s |', '| 301 s | 70.001 | 81 MB | 81 s |') },
  { doc: 'results', what: 'una fila de calentamiento borrada', apply: dropLines('| [whale 2](../../bench/results/medium-whale-2-C-caliente-restore.txt)') },
  { doc: 'results', what: 'la tabla de calentamiento borrada', apply: dropLines('| [') },
];

const snapshotText = readFileSync(join(ROOT, SNAPSHOT_DOC), 'utf8');
const resultsText = readFileSync(join(ROOT, RESULTS_DOC), 'utf8');
const problems = [...checkSnapshot(snapshotText), ...checkResults(resultsText)];
const undetected: string[] = [];
for (const m of MUTATIONS) {
  try {
    const found = m.doc === 'snapshot' ? checkSnapshot(m.apply(snapshotText)) : checkResults(m.apply(resultsText));
    if (found.length === 0) undetected.push(m.what);
  } catch (err) {
    undetected.push(`${m.what} (${(err as Error).message})`);
  }
}

if (problems.length) console.error(`✗ ${problems.length} diferencia(s) entre los docs y bench/results:\n  ${problems.join('\n  ')}`);
if (undetected.length) console.error(`✗ el control no detecta ${undetected.length} mutación(es):\n  ${undetected.join('\n  ')}`);
if (problems.length || undetected.length) process.exit(1);
console.log(`✓ las tablas coinciden con las ${all.length} corridas de bench/results (y las ${MUTATIONS.length} mutaciones del autocontrol fallan)`);
