// Los docs versionados no dicen cuántas pruebas hay (issue #19): ese número cambia con cada PR
// que agrega una, así que dos PRs en paralelo chocaban siempre en la misma línea del README. La
// cuenta va en "Cómo se probó" del PR (CONTRIBUTING.md).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

// Un número (con separador de miles o sin él) seguido de "prueba(s)" o "test(s)". El número puede
// llevar énfasis Markdown (`**236**`, `_236_`, `` `236` ``) y el espacio puede ser un salto de línea,
// porque Markdown ajusta las líneas largas.
const EMPHASIS = '[*_`~]*';
const TEST_COUNT = new RegExp(
  `(\\d+(?:[.,]\\d+)*)${EMPHASIS}\\s+${EMPHASIS}(?:pruebas?|tests?)\\b`,
  'gi',
);

const findTestCounts = (text: string) =>
  [...text.matchAll(TEST_COUNT)].map((match) => ({
    line: text.slice(0, match.index).split('\n').length,
    text: match[0].replace(/\s+/g, ' '),
  }));

const versionedMarkdown = () => {
  const { status, stdout, stderr } = spawnSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (status !== 0) throw new Error(`git ls-files falló: ${stderr}`);
  return stdout.split('\0').filter(Boolean);
};

describe('cuenta de pruebas en los docs', () => {
  it('detecta la línea que tenía el README y otras formas de contar', () => {
    expect(findTestCounts('Crean su propia base. Hay 236 pruebas: unitarias, de base y bootstrap.')).toEqual([
      { line: 1, text: '236 pruebas' },
    ]);
    expect(findTestCounts('Son 1.234 tests en total.')).toEqual([{ line: 1, text: '1.234 tests' }]);
    expect(findTestCounts('Corre 1 test de humo.')).toEqual([{ line: 1, text: '1 test' }]);
  });

  it('detecta la cuenta partida por un salto de línea, con la línea del número', () => {
    expect(findTestCounts('# Pruebas\n\nHay 236\npruebas: unitarias y de base.')).toEqual([
      { line: 3, text: '236 pruebas' },
    ]);
  });

  it('detecta la cuenta con énfasis Markdown', () => {
    expect(findTestCounts('Hay **236** pruebas.')).toEqual([{ line: 1, text: '236** pruebas' }]);
    expect(findTestCounts('Hay _236_ tests.')).toEqual([{ line: 1, text: '236_ tests' }]);
    expect(findTestCounts('Hay `236` pruebas.')).toEqual([{ line: 1, text: '236` pruebas' }]);
  });

  it('no confunde con una cuenta lo que no lo es', () => {
    expect(findTestCounts('Las suites: unitarias, el test funcional de órdenes por HTTP y bootstrap.')).toEqual([]);
    expect(findTestCounts('100 usuarios × 20 operaciones aleatorias (seed fija, ~1.700 operaciones).')).toEqual([]);
    expect(findTestCounts('Las pruebas con base crean su propia base de datos.')).toEqual([]);
  });

  it('ningún .md versionado dice cuántas pruebas hay', () => {
    const files = versionedMarkdown();
    expect(files).toContain('README.md');
    expect(files).toContain('docs/testing.md');
    const found = files.flatMap((file) =>
      findTestCounts(readFileSync(resolve(ROOT, file), 'utf8')).map(
        ({ line, text }) => `${file}:${line}: ${text}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

// Plan de pruebas del issue #19, punto 2: dos ramas que agregan una suite cada una se fusionan sin
// conflicto. Cada rama hace lo que piden los docs: un archivo de test nuevo, una fila nueva en
// docs/testing.md y, si algún .md versionado tuviera una cuenta, actualizarla. Se arma en un
// repositorio temporal con los .md del árbol de trabajo y se fusiona con `git merge-tree`.
describe('dos ramas que agregan pruebas', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  // Aislado de la configuración del usuario (hooks, firma de commits).
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'prueba',
    GIT_AUTHOR_EMAIL: 'prueba@example.com',
    GIT_COMMITTER_NAME: 'prueba',
    GIT_COMMITTER_EMAIL: 'prueba@example.com',
  };

  const gitIn = (repo: string, ...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV });

  const run = (repo: string, ...args: string[]) => {
    const result = gitIn(repo, ...args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} falló: ${result.stderr}`);
    return result.stdout.trim();
  };

  const write = (repo: string, path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  // Agrega la fila de `suite` después de la primera fila que empieza con `after`.
  const addRow = (table: string, after: string, suite: string) => {
    const lines = table.split('\n');
    const index = lines.findIndex((line) => line.startsWith(after));
    if (index < 0) throw new Error(`docs/testing.md no tiene una fila que empiece con ${after}`);
    lines.splice(index + 1, 0, `| \`${suite}\` | Prueba de ejemplo. |`);
    return lines.join('\n');
  };

  const bumpCounts = (text: string, delta: number) =>
    text.replace(TEST_COUNT, (match, count: string) =>
      match.replace(count, String(Number(count.replace(/[.,]/g, '')) + delta)),
    );

  const branch = (repo: string, base: string, name: string, after: string, delta: number) => {
    run(repo, 'checkout', '-q', '-b', name, base);
    const suite = `test/unit/${name}`;
    write(repo, `${suite}.test.ts`, `import { it } from 'vitest';\nit('${name}', () => {});\n`);
    const testing = readFileSync(join(repo, 'docs/testing.md'), 'utf8');
    write(repo, 'docs/testing.md', addRow(testing, after, suite));
    for (const file of run(repo, 'ls-files', '--', '*.md').split('\n')) {
      const text = readFileSync(join(repo, file), 'utf8');
      write(repo, file, bumpCounts(text, delta));
    }
    run(repo, 'add', '-A');
    run(repo, 'commit', '-q', '--no-verify', '-m', `rama ${name}`);
    return run(repo, 'rev-parse', 'HEAD');
  };

  // Fusiona dos ramas que agregan una suite unitaria y una de base sobre los .md dados.
  const mergeTwoBranches = (docs: Record<string, string>) => {
    const repo = mkdtempSync(join(tmpdir(), 'docs-merge-'));
    repos.push(repo);
    run(repo, 'init', '-q', '-b', 'main');
    for (const [path, content] of Object.entries(docs)) write(repo, path, content);
    run(repo, 'add', '-A');
    run(repo, 'commit', '-q', '--no-verify', '-m', 'base');
    const alpha = branch(repo, 'main', 'alpha', '| `test/unit/', 1);
    const beta = branch(repo, 'main', 'beta', '| `test/db/', 2);
    return gitIn(repo, 'merge-tree', '--write-tree', '--name-only', alpha, beta);
  };

  const currentDocs = () =>
    Object.fromEntries(versionedMarkdown().map((file) => [file, readFileSync(resolve(ROOT, file), 'utf8')]));

  it('con los docs actuales se fusionan sin conflicto', () => {
    const merge = mergeTwoBranches(currentDocs());
    expect(merge.stderr).toBe('');
    expect(merge.status).toBe(0);
  });

  it('control: con una cuenta en el README, las dos ramas chocan en esa línea', () => {
    const docs = currentDocs();
    docs['README.md'] += '\nHay 236 pruebas: unitarias y de base.\n';
    const merge = mergeTwoBranches(docs);
    expect(merge.status).toBe(1);
    expect(merge.stdout).toContain('CONFLICT (content): Merge conflict in README.md');
    expect(merge.stdout).not.toContain('Merge conflict in docs/testing.md');
  });
});
