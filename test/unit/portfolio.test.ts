// Armado de la respuesta del portfolio a partir de las filas de la base, sin base.
import { describe, expect, it } from 'vitest';
import { buildPortfolio, type PortfolioRow } from '../../src/domain/portfolio.js';

const cash = (qty: string, reserved: string, inconsistent = false): PortfolioRow => ({
  kind: 0, instrumentid: null, ticker: null, name: null, qty, cost_total: '0', inconsistent,
  reserved, close: null, previousclose: null, price_date: null,
});
const pos = (p: Partial<PortfolioRow> & { instrumentid: number; qty: string; cost_total: string }): PortfolioRow => ({
  kind: 1, ticker: 'X', name: 'x', inconsistent: false, reserved: '0', close: null, previousclose: null, price_date: null, ...p,
});

describe('buildPortfolio', () => {
  it('cash neto, reservado y disponible; valor total = neto sin posiciones', () => {
    const p = buildPortfolio(1, [cash('75300000', '12550000')]);
    expect(p.cash).toEqual({ neto: '753000.00', reservado: '125500.00', disponible: '627500.00' });
    expect(p.valor_total).toBe('753000.00');
    expect(p.valuation_complete).toBe(true);
    expect(p.positions).toEqual([]);
  });

  it('costo 100, valor 110 → rendimiento "10.00", resultado "10.00", unitario 10', () => {
    const p = buildPortfolio(1, [
      cash('0', '0'),
      pos({ instrumentid: 7, qty: '10', cost_total: '100000000', close: '11.00', previousclose: '10.00', price_date: '2023-07-13' }),
    ]);
    expect(p.positions[0]).toMatchObject({
      valor: '110.00', resultado: '10.00', rendimiento_pct: '10.00', costo_unitario: '10.0000', retorno_diario_pct: '10.00',
    });
    expect(p.valor_total).toBe('110.00');
  });

  it('el valor total suma el cash reservado: reservar no cambia lo que el usuario tiene (D-15)', () => {
    const p = buildPortfolio(1, [cash('10000', '4000'), pos({ instrumentid: 7, qty: '1', cost_total: '1000000', close: '1.00' })]);
    expect(p.valor_total).toBe('101.00');
    expect(p.cash.disponible).toBe('60.00');
  });

  it('sin precio → valor null, fuera del total y valuation_complete false', () => {
    const p = buildPortfolio(1, [cash('100', '0'), pos({ instrumentid: 7, qty: '10', cost_total: '100000000' })]);
    expect(p.positions[0]).toMatchObject({ valor: null, resultado: null, rendimiento_pct: null });
    expect(p.valuation_complete).toBe(false);
    expect(p.valor_total).toBe('1.00');
  });

  it('posición heredada en corto (D-01, D-02): qty real, sin costo ni rendimiento, flags en los dos niveles', () => {
    const p = buildPortfolio(1, [
      cash('100', '0', true),
      pos({ instrumentid: 31, qty: '-10', cost_total: '0', inconsistent: true, close: '1530.00', price_date: '2023-07-13' }),
    ]);
    expect(p.has_inconsistent_history).toBe(true);
    expect(p.positions[0]).toMatchObject({
      qty: '-10', inconsistent: true, costo_unitario: null, rendimiento_pct: null, resultado: null, valor: '-15300.00',
    });
  });

  it('el flag global sale de la historia, no de las posiciones actuales (corto ya cubierto, D-03)', () => {
    const p = buildPortfolio(1, [cash('0', '0', true), pos({ instrumentid: 31, qty: '5', cost_total: '500000000', close: '100.00' })]);
    expect(p.has_inconsistent_history).toBe(true);
    expect(p.positions[0]).toMatchObject({ inconsistent: false, rendimiento_pct: '0.00' });
  });

  it('acciones reservadas se descuentan de las disponibles', () => {
    const p = buildPortfolio(1, [cash('0', '0'), pos({ instrumentid: 47, qty: '50', cost_total: '1', reserved: '10' })]);
    expect(p.positions[0].acciones_disponibles).toBe('40');
  });
});
