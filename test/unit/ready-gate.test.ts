// scripts/ready-gate.sh con `gh` simulado (test/support/ready-gate), y el paso de
// .github/workflows/ready-gate.yml que lo corre. Cada caso fija qué lee la gate y, sobre todo,
// cuándo devuelve el PR a borrador: solo codex/review en success sobre el head vigente lo deja
// ready, y un error de la API o una corrida atrasada nunca lo aprueban.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/ready-gate.sh');
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/ready-gate.yml'), 'utf8');
const FAKE_GH = join(REPO_ROOT, 'test/support/ready-gate/fake-gh.mjs');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const NODE_ID = 'PR_kwDOtest29';
const ENV = { REPO: 'acme/demo', PR_NUMBER: '29', PR_NODE_ID: NODE_ID, EVENT_SHA: A };

type Pull = { head: string; state?: string; draft?: boolean };
type State = {
  pulls: Pull[]; statuses?: Record<string, { context: string; state: string }[]>;
  failPulls?: number; failPullsFrom?: number; failStatuses?: number; mutation?: 'ok' | 'not-draft' | 'fail';
};
type Call = { endpoint: string; fields: Record<string, string>; jq: string | null };

let root: string;
let bin: string;
let fake: string;

/** codex/review en `state`, junto a otros contextos que el filtro tiene que ignorar. */
const review = (state: string) => [
  { context: 'ci', state: 'success' },
  { context: 'codex/review', state },
  { context: 'codex/review-extra', state: 'success' },
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ready-gate-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node "${FAKE_GH}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  fake = mkdtempSync(join(root, 'fake-'));
});

/** Prepara el estado de GitHub para la próxima corrida (sin borrar las llamadas anteriores). */
const arrange = (state: State) => {
  writeFileSync(join(fake, 'state.json'), JSON.stringify({ mutation: 'ok', ...state }));
  rmSync(join(fake, 'counts.json'), { force: true });
};

function calls(): Call[] {
  try {
    return readFileSync(join(fake, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call);
  } catch {
    return [];
  }
}

function exec(command: string[], env: Record<string, string>) {
  const before = calls().length;
  const r = spawnSync(command[0], command.slice(1), {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: fake, READY_GATE_RETRY_DELAY: '0', ...env },
  });
  const made = calls().slice(before);
  return {
    code: r.status, stdout: r.stdout, stderr: r.stderr, calls: made,
    statusReads: made.filter((c) => c.endpoint.includes('/commits/')).map((c) => c.endpoint.split('/')[4]),
    mutations: made.filter((c) => c.endpoint === 'graphql').map((c) => c.fields),
  };
}

const gate = (env: Partial<typeof ENV> = {}) => exec(['bash', SCRIPT], { ...ENV, ...env });

describe('ready-gate: contrato con la API de GitHub', () => {
  it('lee el PR, el status de su head y vuelve a leer el PR; con success no convierte', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('success') } });
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.endpoint)).toEqual([
      'repos/acme/demo/pulls/29',
      `repos/acme/demo/commits/${A}/status?per_page=100`,
      'repos/acme/demo/pulls/29',
    ]);
    expect(r.mutations).toEqual([]);
    expect(r.stdout).toContain(`codex/review en verde en ${A}`);
  });

  it('convierte con convertPullRequestToDraft sobre el node_id del PR', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('pending') } });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0].id).toBe(NODE_ID);
    expect(r.mutations[0].query).toMatch(/^mutation\(\$id: ID!\) \{ convertPullRequestToDraft\(input: \{pullRequestId: \$id\}\)/);
  });

  it('mira solo el contexto codex/review: otros contextos en verde no aprueban', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: [
      { context: 'ci', state: 'success' }, { context: 'codex/review-extra', state: 'success' },
      { context: 'Codex/Review', state: 'success' },
    ] } });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('(estado: absent)');
    expect(r.mutations).toHaveLength(1);
  });

  it('falla de uso si falta una variable', () => {
    arrange({ pulls: [{ head: A }] });
    const r = exec(['bash', SCRIPT], { ...ENV, PR_NODE_ID: '' });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('falta PR_NODE_ID');
    expect(r.calls).toEqual([]);
  });
});

describe('ready-gate: decisión según codex/review', () => {
  it('success: el PR queda ready', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('success') } });
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.mutations).toEqual([]);
  });

  it.each([
    ['ausente', [] as { context: string; state: string }[], 'absent'],
    ['pending', review('pending'), 'pending'],
    ['failure', review('failure'), 'failure'],
    ['error', review('error'), 'error'],
  ])('%s: vuelve a borrador y falla', (_, statuses, shown) => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: statuses } });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.mutations).toHaveLength(1);
    expect(r.stdout).toContain(`codex/review no está en verde en ${A} (estado: ${shown})`);
    expect(r.stdout).toContain('El PR volvió a borrador');
  });

  it.each([
    ['ya en borrador', { head: A, draft: true }],
    ['cerrado', { head: A, state: 'closed' }],
  ])('PR %s: no hay nada que decidir', (_, pull) => {
    arrange({ pulls: [pull], statuses: { [A]: review('failure') } });
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.statusReads).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('el PR pasa a borrador mientras se lee el status: no lo vuelve a convertir', () => {
    arrange({ pulls: [{ head: A }, { head: A, draft: true }], statuses: { [A]: review('failure') } });
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.mutations).toEqual([]);
  });
});

describe('ready-gate: errores de la API', () => {
  it('la consulta del status falla siempre: reintenta, convierte y falla sin aprobar', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('success') }, failStatuses: 99 });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.statusReads).toEqual([A, A, A]);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0].id).toBe(NODE_ID);
    expect(r.stdout).toContain(`No se pudo leer codex/review en ${A}.`);
    expect(r.stdout).toContain('El PR volvió a borrador');
  });

  it('la consulta del status falla una vez: el reintento la lee y el PR queda ready', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('success') }, failStatuses: 1 });
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.statusReads).toEqual([A, A]);
    expect(r.mutations).toEqual([]);
  });

  it('la lectura del PR falla siempre: convierte con el node_id del evento', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('success') }, failPulls: 99 });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.statusReads).toEqual([]);
    expect(r.mutations).toEqual([expect.objectContaining({ id: NODE_ID })]);
    expect(r.stdout).toContain('No se pudo leer el PR #29.');
  });

  it('la relectura del PR falla siempre: no aprueba con el status ya leído', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('success') }, failPullsFrom: 1 });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.statusReads).toEqual([A]);
    expect(r.mutations).toHaveLength(1);
    expect(r.stdout).toContain('No se pudo releer el PR #29.');
  });

  it('la conversión falla: lo informa como tal y sale con 2', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('failure') }, mutation: 'fail' });
    const r = gate();
    expect(r.code).toBe(2);
    expect(r.mutations).toHaveLength(3);
    expect(r.stdout).toContain('No se pudo devolver el PR a borrador (respuesta: sin respuesta)');
    expect(r.stdout).not.toContain('El PR volvió a borrador');
  });

  it('el token no tiene contents: write: la conversión falla y sale con 2', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('failure') } });
    const r = exec(['bash', SCRIPT], { ...ENV, FAKE_PERMISSIONS: 'contents=read,pull-requests=write,statuses=read' });
    expect(r.code).toBe(2);
    expect(r.mutations).toHaveLength(3);
    expect(r.stderr).toContain('Resource not accessible by integration');
    expect(r.stdout).toContain('No se pudo devolver el PR a borrador');
  });

  it('la conversión responde isDraft false: no la da por hecha', () => {
    arrange({ pulls: [{ head: A }], statuses: { [A]: review('failure') }, mutation: 'not-draft' });
    const r = gate();
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('No se pudo devolver el PR a borrador (respuesta: false)');
  });

  it('la consulta falla y la conversión también: sale con 2', () => {
    arrange({ pulls: [{ head: A }], failStatuses: 99, mutation: 'fail' });
    const r = gate();
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`No se pudo leer codex/review en ${A}. No se pudo devolver el PR a borrador`);
  });
});

describe('ready-gate: eventos atrasados y cambios de head', () => {
  it('evento en A, head vigente B aprobado: queda ready sin mirar A', () => {
    arrange({ pulls: [{ head: B }], statuses: { [A]: review('failure'), [B]: review('success') } });
    const r = gate({ EVENT_SHA: A });
    expect(r.code).toBe(0);
    expect(r.statusReads).toEqual([B]);
    expect(r.mutations).toEqual([]);
    expect(r.stdout).toContain(`El evento era para ${A}; el head vigente es ${B}`);
  });

  it('evento en A aprobado, head vigente B sin revisión: no acepta B con la aprobación de A', () => {
    arrange({ pulls: [{ head: B }], statuses: { [A]: review('success') } });
    const r = gate({ EVENT_SHA: A });
    expect(r.code).toBe(1);
    expect(r.statusReads).toEqual([B]);
    expect(r.mutations).toHaveLength(1);
    expect(r.stdout).toContain(`codex/review no está en verde en ${B} (estado: absent)`);
  });

  it('dos corridas fuera de orden: la de A, sin aprobación, termina después de la de B aprobada', () => {
    arrange({ pulls: [{ head: B }], statuses: { [A]: review('failure'), [B]: review('success') } });
    const runB = gate({ EVENT_SHA: B });
    arrange({ pulls: [{ head: B }], statuses: { [A]: review('failure'), [B]: review('success') } });
    const runA = gate({ EVENT_SHA: A });
    expect([runB.code, runA.code]).toEqual([0, 0]);
    expect(runA.statusReads).toEqual([B]);
    expect([...runB.mutations, ...runA.mutations]).toEqual([]);
  });

  it('dos corridas fuera de orden: la de A aprobada termina después de que B quedó sin revisión', () => {
    arrange({ pulls: [{ head: B }], statuses: { [A]: review('success') } });
    const runB = gate({ EVENT_SHA: B });
    arrange({ pulls: [{ head: B, draft: true }], statuses: { [A]: review('success') } });
    const runA = gate({ EVENT_SHA: A });
    expect(runB.code).toBe(1);
    expect(runB.mutations).toHaveLength(1);
    // La de A encuentra el PR en borrador: no lo marca ready ni decide con el status de A.
    expect(runA.code).toBe(0);
    expect(runA.statusReads).toEqual([]);
    expect(runA.mutations).toEqual([]);
  });

  it('el head pasa de A a B mientras se lee el status: decide con el status de B', () => {
    arrange({ pulls: [{ head: A }, { head: B }], statuses: { [A]: review('success') } });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.statusReads).toEqual([A, B]);
    expect(r.mutations).toHaveLength(1);
    expect(r.stdout).toContain(`El head cambió de ${A} a ${B}`);
  });

  it('el head pasa de A a B aprobado mientras se lee el status: queda ready', () => {
    arrange({ pulls: [{ head: A }, { head: B }], statuses: { [B]: review('success') } });
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.statusReads).toEqual([A, B]);
    expect(r.mutations).toEqual([]);
  });

  it('el head no se estabiliza: vuelve a borrador sin aprobar', () => {
    const all = Object.fromEntries([A, B, C, D].map((sha) => [sha, review('success')]));
    arrange({ pulls: [{ head: A }, { head: B }, { head: C }, { head: D }], statuses: all });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.statusReads).toEqual([A, B, C]);
    expect(r.mutations).toHaveLength(1);
    expect(r.stdout).toContain('El head del PR no se estabilizó en 3 lecturas.');
  });
});

describe('ready-gate.yml', () => {
  /** Las líneas del archivo entre `start` (incluida) y la primera línea sin sangría posterior. */
  const block = (start: string) => {
    const lines = WORKFLOW.split('\n');
    const i = lines.indexOf(start);
    expect(i, `falta "${start}"`).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, j) => j > i && /^\S/.test(l));
    return lines.slice(i, end === -1 ? undefined : end).join('\n');
  };

  it('corre con pull_request_target al abrir, reabrir o marcar ready', () => {
    expect(block('on:')).toBe('on:\n  pull_request_target:\n    types: [opened, reopened, ready_for_review]\n');
  });

  /** Los permisos del bloque `permissions:` como los recibe el fake ("contents=write,…"). */
  const permissions = () => block('permissions:').split('\n').slice(1).filter(Boolean)
    .map((l) => l.trim().replace(': ', '=')).join(',');

  it('pide contents: write y pull-requests: write, los dos que exige convertPullRequestToDraft', () => {
    // Con pull-requests: write solo, GitHub responde "Resource not accessible by integration" (#53).
    expect(block('permissions:')).toBe('permissions:\n  contents: write\n  pull-requests: write\n  statuses: read\n');
  });

  it('excluye los borradores y corre de a una corrida por PR, sin cancelar la que corre', () => {
    expect(WORKFLOW).toContain('    if: ${{ !github.event.pull_request.draft }}\n');
    expect(block('concurrency:')).toBe(
      'concurrency:\n  group: ready-gate-${{ github.event.pull_request.number }}\n  cancel-in-progress: false\n');
  });

  it('hace checkout de la base, nunca del código del PR', () => {
    const refs = [...WORKFLOW.matchAll(/^\s+ref: (.+)$/gm)].map((m) => m[1]);
    expect(refs).toEqual(['${{ github.sha }}']);
    expect(WORKFLOW).not.toMatch(/github\.event\.pull_request\.head\.(ref|repo)|github\.head_ref/);
    expect(WORKFLOW).toContain('persist-credentials: false');
  });

  it('el paso real, con las variables del evento, consulta el head y convierte el PR del evento', () => {
    const step = WORKFLOW.slice(WORKFLOW.indexOf('      - name: codex/review en verde'));
    const event = {
      github: {
        token: 'ghs_test', repository: 'acme/demo', sha: 'f'.repeat(40),
        event: { pull_request: { number: 29, node_id: NODE_ID, draft: false, head: { sha: A } } },
      },
    };
    const lookup = (expr: string) => expr.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], event);
    const env = Object.fromEntries([...step.matchAll(/^ {10}(\w+): \$\{\{ ([\w.]+) \}\}$/gm)]
      .map(([, name, expr]) => [name, String(lookup(expr))]));
    expect(Object.keys(env).sort()).toEqual(['EVENT_SHA', 'GH_TOKEN', 'PR_NODE_ID', 'PR_NUMBER', 'REPO']);
    const run = /^ {8}run: (.+)$/m.exec(step)![1];

    arrange({ pulls: [{ head: A }], statuses: { [A]: review('failure') } });
    const r = exec(['bash', '-e', '-c', run], { ...env, FAKE_PERMISSIONS: permissions() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('El PR volvió a borrador');
    expect(r.calls.map((c) => c.endpoint)).toEqual([
      'repos/acme/demo/pulls/29',
      `repos/acme/demo/commits/${A}/status?per_page=100`,
      'repos/acme/demo/pulls/29',
      'graphql',
    ]);
    expect(r.mutations[0].id).toBe(NODE_ID);
  });
});
