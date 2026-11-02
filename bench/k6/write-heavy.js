// 50 % GET, 40 % débito, 10 % crédito (B.4).
import * as L from './lib.js';
export const options = L.scenarioOptions('write-heavy');
export default function () {
  const u = L.populationUser();
  const r = Math.random();
  if (r < 0.50) L.getPortfolio(u);
  else if (r < 0.90) L.postOrder(L.debit(u), L.key('wh'));
  else L.postOrder(L.credit(u), L.key('wh'));
}
export function handleSummary(data) { return L.summary('write-heavy', data); }
