// El contrato de la API (src/db/contract.ts, issue #39) está completo: cada función app.* que src/
// llama, con su cantidad de argumentos, está en el contrato, y el contrato no tiene llamadas que
// src/ ya no hace (frenarían sin motivo retirar una firma en el release siguiente). Los tipos los
// verifica el bootstrap contra la base (test/bootstrap/contract).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { API_CONTRACT, parseSignature } from '../../src/db/contract.js';

// El bootstrap llama a sus propias funciones (verify_ledger, cancel_unbacked) con la base que él
// mismo deja: no las llama la API que atiende.
const NOT_API = new Set(['src/db/bootstrap.ts', 'src/db/contract.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Cantidad de argumentos de la llamada cuyo paréntesis de apertura está en `open`. */
function arity(sql: string, open: number, where: string): number {
  let depth = 0;
  let commas = 0;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {   // un literal SQL: sus paréntesis y comas no cuentan
      i = sql.indexOf("'", i + 1);
      if (i < 0) break;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      const args = sql.slice(open + 1, i);
      if (args.includes('${')) throw new Error(`${where}: argumentos interpolados, no se pueden contar`);
      return args.trim() === '' ? 0 : commas + 1;
    } else if (c === ',' && depth === 1) commas++;
  }
  throw new Error(`${where}: llamada sin cerrar`);
}

/**
 * Las llamadas a app.* de un archivo, como `nombre/aridad`. Solo mira dentro de los literales de
 * string (el SQL): `app.use(` de Express no es una llamada a la base, y los comentarios tampoco.
 */
function appCalls(source: string, file: string): string[] {
  const calls: string[] = [];
  const tokens = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  for (const [token] of source.matchAll(tokens)) {
    if (token.startsWith('/')) continue;
    if (/\bapp\.\$\{/.test(token)) throw new Error(`${file}: nombre de función interpolado: ${token}`);
    for (const m of token.matchAll(/\bapp\.([a-z_][a-z0-9_]*)\s*\(/g)) {
      calls.push(`${m[1]}/${arity(token, m.index! + m[0].length - 1, `${file}: app.${m[1]}`)}`);
    }
  }
  return calls;
}

const srcCalls = () => {
  const root = resolve('.');
  const calls = new Map<string, string[]>();
  for (const f of sourceFiles(resolve('src'))) {
    const rel = relative(root, f);
    if (NOT_API.has(rel)) continue;
    for (const c of appCalls(readFileSync(f, 'utf8'), rel)) calls.set(c, [...(calls.get(c) ?? []), rel]);
  }
  return calls;
};

describe('contrato de la API (issue #39)', () => {
  it('cada llamada a app.* de src/ está en el contrato con su cantidad de argumentos, y el contrato no tiene llamadas de más', () => {
    const contract = API_CONTRACT.map((s) => { const { name, args } = parseSignature(s); return `${name}/${args.length}`; });
    expect(new Set(contract).size, 'firmas repetidas en el contrato').toBe(contract.length);
    expect([...srcCalls().keys()].sort()).toEqual(contract.sort());
  });

  it('encuentra las llamadas reales (no pasa en falso con un lector que no ve nada)', () => {
    const calls = srcCalls();
    expect(new Set(calls.get('place_order/10'))).toEqual(new Set(['src/repositories/orders.repo.ts']));
    expect(new Set(calls.get('unaccent_immutable/1'))).toEqual(new Set(['src/repositories/instruments.repo.ts']));
    expect(new Set(calls.get('health/0'))).toEqual(new Set(['src/repositories/ops.repo.ts']));
  });

  it('el lector: SQL en cualquier literal, aridad con llamadas y literales anidados; ni Express ni los comentarios cuentan', () => {
    const src = [
      "app.use(express.json()); // app.place_order(1, 2)",
      '/* SELECT app.cancel_order(1, 2) */',
      "q('SELECT * FROM app.read_portfolio($1)', [u]);",
      'q(`SELECT app.f(lower($1), \'a,(b\', g(x, y)) FROM app.orders WHERE app.g() IS NULL`);',
      'q("SELECT app.h ($1, $2)");',
    ].join('\n');
    expect(appCalls(src, 'x.ts')).toEqual(['read_portfolio/1', 'f/3', 'g/0', 'h/2']);
    expect(() => appCalls('q(`SELECT app.${fn}($1)`)', 'x.ts')).toThrow('nombre de función interpolado');
    expect(() => appCalls('q(`SELECT app.f(${args})`)', 'x.ts')).toThrow('argumentos interpolados');
  });

  it('cada firma del contrato tiene la forma app.nombre(tipo,tipo)', () => {
    for (const s of API_CONTRACT) expect(() => parseSignature(s), s).not.toThrow();
    expect(() => parseSignature('place_order(integer)')).toThrow('firma inválida');
  });
});
