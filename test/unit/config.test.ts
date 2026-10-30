// El plazo local del driver (issue #11) va por encima del statement_timeout del rol api: en
// condiciones normales manda la base (D-20).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../src/config.js';

describe('PG_QUERY_TIMEOUT_MS', () => {
  it('por defecto es 7000 ms, por encima del statement_timeout de 5 s que fija la migración del rol api', () => {
    const sql = readFileSync(resolve(import.meta.dirname, '../../db/migrations/001_app_schema.sql'), 'utf8');
    const m = sql.match(/SET statement_timeout = %L', current_database\(\), '(\d+)s'\)/);
    expect(m).not.toBeNull();
    const statementTimeoutMs = Number(m![1]) * 1000;
    expect(statementTimeoutMs).toBe(5000);
    expect(loadConfig({}).PG_QUERY_TIMEOUT_MS).toBe(7000);
    expect(loadConfig({}).PG_QUERY_TIMEOUT_MS).toBeGreaterThan(statementTimeoutMs);
  });

  it('se lee del entorno y rechaza un valor que no es un entero positivo', () => {
    expect(loadConfig({ PG_QUERY_TIMEOUT_MS: '1500' }).PG_QUERY_TIMEOUT_MS).toBe(1500);
    for (const v of ['0', '-1', '1.5', 'x']) expect(() => loadConfig({ PG_QUERY_TIMEOUT_MS: v }), v).toThrow(/PG_QUERY_TIMEOUT_MS/);
  });
});
