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
//   - Las cuentas, en numeric de Postgres: la respuesta sale como strings exactos, como en v2
//     (D-13). round() de Postgres redondea los empates hacia afuera.
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
    const pos = (await pool.query<{ instrumentid: number; ticker: string; name: string; qty: string; reserved: string; costo_total: string; costo_unitario: string | null }>(`
      SELECT instrumentid, ticker, name, qty::text, reserved::text,
             round(CASE WHEN bought_qty > 0 THEN bought_amt * qty / bought_qty ELSE 0 END, 6)::text AS costo_total,
             CASE WHEN qty > 0 AND bought_qty > 0 THEN round(bought_amt / bought_qty, 4)::text END AS costo_unitario
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
      // La última cotización, con valor, resultado y rendimientos calculados sobre ella.
      const px = (await pool.query<{ price: string; price_date: string; valor: string; resultado: string | null; rendimiento_pct: string | null; retorno_diario_pct: string | null }>(`
        SELECT m.close::text AS price, m.date AS price_date,
               round($2::numeric * m.close, 2)::text AS valor,
               CASE WHEN $3::numeric > 0 THEN round($2::numeric * m.close - $3::numeric, 2)::text END AS resultado,
               CASE WHEN $3::numeric > 0 THEN round(($2::numeric * m.close - $3::numeric) / $3::numeric * 100, 2)::text END AS rendimiento_pct,
               CASE WHEN m.previousclose > 0 THEN round((m.close - m.previousclose) / m.previousclose * 100, 2)::text END AS retorno_diario_pct
          FROM (SELECT close, previousclose, date FROM marketdata WHERE instrumentid = $1 ORDER BY date DESC LIMIT 1) m`,
        [p.instrumentid, p.qty, p.costo_total])).rows[0];
      if (px) total += cents(px.valor); else complete = false;
      positions.push({
        instrumentid: p.instrumentid, ticker: p.ticker, name: p.name,
        qty: p.qty, acciones_reservadas: p.reserved, acciones_disponibles: (BigInt(p.qty) - BigInt(p.reserved)).toString(),
        costo_total: p.costo_total, costo_unitario: p.costo_unitario,
        price: px?.price ?? null, price_date: px?.price_date ?? null, valor: px?.valor ?? null,
        resultado: px?.resultado ?? null, rendimiento_pct: px?.rendimiento_pct ?? null, retorno_diario_pct: px?.retorno_diario_pct ?? null,
        inconsistent: BigInt(p.qty) < 0n,
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
