#!/usr/bin/env node
// @ts-check
// El smoke funcional de punta a punta (D-29, issue #51): el flujo crítico de la API, por HTTP,
// contra una URL base, tal como se despliega. Sin dependencias (Node 22, fetch): corre en el
// runner del deploy y, en el CI, dentro de la imagen recién construida.
//
//   URL=<base> SHA=<release> deploy/smoke.mjs read
//       Solo lecturas (producción): GET /health atiende SHA con ok: true; GET /instruments?q=PAMP
//       trae PAMP primero; un GET inválido (q vacío, userid que no es un número) responde 400.
//
//   URL=<base> SHA=<release> SMOKE_USERID=<id> deploy/smoke.mjs write
//       Lo de read y el flujo de órdenes con un usuario dedicado, que tiene que empezar en cero
//       (sin cash, posiciones ni reservas; staging: deploy/lightsail/smoke-user.sql) y termina en
//       cero, así que se puede repetir con el mismo usuario release tras release:
//         1. CASH_IN y su replay por idempotencia (la misma respuesta, Idempotent-Replay: true).
//         2. BUY MARKET por size (3) y por amount (2), SELL MARKET por size (1) y por amount (1),
//            todas al último close (p), que no se fija acá: lo devuelve la primera compra.
//         3. BUY LIMIT por debajo del close, que queda NEW y reserva.
//         4. GET /portfolio exacto: cash neto, reservado y disponible, la posición (3 acciones,
//            costo 3p, valor 3p) y el valor total.
//         5. GET /orders/:id NEW, cancelación (CANCELLED, USER), SELL MARKET del resto, CASH_OUT
//            del depósito y el portfolio otra vez en cero.
//         6. Errores de contrato: un body inválido y un JSON roto responden 400, nunca 500.
//
// Cada request usa claves de idempotencia nuevas (la corrida tiene su propio id). Termina con 0
// si todo pasó, con 1 en el primer paso que falla (SMOKE FALLIDO: <paso>: <qué>) y con 2 si falta
// algo para correr.

const BASE = (process.env.URL ?? '').replace(/\/+$/, '');
const SHA = process.env.SHA ?? '';
const MODE = process.argv[2] ?? '';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const DEPOSIT = 10_000_000n;   // 100000.00 ARS, en centavos

/** @param {string} msg */
function usage(msg) {
  console.error(`SMOKE: ${msg}\nuso: URL=<base> SHA=<release> [SMOKE_USERID=<id>] ${process.argv[1]} read|write`);
  process.exit(2);
}
if (MODE !== 'read' && MODE !== 'write') usage(`modo desconocido: '${MODE}'`);
if (!/^https?:\/\/[^/]+/.test(BASE)) usage('falta URL (la base de la API, http(s)://...)');
if (!SHA) usage('falta SHA (el release que tiene que atender /health)');
const USERID = MODE === 'write' ? Number(process.env.SMOKE_USERID ?? '') : 0;
if (MODE === 'write' && !(Number.isInteger(USERID) && USERID > 0)) usage(`SMOKE_USERID tiene que ser el id del usuario del smoke: '${process.env.SMOKE_USERID ?? ''}'`);
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

class SmokeError extends Error {}
let step = 'inicio';
/** @param {string} what @returns {never} */
const fail = (what) => { throw new SmokeError(what); };
/** @param {unknown} v */
const show = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 600 ? `${s.slice(0, 600)}…` : s; };

/**
 * @typedef {{ status: number, headers: Headers, text: string, json: any }} Reply
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, raw?: string, key?: string }} [opts]
 * @returns {Promise<Reply>}
 */
async function http(method, path, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  let body;
  if (opts.raw !== undefined || opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = opts.raw ?? JSON.stringify(opts.body);
  }
  if (opts.key) headers['idempotency-key'] = opts.key;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    fail(`${method} ${path}: sin respuesta (${/** @type {Error} */ (e).cause ?? /** @type {Error} */ (e).message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* se informa abajo si hacía falta */ }
  return { status: res.status, headers: res.headers, text, json };
}

/** @param {Reply} r @param {number} status @param {string} what */
function expectStatus(r, status, what) {
  if (r.status !== status) fail(`${what}: se esperaba ${status} y respondió ${r.status}: ${show(r.text)}`);
  if (r.json === null || typeof r.json !== 'object') fail(`${what}: la respuesta no es un objeto JSON: ${show(r.text)}`);
  return r.json;
}
/** El valor con las claves de cada objeto ordenadas y sin las undefined: compara sin mirar el orden. @param {unknown} v @returns {unknown} */
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
    : v);
/** @param {unknown} actual @param {unknown} expected @param {string} what */
function expectEqual(actual, expected, what) {
  if (JSON.stringify(canon(actual)) !== JSON.stringify(canon(expected))) fail(`${what}: se esperaba ${show(expected)} y vino ${show(actual)}`);
}

// Montos: centavos en BigInt, como strings de escala fija (D-13).
/** @param {unknown} s @param {string} what */
function cents(s, what) {
  if (typeof s !== 'string' || !/^\d+\.\d{2}$/.test(s)) fail(`${what}: '${show(s)}' no es un monto con 2 decimales`);
  return BigInt(s.replace('.', ''));
}
/** @param {bigint} c @param {number} [scale] centavos → string con `scale` decimales (2, 4 o 6) */
function money(c, scale = 2) {
  const neg = c < 0n;
  const v = (neg ? -c : c) * 10n ** BigInt(scale - 2);
  const s = v.toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** @param {string} name @param {() => Promise<void>} fn */
async function check(name, fn) {
  step = name;
  await fn();
  console.log(`== smoke: ${name}`);
}

// ---------------------------------------------------------------------------------------------
let instrumentid = 0;

async function reads() {
  await check('GET /health atiende el release', async () => {
    const h = expectStatus(await http('GET', '/health'), 200, 'GET /health');
    expectEqual({ ok: h.ok, release: h.release }, { ok: true, release: SHA }, 'GET /health');
  });
  await check('GET /instruments?q=PAMP encuentra Pampa primero', async () => {
    const r = expectStatus(await http('GET', '/instruments?q=PAMP'), 200, 'GET /instruments?q=PAMP');
    const first = Array.isArray(r.results) ? r.results[0] : undefined;
    expectEqual(first && { ticker: first.ticker, name: first.name, type: first.type },
      { ticker: 'PAMP', name: 'Pampa Holding S.A.', type: 'ACCIONES' }, 'el primer resultado');
    if (!Number.isInteger(first.id) || first.id <= 0) fail(`el id de PAMP no es un entero > 0: ${show(first)}`);
    instrumentid = first.id;
  });
  await check('un GET inválido responde 400, no 500', async () => {
    for (const path of ['/instruments?q=', '/portfolio/abc']) {
      const e = expectStatus(await http('GET', path), 400, `GET ${path}`);
      expectEqual(e.error, 'BAD_REQUEST', `GET ${path}`);
    }
  });
}

/**
 * POST /orders con una clave nueva de la corrida; exige 201 y el estado. Devuelve la orden.
 * @param {string} tag @param {Record<string, unknown>} order @param {string} status
 */
async function order(tag, order, status) {
  const key = `smoke-${RUN}-${tag}`;
  const body = { userid: USERID, ...order };
  const r = await http('POST', '/orders', { body, key });
  const o = expectStatus(r, 201, `POST /orders ${tag}`);
  expectEqual(o.status, status, `${tag}: status`);
  expectEqual(r.headers.get('idempotent-replay'), 'false', `${tag}: Idempotent-Replay`);
  return { o, key, body, r };
}

/** @param {{ neto: bigint, reservado: bigint }} cash @param {unknown[]} positions @param {bigint} valor @param {string} what */
async function portfolio(cash, positions, valor, what) {
  const p = expectStatus(await http('GET', `/portfolio/${USERID}`), 200, `GET /portfolio/${USERID}`);
  expectEqual(p.cash, { neto: money(cash.neto), reservado: money(cash.reservado), disponible: money(cash.neto - cash.reservado) }, `${what}: cash`);
  expectEqual(p.valor_total, money(cash.neto + valor), `${what}: valor_total`);
  expectEqual({ valuation_complete: p.valuation_complete, has_inconsistent_history: p.has_inconsistent_history },
    { valuation_complete: true, has_inconsistent_history: false }, `${what}: flags`);
  const got = Array.isArray(p.positions) ? p.positions.map((/** @type {any} */ x) => ({ ...x, price_date: undefined, retorno_diario_pct: undefined })) : p.positions;
  expectEqual(got, positions, `${what}: positions`);
}

async function writes() {
  await check('el usuario del smoke empieza en cero', async () => {
    const p = expectStatus(await http('GET', `/portfolio/${USERID}`), 200, `GET /portfolio/${USERID}`);
    if (p.cash?.neto !== '0.00' || p.cash?.reservado !== '0.00' || !Array.isArray(p.positions) || p.positions.length !== 0) {
      fail(`el usuario ${USERID} no está en cero (una corrida anterior quedó a la mitad; en staging lo resuelve deploy.sh smoke-user): ${show(p)}`);
    }
  });

  await check('CASH_IN y su replay', async () => {
    const { o, key, body } = await order('cash-in', { side: 'CASH_IN', amount: money(DEPOSIT) }, 'FILLED');
    expectEqual({ side: o.side, amount: o.amount }, { side: 'CASH_IN', amount: money(DEPOSIT) }, 'CASH_IN');
    const again = await http('POST', '/orders', { body, key });
    expectEqual(expectStatus(again, 201, 'replay del CASH_IN'), o, 'replay del CASH_IN: la misma respuesta');
    expectEqual(again.headers.get('idempotent-replay'), 'true', 'replay del CASH_IN: Idempotent-Replay');
  });

  /** @type {bigint} */
  let p = 0n;
  /** @param {any} o @param {string} side @param {bigint} size @param {string} what */
  const filled = (o, side, size, what) => {
    expectEqual({ side: o.side, type: o.type, instrumentid: o.instrumentid, size: o.size },
      { side, type: 'MARKET', instrumentid: String(instrumentid), size: String(size) }, what);
    if (cents(o.price, `${what}: price`) !== p) fail(`${what}: el close cambió durante el smoke (${money(p)} → ${o.price})`);
    expectEqual(o.amount, money(size * p), `${what}: amount`);
  };
  await check('BUY MARKET por size', async () => {
    const { o } = await order('buy-size', { side: 'BUY', type: 'MARKET', instrumentid, size: 3 }, 'FILLED');
    p = cents(o.price, 'BUY por size: price');
    if (p <= 1n) fail(`BUY por size: un close de ${o.price} no deja probar la orden por monto`);
    filled(o, 'BUY', 3n, 'BUY por size');
  });
  // Un monto de 2,5 acciones compra (o vende) 2: el máximo entero que alcanza (D-11).
  await check('BUY MARKET por amount', async () => {
    const { o } = await order('buy-amount', { side: 'BUY', type: 'MARKET', instrumentid, amount: money(2n * p + p / 2n) }, 'FILLED');
    filled(o, 'BUY', 2n, 'BUY por amount');
  });
  await check('SELL MARKET por size', async () => {
    const { o } = await order('sell-size', { side: 'SELL', type: 'MARKET', instrumentid, size: 1 }, 'FILLED');
    filled(o, 'SELL', 1n, 'SELL por size');
  });
  await check('SELL MARKET por amount', async () => {
    const { o } = await order('sell-amount', { side: 'SELL', type: 'MARKET', instrumentid, amount: money(p + p / 2n) }, 'FILLED');
    filled(o, 'SELL', 1n, 'SELL por amount');
  });

  // Por debajo del close: el executor no la ejecutaría aunque corriera (D-28).
  const limit = p / 2n;
  /** @type {string} */
  let limitId = '';
  await check('BUY LIMIT queda NEW y reserva', async () => {
    const { o } = await order('buy-limit', { side: 'BUY', type: 'LIMIT', instrumentid, size: 2, price: money(limit) }, 'NEW');
    expectEqual({ size: o.size, price: o.price, amount: o.amount }, { size: '2', price: money(limit), amount: money(2n * limit) }, 'BUY LIMIT');
    limitId = o.id;
  });

  // 3 acciones: compró 5 y vendió 2, todas a p. El costo promedio es p (D-09).
  const position = {
    instrumentid, ticker: 'PAMP', name: 'Pampa Holding S.A.',
    qty: '3', acciones_reservadas: '0', acciones_disponibles: '3',
    costo_total: money(3n * p, 6), costo_unitario: money(p, 4),
    price: money(p), price_date: undefined,
    valor: money(3n * p), resultado: '0.00', rendimiento_pct: '0.00', retorno_diario_pct: undefined,
    inconsistent: false,
  };
  await check('GET /portfolio exacto, con la reserva', async () => {
    await portfolio({ neto: DEPOSIT - 3n * p, reservado: 2n * limit }, [position], 3n * p, 'portfolio con la LIMIT');
  });

  await check('GET /orders/:id y cancelación de la LIMIT', async () => {
    const got = expectStatus(await http('GET', `/orders/${limitId}?userid=${USERID}`), 200, `GET /orders/${limitId}`);
    expectEqual({ id: got.id, status: got.status }, { id: limitId, status: 'NEW' }, 'la LIMIT');
    const c = expectStatus(await http('POST', `/orders/${limitId}/cancel`, { body: { userid: USERID } }), 200, 'cancelación');
    expectEqual({ id: c.id, status: c.status, cancel_reason: c.cancel_reason }, { id: limitId, status: 'CANCELLED', cancel_reason: 'USER' }, 'cancelación');
  });

  await check('SELL MARKET del resto y CASH_OUT', async () => {
    const { o } = await order('sell-rest', { side: 'SELL', type: 'MARKET', instrumentid, size: 3 }, 'FILLED');
    filled(o, 'SELL', 3n, 'SELL del resto');
    const out = (await order('cash-out', { side: 'CASH_OUT', amount: money(DEPOSIT) }, 'FILLED')).o;
    expectEqual({ side: out.side, amount: out.amount }, { side: 'CASH_OUT', amount: money(DEPOSIT) }, 'CASH_OUT');
  });

  await check('GET /portfolio vuelve a cero', async () => {
    await portfolio({ neto: 0n, reservado: 0n }, [], 0n, 'portfolio final');
  });

  await check('un body inválido responde 400, no 500', async () => {
    const cases = [
      { tag: 'side', opts: { body: { userid: USERID, side: 'HOLD', amount: '1.00' } } },
      { tag: 'json', opts: { raw: '{"userid":' } },
    ];
    for (const { tag, opts } of cases) {
      const e = expectStatus(await http('POST', '/orders', { ...opts, key: `smoke-${RUN}-bad-${tag}` }), 400, `POST /orders inválido (${tag})`);
      expectEqual(e.error, 'BAD_REQUEST', `POST /orders inválido (${tag})`);
    }
  });
}

try {
  await reads();
  if (MODE === 'write') await writes();
  console.log(`== SMOKE OK (${MODE}) contra ${BASE}: atiende ${SHA}`);
} catch (e) {
  if (!(e instanceof SmokeError)) throw e;
  console.error(`SMOKE FALLIDO: ${step}: ${e.message}`);
  process.exit(1);
}
