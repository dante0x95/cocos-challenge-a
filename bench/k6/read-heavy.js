// 90 % GET /portfolio, 8 % POST débito, 2 % POST crédito; usuarios según la población.
import * as L from './lib.js';
export const options = L.scenarioOptions('read-heavy');
export default function () {
  const u = L.populationUser();
  const r = Math.random();
  if (r < 0.90) L.getPortfolio(u);
  else if (r < 0.98) L.postOrder(L.debit(u), L.key('rh'));
  else L.postOrder(L.credit(u), L.key('rh'));
}
export function handleSummary(data) { return L.summary('read-heavy', data); }
