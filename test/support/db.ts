// Utilidades para las pruebas que tocan Postgres.
import pg from 'pg';
import { TEST_ADMIN_URL, TEST_API_URL } from './urls.js';

/** Conexión administradora: crea usuarios de prueba y escribe historia heredada. Nunca la usa la API. */
export const admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 4 });

/** Usuario nuevo por prueba: las órdenes no se pueden borrar (trigger), así que nadie reutiliza estado. */
export async function newUser(tag = 'test'): Promise<number> {
  const r = await admin.query<{ id: number }>(
    'INSERT INTO app.users (email, accountnumber) VALUES ($1, $2) RETURNING id',
    [`${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, String(Date.now()).slice(-10)],
  );
  return r.rows[0].id;
}

export interface Quote { instrumentid: number; closeCents: bigint }

/** Instrumentos (no moneda) con cotización válida, con su close en centavos. */
export async function quotes(limit = 10): Promise<Quote[]> {
  const r = await admin.query<{ instrumentid: number; close: string }>(
    `SELECT i.id AS instrumentid, vc.close::text
       FROM app.instruments i
       JOIN LATERAL app.valid_close(i.id) vc ON vc.close IS NOT NULL
      WHERE i.type <> 'MONEDA'
      ORDER BY i.id LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ instrumentid: x.instrumentid, closeCents: cents(x.close) }));
}

export async function arsId(): Promise<number> {
  return (await admin.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id;
}

/** Una conexión = una sesión, con el rol api: para pruebas de concurrencia. */
export async function apiClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: TEST_API_URL });
  await c.connect();
  return c;
}

export interface PlaceArgs {
  userid: number; key: string; hash?: string;
  side: string; type: string; instrumentid: number;
  size?: bigint | number | null; amount?: string | null; limit?: string | null;
}

export interface PlaceResult { status: number; body: Record<string, string | null>; replay: boolean; order_id: string }

/** SELECT app.place_order(...) sobre una conexión dada. */
export async function placeOrder(c: pg.Client | pg.Pool | pg.PoolClient, a: PlaceArgs): Promise<PlaceResult> {
  const r = await c.query<{ r: PlaceResult }>(
    'SELECT app.place_order($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',
    [a.userid, a.key, a.hash ?? 'h', a.side, a.type, a.instrumentid,
      a.size === undefined || a.size === null ? null : Number(a.size), a.amount ?? null, a.limit ?? null]);
  return r.rows[0].r;
}

/**
 * Historia heredada con venta en corto (D-01). La API no permite crearla, así que se escribe
 * directo como administrador: el trigger valida secuencias, no tenencias. Resultado:
 * `cashCents` de cash y `-short` acciones del instrumento. Devuelve la última secuencia usada.
 */
export async function legacyShort(u: number, instrumentid: number, priceCents: bigint, cashCents: bigint, short = 10n): Promise<number> {
  const ars = await arsId();
  const ins = (side: string, iid: number, size: bigint, price: string, seq: number) => admin.query(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
     VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`, [iid, u, size.toString(), price, side, seq]);
  const bought = 2n * short;
  // CASH_IN + BUY 2s + SELL 3s: el cash neto queda en cashCents.
  await ins('CASH_IN', ars, cashCents + bought * priceCents - (bought + short) * priceCents, '0.01', 1);
  await ins('BUY', instrumentid, bought, fmt(priceCents), 2);
  await ins('SELL', instrumentid, bought + short, fmt(priceCents), 3);
  return 3;
}

export const cents = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i + f.padEnd(2, '0'));
  return neg ? -v : v;
};

export const fmt = (c: bigint): string => {
  const a = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};
