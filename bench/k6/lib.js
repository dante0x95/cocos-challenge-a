// Común a todos los escenarios k6.
//   -e BASE=http://app:3000 -e RPS=100 -e DURATION=5m -e PROFILE=medium -e VARIANT=A
//   -e WARMUP=0s (calentamiento previo, sin medir) -e OUT=/results
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const BASE = __ENV.BASE || 'http://localhost:3000';
// 201 (orden, FILLED o REJECTED) y 422 (NO_PRICE / LIMIT) son respuestas de negocio, no fallos.
http.setResponseCallback(http.expectedStatuses(200, 201, 422));
export const RPS = Number(__ENV.RPS || 50);
export const DURATION = __ENV.DURATION || '60s';
export const PROFILE = __ENV.PROFILE || 'medium';
export const VARIANT = __ENV.VARIANT || 'A';
export const OUT = __ENV.OUT || '/results';

// cohorts.json lo escribe el generador (fase 8); el compose lo monta en /data/cohorts.json
// (no puede ir dentro de /k6, que es un montaje de solo lectura). -e COHORTS=... para otra ruta.
export const cohorts = JSON.parse(open(__ENV.COHORTS || '/data/cohorts.json'));

export const orderStatus = new Counter('order_status');        // tag status=FILLED|REJECTED|NEW
export const httpStatus = new Counter('http_status_code');     // tag code=201|400|422|503|...
export const getDuration = new Trend('portfolio_get_ms', true);
export const postDuration = new Trend('order_post_ms', true);

function pickFrom(xs) { return xs[Math.floor(Math.random() * xs.length)]; }

/** Usuario según la población: 80 % mediano, 15 % p90, 4 % p99, 1 % p999. */
export function populationUser() {
  const r = Math.random();
  const k = r < 0.80 ? 'median' : r < 0.95 ? 'p90' : r < 0.99 ? 'p99' : 'p999';
  return pickFrom(cohorts[k]);
}
export function whaleUser() { return pickFrom(cohorts.whale); }

export function scenarioOptions(name) {
  return {
    scenarios: {
      [name]: {
        executor: 'constant-arrival-rate',
        rate: RPS, timeUnit: '1s', duration: DURATION,
        preAllocatedVUs: 100, maxVUs: 500,
        startTime: __ENV.WARMUP || '0s',
      },
    },
    // Declarados, no abortantes: el benchmark reporta, no corta.
    thresholds: {
      http_req_failed: [{ threshold: 'rate<0.001', abortOnFail: false }],
      'http_req_duration{op:get}': [{ threshold: 'p(99)<500', abortOnFail: false }],
      'http_req_duration{op:post}': [{ threshold: 'p(99)<500', abortOnFail: false }],
      dropped_iterations: [{ threshold: 'count==0', abortOnFail: false }],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  };
}

export function getPortfolio(userid) {
  const res = http.get(`${BASE}/portfolio/${userid}`, { tags: { op: 'get' } });
  httpStatus.add(1, { code: String(res.status) });
  getDuration.add(res.timings.duration);
  check(res, { 'GET 200': (r) => r.status === 200 });
  return res;
}

export function postOrder(body, key) {
  const res = http.post(`${BASE}/orders`, JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    tags: { op: 'post', side: body.side },
  });
  httpStatus.add(1, { code: String(res.status) });
  postDuration.add(res.timings.duration);
  if (res.status === 201) {
    try { orderStatus.add(1, { status: res.json('status') }); } catch (_) { /* body no JSON */ }
  }
  check(res, { 'POST 201/422': (r) => r.status === 201 || r.status === 422 });
  return res;
}

export const key = (scenario) => `${scenario}-${__VU}-${__ITER}-${Date.now()}`;
/** Instrumento del dataset (ids 1000..1999 según el generador). */
export const instrument = () => 1000 + Math.floor(Math.random() * Number(__ENV.INSTRUMENTS || 1000));

/** Débito: 70 % BUY MARKET por monto, 30 % CASH_OUT chico. Crédito: CASH_IN. */
export function debit(userid) {
  return Math.random() < 0.7
    ? { userid, side: 'BUY', type: 'MARKET', instrumentid: instrument(), amount: '20000.00' }   // > precio máximo del dataset: nunca 400 por monto
    : { userid, side: 'CASH_OUT', amount: '10.00' };
}
export function credit(userid) { return { userid, side: 'CASH_IN', amount: '100.00' }; }

export function summary(name, data) {
  const file = `${OUT}/${PROFILE}-${name}-${RPS}-${VARIANT}.json`;
  const m = data.metrics;
  const pick = (k) => (m[k] && m[k].values) || {};
  const line = (k) => { const v = pick(k); return `${k}: p50=${f(v.med)} p95=${f(v['p(95)'])} p99=${f(v['p(99)'])} max=${f(v.max)} n=${v.count ?? ''}`; };
  const f = (x) => (x == null ? '-' : Math.round(x) + 'ms');
  const out = [
    `== ${PROFILE} / ${name} / ${RPS} rps / ${VARIANT} / ${DURATION} ==`,
    line('http_req_duration{op:get}'), line('http_req_duration{op:post}'),
    `http_req_failed: ${((pick('http_req_failed').rate || 0) * 100).toFixed(3)} %`,
    `dropped_iterations: ${pick('dropped_iterations').count || 0}`,
    `iterations: ${pick('iterations').count || 0}  vus_max: ${pick('vus_max').value || ''}`,
  ].join('\n');
  return { stdout: out + '\n', [file]: JSON.stringify(data, null, 1) };
}
