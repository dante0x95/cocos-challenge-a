// Jobs periódicos dentro del proceso de la API (JOBS_ENABLED=true). El job es idempotente y
// usa try-lock por usuario, así que correr dos instancias a la vez no rompe nada: solo duplica
// trabajo. En producción irían a un worker o cron aparte.
import { config } from '../config.js';
import { cleanupIdempotency } from '../repositories/ops.repo.js';

type Job = { name: string; every: number; run: () => Promise<unknown> };

export function startJobs(): () => void {
  const jobs: Job[] = [
    { name: 'cleanup-idempotency', every: config.CLEANUP_EVERY_MS, run: cleanupIdempotency },
  ];
  const timers = jobs.map((j) => {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        console.log(JSON.stringify({ level: 'info', job: j.name, result: await j.run() }));
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', job: j.name, err: String(e) }));
      } finally {
        running = false;
      }
    }, j.every);
    t.unref();
    return t;
  });
  return () => timers.forEach(clearInterval);
}
