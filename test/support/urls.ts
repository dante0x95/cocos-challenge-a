// URLs de las bases de test. Todo sale de TEST_PG_URL (un servidor Postgres con un rol
// administrador); las bases se crean y se borran solas.
const server = process.env.TEST_PG_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

export function dbUrl(database: string, user?: { name: string; password: string }): string {
  const u = new URL(server);
  u.pathname = `/${database}`;
  if (user) { u.username = user.name; u.password = user.password; }
  return u.toString();
}

export const SERVER_URL = server;
export const TEST_DB = 'cocos_test';
export const TEST_ADMIN_URL = dbUrl(TEST_DB);
export const TEST_API_PASSWORD = 'api';
export const TEST_API_URL = dbUrl(TEST_DB, { name: 'api', password: TEST_API_PASSWORD });
