// Todo a las 10 ballenas (lectura y débito): aísla O(historia).
import * as L from './lib.js';
export const options = L.scenarioOptions('whale');
export default function () {
  const u = L.whaleUser();
  if (Math.random() < 0.90) L.getPortfolio(u);
  else L.postOrder(L.debit(u), L.key('wl'));
}
export function handleSummary(data) { return L.summary('whale', data); }
