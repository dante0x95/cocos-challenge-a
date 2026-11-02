// Todo a UN usuario (-e USER=...; default: primer p90): serialización por el lock de usuario.
// 50 % GET (sin lock), 50 % POST (con lock): mide la cola de escrituras de un solo usuario.
import * as L from './lib.js';
const USER = Number(__ENV.USER || L.cohorts.p90[0]);
export const options = L.scenarioOptions('same-user');
export default function () {
  if (Math.random() < 0.50) L.getPortfolio(USER);
  else L.postOrder(Math.random() < 0.8 ? L.debit(USER) : L.credit(USER), L.key('su'));
}
export function handleSummary(data) { return L.summary('same-user', data); }
