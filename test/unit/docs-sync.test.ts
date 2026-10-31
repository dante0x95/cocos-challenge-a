// Los docs no se desactualizan en silencio (issue #37): cada suite tiene su fila en docs/testing.md
// y ningún link apunta al repositorio de la otra variante, que quien evalúa este no puede abrir.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

// `test/unit/money.test.ts` → `test/unit/money`, como se nombra la suite en la tabla. Un archivo
// con el nombre de su carpeta es la carpeta: `test/bootstrap/bootstrap.test.ts` → `test/bootstrap`.
const suiteOf = (file: string) => file.replace(/\.test\.ts$/, '').replace(/\/([^/]+)\/\1$/, '/$1');
const fileOf = (suite: string) =>
  [`${suite}.test.ts`, `${suite}/${suite.split('/').at(-1)}.test.ts`].find((file) => existsSync(resolve(ROOT, file)));

/** Cada `test/**\/*.test.ts` del árbol de trabajo, también los que todavía no se versionaron. */
const testFiles = () =>
  readdirSync(resolve(ROOT, 'test'), { recursive: true, encoding: 'utf8' })
    .map((path) => `test/${path.split('\\').join('/')}`)
    .filter((path) => path.endsWith('.test.ts'))
    .sort();

/** Las suites de la tabla "Qué prueba cada suite": la primera celda de cada fila, entre backticks. */
const suitesInTable = (markdown: string) => {
  const start = markdown.indexOf('## Qué prueba cada suite');
  if (start < 0) throw new Error('docs/testing.md no tiene la sección "Qué prueba cada suite"');
  const end = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^\| `(test\/[^`]+)` \|/gm)].map((match) => match[1]);
};

// El otro repositorio es `cocos-challenge`, sin `-a`. La barra final deja afuera a este.
const OTHER_REPO = /github\.com\/dante0x95\/cocos-challenge\//g;

const linksToOtherRepo = (text: string) =>
  [...text.matchAll(OTHER_REPO)].map((match) => text.slice(0, match.index).split('\n').length);

const versionedDocs = () => {
  const { status, stdout, stderr } = spawnSync('git', ['ls-files', '-z', '--', '*.md', '.env.example'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (status !== 0) throw new Error(`git ls-files falló: ${stderr}`);
  return stdout.split('\0').filter(Boolean);
};

describe('tabla de suites de docs/testing.md', () => {
  const table = suitesInTable(readFileSync(resolve(ROOT, 'docs/testing.md'), 'utf8'));

  it('lee las filas de la tabla y nada fuera de ella', () => {
    const doc = [
      '# Pruebas',
      '| `test/unit/fuera` | antes de la sección |',
      '## Qué prueba cada suite',
      '| Suite | Qué demuestra |',
      '|---|---|',
      '| `test/unit/money` | Redondeo. |',
      '| `test/db/orders.api` | Por HTTP. |',
      '## Lo que no está cubierto',
      '| `test/unit/despues` | después de la sección |',
    ].join('\n');
    expect(suitesInTable(doc)).toEqual(['test/unit/money', 'test/db/orders.api']);
  });

  it('nombra la suite como la tabla', () => {
    expect(suiteOf('test/unit/money.test.ts')).toBe('test/unit/money');
    expect(suiteOf('test/db/orders.api.test.ts')).toBe('test/db/orders.api');
    expect(suiteOf('test/bootstrap/bootstrap.test.ts')).toBe('test/bootstrap');
    expect(suiteOf('test/property/parity.test.ts')).toBe('test/property/parity');
  });

  it('cada test/**/*.test.ts tiene su fila', () => {
    const files = testFiles();
    expect(files).toContain('test/unit/docs-sync.test.ts');
    expect(files.map(suiteOf).filter((suite) => !table.includes(suite))).toEqual([]);
  });

  it('cada fila nombra una suite que existe, una sola vez', () => {
    expect(table.filter((suite) => !fileOf(suite))).toEqual([]);
    expect(table.filter((suite, index) => table.indexOf(suite) !== index)).toEqual([]);
  });
});

describe('links al otro repositorio', () => {
  it('detecta un link al repo sin -a y no uno a este', () => {
    const text = [
      'Solo pnpm ([#6](https://github.com/dante0x95/cocos-challenge/issues/6)).',
      'Búsqueda ([#14](https://github.com/dante0x95/cocos-challenge-a/issues/14)).',
      'El enunciado: https://github.com/cocoscap/cocos-challenge/blob/main/backend-challenge.md',
    ].join('\n');
    expect(linksToOtherRepo(text)).toEqual([1]);
  });

  it('ningún .md versionado ni .env.example apunta a github.com/dante0x95/cocos-challenge/', () => {
    const files = versionedDocs();
    expect(files).toContain('docs/testing.md');
    expect(files).toContain('.env.example');
    const found = files.flatMap((file) =>
      linksToOtherRepo(readFileSync(resolve(ROOT, file), 'utf8')).map((line) => `${file}:${line}`),
    );
    expect(found).toEqual([]);
  });
});
