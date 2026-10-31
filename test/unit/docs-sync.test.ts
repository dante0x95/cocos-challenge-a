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

/**
 * Lo que está mal en las filas de la tabla: una suite que no existe, una que no usa el nombre de
 * `suiteOf` (`test/bootstrap/bootstrap` en vez de `test/bootstrap`) y una cuyo archivo ya tiene
 * fila, aunque se llame distinto: se compara el archivo, no el texto de la celda.
 */
const rowProblems = (table: string[]) => {
  const seen = new Set<string>();
  return table.flatMap((suite) => {
    const file = fileOf(suite);
    if (!file) return [`${suite}: no existe`];
    const problems = suiteOf(file) === suite ? [] : [`${suite}: el nombre de la suite es ${suiteOf(file)}`];
    if (seen.has(file)) problems.push(`${suite}: repite ${file}`);
    seen.add(file);
    return problems;
  });
};

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

// El otro repositorio es `cocos-challenge`, sin `-a`: con ruta, en la raíz, con `.git`, con ancla o
// al final de una oración. El nombre termina donde no sigue un carácter que podría continuarlo
// (`-a`, `_b`, `.github.io` son otros repositorios). GitHub no distingue mayúsculas.
const OTHER_REPO = /github\.com\/dante0x95\/cocos-challenge(?:\.git)?(?![\w-]|\.[\w-])/gi;

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

  it('control: dos filas para el mismo archivo, con nombres distintos, se detectan', () => {
    expect(rowProblems(['test/unit/money', 'test/bootstrap', 'test/bootstrap/bootstrap'])).toEqual([
      'test/bootstrap/bootstrap: el nombre de la suite es test/bootstrap',
      'test/bootstrap/bootstrap: repite test/bootstrap/bootstrap.test.ts',
    ]);
    expect(rowProblems(['test/unit/money', 'test/unit/money'])).toEqual([
      'test/unit/money: repite test/unit/money.test.ts',
    ]);
    expect(rowProblems(['test/unit/no-existe'])).toEqual(['test/unit/no-existe: no existe']);
  });

  it('cada fila nombra una suite que existe, con su nombre, una sola vez', () => {
    expect(rowProblems(table)).toEqual([]);
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

  it('detecta también un link a la raíz del repo sin -a, con o sin barra, y no a otro repo que empieza igual', () => {
    const text = [
      'El otro repo: https://github.com/dante0x95/cocos-challenge',
      'Entre paréntesis ([variante B](https://github.com/dante0x95/cocos-challenge)).',
      'Al final de una oración: https://github.com/dante0x95/cocos-challenge.',
      'Con ancla: https://github.com/dante0x95/cocos-challenge#readme y con .git: https://github.com/dante0x95/cocos-challenge.git',
      'En mayúsculas: https://GitHub.com/dante0x95/Cocos-Challenge/issues/1',
      'Este: https://github.com/dante0x95/cocos-challenge-a y https://github.com/dante0x95/cocos-challenge-a/',
      'Otros: https://github.com/dante0x95/cocos-challenge_b, https://github.com/dante0x95/cocos-challenge.github.io',
    ].join('\n');
    expect(linksToOtherRepo(text)).toEqual([1, 2, 3, 4, 4, 5]);
  });

  it('ningún .md versionado ni .env.example enlaza al repositorio dante0x95/cocos-challenge', () => {
    const files = versionedDocs();
    expect(files).toContain('docs/testing.md');
    expect(files).toContain('.env.example');
    const found = files.flatMap((file) =>
      linksToOtherRepo(readFileSync(resolve(ROOT, file), 'utf8')).map((line) => `${file}:${line}`),
    );
    expect(found).toEqual([]);
  });
});
