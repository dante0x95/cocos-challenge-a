// Pool de node-postgres.
//
// Tiempos (D-20): cada escritura es una sola sentencia (`SELECT app.<función>(...)`) y la base
// hace cumplir su presupuesto (statement_timeout del rol api, lock_timeout de la función). Lo
// único que la base no ve es la espera por una conexión libre del pool: la acota
// connectionTimeoutMillis.
//
// Dinero y cantidades: NINGÚN parser que devuelva Number para int8 (OID 20) ni numeric
// (OID 1700). node-postgres los entrega como string por defecto y acá no se registra nada
// para esos OIDs; un test lo verifica (D-13). Lo único que se cambia es date (1082) y
// timestamp sin zona (1114): string tal cual, en vez de Date. node-postgres interpretaría el
// timestamp en la zona horaria del proceso, y orders.datetime se guarda en UTC.
import pg from 'pg';
import { config } from '../config.js';

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1114, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  connectionTimeoutMillis: config.PG_CONNECT_TIMEOUT_MS,
  application_name: 'cocos-api',
});

/** Para el test de parsers: int8 y numeric deben devolver el string intacto. */
export function parserFor(oid: number): (v: string) => unknown {
  return pg.types.getTypeParser(oid, 'text');
}
