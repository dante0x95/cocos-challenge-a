import express from 'express';
import { portfolioRouter } from './routes/portfolio.js';
import { ordersRouter } from './routes/orders.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.use(portfolioRouter);
  app.use(ordersRouter);
  // JSON inválido u otros errores de parseo.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: status === 400 ? 'BAD_REQUEST' : 'INTERNAL', message: (err as Error).message });
  });
  return app;
}
