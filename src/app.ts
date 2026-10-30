import express from 'express';
import { config } from './config.js';
import { HttpError, errorHandler } from './http/errors.js';
import { requestLog } from './http/request-log.js';
import { portfolioRouter } from './routes/portfolio.routes.js';
import { ordersRouter } from './routes/orders.routes.js';
import { instrumentsRouter } from './routes/instruments.routes.js';
import { healthRouter, internalRouter } from './routes/internal.routes.js';

export function createApp(
  opts: { internalToken?: string; release?: string } = { internalToken: config.INTERNAL_TOKEN, release: config.RELEASE },
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(requestLog);
  app.use(express.json({ limit: '16kb' }));
  app.use(healthRouter(opts.release));
  app.use(portfolioRouter);
  app.use(instrumentsRouter);
  app.use(ordersRouter);
  app.use(internalRouter(opts.internalToken));
  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'ruta inexistente')));
  app.use(errorHandler);
  return app;
}
