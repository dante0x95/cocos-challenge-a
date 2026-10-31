// Secretos como archivos (D-29, issue #36). En el servidor, los secretos no llegan como variables
// de entorno (las muestra `docker inspect`) sino como archivos montados por Docker Compose en
// /run/secrets: <VAR>_FILE es la ruta del archivo con el valor de <VAR>, como POSTGRES_PASSWORD_FILE
// en la imagen de Postgres.
//
// - El valor es el contenido del archivo sin el salto de línea final (uno: `\n` o `\r\n`).
// - <VAR> y <VAR>_FILE juntas, un archivo que no se puede leer o uno vacío fallan al arrancar.
// - Sin <VAR>_FILE, <VAR> se usa como siempre (docker compose local, tests, .env).
//
// Devuelve un entorno nuevo: el valor leído no se escribe en process.env, así que tampoco lo
// heredan los procesos hijos ni aparece en un volcado del entorno.
import { readFileSync } from 'node:fs';

export function withFileSecrets(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of names) {
    const fileVar = `${name}_FILE`;
    const path = env[fileVar];
    if (path === undefined) continue;
    if (env[name] !== undefined) throw new Error(`${name} y ${fileVar} están las dos: va una sola`);
    let value: string;
    try {
      value = readFileSync(path, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(`${fileVar}: no se pudo leer '${path}' (${err.code ?? err.message})`);
    }
    value = value.replace(/\r?\n$/, '');
    if (value === '') throw new Error(`${fileVar}: '${path}' está vacío`);
    out[name] = value;
    delete out[fileVar];
  }
  return out;
}
