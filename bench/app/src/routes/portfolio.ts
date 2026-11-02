import { Router } from 'express';
import { pool } from '../db/pool.js';
import { mapDbError } from '../db/errors.js';
import { buildPortfolio, type PortfolioRow } from '../domain/portfolio.js';

export const portfolioRouter = Router();

// GET /portfolio/:userid — lectura sin lock, una sentencia = un snapshot de órdenes (A §5.2).
// Los precios se leen en la misma función por instrumento; price_date lo declara.
portfolioRouter.get('/portfolio/:userid', async (req, res) => {
  const userid = Number(req.params.userid);
  if (!Number.isInteger(userid) || userid <= 0) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'userid inválido' });
    return;
  }
  try {
    const exists = await pool.query('SELECT 1 FROM app.users WHERE id = $1', [userid]);
    if (exists.rowCount === 0) {
      res.status(404).json({ error: 'NOT_FOUND', message: `usuario ${userid} inexistente` });
      return;
    }
    const { rows } = await pool.query<PortfolioRow>('SELECT * FROM app.read_portfolio($1)', [userid]);
    res.json(buildPortfolio(userid, rows));
  } catch (err) {
    const e = mapDbError(err);
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(e.status).json({ error: e.code, message: e.message });
  }
});
