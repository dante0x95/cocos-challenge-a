// scripts/codex-review.sh contra un repositorio de prueba, con `gh` y `codex` simulados
// (test/support/codex-review). Cada caso fija qué publica la gate, y sobre todo qué no:
// una salida de Codex incoherente, un CI que no pasó o una simulación nunca dejan
// codex/review en verde ni escriben en el PR.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/codex-review.sh');
const FAKES = join(REPO_ROOT, 'test/support/codex-review');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

let root: string;
let work: string;
let bin: string;
let fake: string;
let headSha: string;
let prNumber: number;
/** PR 9: la base ya tiene la configuración de la revisión y el PR la cambia. */
const pr9 = { base: 'base-con-config', head: '' };
/**
 * --after-rebase: `old` es el commit aprobado sobre `oldBase`; la base avanzó a `newBase`
 * cambiando README.md y agregando una línea al principio de src/shared.ts, que el PR no toca, y
 * `rebased` es el mismo PR rebaseado, sin ningún cambio.
 */
const rb = { base: 'base-rebase', oldBase: '', newBase: '', old: '', rebased: '' };
const BASE_LINES = Array.from({ length: 20 }, (_, i) => `export const v${i + 1} = ${i + 1};\n`);
/** BASE_LINES con otra línea 15, como la cambia un PR. */
const withV15 = (v15: string) => BASE_LINES.map((l, i) => (i === 14 ? `export const v15 = ${v15};\n` : l)).join('');
/**
 * src/fn.ts: dos funciones con el mismo cuerpo; `changed` es la que devuelve true. Las tres
 * líneas de contexto de git a cada lado del return son iguales en las dos.
 */
const twoFunctions = (changed: string) => ['canBuy', 'canSell'].map((name) => [
  `export function ${name}(x: number) {`, '  const a = x + 1;', '  const b = a + 1;', '  const c = b + 1;',
  `  return ${name === changed};`, '  // fin 1', '  // fin 2', '  // fin 3', '}', '',
].join('\n')).join('\n');
/**
 * src/rules.ts: lo mismo como métodos de una clase. El nombre que git pone en el hunk es el de la
 * clase para los dos, así que solo la función entera como contexto los distingue.
 */
const twoMethods = (changed: string) => [
  'export class Rules {',
  ...['canBuy', 'canSell'].flatMap((name) => [
    `  ${name}(x: number) {`, '    const a = x + 1;', '    const b = a + 1;', '    const c = b + 1;',
    `    return ${name === changed};`, '    // fin 1', '    // fin 2', '    // fin 3', '  }', '',
  ]),
  '}', '',
].join('\n');
/**
 * db/rules.sql: lo mismo en PL/pgSQL. git toma BEGIN como inicio de la función, así que ni el
 * nombre del hunk ni la función entera como contexto distinguen app.canBuy de app.canSell.
 */
const twoSqlFunctions = (changed: string) => ['canBuy', 'canSell'].map((name) => [
  `CREATE FUNCTION app.${name}() RETURNS boolean`, 'LANGUAGE plpgsql AS $$', 'DECLARE', '  a int := 1;', 'BEGIN',
  '  a := a + 1;', '  a := a + 1;', '  a := a + 1;', `  IF ${name === changed} THEN RETURN true; END IF;`,
  '  a := a + 1;', '  a := a + 1;', '  a := a + 1;', '  RETURN false;', 'END;', '$$;', '',
].join('\n')).join('\n');

const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: work, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// --- Fixtures -------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const coverage = (o: Json = {}) => ({
  plan_item: 1, risk: 'riesgo', planted_defect: 'defecto', tests: ['test/unit/a.test.ts:1'],
  fails_on_defect: 'YES', reasoning: 'razón', ...o,
});

const finding = (id: string, o: Json = {}) => ({
  id, category: 'QUALITY', severity: 'OPTIONAL', plan_item: 0, title: `título ${id}`,
  path: 'src/a.ts', start_line: 1, end_line: 1, rule: 'R-6', observation: 'obs', impact: 'imp',
  requested_action: 'acción', ...o,
});

const output = (o: Json = {}) => ({
  inspected_commit: 'HEAD', issues: [7], verdict: 'APPROVED', summary: 'Resumen.',
  previous_findings: [], findings: [], test_coverage: [coverage()],
  adversarial_justification: 'El cambio es de una línea: no hay dos escenarios razonables.',
  evidence: 'Leí src/a.ts.', ...o,
});

/** Hilo de un hallazgo de una corrida anterior, como lo devuelve la API de GraphQL. */
const thread = (id: string, severity: 'BLOCKING' | 'OPTIONAL', resolved: boolean) => ({
  id: `T_${id}`, isResolved: resolved,
  comments: { nodes: [
    { databaseId: 100 + Number(id.slice(3)), author: { login: 'dante' },
      body: `<!-- codex-finding id=${id} severity=${severity} iteration=1 -->\n**${id}**` },
    { databaseId: 900, author: { login: 'claude' }, body: 'FIXED abc1234' },
  ] },
});

const checks = (...entries: [string, string][]) =>
  [...entries, ['codex/review', 'fail'] as [string, string]].map(([name, bucket]) => ({ name, bucket, state: bucket, link: '' }));
const GREEN = checks(['ci', 'pass'], ['commit-messages', 'pass']);

type Pr = { number: number; head: string; base: string; files: string[] };

/**
 * Review de una corrida anterior como lo publica el script: con la cuenta que lo corre (`dante`
 * en el doble de `gh`), la marca en la primera línea y el commit de la marca como commit_id.
 */
const review = (sha: string, verdict: string, o: { iteration?: number; afterRebase?: string } = {}) => ({
  user: { login: 'dante' }, commit_id: sha,
  html_url: `https://github.com/acme/demo/pull/8#pullrequestreview-${sha.slice(0, 7)}`,
  body: `<!-- codex-review iteration:${o.iteration ?? 1} sha:${sha}${o.afterRebase ? ` after-rebase:${o.afterRebase}` : ''} -->\n`
    + `## Revisión de Codex\n\n- Iteración: ${o.iteration ?? 1}\n- Veredicto: **${verdict}**\n`,
});

function arrange(o: {
  codex?: Json | string; checks?: Json[]; previousRuns?: number; threads?: Json[];
  pr?: Pr; reviews?: Json[]; issueComments?: Json[];
} = {}) {
  const write = (name: string, value: unknown) =>
    writeFileSync(join(fake, name), typeof value === 'string' ? value : JSON.stringify(value));
  const pr = o.pr ?? { number: 8, head: headSha, base: 'main', files: ['src/a.ts'] };
  prNumber = pr.number;
  write('pr.json', {
    state: 'OPEN', headRefOid: pr.head, baseRefName: pr.base, title: 'feat: algo', url: 'u',
    body: 'Problema:\n...\n\nRefs: #7', files: pr.files.map((path) => ({ path })),
  });
  write('checks.json', o.checks ?? GREEN);
  write('reviews.json', o.reviews ?? Array.from({ length: o.previousRuns ?? 0 }, (_, i) =>
    review((i + 1).toString(16).repeat(40), 'CHANGES_REQUESTED', { iteration: i + 1 })));
  write('issue-comments.json', o.issueComments ?? []);
  write('threads.json', { data: { repository: { pullRequest: { reviewThreads: { nodes: o.threads ?? [] } } } } });
  write('codex-out.json', o.codex ?? output());
}

function run(...extra: string[]) {
  const r = spawnSync('bash', [SCRIPT, String(prNumber), ...extra], {
    cwd: work, encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: fake },
  });
  const log = join(fake, 'calls.jsonl');
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as {
        method: string; endpoint: string; fields: Record<string, string>; stdin: Json | null; write: boolean })
    : [];
  const writes = calls.filter((c) => c.write);
  return {
    code: r.status, stdout: r.stdout, stderr: r.stderr, writes,
    statuses: writes.filter((c) => c.endpoint.includes('/statuses/')).map((c) => c.fields),
    reviews: writes.filter((c) => c.endpoint.endsWith('/reviews')).map((c) => c.stdin!),
    comments: writes.filter((c) => c.endpoint.includes('/pulls/') && c.endpoint.endsWith('/comments')).map((c) => c.stdin!),
    issueComments: writes.filter((c) => /\/issues\/\d+\/comments$/.test(c.endpoint)).map((c) => c.fields),
    replies: writes.filter((c) => c.endpoint.endsWith('/replies')),
    mutations: writes.filter((c) => c.endpoint === 'graphql').map((c) => c.fields),
    codexInput: existsSync(join(fake, 'codex-input.md')) ? readFileSync(join(fake, 'codex-input.md'), 'utf8') : null,
    codexArgs: existsSync(join(fake, 'codex-args.json')) ? JSON.parse(readFileSync(join(fake, 'codex-args.json'), 'utf8')) as string[] : null,
    codexSchema: existsSync(join(fake, 'codex-schema.json')) ? readFileSync(join(fake, 'codex-schema.json'), 'utf8') : null,
  };
}

/** Nombre exacto de la mutación de GraphQL: resolveReviewThread o unresolveReviewThread. */
const mutationName = (query: string) => /\{\s*(\w+)\(input:/.exec(query)?.[1];

const CONFIG = ['review-prompt.md', 'review-rules.md', 'review-output-schema.json'];
/** La configuración real con una marca de versión, para saber cuál recibió Codex. */
const marked = (file: string, version: string) => {
  const text = readFileSync(join(REPO_ROOT, 'docs/process', file), 'utf8');
  return file.endsWith('.json')
    ? JSON.stringify({ $comment: `versión ${version}`, ...JSON.parse(text) }, null, 2)
    : `${text}\n<!-- versión ${version} -->\n`;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-review-'));
  work = join(root, 'work');
  bin = join(root, 'bin');
  mkdirSync(work);
  mkdirSync(bin);
  for (const [name, target] of [['gh', 'fake-gh.mjs'], ['codex', 'fake-codex.mjs']]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec node "${join(FAKES, target)}" "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  spawnSync('git', ['init', '-q', '--bare', join(root, 'origin.git')]);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', join(root, 'origin.git'));
  writeFileSync(join(work, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('push', '-q', 'origin', 'main');
  // El PR trae la configuración de la revisión: la base todavía no la tiene.
  mkdirSync(join(work, 'docs/process'), { recursive: true });
  mkdirSync(join(work, 'src'));
  for (const f of CONFIG) writeFileSync(join(work, 'docs/process', f), readFileSync(join(REPO_ROOT, 'docs/process', f)));
  writeFileSync(join(work, 'src/a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'pr');
  git('push', '-q', 'origin', 'HEAD:refs/pull/8/head');
  headSha = git('rev-parse', 'HEAD');

  // PR 9: otra base, que ya tiene la configuración, y un PR que intenta cambiarla.
  git('checkout', '-q', '-b', pr9.base, 'main');
  mkdirSync(join(work, 'docs/process'), { recursive: true });
  for (const f of CONFIG) writeFileSync(join(work, 'docs/process', f), marked(f, 'base'));
  git('add', '.');
  git('commit', '-q', '-m', 'base con configuración');
  git('push', '-q', 'origin', pr9.base);
  for (const f of CONFIG) writeFileSync(join(work, 'docs/process', f), marked(f, 'PR'));
  git('add', '.');
  git('commit', '-q', '-m', 'pr que cambia la configuración');
  git('push', '-q', 'origin', 'HEAD:refs/pull/9/head');
  pr9.head = git('rev-parse', 'HEAD');

  // --after-rebase: base vieja, PR aprobado (código, un .md y la configuración), base nueva y rebase.
  git('checkout', '-q', '--detach', 'origin/main');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'docs/process'), { recursive: true });
  mkdirSync(join(work, 'db'), { recursive: true });
  writeFileSync(join(work, 'src/base.ts'), BASE_LINES.join(''));
  writeFileSync(join(work, 'src/shared.ts'), BASE_LINES.join(''));
  writeFileSync(join(work, 'src/fn.ts'), twoFunctions(''));
  writeFileSync(join(work, 'src/rules.ts'), twoMethods(''));
  writeFileSync(join(work, 'db/rules.sql'), twoSqlFunctions(''));
  git('add', '.');
  git('commit', '-q', '-m', 'base vieja');
  rb.oldBase = git('rev-parse', 'HEAD');
  writeFileSync(join(work, 'src/base.ts'), withV15('150'));
  writeFileSync(join(work, 'docs/guia.md'), 'guía v1\n');
  for (const f of CONFIG) writeFileSync(join(work, 'docs/process', f), readFileSync(join(REPO_ROOT, 'docs/process', f)));
  git('add', '.');
  git('commit', '-q', '-m', 'pr aprobado');
  rb.old = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', rb.oldBase);
  writeFileSync(join(work, 'src/shared.ts'), `// encabezado\n${BASE_LINES.join('')}`);
  writeFileSync(join(work, 'README.md'), 'base\nla base avanzó\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base nueva');
  rb.newBase = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', `HEAD:refs/heads/${rb.base}`);
  git('cherry-pick', rb.old);
  rb.rebased = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

/** Un commit con `edits` sobre `start`; con `ref`, publicado ahí. */
function commitOn(start: string, edits: Record<string, string>, ref?: string) {
  git('checkout', '-q', '--detach', start);
  for (const [path, text] of Object.entries(edits)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  git('add', '.');
  git('commit', '-q', '-m', 'pr');
  if (ref) git('push', '-q', '-f', 'origin', `HEAD:${ref}`);
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return head;
}

/** El PR rebaseado con `edits` encima, publicado como refs/pull/<number>/head. */
function rebasedPr(number: number, edits: Record<string, string> = {}): Pr {
  git('checkout', '-q', '--detach', rb.rebased);
  for (const [path, text] of Object.entries(edits)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  if (Object.keys(edits).length > 0) {
    git('add', '.');
    git('commit', '-q', '--amend', '--no-edit');
  }
  git('push', '-q', '-f', 'origin', `HEAD:refs/pull/${number}/head`);
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return { number, head, base: rb.base, files: ['src/base.ts', 'docs/guia.md', ...Object.keys(edits)] };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  fake = mkdtempSync(join(root, 'fake-'));
});

// --- Casos ----------------------------------------------------------------------------------

describe('codex-review.sh: publicación', () => {
  it('APPROVED: publica el review sobre HEAD_SHA y deja codex/review en success', () => {
    arrange();
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.statuses.map((s) => s.state)).toEqual(['pending', 'success']);
    expect(r.statuses[1]).toMatchObject({ context: 'codex/review', target_url: 'https://github.com/acme/demo/pull/8#pullrequestreview-1' });
    expect(r.writes.every((c) => !c.endpoint.includes('/statuses/') || c.endpoint.endsWith(`/statuses/${headSha}`))).toBe(true);
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0]).toMatchObject({ commit_id: headSha, event: 'COMMENT' });
    expect(r.reviews[0].body).toContain(`<!-- codex-review iteration:1 sha:${headSha} -->`);
    expect(r.reviews[0].body).toContain('Veredicto: **APPROVED**');
    expect(r.comments).toEqual([]);
  });

  it('corre Codex en solo lectura, sobre el commit del PR y con el schema de la salida', () => {
    arrange();
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    const args = r.codexArgs!;
    expect(args.slice(0, 3)).toEqual(['exec', '--sandbox', 'read-only']);
    expect(args).toContain('--output-schema');
    // La base no tiene configuración: se usa la del PR, y el review lo dice.
    expect(r.codexSchema).toBe(readFileSync(join(REPO_ROOT, 'docs/process/review-output-schema.json'), 'utf8'));
    expect(r.codexInput).toContain(readFileSync(join(REPO_ROOT, 'docs/process/review-rules.md'), 'utf8'));
    expect(r.codexInput).toContain(`HEAD_SHA: ${headSha}`);
    expect(r.reviews[0].body).toContain('La rama base todavía no tiene la configuración de la revisión: esta corrida usó la del propio PR.');
  });

  it('con la configuración en la base, Codex recibe la de la base aunque el PR la cambie', () => {
    arrange({ pr: { number: 9, head: pr9.head, base: pr9.base, files: CONFIG.map((f) => `docs/process/${f}`) } });
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    // El diff también trae las marcas: se compara el texto completo de cada archivo.
    for (const f of ['review-prompt.md', 'review-rules.md']) {
      expect(r.codexInput).toContain(marked(f, 'base'));
      expect(r.codexInput).not.toContain(marked(f, 'PR'));
    }
    expect(JSON.parse(r.codexSchema!).$comment).toBe('versión base');
    expect(r.reviews[0].body).toContain(`Este PR cambia la configuración de la revisión; esta corrida usó la de \`${pr9.base}\`.`);
  });

  it('CHANGES_REQUESTED: un hilo por hallazgo en sus líneas y codex/review en failure', () => {
    arrange({ codex: output({
      verdict: 'CHANGES_REQUESTED',
      findings: [finding('CR-1', { severity: 'BLOCKING', category: 'FUNCTIONAL', start_line: 1, end_line: 2 }), finding('CR-2')],
    }) });
    const r = run();
    expect(r.code, r.stderr).toBe(2);
    expect(r.statuses.map((s) => s.state)).toEqual(['pending', 'failure']);
    expect(r.reviews[0].body).toContain('Veredicto: **CHANGES_REQUESTED**');
    expect(r.comments).toHaveLength(2);
    expect(r.comments[0]).toMatchObject({ commit_id: headSha, path: 'src/a.ts', start_line: 1, line: 2, side: 'RIGHT' });
    expect(r.comments[0].body).toContain('<!-- codex-finding id=CR-1 severity=BLOCKING iteration=1 -->');
    expect(r.comments[1].body).toContain('<!-- codex-finding id=CR-2 severity=OPTIONAL iteration=1 -->');
  });

  it('--dry-run corre Codex y muestra todo, sin escribir nada en GitHub', () => {
    arrange({
      previousRuns: 1,
      threads: [thread('CR-1', 'BLOCKING', false)],
      codex: output({
        verdict: 'CHANGES_REQUESTED',
        previous_findings: [{ id: 'CR-1', disposition: 'STILL_OPEN', note: 'sigue' }],
        findings: [finding('CR-2', { severity: 'BLOCKING' })],
      }),
    });
    const r = run('--dry-run');
    expect(r.code, r.stderr).toBe(2);
    expect(r.codexInput).not.toBeNull();
    expect(r.writes).toEqual([]);
    expect(r.stdout).toContain('===== review (dry-run, no se publica) =====');
    expect(r.stdout).toContain('id=CR-2 severity=BLOCKING');
    expect(r.stdout).toContain('CR-1: STILL_OPEN');
  });

  it('--dry-run con el CI en rojo avisa y tampoco escribe', () => {
    arrange({ checks: checks(['ci', 'fail'], ['commit-messages', 'pass']) });
    const r = run('--dry-run');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('aviso: el CI no está en verde');
    expect(r.writes).toEqual([]);
  });
});

describe('codex-review.sh: CI obligatorio', () => {
  it.each([
    ['ci ausente', checks(['commit-messages', 'pass']), 'ci=ausente'],
    ['ci omitido', checks(['ci', 'skipping'], ['commit-messages', 'pass']), 'ci=skipping'],
    ['ci pendiente', checks(['ci', 'pending'], ['commit-messages', 'pass']), 'ci=pending'],
    ['commit-messages ausente', checks(['ci', 'pass']), 'commit-messages=ausente'],
    ['commit-messages fallido', checks(['ci', 'pass'], ['commit-messages', 'fail']), 'commit-messages=fail'],
    ['otro check fallido', checks(['ci', 'pass'], ['commit-messages', 'pass'], ['lint', 'fail']), 'lint=fail'],
    ['sin checks', [], 'ci=ausente, commit-messages=ausente'],
  ])('%s: no corre Codex ni publica', (_, list, expected) => {
    arrange({ checks: list });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`el CI no está en verde en ${headSha}: ${expected}`);
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });

  it('un check no obligatorio omitido no bloquea', () => {
    arrange({ checks: checks(['ci', 'pass'], ['commit-messages', 'pass'], ['deploy', 'skipping']) });
    expect(run().code).toBe(0);
  });
});

describe('codex-review.sh: hallazgos anteriores', () => {
  it('rechaza APPROVED que omite un bloqueante anterior cuyo hilo se cerró a mano', () => {
    arrange({ previousRuns: 1, threads: [thread('CR-1', 'BLOCKING', true)], codex: output() });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Codex no dio disposición a todos los hallazgos anteriores');
    expect(r.reviews).toEqual([]);
    expect(r.statuses.map((s) => s.state)).toEqual(['pending', 'error']);
  });

  it.each(['STILL_OPEN', 'JUSTIFICATION_REJECTED'])('rechaza APPROVED con un bloqueante anterior %s', (disposition) => {
    arrange({
      previousRuns: 1, threads: [thread('CR-1', 'BLOCKING', false)],
      codex: output({ previous_findings: [{ id: 'CR-1', disposition, note: 'n' }] }),
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Codex aprobó con un hallazgo bloqueante anterior todavía abierto');
    expect(r.reviews).toEqual([]);
    expect(r.statuses.map((s) => s.state)).toEqual(['pending', 'error']);
  });

  it.each(['RESOLVED', 'JUSTIFICATION_ACCEPTED'])('%s: aprueba, responde en el hilo y lo resuelve', (disposition) => {
    arrange({
      previousRuns: 1, threads: [thread('CR-1', 'BLOCKING', false)],
      codex: output({ previous_findings: [{ id: 'CR-1', disposition, note: 'verificado en src/a.ts' }] }),
    });
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain('ITERATION: 2');
    expect(r.codexInput).toContain('FIXED abc1234');
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0].endpoint).toBe('repos/acme/demo/pulls/8/comments/101/replies');
    expect(r.replies[0].fields.body).toContain(`**Codex (iteración 2): ${disposition}** — verificado en src/a.ts`);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]).toMatchObject({ id: 'T_CR-1' });
    expect(mutationName(r.mutations[0].query)).toBe('resolveReviewThread');
    expect(r.statuses.at(-1)).toMatchObject({ state: 'success' });
  });

  it('las respuestas en los hilos (reviews con cuerpo vacío o nulo) no cuentan como corrida ni rompen la iteración 2', () => {
    // GitHub guarda cada respuesta a un hilo dentro de un review sin cuerpo, con la misma cuenta.
    const reply = (body: string | null) => ({ user: { login: 'dante' }, commit_id: headSha, body, html_url: 'u' });
    arrange({
      reviews: [review('1'.repeat(40), 'CHANGES_REQUESTED'), reply(''), reply(null)],
      threads: [thread('CR-1', 'BLOCKING', false)],
      codex: output({ previous_findings: [{ id: 'CR-1', disposition: 'RESOLVED', note: 'n' }] }),
    });
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain('ITERATION: 2');
    expect(r.reviews[0].body).toContain('<!-- codex-review iteration:2 ');
  });

  it('JUSTIFICATION_REJECTED reabre un hilo cerrado a mano', () => {
    arrange({
      previousRuns: 1, threads: [thread('CR-1', 'BLOCKING', true)],
      codex: output({ verdict: 'CHANGES_REQUESTED', previous_findings: [{ id: 'CR-1', disposition: 'JUSTIFICATION_REJECTED', note: 'n' }] }),
    });
    const r = run();
    expect(r.code, r.stderr).toBe(2);
    expect(r.mutations).toHaveLength(1);
    expect(mutationName(r.mutations[0].query)).toBe('unresolveReviewThread');
    expect(r.statuses.at(-1)).toMatchObject({ state: 'failure' });
  });
});

describe('codex-review.sh: coherencia de la salida de Codex', () => {
  it.each([
    ['no es JSON', 'esto no es JSON', 'la salida de Codex no es JSON válido'],
    ['revisó otro commit', output({ inspected_commit: '0'.repeat(40) }), 'Codex revisó otro commit que el del PR'],
    ['aprueba con un bloqueante', output({ findings: [finding('CR-1', { severity: 'BLOCKING' })] }), 'Codex aprobó con un hallazgo bloqueante'],
    ['repite un id', output({ verdict: 'CHANGES_REQUESTED', findings: [finding('CR-1'), finding('CR-1')] }), 'Codex repitió un id de hallazgo'],
    ['trae la cobertura vacía', output({ test_coverage: [] }), 'test_coverage tiene que tener al menos una entrada'],
    ['numera la cobertura sin empezar en 1', output({ test_coverage: [coverage({ plan_item: 2 })] }), 'numeradas 1..n'],
    ['deja un riesgo sin test que falle y sin hallazgo', output({ test_coverage: [coverage({ fails_on_defect: 'NO' })] }), 'no tiene su hallazgo bloqueante MISSING_TEST o WEAK_TEST'],
    ['deja un riesgo sin tests y sin hallazgo', output({ test_coverage: [coverage({ tests: [] })] }), 'no tiene su hallazgo bloqueante MISSING_TEST o WEAK_TEST'],
    ['no trae escenarios adversos ni justificación en la iteración 1', output({ adversarial_justification: 'n/a' }), 'dos escenarios adversos'],
  ])('rechaza una salida que %s: ni review ni status verde', (_, codex, expected) => {
    arrange({ codex });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(expected);
    expect(r.reviews).toEqual([]);
    expect(r.comments).toEqual([]);
    expect(r.statuses.map((s) => s.state)).toEqual(['pending', 'error']);
  });

  it('rechaza un id que reutiliza el de un hallazgo anterior', () => {
    arrange({
      previousRuns: 1, threads: [thread('CR-1', 'OPTIONAL', false)],
      codex: output({ previous_findings: [{ id: 'CR-1', disposition: 'RESOLVED', note: 'n' }], findings: [finding('CR-1')] }),
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Codex reutilizó el id de un hallazgo anterior');
    expect(r.reviews).toEqual([]);
  });

  it('acepta un riesgo sin test cuando tiene su hallazgo bloqueante MISSING_TEST', () => {
    arrange({ codex: output({
      verdict: 'CHANGES_REQUESTED', test_coverage: [coverage({ tests: [], fails_on_defect: 'NO' })],
      findings: [finding('CR-1', { severity: 'BLOCKING', category: 'MISSING_TEST', plan_item: 1 })],
    }) });
    expect(run().code).toBe(2);
  });
});

describe('codex-review.sh: límite de iteraciones', () => {
  it('iteración 4 sin aprobar: publica, escala a Dante y sale con 3', () => {
    arrange({ previousRuns: 3, codex: output({ verdict: 'CHANGES_REQUESTED', findings: [finding('CR-9', { severity: 'BLOCKING' })] }) });
    const r = run();
    expect(r.code, r.stderr).toBe(3);
    expect(r.reviews[0].body).toContain('**Escalado a Dante:**');
    expect(r.statuses.at(-1)).toMatchObject({ state: 'failure' });
    expect(r.statuses.at(-1)!.description).toContain('Escalado a Dante');
  });

  it('después de 4 corridas no vuelve a correr Codex', () => {
    arrange({ previousRuns: 4 });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('la revisión ya corrió 4 veces sobre el PR #8; decide Dante');
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });
});

describe('codex-review.sh: --after-rebase', () => {
  const approved = () => review(rb.old, 'APPROVED');
  const rebaseMarker = (head: string) => `<!-- codex-after-rebase sha:${head} approved:${rb.old} -->`;

  it('aprobado y rebase que solo cambia documentación: success citando el review aprobado, sin Codex ni iteración', () => {
    const pr = rebasedPr(20, { 'docs/guia.md': 'guía v2\n' });
    arrange({ pr, reviews: [approved()] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toBeNull();
    expect(r.statuses).toEqual([{
      state: 'success', context: 'codex/review', target_url: approved().html_url,
      description: `APPROVED en ${rb.old.slice(0, 7)} (iteración 1); el rebase no cambió código`,
    }]);
    expect(r.writes.filter((c) => c.endpoint.includes('/statuses/')).map((c) => c.endpoint))
      .toEqual([`repos/acme/demo/statuses/${pr.head}`]);
    // Ni review ni hilos: la iteración no cambia.
    expect(r.reviews).toEqual([]);
    expect(r.comments).toEqual([]);
    expect(JSON.stringify(r.writes)).not.toContain('<!-- codex-review ');
    expect(r.issueComments).toHaveLength(1);
    const body = r.issueComments[0].body;
    expect(body.startsWith(`${rebaseMarker(pr.head)}\n`)).toBe(true);
    expect(body).toContain(approved().html_url);
    // La base cambió README.md y src/shared.ts, que el PR no toca: no aparecen.
    expect(body).toContain('| `src/base.ts` | código | igual |');
    expect(body).not.toContain('src/shared.ts');
    expect(body).not.toContain('README.md');
    expect(body).toContain('| `docs/guia.md` | documentación | **cambió** |');
    expect(body).toContain('-+guía v1\n++guía v2');
  });

  it('rebase sin ningún cambio en el diff del PR: success sin Codex', () => {
    const pr = rebasedPr(21);
    arrange({ pr, reviews: [approved()] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toBeNull();
    expect(r.statuses.map((s) => s.state)).toEqual(['success']);
    expect(r.issueComments[0].body).toContain('| `docs/guia.md` | documentación | igual |');
    expect(r.issueComments[0].body).not.toContain('**cambió**');
  });

  it('--dry-run muestra el comentario y el status sin escribir', () => {
    const pr = rebasedPr(21);
    arrange({ pr, reviews: [approved()] });
    const r = run('--after-rebase', '--dry-run');    expect(r.code, r.stderr).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.stdout).toContain(rebaseMarker(pr.head));
    expect(r.stdout).toContain('codex/review: success');
  });

  it('aprobado y rebase que cambia una línea de código: corre Codex y no cuenta para el límite', () => {
    const pr = rebasedPr(22, { 'src/base.ts': withV15('151') });
    // Cuatro corridas: una corrida normal ya no podría correr.
    arrange({ pr, reviews: [
      review('a'.repeat(40), 'CHANGES_REQUESTED', { iteration: 1 }), review('b'.repeat(40), 'CHANGES_REQUESTED', { iteration: 2 }),
      review('c'.repeat(40), 'CHANGES_REQUESTED', { iteration: 3 }), review(rb.old, 'APPROVED', { iteration: 4 }),
    ] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain(`HEAD_SHA: ${pr.head}`);
    expect(r.codexInput).toContain('ITERATION: 4');
    expect(r.codexInput).toContain('## Corrida posterior a un rebase');
    expect(r.codexInput).toContain('| `src/base.ts` | código | **cambió** |');
    expect(r.codexInput).toContain('-+export const v15 = 150;\n++export const v15 = 151;');
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0].body).toContain(`<!-- codex-review iteration:4 sha:${pr.head} after-rebase:${rb.old} -->`);
    expect(r.reviews[0].body).toContain('- Iteración: 4 (posterior al rebase, no cuenta)');
    expect(r.reviews[0].body).toContain('Código cuyo diff cambió: `src/base.ts`.');
    expect(r.statuses.map((s) => s.description)).toEqual([
      'Codex revisando (iteración 4, posterior al rebase)', 'APPROVED (iteración 4, posterior al rebase)',
    ]);
    expect(r.issueComments).toEqual([]);
  });

  it.each([
    ['la configuración del revisor (docs/process/)', 'docs/process/review-rules.md', 'reglas cambiadas\n'],
    ['un .md fuera de la raíz, docs/ y .github/', 'src/notas.md', 'notas\n'],
    ['un archivo que no es .md', 'src/nuevo.ts', 'export const n = 1;\n'],
    ['un cambio de código que solo agrega un espacio', 'src/base.ts', withV15(' 150')],
  ])('%s cuenta como código: corre Codex', (_, path, text) => {
    const pr = rebasedPr(23, { [path]: text });
    arrange({ pr, reviews: [approved()] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain(`| \`${path}\` | código | **cambió** |`);
    expect(r.issueComments).toEqual([]);
  });

  it.each([
    ['sin corridas anteriores', () => [], 'el PR #22 no tiene ninguna'],
    ['con la última corrida CHANGES_REQUESTED', () => [approved(), review('d'.repeat(40), 'CHANGES_REQUESTED', { iteration: 2 })],
      `fue CHANGES_REQUESTED sobre ${'d'.repeat(40)}`],
  ])('%s: rechaza el modo sin correr Codex ni escribir', (_, reviews, expected) => {
    arrange({ pr: rebasedPr(22, { 'src/base.ts': withV15('151') }), reviews: reviews() });
    const r = run('--after-rebase');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--after-rebase exige que la última corrida haya sido APPROVED');
    expect(r.stderr).toContain(expected);
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });

  it('con una corrida normal sobre el mismo commit no hay rebase que comparar', () => {
    const pr = rebasedPr(22, { 'src/base.ts': withV15('151') });
    arrange({ pr, reviews: [approved(), review(pr.head, 'APPROVED', { iteration: 2 })] });
    const r = run('--after-rebase');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`una corrida anterior ya revisó ${pr.head}: no hay rebase que comparar`);
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });

  it('segunda corrida sobre el mismo rebase con código cambiado: no vuelve a correr Codex', () => {
    const pr = rebasedPr(22, { 'src/base.ts': withV15('151') });
    arrange({ pr, reviews: [approved(), review(pr.head, 'APPROVED', { afterRebase: rb.old })] });
    const r = run('--after-rebase');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`la revisión posterior al rebase ya corrió sobre ${pr.head}; no se repite`);
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });

  it('segunda corrida sobre un commit que ya tuvo la suya, aunque después se revisó otro: no vuelve a correr Codex', () => {
    // A aprobado → B (--after-rebase) → C aprobado en una corrida normal → el PR vuelve a B.
    const b = rebasedPr(22, { 'src/base.ts': withV15('151') });
    const c = rebasedPr(26, { 'src/base.ts': withV15('152') });
    arrange({ pr: b, reviews: [
      approved(), review(b.head, 'APPROVED', { afterRebase: rb.old }), review(c.head, 'APPROVED', { iteration: 2 }),
    ] });
    const r = run('--after-rebase');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`la revisión posterior al rebase ya corrió sobre ${b.head}; no se repite`);
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });

  it.each([
    ['otra función', 'src/fn.ts', twoFunctions],
    ['otro método de la misma clase', 'src/rules.ts', twoMethods],
    ['otra función PL/pgSQL', 'db/rules.sql', twoSqlFunctions],
  ])('el mismo cambio movido a %s con el mismo cuerpo cuenta como código: corre Codex', (_, path, source) => {
    const approvedFn = rebasedPr(24, { [path]: source('canBuy') });
    const pr = rebasedPr(25, { [path]: source('canSell') });
    arrange({ pr, reviews: [review(approvedFn.head, 'APPROVED')] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain(`| \`${path}\` | código | **cambió** |`);
    expect(r.issueComments).toEqual([]);
  });

  it('la base cambió un archivo de código que el PR también cambia: corre Codex aunque el diff del PR sea el mismo', () => {
    // El PR cambia la línea 15 de src/shared.ts; la base nueva le agregó una línea al principio.
    const config = Object.fromEntries(CONFIG.map((f) => [`docs/process/${f}`, readFileSync(join(REPO_ROOT, 'docs/process', f), 'utf8')]));
    const approvedShared = commitOn(rb.oldBase, { 'src/shared.ts': withV15('150'), ...config });
    git('checkout', '-q', '--detach', rb.newBase);
    git('cherry-pick', approvedShared);
    git('push', '-q', '-f', 'origin', 'HEAD:refs/pull/27/head');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    arrange({ pr: { number: 27, head, base: rb.base, files: ['src/shared.ts'] }, reviews: [review(approvedShared, 'APPROVED')] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain('| `src/shared.ts` | código | **cambió** |');
    expect(r.codexInput).toContain('(el diff del PR es el mismo salvo los números de línea; cambió el archivo en la base)');
    expect(r.issueComments).toEqual([]);
  });

  it('el rebase deja el archivo igual al aprobado pero la base lo había cambiado: corre Codex', () => {
    // La resolución conserva src/shared.ts tal como se aprobó y así deshace la línea que agregó
    // la base: el archivo final es el mismo, pero el diff del PR contra la base nueva no.
    const config = Object.fromEntries(CONFIG.map((f) => [`docs/process/${f}`, readFileSync(join(REPO_ROOT, 'docs/process', f), 'utf8')]));
    const edits = { 'src/shared.ts': withV15('150'), ...config };
    const approvedShared = commitOn(rb.oldBase, edits);
    const head = commitOn(rb.newBase, edits, 'refs/pull/27/head');
    expect(git('rev-parse', `${approvedShared}:src/shared.ts`)).toBe(git('rev-parse', `${head}:src/shared.ts`));
    arrange({ pr: { number: 27, head, base: rb.base, files: ['src/shared.ts'] }, reviews: [review(approvedShared, 'APPROVED')] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain('| `src/shared.ts` | código | **cambió** |');
    expect(r.issueComments).toEqual([]);
  });

  it('un archivo de código que solo cambia de modo (pierde el permiso de ejecución): corre Codex', () => {
    git('checkout', '-q', '--detach', rb.rebased);
    mkdirSync(join(work, 'scripts'), { recursive: true });
    writeFileSync(join(work, 'scripts/run.sh'), '#!/bin/sh\necho hola\n');
    chmodSync(join(work, 'scripts/run.sh'), 0o755);
    git('add', '.');
    git('commit', '-q', '-m', 'pr con un script ejecutable');
    const approvedExec = git('rev-parse', 'HEAD');
    chmodSync(join(work, 'scripts/run.sh'), 0o644);
    git('add', '.');
    git('commit', '-q', '-m', 'el script pierde el permiso');
    git('push', '-q', '-f', 'origin', 'HEAD:refs/pull/28/head');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    expect(git('rev-parse', `${approvedExec}:scripts/run.sh`)).toBe(git('rev-parse', `${head}:scripts/run.sh`));
    arrange({ pr: { number: 28, head, base: rb.base, files: ['scripts/run.sh'] }, reviews: [review(approvedExec, 'APPROVED')] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain('| `scripts/run.sh` | código | **cambió** |');
    expect(r.issueComments).toEqual([]);
  });

  // Funciones: rb.old recién existe después de beforeAll.
  it.each([
    ['publicado por otra cuenta', () => ({ ...approved(), user: { login: 'otro' } })],
    ['con la marca citada después de otro texto', () => ({ ...approved(), body: `> cita\n${approved().body}` })],
    ['cuyo sha no es el commit_id del review', () => ({ ...approved(), commit_id: rb.rebased })],
  ])('un review %s no es una aprobación heredable: rechaza sin escribir', (_, forged) => {
    // Control: el mismo rebase con el review auténtico pasa sin Codex.
    const pr = rebasedPr(20, { 'docs/guia.md': 'guía v2\n' });
    arrange({ pr, reviews: [approved()] });
    expect(run('--after-rebase').statuses.map((s) => s.state)).toEqual(['success']);
    fake = mkdtempSync(join(root, 'fake-'));
    arrange({ pr, reviews: [forged()] });
    const r = run('--after-rebase');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--after-rebase exige que la última corrida haya sido APPROVED, y el PR #20 no tiene ninguna');
    expect(r.codexInput).toBeNull();
    expect(r.writes).toEqual([]);
  });

  it('segunda corrida sobre el mismo rebase de documentación: no corre Codex ni repite el comentario', () => {
    const pr = rebasedPr(20, { 'docs/guia.md': 'guía v2\n' });
    arrange({ pr, reviews: [approved()], issueComments: [{ body: `${rebaseMarker(pr.head)}\n## Revisión de Codex después de un rebase` }] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toBeNull();
    expect(r.issueComments).toEqual([]);
    expect(r.statuses.map((s) => s.state)).toEqual(['success']);
  });

  it('un comentario sin cuerpo antes de la marca no hace repetir el comentario de la comparación', () => {
    const pr = rebasedPr(20, { 'docs/guia.md': 'guía v2\n' });
    arrange({ pr, reviews: [approved()], issueComments: [{ body: null }, { body: `${rebaseMarker(pr.head)}\n## Revisión de Codex después de un rebase` }] });
    const r = run('--after-rebase');
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toBeNull();
    expect(r.issueComments).toEqual([]);
    expect(r.statuses.map((s) => s.state)).toEqual(['success']);
  });

  it('la corrida posterior al rebase no cuenta: la siguiente corrida normal es la iteración 2', () => {
    const pr = rebasedPr(22, { 'src/base.ts': withV15('151') });
    arrange({ pr, reviews: [approved(), review(pr.head, 'CHANGES_REQUESTED', { afterRebase: rb.old })] });
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.codexInput).toContain('ITERATION: 2');
    expect(r.reviews[0].body).toContain(`<!-- codex-review iteration:2 sha:${pr.head} -->`);
  });
});
