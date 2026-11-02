// v1 del lab (issue #72): la variante Z del benchmark (docs/decision-snapshot.md), la línea base.
// Es la implementación directa sobre el esquema de database.sql tal cual, "como lo haría alguien
// resolviendo rápido", con los mismos endpoints de lectura y el mismo JSON que la API (v2), para
// que una misma URL con otro prefijo compare las variantes:
//   - GET /portfolio: SUM … GROUP BY sobre orders en cada request, y una consulta de la última
//     cotización por posición. database.sql no tiene índices sobre orders ni marketdata (solo
//     claves primarias): cada consulta recorre la tabla entera.
//   - Costo = Σ importes de compra / Σ acciones compradas × cantidad: el "promedio de todos los
//     BUY", no el fold de D-09, que necesita el orden de ejecución que database.sql no guarda. Por
//     eso costo, resultado y rendimiento de Z no coinciden con v2 y v3 cuando hubo ventas; cash,
//     cantidades, reservas, valor y total sí (decisión en #72, lab/README.md).
//   - Las sumas, en numeric de Postgres; las divisiones (costo, costo unitario, rendimientos), con
//     cociente y resto enteros (BigInt), porque la división de numeric elige una escala que con
//     importes grandes deja menos decimales que los de la respuesta. La respuesta sale como
//     strings exactos, como en v2 (D-13), con los empates redondeados hacia afuera.
//   - Sin escrituras: el lab es de solo lectura y todo lo que no es GET ni HEAD responde 403.
// Base: src/naive/app.ts del benchmark, que usaba Number. NO es correcta: es la vara.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import express from 'express';
import pg from 'pg';

// date y timestamp sin zona como string, como v2 (src/db/pool.ts). numeric e int8 llegan como string.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1114, (v: string) => v);

const isId = (s: unknown): s is string => typeof s === 'string' && /^\d{1,10}$/.test(s) && Number(s) > 0 && Number(s) <= 2_147_483_647;

/** "123.45" o "-0.50" → centavos. Los importes de Postgres ya vienen con 2 decimales. */
const cents = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i + f.padEnd(2, '0'));
  return neg ? -v : v;
};
const fromCents = (c: bigint): string => {
  const neg = c < 0n;
  const s = (neg ? -c : c).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
};

/** n / d redondeado a entero, con los empates hacia afuera. d > 0. */
const divRound = (n: bigint, d: bigint): bigint => {
  const q = ((n < 0n ? -n : n) * 2n + d) / (2n * d);
  return n < 0n ? -q : q;
};
/** Un entero en unidades de 10^-scale, como decimal. */
const fixed = (v: bigint, scale: number): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
};

type Handler = (req: express.Request, res: express.Response) => Promise<void>;
const route = (h: Handler): express.RequestHandler => (req, res) => {
  h(req, res).catch((err) => { res.status(500).json({ error: 'INTERNAL', message: (err as Error).message }); });
};

export function createZApp(pool: pg.Pool) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.status(403).json({ error: 'FORBIDDEN', message: 'el lab es de solo lectura' });
  });

  app.get('/health', route(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', variant: 'Z' });
  }));

  app.get('/portfolio/:userid', route(async (req, res) => {
    if (!isId(req.params.userid)) { res.status(400).json({ error: 'BAD_REQUEST', message: 'userid inválido' }); return; }
    const userid = Number(req.params.userid);
    const u = await pool.query('SELECT 1 FROM users WHERE id = $1', [userid]);
    if (u.rowCount === 0) { res.status(404).json({ error: 'NOT_FOUND', message: `usuario ${userid} inexistente` }); return; }
    const cash = (await pool.query<{ neto: string; reservado: string; disponible: string }>(`
      SELECT round(neto, 2)::text AS neto, round(reservado, 2)::text AS reservado, round(neto - reservado, 2)::text AS disponible
        FROM (SELECT COALESCE(SUM(CASE WHEN status = 'FILLED' THEN
                       CASE side WHEN 'CASH_IN' THEN size*price WHEN 'SELL' THEN size*price ELSE -size*price END END), 0) AS neto,
                     COALESCE(SUM(CASE WHEN status = 'NEW' AND side = 'BUY' THEN size*price END), 0) AS reservado
                FROM orders WHERE userid = $1) t`, [userid])).rows[0];
    // Por instrumento: cantidad, reservas y lo comprado (acciones e importe en centavos), todo entero.
    const pos = (await pool.query<{ instrumentid: number; ticker: string; name: string; qty: string; reserved: string; bought_qty: string; bought_cents: string }>(`
      SELECT instrumentid, ticker, name, qty::text, reserved::text, bought_qty::text, trunc(bought_amt * 100)::text AS bought_cents
        FROM (SELECT o.instrumentid, i.ticker, i.name,
                     SUM(CASE WHEN o.status = 'FILLED' THEN CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -o.size ELSE 0 END ELSE 0 END) AS qty,
                     SUM(CASE WHEN o.status = 'FILLED' AND o.side = 'BUY' THEN o.size ELSE 0 END)        AS bought_qty,
                     SUM(CASE WHEN o.status = 'FILLED' AND o.side = 'BUY' THEN o.size*o.price ELSE 0 END) AS bought_amt,
                     SUM(CASE WHEN o.status = 'NEW' AND o.side = 'SELL' THEN o.size ELSE 0 END)           AS reserved
                FROM orders o JOIN instruments i ON i.id = o.instrumentid
               WHERE o.userid = $1 AND o.side IN ('BUY','SELL')
               GROUP BY o.instrumentid, i.ticker, i.name) p
       WHERE qty <> 0
       ORDER BY instrumentid`, [userid])).rows;
    let total = cents(cash.neto);
    let complete = true;
    const positions = [];
    for (const p of pos) {
      const qty = BigInt(p.qty);
      const boughtQty = BigInt(p.bought_qty);
      const boughtCents = BigInt(p.bought_cents);
      // costo = Σ compras / Σ acciones compradas × qty, en micro-ARS: centavos × 10^4 × qty / acciones
      const costMicro = boughtQty > 0n ? divRound(boughtCents * 10_000n * qty, boughtQty) : 0n;
      // La última cotización: una consulta por posición, sobre marketdata sin índices.
      const px = (await pool.query<{ close: string; previousclose: string | null; date: string }>(
        'SELECT close::text, previousclose::text, date FROM marketdata WHERE instrumentid = $1 ORDER BY date DESC LIMIT 1', [p.instrumentid])).rows[0];
      let valor: string | null = null;
      let resultado: string | null = null;
      let rendimiento: string | null = null;
      let diario: string | null = null;
      if (px) {
        const valorCents = qty * cents(px.close);
        total += valorCents;
        valor = fromCents(valorCents);
        if (costMicro > 0n) {
          const diffMicro = valorCents * 10_000n - costMicro;
          resultado = fixed(divRound(diffMicro, 10_000n), 2);
          rendimiento = fixed(divRound(diffMicro * 10_000n, costMicro), 2);
        }
        const prev = px.previousclose === null ? 0n : cents(px.previousclose);
        if (prev > 0n) diario = fixed(divRound((cents(px.close) - prev) * 10_000n, prev), 2);
      } else {
        complete = false;
      }
      positions.push({
        instrumentid: p.instrumentid, ticker: p.ticker, name: p.name,
        qty: p.qty, acciones_reservadas: p.reserved, acciones_disponibles: (qty - BigInt(p.reserved)).toString(),
        costo_total: fixed(costMicro, 6),
        costo_unitario: qty > 0n && boughtQty > 0n ? fixed(divRound(boughtCents * 100n, boughtQty), 4) : null,
        price: px?.close ?? null, price_date: px?.date ?? null, valor,
        resultado, rendimiento_pct: rendimiento, retorno_diario_pct: diario,
        inconsistent: qty < 0n,
      });
    }
    res.json({
      userid,
      valor_total: fromCents(total),
      cash,
      valuation_complete: complete,
      has_inconsistent_history: positions.some((p) => p.inconsistent),
      positions,
    });
  }));

  // GET /orders/:id?userid= — una orden ajena responde igual que una inexistente, como en v2.
  app.get('/orders/:id', route(async (req, res) => {
    const userid = req.query.userid;
    if (!isId(req.params.id) || !isId(userid)) { res.status(400).json({ error: 'BAD_REQUEST', message: 'id y userid enteros > 0' }); return; }
    const r = await pool.query<{ id: number; userid: number; instrumentid: number; side: string; type: string; size: number; price: string; amount: string; status: string; datetime: string }>(
      `SELECT id, userid, instrumentid, side, type, size, price::text, round(size * price, 2)::text AS amount, status, datetime
         FROM orders WHERE id = $1 AND userid = $2`,
      [Number(req.params.id), Number(userid)]);
    const o = r.rows[0];
    if (!o) { res.status(404).json({ error: 'NOT_FOUND', message: `orden ${req.params.id} inexistente para el usuario ${userid}` }); return; }
    res.json({
      id: String(o.id), userid: String(o.userid), instrumentid: String(o.instrumentid), side: o.side, type: o.type,
      size: String(o.size), price: o.price, amount: o.amount, status: o.status,
      balance_seq: null, datetime: `${o.datetime.slice(0, 10)}T${o.datetime.slice(11, 19)}Z`, cancel_reason: null,
    });
  }));

  // GET /instruments?q= — ILIKE sobre ticker y nombre, sin acentos ni trigramas (v2 los tiene, D-25).
  // Las mismas entradas inválidas que v2 dan 400 (también un carácter de control, que Postgres no
  // acepta en text: D-30), y q se busca como texto: %, _ y \ no son comodines.
  app.get('/instruments', route(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const cash = req.query.include_cash ?? 'false';
    if (!q || q.length > 50 || /\p{Cc}/u.test(q) || !Number.isInteger(limit) || limit < 1 || limit > 50 || (cash !== 'true' && cash !== 'false')) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'q (1 a 50 caracteres, sin caracteres de control), limit (1 a 50) e include_cash (true o false)' });
      return;
    }
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const r = await pool.query(
      `SELECT id, ticker, name, type FROM instruments
        WHERE (ticker ILIKE $1 OR name ILIKE $1) AND ($2 OR type <> 'MONEDA')
        ORDER BY ticker LIMIT $3`, [pattern, cash === 'true', limit]);
    res.json({ query: q, results: r.rows });
  }));

  app.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND', message: 'ruta inexistente' }); });
  return app;
}

// Ejecución directa (el contenedor api-z); los tests importan createZApp.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/cocos',
    max: Number(process.env.PG_POOL_MAX ?? 4),
    application_name: 'lab-z',
  });
  pool.on('error', () => undefined);
  const port = Number(process.env.PORT ?? 3000);
  createZApp(pool).listen(port, () => {
    console.log(JSON.stringify({ level: 'info', msg: `lab-z escuchando en :${port}` }));
  });
}
