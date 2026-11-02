// v1 del lab (issue #72): la variante Z del benchmark (docs/decision-snapshot.md), la línea base.
// Es la implementación directa sobre el esquema de database.sql tal cual, "como lo haría alguien
// resolviendo rápido", con los mismos endpoints de lectura y el mismo JSON que la API (v2), para
// que una misma URL con otro prefijo compare las variantes:
//   - GET /portfolio: SUM … GROUP BY sobre orders en cada request. database.sql no tiene índices
//     sobre orders ni marketdata (solo claves primarias): cada request recorre las tablas enteras.
//   - Dinero en Number (float). Costo promedio = Σ compras / Σ acciones compradas: el "promedio de
//     todos los BUY", no el fold de D-09. Por eso costo, resultado y rendimiento de Z no coinciden
//     con v2 y v3 cuando hubo ventas; cash, cantidades, reservas y valor sí (lab/README.md).
//   - Sin escrituras: el lab es de solo lectura y todo lo que no es GET responde 403.
// Base: src/naive/app.ts del benchmark. NO es correcta: es la vara.
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/lab',
  max: Number(process.env.PG_POOL_MAX ?? 4),
  application_name: 'lab-z',
});
pool.on('error', () => undefined);
// Z usa Number a propósito: convierte numeric e int8 al llegar.
pg.types.setTypeParser(1700, parseFloat);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1114, (v: string) => v);

const money = (n: number) => n.toFixed(2);
const isId = (s: unknown): s is string => typeof s === 'string' && /^\d{1,10}$/.test(s) && Number(s) > 0 && Number(s) <= 2_147_483_647;

async function latestClose(instrumentid: number) {
  const r = await pool.query<{ close: number; previousclose: number | null; date: string }>(
    'SELECT close, previousclose, date FROM marketdata WHERE instrumentid = $1 ORDER BY date DESC LIMIT 1', [instrumentid]);
  return r.rows[0] ?? null;
}

type Handler = (req: express.Request, res: express.Response) => Promise<void>;
const route = (h: Handler): express.RequestHandler => (req, res) => {
  h(req, res).catch((err) => { res.status(500).json({ error: 'INTERNAL', message: (err as Error).message }); });
};

export function createZApp() {
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
    const cash = (await pool.query<{ neto: number; reservado: number }>(`
      SELECT COALESCE(SUM(CASE WHEN status = 'FILLED' THEN
               CASE side WHEN 'CASH_IN' THEN size*price WHEN 'SELL' THEN size*price ELSE -size*price END END), 0) AS neto,
             COALESCE(SUM(CASE WHEN status = 'NEW' AND side = 'BUY' THEN size*price END), 0) AS reservado
        FROM orders WHERE userid = $1`, [userid])).rows[0];
    const pos = (await pool.query<{ instrumentid: number; ticker: string; name: string; qty: number; bought_qty: number; bought_amt: number; reserved: number }>(`
      SELECT o.instrumentid, i.ticker, i.name,
             SUM(CASE WHEN o.status = 'FILLED' THEN CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -o.size ELSE 0 END ELSE 0 END) AS qty,
             SUM(CASE WHEN o.status = 'FILLED' AND o.side = 'BUY' THEN o.size ELSE 0 END)        AS bought_qty,
             SUM(CASE WHEN o.status = 'FILLED' AND o.side = 'BUY' THEN o.size*o.price ELSE 0 END) AS bought_amt,
             SUM(CASE WHEN o.status = 'NEW' AND o.side = 'SELL' THEN o.size ELSE 0 END)           AS reserved
        FROM orders o JOIN instruments i ON i.id = o.instrumentid
       WHERE o.userid = $1 AND o.side IN ('BUY','SELL')
       GROUP BY o.instrumentid, i.ticker, i.name
      HAVING SUM(CASE WHEN o.status = 'FILLED' THEN CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -o.size ELSE 0 END ELSE 0 END) <> 0
       ORDER BY o.instrumentid`, [userid])).rows;
    let total = cash.neto;
    let complete = true;
    const positions = [];
    for (const p of pos) {
      const px = await latestClose(p.instrumentid);
      const avg = p.bought_qty > 0 ? p.bought_amt / p.bought_qty : 0;
      const cost = avg * p.qty;
      const valor = px ? p.qty * px.close : null;
      if (valor === null) complete = false; else total += valor;
      positions.push({
        instrumentid: p.instrumentid, ticker: p.ticker, name: p.name,
        qty: String(p.qty), acciones_reservadas: String(p.reserved), acciones_disponibles: String(p.qty - p.reserved),
        costo_total: cost.toFixed(6), costo_unitario: p.qty > 0 ? avg.toFixed(4) : null,
        price: px ? money(px.close) : null, price_date: px?.date ?? null,
        valor: valor === null ? null : money(valor),
        resultado: valor !== null && cost > 0 ? money(valor - cost) : null,
        rendimiento_pct: valor !== null && cost > 0 ? ((valor - cost) / cost * 100).toFixed(2) : null,
        retorno_diario_pct: px && px.previousclose ? ((px.close - px.previousclose) / px.previousclose * 100).toFixed(2) : null,
        inconsistent: p.qty < 0,
      });
    }
    res.json({
      userid,
      valor_total: money(total),
      cash: { neto: money(cash.neto), reservado: money(cash.reservado), disponible: money(cash.neto - cash.reservado) },
      valuation_complete: complete,
      has_inconsistent_history: positions.some((p) => p.inconsistent),
      positions,
    });
  }));

  // GET /orders/:id?userid= — una orden ajena responde igual que una inexistente, como en v2.
  app.get('/orders/:id', route(async (req, res) => {
    const userid = req.query.userid;
    if (!isId(req.params.id) || !isId(userid)) { res.status(400).json({ error: 'BAD_REQUEST', message: 'id y userid enteros > 0' }); return; }
    const r = await pool.query<{ id: number; userid: number; instrumentid: number; side: string; type: string; size: number; price: number; status: string; datetime: string }>(
      'SELECT id, userid, instrumentid, side, type, size, price, status, datetime FROM orders WHERE id = $1 AND userid = $2',
      [Number(req.params.id), Number(userid)]);
    const o = r.rows[0];
    if (!o) { res.status(404).json({ error: 'NOT_FOUND', message: `orden ${req.params.id} inexistente para el usuario ${userid}` }); return; }
    res.json({
      id: String(o.id), userid: String(o.userid), instrumentid: String(o.instrumentid), side: o.side, type: o.type,
      size: String(o.size), price: money(o.price), amount: money(o.size * o.price), status: o.status,
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

const port = Number(process.env.PORT ?? 3000);
createZApp().listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: `lab-z escuchando en :${port}` }));
});
