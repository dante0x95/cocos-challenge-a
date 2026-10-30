import { Router } from 'express';
import { badRequest, route } from '../http/errors.js';
import { buildPortfolio } from '../domain/portfolio.js';
import { readPortfolio } from '../repositories/portfolio.repo.js';

export const portfolioRouter = Router();

export function parseId(raw: string, what: string): number {
  if (!/^\d{1,10}$/.test(raw) || Number(raw) <= 0 || Number(raw) > 2_147_483_647) throw badRequest(`${what} inválido`);
  return Number(raw);
}

// GET /portfolio/:userid — docs/api/portfolio.md
// Una sola consulta: si el usuario no existe, read_portfolio falla con APP06 → 404.
portfolioRouter.get('/portfolio/:userid', route(async (req, res) => {
  const userid = parseId(req.params.userid, 'userid');
  res.json(buildPortfolio(userid, await readPortfolio(userid)));
}));
