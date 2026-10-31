// La colección de Postman versionada (issue #49): esquema v2.1, cada request contra {{baseUrl}},
// cada endpoint de src/routes cubierto, sin secretos, y las escrituras salteadas donde el
// environment no las permite (producción).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

type Script = { listen: string; script: { type?: string; exec: string[] } };
type Url = { raw: string; host: string[]; path: string[]; query?: { key: string; value: string }[] };
type Request = {
  method: string;
  header: { key: string; value: string }[];
  url: Url;
  auth?: unknown;
  body?: { mode: string; raw: string };
};
type Item = { name: string; event?: Script[]; item?: Item[]; request?: Request };
type Collection = Item & { info: { name: string; schema: string }; variable?: { key: string; value: string }[] };
type Environment = { name: string; values: { key: string; value: string; enabled: boolean }[] };

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
const collection = readJson<Collection>('postman/cocos.postman_collection.json');
const ENVIRONMENTS = ['local', 'staging', 'production'] as const;
const environments = Object.fromEntries(
  ENVIRONMENTS.map((name) => [name, readJson<Environment>(`postman/${name}.postman_environment.json`)]),
) as Record<(typeof ENVIRONMENTS)[number], Environment>;
const envValue = (env: Environment, key: string) => env.values.find((v) => v.key === key)?.value;

/** Cada request de la colección, con los folders que lo contienen. */
const requestsOf = (root: Item, parents: Item[] = []): { item: Item; request: Request; parents: Item[] }[] =>
  (root.item ?? []).flatMap((item) =>
    item.request ? [{ item, request: item.request, parents }] : requestsOf(item, [...parents, item]),
  );

/** Lo que no respeta la forma v2.1 que se usa acá: folders con `item`, requests con método y `url`. */
const shapeProblems = (root: Item, path = ''): string[] =>
  (root.item ?? []).flatMap((item) => {
    const where = `${path}/${item.name}`;
    const problems: string[] = [];
    if (!item.name) problems.push(`${where}: sin nombre`);
    if (!!item.item === !!item.request) problems.push(`${where}: tiene que ser un folder (item) o un request`);
    for (const e of item.event ?? []) {
      if (!['prerequest', 'test'].includes(e.listen)) problems.push(`${where}: evento ${e.listen}`);
      if (!Array.isArray(e.script?.exec) || !e.script.exec.every((l) => typeof l === 'string')) {
        problems.push(`${where}: script sin exec`);
      }
    }
    const r = item.request;
    if (r) {
      if (!METHODS.includes(r.method)) problems.push(`${where}: método ${r.method}`);
      if (typeof r.url !== 'object' || typeof r.url.raw !== 'string') problems.push(`${where}: url sin raw`);
      if (!Array.isArray(r.header)) problems.push(`${where}: header no es una lista`);
    }
    return item.item ? [...problems, ...shapeProblems(item, where)] : problems;
  });

/** Los endpoints de la API, leídos de src/routes: `router.get('/ruta', …)`, `r.post('/ruta', …)`. */
const apiRoutes = () =>
  readdirSync(resolve(ROOT, 'src/routes'))
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => [
      ...readFileSync(resolve(ROOT, 'src/routes', file), 'utf8').matchAll(/\.(get|post|put|patch|delete)\(\s*'(\/[^']*)'/g),
    ])
    .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
    .sort();

/** Los endpoints sin un request que los llame: `:param` acepta cualquier segmento. */
const missingRoutes = (routes: string[], requests: Request[]) =>
  routes.filter((route) => {
    const [method, path] = route.split(' ') as [string, string];
    const segments = path.split('/').filter(Boolean);
    return !requests.some(
      (r) =>
        r.method === method &&
        r.url.path.length === segments.length &&
        segments.every((s, i) => s.startsWith(':') || s === r.url.path[i]),
    );
  });

const isGuarded = (folder: Item) =>
  (folder.event ?? []).some(
    (e) => e.listen === 'prerequest' && /allowWrites/.test(e.script.exec.join('\n')) && /skipRequest\(\)/.test(e.script.exec.join('\n')),
  );

const requests = requestsOf(collection);

describe('colección de Postman', () => {
  it('es una colección v2.1 bien formada', () => {
    expect(collection.info.schema).toBe(SCHEMA_V21);
    expect(collection.info.name).toBeTruthy();
    expect(shapeProblems(collection)).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  });

  it('cada request va contra {{baseUrl}}', () => {
    const outside = requests
      .filter(({ request: r }) => !r.url.raw.startsWith('{{baseUrl}}/') || r.url.host.join('') !== '{{baseUrl}}')
      .map(({ item }) => item.name);
    expect(outside).toEqual([]);
  });

  it('lee los endpoints de src/routes', () => {
    const routes = apiRoutes();
    expect(routes).toContain('GET /health');
    expect(routes).toContain('POST /orders/:id/cancel');
    expect(routes).toContain('POST /internal/execute-limits');
    // Control: sin los requests de la cancelación, ese endpoint falta.
    const withoutCancel = requests.map((r) => r.request).filter((r) => !r.url.path.includes('cancel'));
    expect(missingRoutes(routes, withoutCancel)).toEqual(['POST /orders/:id/cancel']);
  });

  it('cubre cada endpoint de la API', () => {
    expect(missingRoutes(apiRoutes(), requests.map((r) => r.request))).toEqual([]);
  });

  it('no lleva secretos: el token interno sale del environment', () => {
    const text = JSON.stringify(collection);
    expect(text).not.toContain(envValue(environments.local, 'internalToken'));
    expect(requests.filter(({ request }) => request.auth).map(({ item }) => item.name)).toEqual([]);
    const headers = requests.flatMap(({ item, request }) => request.header.map((h) => ({ name: item.name, ...h })));
    expect(headers.filter((h) => /^authorization$/i.test(h.key))).toEqual([]);
    // El único token literal es el inválido a propósito del 401.
    expect(
      headers
        .filter((h) => /^x-internal-token$/i.test(h.key) && h.value !== '{{internalToken}}')
        .map((h) => `${h.name}: ${h.value}`),
    ).toEqual(['Token inválido → 401: no-es-el-token']);
    const collectionVars = (collection.variable ?? []).map((v) => v.key);
    expect(collectionVars).not.toContain('baseUrl');
    expect(collectionVars).not.toContain('internalToken');
  });

  it('todo lo que no es GET está en un folder que se saltea sin allowWrites', () => {
    const unguarded = requests
      .filter(({ request, parents }) => request.method !== 'GET' && !parents.some(isGuarded))
      .map(({ item }) => item.name);
    expect(unguarded).toEqual([]);
    // Control: el guard se detecta en los folders que escriben.
    expect(requests.filter(({ parents }) => parents.some(isGuarded)).length).toBeGreaterThan(0);
  });

  it('cada variable que usa está definida en los tres environments o en la colección', () => {
    const used = new Set([...JSON.stringify(collection).matchAll(/\{\{([^}$]+)\}\}/g)].map((m) => m[1]!));
    const collectionVars = new Set((collection.variable ?? []).map((v) => v.key));
    const undefinedVars = ENVIRONMENTS.flatMap((name) =>
      [...used]
        .filter((key) => !collectionVars.has(key) && envValue(environments[name], key) === undefined)
        .map((key) => `${name}: ${key}`),
    );
    expect(undefinedVars).toEqual([]);
  });
});

describe('environments de Postman', () => {
  it('el token interno va vacío salvo el de desarrollo de local', () => {
    expect(envValue(environments.staging, 'internalToken')).toBe('');
    expect(envValue(environments.production, 'internalToken')).toBe('');
    // El de local es el que docker compose usa por defecto.
    const compose = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf8');
    const devToken = compose.match(/INTERNAL_TOKEN: \$\{INTERNAL_TOKEN:-([^}]+)\}/)?.[1];
    expect(devToken).toBeTruthy();
    expect(envValue(environments.local, 'internalToken')).toBe(devToken);
  });

  it('producción no escribe; local y staging sí', () => {
    expect(envValue(environments.production, 'allowWrites')).toBe('false');
    expect(envValue(environments.local, 'allowWrites')).toBe('true');
    expect(envValue(environments.staging, 'allowWrites')).toBe('true');
  });

  it('cada baseUrl es la del entorno: localhost en local, la URL pública del README en los otros', () => {
    expect(envValue(environments.local, 'baseUrl')).toBe('http://localhost:3000');
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    for (const name of ['staging', 'production'] as const) {
      const url = envValue(environments[name], 'baseUrl')!;
      expect(url).toMatch(/^https:\/\/[^/]+$/);
      expect(readme).toContain(`(\`${url}\`)`);
    }
  });
});
