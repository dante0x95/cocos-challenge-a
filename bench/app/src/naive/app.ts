// Escenario Z — línea base: la implementación directa sobre el esquema del challenge tal cual.
// Deliberadamente "como lo haría alguien resolviendo rápido":
//   - GET: SUM/GROUP BY sobre orders por userid en cada request (sin índice propio: el que traiga Neon).
//   - POST: leer disponible, decidir en la app, INSERT. Sin lock, sin idempotencia, sin balance_seq.
//   - Dinero en Number (float), costo promedio = Σ compras / Σ acciones compradas (el "promedio de
//     todos los BUY", contraejemplo A.2 §3.1). Ventas al close vigente, LIMIT queda NEW.
// Mismos endpoints y mismo JSON que la API de A para que k6 sea el mismo. NO es correcta: es la vara.
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5434/trading',
  max: Number(process.env.PG_POOL_MAX ?? 20),
  application_name: 'balances-naive',
});
// Z usa Number a propósito: convierte numeric e int8 al llegar.
pg.types.setTypeParser(1700, parseFloat);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v);

const money = (n: number) => n.toFixed(2);

async function latestClose(instrumentid: number) {
  const r = await pool.query<{ close: number; previousclose: number | null; date: string }>(
    'SELECT close, previousclose, date FROM marketdata WHERE instrumentid = $1 ORDER BY date DESC LIMIT 1', [instrumentid]);
  return r.rows[0] ?? null;
}

async function arsId() {
  return (await pool.query<{ id: number }>("SELECT id FROM instruments WHERE ticker = 'ARS'")).rows[0].id;
}

export function createNaiveApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => { res.json({ ok: true, mode: 'naive' }); });

  app.get('/portfolio/:userid', async (req, res) => {
    const userid = Number(req.params.userid);
    try {
      const u = await pool.query('SELECT 1 FROM users WHERE id = $1', [userid]);
      if (u.rowCount === 0) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
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
        HAVING SUM(CASE WHEN o.status = 'FILLED' THEN CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -o.size ELSE 0 END ELSE 0 END) <> 0`, [userid])).rows;
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
          rendimiento_pct: valor !== null && cost > 0 ? ((valor - cost) / cost * 100).toFixed(2) : null,
          retorno_diario_pct: px && px.previousclose ? ((px.close - px.previousclose) / px.previousclose * 100).toFixed(2) : null,
          inconsistent: p.qty < 0,
        });
      }
      res.json({
        userid,
        cash: { neto: money(cash.neto), reservado: money(cash.reservado), disponible: money(cash.neto - cash.reservado) },
        valor_total: money(total), valuation_complete: complete,
        has_inconsistent_history: positions.some((p) => p.inconsistent), positions,
      });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL', message: (err as Error).message });
    }
  });

  app.post('/orders', async (req, res) => {
    const b = req.body ?? {};
    const userid = Number(b.userid);
    const side = String(b.side);
    const type = String(b.type ?? 'MARKET');
    if (!['BUY', 'SELL', 'CASH_IN', 'CASH_OUT'].includes(side) || !['MARKET', 'LIMIT'].includes(type) || !userid) {
      res.status(400).json({ error: 'BAD_REQUEST' }); return;
    }
    try {
      const isCash = side === 'CASH_IN' || side === 'CASH_OUT';
      const instrumentid = isCash ? await arsId() : Number(b.instrumentid);
      let price: number;
      if (isCash) price = 1;
      else if (type === 'LIMIT') price = Number(b.price);
      else {
        const px = await latestClose(instrumentid);
        if (!px) { res.status(422).json({ error: 'NO_PRICE' }); return; }
        price = px.close;
      }
      let size: number;
      if (b.size !== undefined) size = Number(b.size);
      else if (isCash) size = Number(b.amount);                       // pesos enteros a price 1
      else size = Math.floor(Number(b.amount) / price);
      if (!(size > 0)) { res.status(400).json({ error: 'BAD_REQUEST', message: 'size/amount' }); return; }

      // Leer disponible (sin lock) y decidir en la app.
      const cash = (await pool.query<{ disponible: number }>(`
        SELECT COALESCE(SUM(CASE WHEN status = 'FILLED' THEN
                 CASE side WHEN 'CASH_IN' THEN size*price WHEN 'SELL' THEN size*price ELSE -size*price END END), 0)
             - COALESCE(SUM(CASE WHEN status = 'NEW' AND side = 'BUY' THEN size*price END), 0) AS disponible
          FROM orders WHERE userid = $1`, [userid])).rows[0].disponible;
      let status: string;
      if (side === 'CASH_IN') status = 'FILLED';
      else if (side === 'CASH_OUT' || side === 'BUY') status = cash >= size * price ? (type === 'LIMIT' ? 'NEW' : 'FILLED') : 'REJECTED';
      else {
        const held = (await pool.query<{ qty: number }>(`
          SELECT COALESCE(SUM(CASE WHEN status = 'FILLED' THEN CASE side WHEN 'BUY' THEN size ELSE -size END END), 0)
               - COALESCE(SUM(CASE WHEN status = 'NEW' AND side = 'SELL' THEN size END), 0) AS qty
            FROM orders WHERE userid = $1 AND instrumentid = $2`, [userid, instrumentid])).rows[0].qty;
        status = held >= size ? (type === 'LIMIT' ? 'NEW' : 'FILLED') : 'REJECTED';
      }
      const ins = await pool.query<{ id: number; datetime: string }>(
        `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id, datetime`,
        [instrumentid, userid, size, price, type, side, status]);
      res.status(201).json({
        id: String(ins.rows[0].id), userid: String(userid), instrumentid: String(instrumentid), side, type,
        size: String(size), price: money(price), amount: money(size * price), status, balance_seq: null,
        datetime: ins.rows[0].datetime,
      });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL', message: (err as Error).message });
    }
  });

  return app;
}
