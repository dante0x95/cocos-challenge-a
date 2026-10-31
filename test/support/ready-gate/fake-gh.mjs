// Doble de `gh` para test/unit/ready-gate.test.ts. Responde las llamadas de
// scripts/ready-gate.sh según FAKE_DIR/state.json, aplica el --jq con el jq real (como gh) y
// registra cada llamada en FAKE_DIR/calls.jsonl.
//
// state.json:
//   pulls      lecturas sucesivas del PR ({ state, draft, head }); la última se repite.
//   statuses   sha -> lista de { context, state } del combined status.
//   failPulls / failStatuses   cuántas lecturas fallan (código 1) antes de responder.
//   failPullsFrom   desde qué lectura del PR (contando desde 0) fallan todas.
//   mutation   'ok' (isDraft true), 'not-draft' (isDraft false) o 'fail' (código 1).
//
// FAKE_PERMISSIONS (opcional), los permisos del token como "contents=write,pull-requests=write":
// la mutación falla como en GitHub si no tiene contents y pull-requests en write.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR;
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
const countsFile = join(dir, 'counts.json');
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
const next = (key) => {
  counts[key] = (counts[key] ?? 0) + 1;
  writeFileSync(countsFile, JSON.stringify(counts));
  return counts[key] - 1;
};

const args = process.argv.slice(2);
let jq = null;
const fields = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--jq' || a === '-q') jq = args[++i];
  else if (a === '-f' || a === '-F') {
    const v = args[++i];
    const eq = v.indexOf('=');
    fields[v.slice(0, eq)] = v.slice(eq + 1);
  } else if (a.startsWith('-')) {
    console.error(`fake-gh: opción no prevista: ${a}`);
    process.exit(1);
  } else positional.push(a);
}
const endpoint = positional[0] === 'api' ? positional[1] : positional.join(' ');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ endpoint, fields, jq }) + '\n');

const fail = (msg) => {
  console.error(`fake-gh: ${msg}`);
  process.exit(1);
};
const respond = (body) => {
  if (jq === null) return process.stdout.write(JSON.stringify(body));
  const r = spawnSync('jq', ['-r', jq], { input: JSON.stringify(body), encoding: 'utf8' });
  if (r.status !== 0) fail(`jq falló: ${r.stderr}`);
  process.stdout.write(r.stdout);
};

let m;
if ((m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint))) {
  const n = next('pulls');
  if (n < (state.failPulls ?? 0) || n >= (state.failPullsFrom ?? Infinity)) fail('HTTP 502: Bad Gateway');
  const pr = state.pulls[Math.min(n, state.pulls.length - 1)];
  respond({ number: Number(m[2]), state: pr.state ?? 'open', draft: pr.draft ?? false, head: { sha: pr.head } });
} else if ((m = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-z]+)\/status\?per_page=100$/.exec(endpoint))) {
  if (next('statuses') < (state.failStatuses ?? 0)) fail('HTTP 502: Bad Gateway');
  const statuses = state.statuses?.[m[1]] ?? [];
  respond({ sha: m[1], state: 'pending', statuses });
} else if (endpoint === 'graphql' && /^\s*mutation/.test(fields.query ?? '')) {
  const perms = process.env.FAKE_PERMISSIONS?.split(',');
  const canConvert = !perms || ['contents=write', 'pull-requests=write'].every((p) => perms.includes(p));
  if (state.mutation === 'fail' || !canConvert) fail('GraphQL: Resource not accessible by integration');
  respond({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: state.mutation !== 'not-draft' } } } });
} else {
  fail(`llamada no prevista: ${args.join(' ')}`);
}
