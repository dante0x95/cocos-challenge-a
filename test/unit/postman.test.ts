// La colección de Postman versionada (issue #49): válida contra el esquema oficial v2.1, cada
// request contra {{baseUrl}}, cada endpoint de src/routes cubierto, sin secretos, y sus scripts
// ejecutados con un `pm` simulado: las escrituras se saltean donde el environment no las permite
// (producción), un request reenviado conserva su Idempotency-Key, la corrida queda atada a su
// environment y usuario, y los requests sobre la LIMIT usan solo la que creó la corrida en ese environment.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

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
type Located = { item: Item; request: Request; parents: Item[] };

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
const collection = readJson<Collection>('postman/cocos.postman_collection.json');
const ENVIRONMENTS = ['local', 'staging', 'production'] as const;
const environments = Object.fromEntries(
  ENVIRONMENTS.map((name) => [name, readJson<Environment>(`postman/${name}.postman_environment.json`)]),
) as Record<(typeof ENVIRONMENTS)[number], Environment>;
const envValue = (env: Environment, key: string) => env.values.find((v) => v.key === key)?.value;
const envObject = (env: Environment) => Object.fromEntries(env.values.map((v) => [v.key, v.value]));

// El esquema oficial (https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json),
// versionado para que la prueba no dependa de la red.
const validateSchema = new Ajv({ strict: false, allErrors: true }).compile(
  readJson<object>('test/support/postman/collection-v2.1.0.schema.json'),
);
const schemaErrors = (c: unknown) =>
  validateSchema(c) ? [] : (validateSchema.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);

/** Cada request de la colección, con los folders que lo contienen. */
const requestsOf = (root: Item, parents: Item[] = []): Located[] =>
  (root.item ?? []).flatMap((item) =>
    item.request ? [{ item, request: item.request, parents }] : requestsOf(item, [...parents, item]),
  );

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

// Un `pm` mínimo, con la precedencia de Postman: local > environment > colección.
type State = { env: Record<string, string>; collection: Map<string, string>; locals: Map<string, string> };
const newState = (env: Environment): State => ({
  env: envObject(env),
  collection: new Map((collection.variable ?? []).map((v) => [v.key, v.value])),
  locals: new Map(),
});
const resolveVar = (s: State, key: string) => s.locals.get(key) ?? s.env[key] ?? s.collection.get(key);
const fill = (s: State, text: string) =>
  text.replace(/\{\{([^}]+)\}\}/g, (all, key: string) => resolveVar(s, key) ?? all);

/** Corre un script de la colección; devuelve si pidió saltear el request. */
function runScript(exec: string[], s: State, response?: unknown, code = 200): boolean {
  let skipped = false;
  const pm = {
    environment: { get: (k: string) => s.env[k] },
    collectionVariables: { get: (k: string) => s.collection.get(k), set: (k: string, v: unknown) => s.collection.set(k, String(v)) },
    variables: {
      get: (k: string) => resolveVar(s, k),
      set: (k: string, v: unknown) => s.locals.set(k, String(v)),
      replaceIn: (text: string) => text.replaceAll('{{$guid}}', () => randomUUID()),
    },
    execution: { skipRequest: () => { skipped = true; } },
    // Las aserciones no se evalúan acá (eso lo hace newman); sí lo que el script guarda.
    test: () => {},
    response: { code, json: () => response, headers: { get: () => null } },
  };
  runInNewContext(exec.join('\n'), { pm, console: { log: () => {} }, JSON });
  return skipped;
}

const scriptsOf = (item: Item | Collection, listen: string) =>
  (item.event ?? []).filter((e) => e.listen === listen).map((e) => e.script.exec);

/** Los prerequest de un request en el orden de Postman (colección, folders, request); `true` si alguno lo saltea. */
const prerequest = (r: Located, s: State, root: Collection = collection) => {
  s.locals.clear();
  return [root, ...r.parents, r.item]
    .flatMap((i) => scriptsOf(i, 'prerequest'))
    .reduce((skipped, exec) => runScript(exec, s) || skipped, false);
};
const testScript = (r: Located, s: State, response: unknown, code = 200) => {
  for (const exec of scriptsOf(r.item, 'test')) runScript(exec, s, response, code);
};

const requests = requestsOf(collection);
const byName = (name: string, list = requests) => {
  const found = list.find((r) => r.item.name === name);
  if (!found) throw new Error(`la colección no tiene el request "${name}"`);
  return found;
};
const idempotencyKey = (r: Located, s: State) =>
  fill(s, r.request.header.find((h) => h.key === 'Idempotency-Key')?.value ?? '');
/** El runContext con que Órdenes ata runId al environment y al usuario. */
const contextOf = (s: State) => JSON.stringify({ baseUrl: s.env.baseUrl, userid: s.env.userid });
/** Corre Órdenes en orden, como el Runner: cada request no salteado recibe una respuesta con `code`. */
const fullRun = (
  s: State, list = requests, root: Collection = collection, code: (r: Located) => number = () => 201,
) => {
  for (const r of list.filter((x) => x.parents.some((p) => p.name === 'Órdenes'))) {
    if (!prerequest(r, s, root)) testScript(r, s, { id: '15', status: 'NEW', positions: [], cash: {} }, code(r));
  }
};
/** Una copia de la colección con un script cambiado por `edit`, para los controles. */
const mutated = (edit: (json: string) => string) => {
  const copy = JSON.parse(edit(JSON.stringify(collection))) as Collection;
  return { copy, list: requestsOf(copy) };
};

/** Para `allowWrites`: los valores con los que el folder se saltea y no tendría que saltearse, y al revés. */
const WRITE_CASES: [string | undefined, boolean][] = [
  ['true', false], ['false', true], [undefined, true], ['', true], ['TRUE', true], ['yes', true],
];
const writeGuardProblems = (r: Located, root: Collection = collection) =>
  WRITE_CASES.flatMap(([allowWrites, shouldSkip]) => {
    const s = newState(environments.local);
    if (allowWrites === undefined) delete s.env.allowWrites;
    else s.env.allowWrites = allowWrites;
    s.collection.set('limitOrder', JSON.stringify({ id: '1', baseUrl: s.env.baseUrl, userid: s.env.userid, runId: 'r' }));
    s.collection.set('runId', 'r');
    s.collection.set('runContext', contextOf(s));
    return prerequest(r, s, root) === shouldSkip ? [] : [`${r.item.name}: allowWrites=${String(allowWrites)}`];
  });

describe('colección de Postman', () => {
  it('es válida contra el esquema oficial v2.1', () => {
    expect(collection.info.schema).toBe(SCHEMA_V21);
    expect(schemaErrors(collection)).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  });

  it('control: el esquema rechaza un body.mode inválido e info sin schema', () => {
    const badMode = structuredClone(collection);
    requestsOf(badMode).find((r) => r.request.body)!.request.body!.mode = 'modo-inexistente';
    expect(schemaErrors(badMode).length).toBeGreaterThan(0);
    const noSchema = structuredClone(collection);
    delete (noSchema.info as Partial<Collection['info']>).schema;
    expect(schemaErrors(noSchema).length).toBeGreaterThan(0);
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

  // `to.have.all.keys` falla con un campo nuevo: la verificación del executor sigue a ExecuteReport.
  it('el executor se verifica con los campos de ExecuteReport', () => {
    const repo = readFileSync(resolve(ROOT, 'src/repositories/ops.repo.ts'), 'utf8');
    const body = repo.match(/export interface ExecuteReport \{\n([\s\S]*?)\n\}/)?.[1];
    expect(body, 'ExecuteReport en src/repositories/ops.repo.ts').toBeTruthy();
    const fields = [...body!.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort();
    expect(fields).toContain('overflow_users');
    const script = scriptsOf(byName('Ejecutar las LIMIT que cruzan').item, 'test').flat().join('\n');
    const keys = script.match(/have\.all\.keys\(([^)]*)\)/)?.[1].match(/'(\w+)'/g)?.map((k) => k.slice(1, -1)).sort();
    expect(keys).toEqual(fields);
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

describe('scripts de la colección', () => {
  const writes = requests.filter(({ request }) => request.method !== 'GET');

  it('todo lo que no es GET se envía solo con allowWrites exactamente "true"', () => {
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.flatMap((r) => writeGuardProblems(r))).toEqual([]);
    // Con producción, ninguna escritura sale.
    const prod = writes.filter((r) => !prerequest(r, newState(environments.production)));
    expect(prod.map((r) => r.item.name)).toEqual([]);
  });

  it('control: la condición invertida o sin guard se detecta', () => {
    const inverted = mutated((j) => j.replace(`pm.environment.get('allowWrites') !== 'true'`, `pm.environment.get('allowWrites') === 'true'`));
    const deposit = byName('Depositar pesos (CASH_IN)', inverted.list);
    expect(writeGuardProblems(deposit, inverted.copy)).toContain('Depositar pesos (CASH_IN): allowWrites=false');
    const unguarded = mutated((j) => j.replaceAll('pm.execution.skipRequest();', ''));
    expect(writeGuardProblems(byName('Depositar pesos (CASH_IN)', unguarded.list), unguarded.copy).length).toBeGreaterThan(0);
  });

  it('los requests con el token interno se saltean si internalToken está vacío', () => {
    const withToken = requests.filter(({ request }) => request.header.some((h) => h.value === '{{internalToken}}'));
    expect(withToken.length).toBeGreaterThan(0);
    const sent = withToken.filter((r) => !prerequest(r, newState(environments.staging)));
    expect(sent.map((r) => r.item.name)).toEqual([]);
    const local = withToken.filter((r) => prerequest(r, newState(environments.local)));
    expect(local.map((r) => r.item.name)).toEqual([]);
  });

  // Un depósito cuya respuesta se perdió (timeout) se reenvía tal cual: tiene que llevar la misma
  // Idempotency-Key, así el servidor devuelve la orden ya creada en vez de depositar dos veces.
  const depositKeys = (list: Located[], root: Collection) => {
    const s = newState(environments.local);
    const deposit = byName('Depositar pesos (CASH_IN)', list);
    prerequest(deposit, s, root);
    const first = idempotencyKey(deposit, s);
    // Sin respuesta: no corre el script de test. El reenvío:
    prerequest(deposit, s, root);
    const retry = idempotencyKey(deposit, s);
    return { s, first, retry };
  };

  it('reenviar el depósito sin respuesta conserva la Idempotency-Key', () => {
    const { first, retry } = depositKeys(requests, collection);
    expect(first).toMatch(/^[0-9a-f-]{36}-cash-in$/);
    expect(retry).toBe(first);
    // El replay y el mismatch usan la clave del depósito.
    const s = depositKeys(requests, collection).s;
    expect(idempotencyKey(byName('Repetir el depósito → replay'), s)).toBe(idempotencyKey(byName('Depositar pesos (CASH_IN)'), s));
  });

  it('una corrida completa termina con runId vacío: la siguiente usa claves nuevas', () => {
    const s = newState(environments.local);
    fullRun(s);
    expect(s.collection.get('runId')).toBe('');
    const deposit = byName('Depositar pesos (CASH_IN)');
    prerequest(deposit, s);
    const next = idempotencyKey(deposit, s);
    fullRun(s);
    prerequest(deposit, s);
    expect(idempotencyKey(deposit, s)).not.toBe(next);
  });

  // El cierre no borra la clave de una escritura cuyo resultado no se conoce: ni un portfolio
  // consultado suelto después de un depósito sin respuesta, ni una corrida con un 5xx.
  it('una consulta suelta después de un depósito sin respuesta conserva la clave', () => {
    const { s, first } = depositKeys(requests, collection);
    testScript(byName('Portfolio después de operar'), s, { positions: [], cash: {} });
    expect(s.collection.get('runId')).not.toBe('');
    const deposit = byName('Depositar pesos (CASH_IN)');
    prerequest(deposit, s);
    expect(idempotencyKey(deposit, s)).toBe(first);
  });

  // Cada clave de la corrida, desde los headers: un 5xx en cualquiera la deja sin resultado.
  const KEY_SUFFIXES = [...new Set(requests
    .map((r) => r.request.header.find((h) => h.key === 'Idempotency-Key')?.value.match(/^\{\{runId\}\}-(.+)$/)?.[1])
    .filter((k): k is string => k !== undefined))];
  const withKey = (suffix: string, list = requests) =>
    list.filter((r) => r.request.header.some((h) => h.key === 'Idempotency-Key' && h.value === `{{runId}}-${suffix}`));
  /** Una corrida en la que cada request con la clave `suffix` responde 503; después, el reenvío responde 201. */
  const unknownResult = (suffix: string, list = requests, root: Collection = collection) => {
    const s = newState(environments.local);
    const sent = withKey(suffix, list);
    fullRun(s, list, root, (r) => (sent.includes(r) ? 503 : 201));
    const kept = s.collection.get('runId') !== '';
    prerequest(sent[0]!, s, root);
    const key = idempotencyKey(sent[0]!, s);
    testScript(sent[0]!, s, { id: '15', status: 'NEW' }, 201);
    testScript(byName('Portfolio después de operar', list), s, { positions: [], cash: {} });
    return { kept, key, closed: s.collection.get('runId') === '' };
  };

  it('un 5xx en cualquier escritura con clave conserva runId y la clave; con la respuesta, cierra', () => {
    expect(KEY_SUFFIXES).toEqual(['cash-in', 'buy-size', 'buy-amount', 'buy-limit', 'sell', 'sell-too-much', 'cash-out', 'error-price', 'error-float']);
    const problems = KEY_SUFFIXES.flatMap((suffix) => {
      const { kept, key, closed } = unknownResult(suffix);
      return [
        ...(kept ? [] : [`${suffix}: runId vaciado con el resultado sin conocer`]),
        ...(key.endsWith(`-${suffix}`) && key.length > suffix.length + 30 ? [] : [`${suffix}: clave ${key}`]),
        ...(closed ? [] : [`${suffix}: no cierra después del 201`]),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('control: un guard de buy-size que acepta el 5xx vacía runId', () => {
    const eager = mutated((j) => j.replace(
      'clave buy-size ya se conoce.","if (pm.response.code < 500) {', 'clave buy-size ya se conoce.","if (true) {'));
    expect(unknownResult('buy-size', eager.list, eager.copy).kept).toBe(false);
    expect(unknownResult('cash-in', eager.list, eager.copy).kept).toBe(true);
  });

  // Un depósito pendiente en local no se cierra con respuestas de staging ni de otro usuario: con
  // otro baseUrl o userid, Órdenes se saltea mientras runId tenga valor.
  const pendingDeposit = (list = requests, root: Collection = collection) => {
    const s = newState(environments.local);
    const sent = withKey('cash-in', list);
    fullRun(s, list, root, (r) => (sent.includes(r) ? 503 : 201));
    prerequest(sent[0]!, s, root);
    return { s, key: idempotencyKey(sent[0]!, s) };
  };
  const OTHER_CONTEXTS: [string, (s: State) => void][] = [
    ['staging', (s) => { s.env = envObject(environments.staging); }],
    ['otro userid', (s) => { s.env = { ...envObject(environments.local), userid: '3' }; }],
  ];
  const afterOtherContext = (move: (s: State) => void, list = requests, root: Collection = collection) => {
    const { s, key } = pendingDeposit(list, root);
    move(s);
    const ordenes = list.filter((x) => x.parents.some((p) => p.name === 'Órdenes'));
    const sentThere = ordenes.filter((r) => !prerequest(r, s, root)).map((r) => r.item.name);
    fullRun(s, list, root);
    s.env = envObject(environments.local);
    const deposit = byName('Depositar pesos (CASH_IN)', list);
    prerequest(deposit, s, root);
    return { key, sentThere, retry: idempotencyKey(deposit, s), runId: s.collection.get('runId') };
  };

  it('con otro environment o userid, Órdenes no corre y el depósito pendiente conserva su clave', () => {
    for (const [, move] of OTHER_CONTEXTS) {
      const { key, sentThere, retry } = afterOtherContext(move);
      expect(sentThere).toEqual([]);
      expect(retry).toBe(key);
    }
    // Después de una corrida completa (runId vacío), el otro environment empieza la suya.
    const s = newState(environments.local);
    fullRun(s);
    s.env = envObject(environments.staging);
    const deposit = byName('Depositar pesos (CASH_IN)');
    expect(prerequest(deposit, s)).toBe(false);
    expect(s.collection.get('runContext')).toBe(contextOf(s));
  });

  it('control: sin comparar runContext, staging cierra el depósito pendiente de local', () => {
    const blind = mutated((j) => j.replace(`pm.collectionVariables.get('runContext') !== context`, 'false'));
    for (const [name, move] of OTHER_CONTEXTS) {
      const { key, retry } = afterOtherContext(move, blind.list, blind.copy);
      expect(retry, name).not.toBe(key);
    }
  });

  it('control: un cierre incondicional borra la clave del depósito sin respuesta', () => {
    const eager = mutated((j) => j.replace('if (pending.length === 0) {', 'if (true) {'));
    const { s, first } = depositKeys(eager.list, eager.copy);
    testScript(byName('Portfolio después de operar', eager.list), s, { positions: [], cash: {} });
    const deposit = byName('Depositar pesos (CASH_IN)', eager.list);
    prerequest(deposit, s, eager.copy);
    expect(idempotencyKey(deposit, s)).not.toBe(first);
  });

  it('control: un depósito que renueva runId al enviarse cambia la clave en el reenvío', () => {
    const renewing = structuredClone(collection);
    const deposit = byName('Depositar pesos (CASH_IN)', requestsOf(renewing));
    deposit.item.event = [
      { listen: 'prerequest', script: { exec: [`pm.collectionVariables.set('runId', pm.variables.replaceIn('{{$guid}}'));`] } },
      ...(deposit.item.event ?? []),
    ];
    const { first, retry } = depositKeys(requestsOf(renewing), renewing);
    expect(retry).not.toBe(first);
  });

  // La LIMIT creada en un environment no se consulta ni se cancela desde otro, ni desde otra corrida.
  const LIMIT_DEPENDENTS = [
    'Consultar la LIMIT', 'Consultar la LIMIT como otro usuario → 404', 'Consultar sin userid → 400',
    'Cancelar la LIMIT', 'Cancelar otra vez → 409',
  ];
  const afterLimit = (list: Located[], root: Collection): State => {
    const s = newState(environments.local);
    prerequest(byName('Comprar LIMIT (queda NEW)', list), s, root);
    testScript(byName('Comprar LIMIT (queda NEW)', list), s, { id: '15', status: 'NEW' });
    return s;
  };
  const sentWith = (list: Located[], root: Collection, s: State) =>
    LIMIT_DEPENDENTS.filter((name) => !prerequest(byName(name, list), s, root));

  it('los requests sobre la LIMIT usan la de esta corrida en este environment', () => {
    const s = afterLimit(requests, collection);
    expect(sentWith(requests, collection, s)).toEqual(LIMIT_DEPENDENTS);
    prerequest(byName('Cancelar la LIMIT'), s);
    expect(fill(s, byName('Cancelar la LIMIT').request.url.raw)).toBe('http://localhost:3000/orders/15/cancel');
  });

  // Con runContext del environment nuevo, para que decida solo el guard de la LIMIT (el de la
  // corrida ya saltea Órdenes con otro environment).
  const moveRunTo = (s: State, env: Record<string, string>) => {
    s.env = env;
    s.collection.set('runContext', contextOf(s));
  };

  it('cambiar de environment después de crear la LIMIT no envía su id al otro', () => {
    const s = afterLimit(requests, collection);
    moveRunTo(s, envObject(environments.staging));
    expect(sentWith(requests, collection, s)).toEqual([]);
    // Otro userid en el mismo servidor, tampoco.
    moveRunTo(s, { ...envObject(environments.local), userid: '3' });
    expect(sentWith(requests, collection, s)).toEqual([]);
  });

  it('después de una corrida completa, la LIMIT anterior no se reusa', () => {
    const s = newState(environments.local);
    fullRun(s);
    expect(s.collection.get('limitOrder')).toBe('');
    expect(sentWith(requests, collection, s)).toEqual([]);
    // Ni con una variable limitId que quedó de antes.
    s.collection.set('limitId', '15');
    expect(sentWith(requests, collection, s)).toEqual([]);
  });

  it('otra corrida en el mismo environment y con el mismo userid no usa la LIMIT de la anterior', () => {
    const s = afterLimit(requests, collection);
    // Otra intención: runId vaciado a mano y la colección crea uno nuevo.
    s.collection.set('runId', '');
    expect(sentWith(requests, collection, s)).toEqual([]);
    expect(s.collection.get('runId')).not.toBe('');
  });

  it('control: un guard que no compara runId envía la LIMIT de la corrida anterior', () => {
    const blind = mutated((j) => j.replaceAll(`limit.runId === pm.collectionVariables.get('runId')`, 'true'));
    const s = afterLimit(blind.list, blind.copy);
    s.collection.set('runId', '');
    expect(sentWith(blind.list, blind.copy, s)).toEqual(LIMIT_DEPENDENTS);
  });

  it('control: un guard que no mira el environment envía el id a staging', () => {
    const blind = mutated((j) => j.replaceAll(`limit.baseUrl === pm.environment.get('baseUrl')`, 'true'));
    const s = afterLimit(blind.list, blind.copy);
    moveRunTo(s, envObject(environments.staging));
    expect(sentWith(blind.list, blind.copy, s)).toEqual(LIMIT_DEPENDENTS);
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
