// El plazo local del driver (issue #11) va por encima del statement_timeout del rol api: en
// condiciones normales manda la base (D-20).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

// Secretos como archivos (D-29, issue #36): en el servidor, DATABASE_URL e INTERNAL_TOKEN llegan
// como archivos montados por Docker Compose y la API lee <VAR>_FILE; sin _FILE, nada cambia.
describe('secretos como archivo (<VAR>_FILE)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const secret = (content: string, mode = 0o600) => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-secret-'));
    dirs.push(dir);
    const path = join(dir, 'secreto');
    writeFileSync(path, content, { mode });
    return path;
  };
  const URL_DB = 'postgresql://api:clave@db:5432/cocos';
  const messageOf = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as Error).message; }
    throw new Error('no falló');
  };

  it('lee DATABASE_URL_FILE e INTERNAL_TOKEN_FILE, sin el salto de línea final', () => {
    const c = loadConfig({ DATABASE_URL_FILE: secret(`${URL_DB}\n`), INTERNAL_TOKEN_FILE: secret('token-del-archivo\r\n') });
    expect(c.DATABASE_URL).toBe(URL_DB);
    expect(c.INTERNAL_TOKEN).toBe('token-del-archivo');
    // Sin salto final también, y se quita uno solo: lo demás es el valor.
    expect(loadConfig({ INTERNAL_TOKEN_FILE: secret('sin-salto') }).INTERNAL_TOKEN).toBe('sin-salto');
    expect(loadConfig({ INTERNAL_TOKEN_FILE: secret(' a b \n\n') }).INTERNAL_TOKEN).toBe(' a b \n');
  });

  it('el valor leído no se escribe en el entorno recibido', () => {
    const env: NodeJS.ProcessEnv = { INTERNAL_TOKEN_FILE: secret('token-del-archivo') };
    expect(loadConfig(env).INTERNAL_TOKEN).toBe('token-del-archivo');
    expect(Object.keys(env)).toEqual(['INTERNAL_TOKEN_FILE']);
  });

  it.each(['DATABASE_URL', 'INTERNAL_TOKEN'])('%s y su _FILE juntas fallan al arrancar', (name) => {
    const value = name === 'DATABASE_URL' ? URL_DB : 'token';
    expect(() => loadConfig({ [name]: value, [`${name}_FILE`]: secret(value) }))
      .toThrow(`configuración inválida: ${name} y ${name}_FILE están las dos`);
    // También con la variable vacía: está definida.
    expect(() => loadConfig({ [name]: '', [`${name}_FILE`]: secret(value) })).toThrow(/están las dos/);
  });

  it('un _FILE que no existe, que no se puede leer o vacío falla al arrancar', () => {
    expect(messageOf(() => loadConfig({ INTERNAL_TOKEN_FILE: '/no/existe/internal_token' })))
      .toBe("configuración inválida: INTERNAL_TOKEN_FILE: no se pudo leer '/no/existe/internal_token' (ENOENT)");
    expect(() => loadConfig({ DATABASE_URL_FILE: '' })).toThrow(/DATABASE_URL_FILE: no se pudo leer/);
    // Un directorio en lugar de un archivo.
    expect(() => loadConfig({ DATABASE_URL_FILE: tmpdir() })).toThrow(/DATABASE_URL_FILE: no se pudo leer .* \(EISDIR\)/);
    expect(() => loadConfig({ INTERNAL_TOKEN_FILE: secret('\n') })).toThrow(/INTERNAL_TOKEN_FILE: .* está vacío/);
    if (process.getuid?.() !== 0) {   // root lee cualquier archivo
      const path = secret('token-secreto', 0o000);
      expect(messageOf(() => loadConfig({ INTERNAL_TOKEN_FILE: path })))
        .toBe(`configuración inválida: INTERNAL_TOKEN_FILE: no se pudo leer '${path}' (EACCES)`);
    }
  });

  it('un contenido inválido falla como la variable, sin repetir el valor', () => {
    const message = messageOf(() => loadConfig({ DATABASE_URL_FILE: secret('no-es-una-url-secreta') }));
    expect(message).toMatch(/^configuración inválida: DATABASE_URL: /);
    expect(message).not.toContain('no-es-una-url-secreta');
  });

  it('sin _FILE, todo sigue como antes: las variables y sus valores por defecto', () => {
    expect(loadConfig({ DATABASE_URL: URL_DB, INTERNAL_TOKEN: 'token' })).toMatchObject({ DATABASE_URL: URL_DB, INTERNAL_TOKEN: 'token' });
    const d = loadConfig({});
    expect(d.DATABASE_URL).toBe('postgresql://api:api@localhost:5432/cocos');
    expect(d.INTERNAL_TOKEN).toBeUndefined();
  });
});
