import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { startJobs } from './jobs/scheduler.js';

const server = createApp().listen(config.PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: `cocos-api escuchando en :${config.PORT}` }));
});
const stopJobs = config.JOBS_ENABLED ? startJobs() : () => undefined;

// Apagado limpio: deja de aceptar conexiones, espera las que están en curso y cierra el pool.
let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ level: 'info', msg: `${signal}: cerrando` }));
  stopJobs();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
