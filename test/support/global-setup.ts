// Antes de toda la suite: base cocos_test nueva, con el mismo bootstrap que producción
// (seed del challenge, migraciones, funciones).
import pg from 'pg';
import { bootstrap } from '../../src/db/bootstrap.js';
import { SERVER_URL, TEST_ADMIN_URL, TEST_API_PASSWORD, TEST_DB } from './urls.js';

export async function recreateDatabase(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: SERVER_URL });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  } finally {
    await c.end();
  }
}

export default async function setup(): Promise<void> {
  if (process.env.SKIP_DB_SETUP === '1') return;
  await recreateDatabase(TEST_DB);
  await bootstrap({ adminUrl: TEST_ADMIN_URL, apiPassword: TEST_API_PASSWORD, log: () => undefined });
}
