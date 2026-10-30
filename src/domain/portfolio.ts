// Arma la respuesta de GET /portfolio/:userid a partir de las filas tipadas de
// app.read_portfolio. Se opera en BigInt y todo número sale como string (D-13).
import {
  centsToMicro, dailyReturnPct, fromCents, fromMicro, resultCents, returnPct, toCents, unitCost,
} from './money.js';

/** Fila tal como la entrega node-postgres (int8/numeric como string, date como string). */
export interface PortfolioRow {
  kind: number;                 // 0 = cash, 1 = posición
  instrumentid: number | null;
  ticker: string | null;
  name: string | null;
  qty: string;                  // kind 0: cash en centavos; kind 1: acciones
  cost_total: string;           // micro-ARS
  inconsistent: boolean;        // kind 0: la historia tuvo una venta sin tenencia; kind 1: en corto ahora
  reserved: string;             // kind 0: centavos reservados (BUY NEW); kind 1: acciones reservadas (SELL NEW)
  close: string | null;
  previousclose: string | null;
  price_date: string | null;    // YYYY-MM-DD
}

export interface Position {
  instrumentid: number;
  ticker: string | null;
  name: string | null;
  qty: string;
  acciones_reservadas: string;
  acciones_disponibles: string;
  costo_total: string;          // ARS, 6 decimales
  costo_unitario: string | null;
  price: string | null;
  price_date: string | null;
  valor: string | null;         // ARS, 2 decimales
  resultado: string | null;     // ARS, 2 decimales: valor − costo
  rendimiento_pct: string | null;
  retorno_diario_pct: string | null;
  inconsistent: boolean;
}

export interface Portfolio {
  userid: number;
  valor_total: string;
  cash: { neto: string; reservado: string; disponible: string };
  valuation_complete: boolean;
  has_inconsistent_history: boolean;
  positions: Position[];
}

export function buildPortfolio(userid: number, rows: PortfolioRow[]): Portfolio {
  const cashRow = rows.find((r) => r.kind === 0);
  if (!cashRow) throw new Error('read_portfolio sin fila de cash');

  const cashNeto = BigInt(cashRow.qty);
  const cashReservado = BigInt(cashRow.reserved);
  let valorTotalCents = cashNeto;
  let complete = true;

  const positions: Position[] = rows
    .filter((r) => r.kind === 1)
    .map((r) => {
      const qty = BigInt(r.qty);
      const reserved = BigInt(r.reserved);
      const costMicro = BigInt(r.cost_total);
      // Rendimiento y costo unitario solo con posición larga y costo: una posición en corto
      // heredada (D-01) no tiene costo del cual partir.
      const hasCost = qty > 0n && costMicro > 0n;

      let valor: string | null = null;
      let resultado: string | null = null;
      let rendimiento: string | null = null;
      let diario: string | null = null;
      if (r.close !== null) {
        const closeCents = toCents(r.close);
        const valorCents = qty * closeCents;
        valor = fromCents(valorCents);
        valorTotalCents += valorCents;
        if (hasCost) {
          rendimiento = returnPct(centsToMicro(valorCents), costMicro);
          resultado = fromCents(resultCents(centsToMicro(valorCents), costMicro));
        }
        diario = dailyReturnPct(closeCents, r.previousclose === null ? null : toCents(r.previousclose));
      } else {
        complete = false;
      }

      return {
        instrumentid: r.instrumentid as number,
        ticker: r.ticker,
        name: r.name,
        qty: qty.toString(),
        acciones_reservadas: reserved.toString(),
        acciones_disponibles: (qty - reserved).toString(),
        costo_total: fromMicro(costMicro),
        costo_unitario: hasCost ? unitCost(costMicro, qty) : null,
        price: r.close,
        price_date: r.price_date,
        valor,
        resultado,
        rendimiento_pct: rendimiento,
        retorno_diario_pct: diario,
        inconsistent: r.inconsistent,
      };
    });

  return {
    userid,
    valor_total: fromCents(valorTotalCents),
    cash: {
      neto: fromCents(cashNeto),
      reservado: fromCents(cashReservado),
      disponible: fromCents(cashNeto - cashReservado),
    },
    valuation_complete: complete,
    has_inconsistent_history: cashRow.inconsistent,
    positions,
  };
}
