// Pool de node-postgres.
//
// Tiempos (D-20): cada escritura es una sola sentencia (`SELECT app.<función>(...)`) y la base
// hace cumplir su presupuesto (statement_timeout del rol api, lock_timeout de la función). Lo que
// la base no ve: la espera por una conexión libre del pool (connectionTimeoutMillis) y una
// respuesta que nunca llega porque la red descartó paquetes sin cerrar el socket (query_timeout,
// issue #11). Al vencer el plazo local, pg-pool destruye la conexión en vez de devolverla al pool;
// sin él, la consulta esperaba para siempre y el slot del pool no volvía.
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
  query_timeout: config.PG_QUERY_TIMEOUT_MS,
  application_name: 'cocos-api',
  // Sondas TCP sobre las conexiones ociosas: un peer que desapareció sin cerrar (failover, red)
  // termina detectado y descartado. Con los defaults de Linux tarda minutos, no segundos: a una
  // request que toma esa conexión antes la acota el error de su consulta (ECONNRESET, que
  // responde 503 CONNECTION_LOST), no esto.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// Una conexión ociosa que el servidor corta (reinicio de Postgres, failover, pg_terminate_backend)
// emite 'error' en el pool. Sin listener, Node lo trata como excepción no capturada y el proceso
// sale con código 1: un reinicio de la base tumbaba todas las instancias de la API a la vez. El
// cliente ya está fuera del pool; la próxima consulta abre una conexión nueva. Solo se registra.
pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', scope: 'pg-pool-idle', err: String(err) }));
});

/** Para el test de parsers: int8 y numeric deben devolver el string intacto. */
export function parserFor(oid: number): (v: string) => unknown {
  return pg.types.getTypeParser(oid, 'text');
}
