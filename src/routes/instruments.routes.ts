import { Router } from 'express';
import { z } from 'zod';
import { badRequest, route } from '../http/errors.js';
import { searchInstruments } from '../repositories/instruments.repo.js';
import { withoutControlChars } from '../domain/text.js';

export const instrumentsRouter = Router();

const Query = z.object({
  // Sin caracteres de control (issue #40): U+0000 llegaba a Postgres y respondía 500.
  q: withoutControlChars(z.string().trim().min(1, 'q es obligatorio').max(50, 'q admite hasta 50 caracteres'), 'q'),
  include_cash: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /instruments?q=… — docs/api/instruments.md
instrumentsRouter.get('/instruments', route(async (req, res) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const { q, include_cash, limit } = parsed.data;
  const rows = await searchInstruments(q, { includeCash: include_cash === 'true', limit });
  res.json({ query: q, results: rows });
}));
