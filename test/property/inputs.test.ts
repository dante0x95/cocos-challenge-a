// Invariante del issue #40: ninguna entrada del cliente produce un 500. Strings aleatorios (seed fija,
// reproducible) que mezclan controles, UTF-8 inválido, sustitutos sueltos, no-caracteres,
// combinantes, marcas de dirección, ancho cero y lo que unaccent expande con texto válido, sobre cada
// string de entrada de la API. El status es siempre < 500, y un POST /orders rechazado no deja orden
// ni clave de idempotencia.
// Los requests van por un socket crudo: fetch no deja mandar bytes de control en una cabecera.
// Tamaño por env: INPUTS_RUNS (60 por campo), INPUTS_SEED (40).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { fromDbError } from '../../src/http/errors.js';
import { admin, newUser, quotes, type Quote } from '../support/db.js';

const RUNS = Number(process.env.INPUTS_RUNS ?? 60);
const SEED = Number(process.env.INPUTS_SEED ?? 40);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let server: Server;
let port: number;
let quote: Quote;

beforeAll(async () => {
  [quote] = await quotes(1);
  server = createApp({ internalToken: 'test-token' }).listen(0);
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.close();
  await pool.end();
  await admin.end();
});

interface Raw { status: number; body: string }

/** Un request HTTP/1.1 escrito byte a byte; devuelve el status y el body. */
function send(method: string, path: string, headers: [string, Buffer | string][] = [], body?: Buffer): Promise<Raw> {
  const head = [`${method} ${path} HTTP/1.1`, 'Host: localhost', 'Connection: close'];
  const lines: Buffer[] = [Buffer.from(head.join('\r\n') + '\r\n')];
  for (const [k, v] of headers) lines.push(Buffer.from(`${k}: `), Buffer.isBuffer(v) ? v : Buffer.from(v), Buffer.from('\r\n'));
  if (body) lines.push(Buffer.from(`Content-Length: ${body.length}\r\n`));
  lines.push(Buffer.from('\r\n'));
  if (body) lines.push(body);
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (d: Buffer) => chunks.push(d));
    socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      resolve({ status, body: text.slice(text.indexOf('\r\n\r\n') + 4) });
    });
    // write y no end: si el cliente cierra su lado, Node aborta el request en curso. Lo cierra el
    // servidor, por el Connection: close.
    socket.write(Buffer.concat(lines));
  });
}

// Una pieza es texto (un string de JS, que puede traer un sustituto suelto) o bytes crudos.
type Piece = string | Uint8Array;

function generator(seed: number) {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const ch = (lo: number, hi: number) => String.fromCharCode(int(lo, hi));
  const classes: Record<string, () => Piece> = {
    c0: () => ch(0x00, 0x1f),
    del: () => '\u007f',
    c1: () => ch(0x80, 0x9f),
    utf8Invalido: () => Uint8Array.from(pick([[0xed, 0xa0, 0x80], [0xc3], [0xe2, 0x82], [0xff], [0xfe], [0xc0, 0xaf], [0xf4, 0x90, 0x80, 0x80], [0x80]])),
    sustituto: () => ch(0xd800, 0xdfff),
    noCaracter: () => pick(['￾', '￿', '�', '\u{10ffff}', '﷐']),
    combinante: () => pick(['́', '̈', '̧', '⃝']),
    direccion: () => pick(['‮', '‭', '‏', '⁦']),
    anchoCero: () => pick(['​', '‌', '‍', '﻿', '⁠']),
    unaccent: () => pick(['Æ', 'ß', '½', 'ﬁ', 'Œ', '㎏', 'Ǆ', '…', '℡']),
    anchoCompleto: () => pick(['％', '＿', '＼', 'Ａ', '１']),
    fueraDelPlanoBasico: () => pick(['\u{1f600}', '\u{1d400}', '\u{20000}']),
    sql: () => pick(["'", '"', '%', '_', '\\', ';--', '%25', '&', '=', '+', '#']),
    espacios: () => pick([' ', '  ', ' ', '　']),
    ascii: () => Array.from({ length: int(1, 6) }, () => ch(0x21, 0x7e)).join(''),
    letras: () => pick(['pa', 'mp', 'galicia', 'Petróleo', 'ñandú', 'CASH_IN', 'LIMIT', '10', '1.5', '0']),
  };
  const names = Object.keys(classes);
  /** Una o más piezas de clases al azar, solas o alrededor (o en medio) de un valor válido. */
  function value(valid: string): Piece[] {
    const pieces = Array.from({ length: int(1, 4) }, () => classes[pick(names)]());
    switch (int(0, 3)) {
      case 0: return pieces;
      case 1: return [...pieces, valid];
      case 2: return [valid, ...pieces];
      default: {
        const at = int(0, valid.length);
        return [valid.slice(0, at), ...pieces, valid.slice(at)];
      }
    }
  }
  return { value, rnd };
}

const isControl = (p: Piece) => typeof p === 'string' && /\p{Cc}/u.test(p);

/** Para la URL: texto en UTF-8 (un sustituto suelto, con sus tres bytes) y bytes crudos, en %XX. */
function urlEncode(pieces: Piece[]): string {
  const hex = (bytes: Iterable<number>) => Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  return pieces.map((p) => {
    if (typeof p !== 'string') return hex(p);
    let out = '';
    for (const c of p) {
      const cp = c.codePointAt(0)!;
      out += cp >= 0xd800 && cp <= 0xdfff
        ? hex([0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)])
        : encodeURIComponent(c);
    }
    return out;
  }).join('');
}

/**
 * Para una cabecera: texto de un byte por carácter tal cual (Node lee la cabecera como latin1, así
 * que 0x85 llega como U+0085), el resto en UTF-8, y bytes crudos. Sin CR ni LF: delimitan la
 * cabecera, no son parte del valor.
 */
function headerBytes(pieces: Piece[]): Buffer {
  const buf = Buffer.concat(pieces.map((p) => (typeof p !== 'string'
    ? Buffer.from(p)
    : Buffer.from(p, [...p].every((c) => c.charCodeAt(0) <= 0xff) ? 'latin1' : 'utf8'))));
  return Buffer.from(buf.filter((b) => b !== 0x0d && b !== 0x0a));
}

/** Un string JSON: texto escapado por JSON.stringify (controles y sustitutos como \uXXXX) y bytes crudos. */
function jsonString(pieces: Piece[]): Buffer {
  return Buffer.concat([
    Buffer.from('"'),
    ...pieces.map((p) => (typeof p === 'string' ? Buffer.from(JSON.stringify(p).slice(1, -1)) : Buffer.from(p))),
    Buffer.from('"'),
  ]);
}

/** Body JSON con un campo reemplazado por los bytes de `field`. */
function bodyWith(base: Record<string, unknown>, name: string, field: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from('{')];
  Object.entries({ ...base, [name]: null }).forEach(([k, v], i) => {
    if (i > 0) parts.push(Buffer.from(','));
    parts.push(Buffer.from(`${JSON.stringify(k)}:`), k === name ? field : Buffer.from(JSON.stringify(v)));
  });
  parts.push(Buffer.from('}'));
  return Buffer.concat(parts);
}

const json = [['Content-Type', 'application/json']] as [string, string][];

async function leftovers(userid: number) {
  const { rows } = await admin.query<{ orders: number; keys: number }>(
    `SELECT (SELECT count(*)::int FROM app.orders WHERE userid = $1) AS orders,
            (SELECT count(*)::int FROM app.idempotency_keys WHERE userid = $1) AS keys`, [userid]);
  return rows[0];
}

describe(`ninguna entrada del cliente produce un 500 (${RUNS} por campo, seed ${SEED}, issue #40)`, () => {
  // La query de GET /instruments y, como control, un parámetro de ruta (Express lo decodifica
  // aparte: `/portfolio/%FF` respondía 500).
  it.each([
    ['q', (v: string) => `/instruments?q=${v}`, 'pamp'],
    ['include_cash', (v: string) => `/instruments?q=pa&include_cash=${v}`, 'true'],
    ['limit', (v: string) => `/instruments?q=pa&limit=${v}`, '5'],
    ['userid de la ruta', (v: string) => `/portfolio/${v}`, '1'],
  ])('GET: %s', async (field, url, valid) => {
    const g = generator(SEED + field.length);
    const seen = new Set<number>();
    for (let i = 0; i < RUNS; i++) {
      const pieces = g.value(valid);
      const path = url(urlEncode(pieces));
      const r = await send('GET', path);
      seen.add(r.status);
      expect(r.status, `${path} → ${r.body}`).toBeGreaterThanOrEqual(200);
      expect(r.status, `${path} → ${r.body}`).toBeLessThan(500);
      // Un control que no es un espacio de los extremos llega a q siempre: 400.
      if (field === 'q' && pieces.some((p) => isControl(p) && (p as string).trim() !== '')) expect(r.status, path).toBe(400);
    }
    // La mezcla tiene que rechazar algo: si todo pasara, el generador no estaría probando nada.
    expect(seen.has(400)).toBe(true);
  });

  it('GET /orders/:id: userid', async () => {
    const u = await newUser('inputs');
    const created = await send('POST', '/orders', [...json, ['Idempotency-Key', 'inputs-get']],
      Buffer.from(JSON.stringify({ userid: u, side: 'CASH_IN', amount: '10' })));
    expect(created.status).toBe(201);
    const id = JSON.parse(created.body).id as string;
    const g = generator(SEED + 100);
    const seen = new Set<number>();
    for (let i = 0; i < RUNS; i++) {
      const path = `/orders/${id}?userid=${urlEncode(g.value(String(u)))}`;
      const r = await send('GET', path);
      seen.add(r.status);
      expect(r.status, `${path} → ${r.body}`).toBeGreaterThanOrEqual(200);
      expect(r.status, `${path} → ${r.body}`).toBeLessThan(500);
    }
    expect(seen.has(400)).toBe(true);
  });

  // POST /orders: la cabecera y los strings del body. Un usuario por request: si se rechaza, no
  // quedó ninguna orden ni ninguna clave suya.
  type Case = { field: string; valid: string; base: (u: number) => Record<string, unknown> };
  const cash = (u: number) => ({ userid: u, side: 'CASH_IN', amount: '10' });
  it.each<Case>([
    { field: 'Idempotency-Key', valid: 'clave-1', base: cash },
    { field: 'side', valid: 'CASH_IN', base: cash },
    { field: 'type', valid: 'MARKET', base: (u) => ({ ...cash(u), type: 'MARKET' }) },
    { field: 'amount', valid: '10', base: cash },
    { field: 'price', valid: '10.50', base: (u) => ({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: quote.instrumentid, size: 1, price: '10.50' }) },
  ])('POST /orders: $field', async ({ field, valid, base }) => {
    const g = generator(SEED + 200 + field.length);
    let rejected = 0;
    for (let i = 0; i < RUNS; i++) {
      const u = await newUser('inputs');
      const pieces = g.value(valid);
      const isKey = field === 'Idempotency-Key';
      const key = isKey ? headerBytes(pieces) : `inputs-${i}`;
      const body = isKey ? Buffer.from(JSON.stringify(base(u))) : bodyWith(base(u), field, jsonString(pieces));
      const r = await send('POST', '/orders', [...json, ['Idempotency-Key', key]], body);
      const ctx = `${field} = ${(isKey ? key : body).toString('latin1')} → ${r.status} ${r.body}`;
      expect(r.status, ctx).toBeGreaterThanOrEqual(200);
      expect(r.status, ctx).toBeLessThan(500);
      if (r.status >= 400) {
        rejected++;
        expect(await leftovers(u), ctx).toEqual({ orders: 0, keys: 0 });
      }
      // La clave como la lee Node: latin1, sin los espacios y tabs de los extremos. Con un control
      // (un byte de 0x80 a 0x9F también lo es, leído como latin1), 400.
      const sent = Buffer.isBuffer(key) ? key.toString('latin1').replace(/^[ \t]+|[ \t]+$/g, '') : key;
      if (isKey && /\p{Cc}/u.test(sent)) expect(r.status, ctx).toBe(400);
    }
    // La mezcla tiene que rechazar algo: si todo pasara, el generador no estaría probando nada.
    expect(rejected).toBeGreaterThan(0);
  });

  it('POST /orders con un charset o un Content-Encoding que body-parser no soporta → 415, no 500', async () => {
    const body = Buffer.from(JSON.stringify({ userid: 1, side: 'CASH_IN', amount: '10' }));
    const charset = await send('POST', '/orders', [['Content-Type', 'application/json; charset=latin1'], ['Idempotency-Key', 'k']], body);
    expect({ status: charset.status, body: JSON.parse(charset.body) })
      .toEqual({ status: 415, body: { error: 'BAD_REQUEST', message: 'charset no soportado: enviar el body en utf-8' } });
    const encoding = await send('POST', '/orders', [...json, ['Content-Encoding', 'br2'], ['Idempotency-Key', 'k']], body);
    expect({ status: encoding.status, body: JSON.parse(encoding.body) })
      .toEqual({ status: 415, body: { error: 'BAD_REQUEST', message: 'Content-Encoding no soportado' } });
  });
});

// El middleware decide el mensaje del 500 por la ruta que atendió el request (req.route): se
// verifica con Express de verdad, no con un fixture.
describe('el 500 menciona Idempotency-Key solo en POST /orders (issue #40)', () => {
  async function failing(method: string, path: string, body?: unknown) {
    const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('falla simulada'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await send(method, path, body ? [...json, ['Idempotency-Key', 'k-500']] : [], body ? Buffer.from(JSON.stringify(body)) : undefined);
      return { status: r.status, body: JSON.parse(r.body) };
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  }
  const generic = { error: 'INTERNAL', message: 'error interno; reintentar' };

  it('POST /orders → resultado desconocido, reintentar con la misma clave', async () => {
    expect(await failing('POST', '/orders', { userid: 1, side: 'CASH_IN', amount: '10' })).toEqual({
      status: 500, body: { error: 'INTERNAL', message: 'error interno; el resultado es desconocido: reintentar con la misma Idempotency-Key' },
    });
  });

  it.each([
    ['GET', '/instruments?q=pamp', undefined],
    ['GET', '/orders/1?userid=1', undefined],
    ['POST', '/orders/1/cancel', { userid: 1 }],
  ])('%s %s → sin Idempotency-Key', async (method, path, body) => {
    expect(await failing(method, path, body)).toEqual({ status: 500, body: generic });
  });
});

// La red de seguridad de src/http/errors.ts reconoce la clase 22 de un parámetro por el contexto
// que pone Postgres. Acá se verifica ese contexto contra Postgres 18 real, no contra un fixture.
describe('red de seguridad: la clase 22 al convertir un parámetro → 400; dentro de la sentencia, 500 (D-30)', () => {
  async function failure(sql: string, params: unknown[]) {
    try {
      await pool.query(sql, params);
    } catch (err) {
      const e = fromDbError(err, false);
      return { sqlstate: (err as { code: string }).code, status: e.status };
    }
    throw new Error(`${sql} no falló`);
  }

  it.each([
    ['U+0000 en text', 'SELECT $1::text', ['pa\u0000mp'], '22021', 400],
    ['U+0000 en un argumento de place_order', 'SELECT app.place_order($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [1, 'k\u0000', 'h', 'CASH_IN', 'MARKET', null, null, '1.00', null, null], '22021', 400],
    ['sintaxis de integer', 'SELECT $1::int', ['abc'], '22P02', 400],
    ['rango de integer', 'SELECT $1::int', ['3000000000'], '22003', 400],
    ['overflow en una cuenta', 'SELECT 2147483647 + $1::int', ['1'], '22003', 500],
    ['división por cero', 'SELECT $1::int / 0', ['1'], '22012', 500],
    ['U+0000 en un jsonb armado en la sentencia', `SELECT ('{"a":"\\u0000"}'::jsonb ->> 'a') = $1`, ['x'], '22P05', 500],
  ])('%s → %s', async (_name, sql, params, sqlstate, status) => {
    expect(await failure(sql as string, params as unknown[])).toEqual({ sqlstate, status });
  });
});
