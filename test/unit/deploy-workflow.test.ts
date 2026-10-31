// El deploy en Lightsail (D-29, issues #12, #13, #30 y #34) despliega solo un GitHub Release con
// tag vX.Y.Z sobre un commit de main con el CI en verde, y exactamente ese commit: primero en
// staging y después en producción, en un servidor con dos proyectos de Docker Compose detrás de
// Caddy. Lo frena si no desciende del release que atiende, corre el bootstrap antes de cambiar de
// versión, exige que /health atienda el commit y que pase el smoke funcional (issue #51: el flujo
// de órdenes en staging, con un usuario que existe solo ahí, y lecturas en producción) y, si no,
// vuelve a la versión anterior. Sin red:
//
// 1. .github/workflows/deploy.yml: su disparador, sus jobs y el orden de sus pasos, con un
//    evaluador mínimo de expresiones de GitHub Actions (solo lo que el workflow usa: contextos
//    github.*, env.*, needs.*, steps.* y secrets.*, strings, true/false/null, ==, !=, !, &&, ||
//    y paréntesis; otra sintaxis hace fallar el test, así que cambiarla obliga a mirar este
//    archivo).
// 2. La configuración del servidor (deploy/lightsail/compose.yml, el proxy y el Caddyfile).
// 3. Los scripts que corren esos pasos (deploy/*.sh y deploy/lightsail/*.sh), con `curl`, `gh`,
//    `ssh` y `docker` simulados y repositorios git temporales. El `ssh` simulado corre el comando
//    en la máquina local, así que remote.sh corre de verdad sobre un directorio temporal que hace
//    de /opt/cocos; el `docker` simulado anota cada llamada y qué API atiende cada entorno. El
//    smoke (deploy/smoke.mjs) también es simulado: un `node` que pasa o falla según qué release
//    atiende; el script de verdad lo prueban test/db/smoke y deploy/lightsail/smoke-docker.sh.
// 4. Los jobs staging y production ejecutados paso a paso como los corre GitHub (if, outcome,
//    salidas de los pasos), contra ese servidor simulado.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const yml = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const SCRIPT = join(ROOT, 'deploy/release-check.sh');
const GATE = join(ROOT, 'deploy/release-gate.sh');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
/** Los secretos de un entorno en el servidor, un archivo cada uno (issue #36), como los escribe setup.sh. */
const SECRET_FILES = ['postgres_password', 'database_admin_url', 'api_db_password', 'database_url', 'internal_token'];

/** Valor de la primera clave `key:` del archivo, en una sola línea. */
function valueOf(key: string): string {
  const m = yml.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  if (!m) throw new Error(`deploy.yml no tiene ${key}`);
  return m[1].trim();
}

type Ctx = Record<string, unknown>;

function evaluate(expr: string, ctx: Ctx): unknown {
  const tokens = expr.match(/'[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.-]*|\S+/g) ?? [];
  let i = 0;
  const primary = (): unknown => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('expresión incompleta');
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') throw new Error('falta )');
      return v;
    }
    if (t === '!') return !primary();
    // Funciones de estado del job: success(), failure(), always(), cancelled().
    if (/^(success|failure|always|cancelled)$/.test(t) && tokens[i] === '(' && tokens[i + 1] === ')') {
      i += 2;
      const status = (ctx.job as { status?: string } | undefined)?.status;
      if (status === undefined) throw new Error(`${t}() sin job.status en el contexto`);
      return t === 'always' ? true : t === 'success' ? status === 'success' : t === 'failure' ? status === 'failure' : status === 'cancelled';
    }
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^(github|env|needs|steps|secrets)\./.test(t)) return t.split('.').reduce<unknown>((o, k) => (o as Ctx | undefined)?.[k], ctx);
    throw new Error(`sintaxis no soportada: ${t}`);
  };
  const cmp = (): unknown => {
    let l = primary();
    while (tokens[i] === '==' || tokens[i] === '!=') {
      const op = tokens[i++];
      const r = primary();
      l = op === '==' ? l === r : l !== r;
    }
    return l;
  };
  const and = (): unknown => {
    let l = cmp();
    while (tokens[i] === '&&') { i++; const r = cmp(); l = l && r; }
    return l;
  };
  const or = (): unknown => {
    let l = and();
    while (tokens[i] === '||') { i++; const r = and(); l = l || r; }
    return l;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`sintaxis no soportada: ${tokens.slice(i).join(' ')}`);
  return v;
}

/** `${{ expr }}` → expr */
const inner = (s: string) => {
  const m = s.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  if (!m) throw new Error(`no es una expresión: ${s}`);
  return m[1];
};

const SHA = 'a'.repeat(40);
/** El contexto de un release publicado: github.sha es el commit del tag. */
const released = (tag: string, sha: string) => ({
  github: { sha, ref: `refs/tags/${tag}`, repository: 'dante0x95/cocos-challenge-a', event: { action: 'published', release: { tag_name: tag } } },
});

/** Bloque YAML de un job (indentación de 2 espacios bajo `jobs:`). */
const jobs = yml.slice(yml.indexOf('\njobs:\n') + 1);
const job = (name: string) => {
  const m = jobs.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w+:\\n|$(?![\\s\\S]))`, 'm'));
  if (!m) throw new Error(`deploy.yml no tiene el job ${name}`);
  return m[1];
};
const runsOf = (block: string) => [...block.matchAll(/^\s*run: (.+)$/gm)].map((m) => m[1]);
const keyIn = (block: string, key: string) => block.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1].trim();
/** Clave del job mismo (4 espacios), no de un paso. */
const jobKey = (block: string, key: string) => block.match(new RegExp(`^ {4}${key}:[ \\t]*(.+)$`, 'm'))?.[1].trim();
/** Los pasos de un job, como bloques de texto. */
const stepsOf = (block: string) => block.split(/^ {6}- /m).slice(1);
const step = (block: string, name: string) => {
  const found = stepsOf(block).find((st) => st.startsWith(`name: ${name}\n`));
  if (!found) throw new Error(`no hay un paso "${name}"`);
  return found;
};

/** El bloque `env:` con la clave a `indent` espacios (4: el del job; 8: el de un paso), como objeto. */
const envOf = (block: string, indent: number): Record<string, string> => {
  const m = block.match(new RegExp(`^ {${indent}}env:\\n((?: {${indent + 2}}.+\\n)+)`, 'm'));
  return Object.fromEntries([...(m?.[1] ?? '').matchAll(/^\s*(\w+): (.+)$/gm)].map((e) => [e[1], e[2].trim()]));
};

const URLS: Record<string, string> = {
  staging: 'https://staging.18-227-203-30.sslip.io',
  production: 'https://18-227-203-30.sslip.io',
};
const RUN = {
  access: 'deploy/lightsail/deploy.sh access',
  current: 'deploy/lightsail/deploy.sh current',
  before: 'deploy/release-check.sh before',
  pull: 'deploy/lightsail/deploy.sh pull',
  bootstrap: 'deploy/lightsail/deploy.sh bootstrap',
  smokeUser: 'deploy/lightsail/deploy.sh smoke-user',
  switch: 'deploy/lightsail/deploy.sh switch',
  after: 'deploy/release-check.sh after',
  smokeWrite: 'deploy/smoke.mjs write',
  smokeRead: 'deploy/smoke.mjs read',
  rollback: 'deploy/lightsail/deploy.sh rollback',
};
/**
 * Los pasos de cada entorno, en orden: el bootstrap antes de cambiar, el smoke después de /health
 * y la vuelta atrás al final. El usuario del smoke y el flujo de órdenes, solo en staging;
 * producción corre el smoke de solo lectura.
 */
const FLOWS: Record<string, string[]> = {
  staging: [RUN.access, RUN.current, RUN.before, RUN.pull, RUN.bootstrap, RUN.smokeUser, RUN.switch, RUN.after, RUN.smokeWrite, RUN.rollback],
  production: [RUN.access, RUN.current, RUN.before, RUN.pull, RUN.bootstrap, RUN.switch, RUN.after, RUN.smokeRead, RUN.rollback],
};

describe('workflow de deploy', () => {
  it('el evaluador rechaza lo que no entiende', () => {
    expect(() => evaluate("contains(github.ref, 'main')", {})).toThrow(/sintaxis no soportada/);
    expect(() => evaluate('>-', {})).toThrow(/sintaxis no soportada/);
    expect(() => evaluate('vars.DEPLOY', {})).toThrow(/sintaxis no soportada/);
    expect(() => evaluate('1 == 1', {})).toThrow(/sintaxis no soportada/);
  });

  it('el evaluador interpreta los literales y los contextos', () => {
    const ctx = released('v1.2.3', SHA);
    expect(evaluate("github.event.release.tag_name == 'v1.2.3' && true", ctx)).toBe(true);
    expect(evaluate("github.event.release.tag_name == 'v1.2.4' || false", ctx)).toBe(false);
    expect(evaluate("!(github.event.release.tag_name == null) && github.sha != ''", ctx)).toBe(true);
    expect(evaluate('secrets.X', { secrets: { X: 'x' } })).toBe('x');
  });

  it('lo dispara solo publicar un release: ni workflow_run (el CI de main) ni push', () => {
    const on = yml.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1];
    expect(on).toBe('  release:\n    types: [published]\n');
    expect(yml).not.toMatch(/^\s+(workflow_run|push|pull_request\w*|workflow_dispatch|schedule):/m);
    expect(yml).not.toContain('github.event.workflow_run');
  });

  it('despliega el commit del tag y conoce la versión', () => {
    const sha = 'c'.repeat(40);
    expect(evaluate(inner(valueOf('SHA')), released('v2.0.1', sha))).toBe(sha);
    expect(evaluate(inner(valueOf('TAG')), released('v2.0.1', sha))).toBe('v2.0.1');
    expect(valueOf('IMAGE')).toBe('ghcr.io/${{ github.repository }}');
  });

  // Los scripts y la configuración de cada entorno salen del mismo commit que la imagen.
  it.each(['gate', 'image', 'staging', 'production'])('el job %s hace checkout del commit del release', (name) => {
    const checkouts = stepsOf(job(name)).filter((st) => st.startsWith('uses: actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(keyIn(checkouts[0], 'ref')).toBe('${{ env.SHA }}');
  });

  it('antes de construir, el job gate corre release-gate.sh con la historia completa y permiso para leer los checks', () => {
    const gate = job('gate');
    expect(runsOf(gate)).toEqual(['deploy/release-gate.sh']);
    expect(keyIn(gate, 'fetch-depth')).toBe('0');
    expect(keyIn(gate, 'checks')).toBe('read');
    expect(keyIn(gate, 'GH_TOKEN')).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(keyIn(gate, 'REPO')).toBe('${{ github.repository }}');
    expect(gate).not.toMatch(/packages: write|LIGHTSAIL|docker /);
    expect(statSync(GATE).mode & 0o111).not.toBe(0);
  });

  // Ningún job tiene `if`: con uno (always(), por ejemplo) correría aunque falle un job del que
  // depende. Sin `if`, un gate en rojo deja sin correr todo lo que depende de él, y un staging en
  // rojo deja sin correr producción: publicar el release es la aprobación, y staging es la
  // condición para que llegue a producción.
  it('cuatro etapas en orden: el gate, la imagen una vez, staging con ella y producción con la misma, solo después de staging', () => {
    const names = [...jobs.matchAll(/^  (\w+):\n/gm)].map((m) => m[1]);
    expect(names).toEqual(['gate', 'image', 'staging', 'production']);
    expect(jobKey(job('gate'), 'needs')).toBeUndefined();
    expect(jobKey(job('image'), 'needs')).toBe('gate');
    expect(jobKey(job('staging'), 'needs')).toBe('image');
    expect(jobKey(job('production'), 'needs')).toBe('[image, staging]');
    expect(keyIn(job('staging'), 'name')).toBe('staging');
    expect(keyIn(job('production'), 'name')).toBe('production');
    for (const name of names) expect(jobKey(job(name), 'if')).toBeUndefined();
    // Todos los demás dependen del gate, directa o indirectamente: si falla, no corre ninguno.
    const needs = (name: string) => (jobKey(job(name), 'needs') ?? '').replace(/[[\]]/g, '').split(',').map((n) => n.trim()).filter(Boolean);
    const dependsOnGate = (name: string): boolean => needs(name).some((d) => d === 'gate' || dependsOnGate(d));
    expect(names.filter((n) => n !== 'gate' && !dependsOnGate(n))).toEqual([]);
  });

  it('la imagen lleva la etiqueta del SHA y la de la versión, y se publica con las dos', () => {
    const runs = runsOf(job('image'));
    const build = runs.find((r) => r.startsWith('docker build'))!;
    // Las etiquetas con el entorno de un release v1.4.0.
    const ctx = released('v1.4.0', SHA);
    const env: Record<string, string> = {
      IMAGE: valueOf('IMAGE').replace('${{ github.repository }}', ctx.github.repository),
      SHA: evaluate(inner(valueOf('SHA')), ctx) as string,
      TAG: evaluate(inner(valueOf('TAG')), ctx) as string,
    };
    const expand = (t: string) => t.replace(/\$(\w+)/g, (_m, k: string) => env[k]);
    const tags = [...build.matchAll(/-t "([^"]+)"/g)].map((m) => expand(m[1]));
    expect(tags).toEqual([`ghcr.io/dante0x95/cocos-challenge-a:${SHA}`, 'ghcr.io/dante0x95/cocos-challenge-a:v1.4.0']);
    const pushed = runs.filter((r) => r.startsWith('docker push')).map((r) => expand(r.match(/^docker push "(.+)"$/)![1]));
    expect(pushed).toEqual(tags);
  });

  it('la imagen se construye y publica una sola vez en GHCR; cada entorno la baja, corre el bootstrap y cambia, por SSH', () => {
    expect(runsOf(job('image'))).toEqual([
      'echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin',
      'docker build -t "$IMAGE:$SHA" -t "$IMAGE:$TAG" .',
      'docker push "$IMAGE:$SHA"',
      'docker push "$IMAGE:$TAG"',
      'deploy/image-digest.sh',
    ]);
    expect(keyIn(job('image'), 'packages')).toBe('write');
    for (const name of ['staging', 'production']) {
      expect(job(name)).not.toMatch(/docker build|packages: write/);
      // El token del job alcanza para bajar la imagen privada de GHCR, no para publicarla.
      expect(job(name)).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}packages: read\n {4}\w/m);
      expect(runsOf(job(name))).toEqual(FLOWS[name]);
    }
  });

  // La etiqueta <IMAGE>:<SHA> se puede sobrescribir entre el staging de una corrida y su
  // producción (otra corrida del mismo commit reconstruye y publica); los dos entornos despliegan
  // el digest que entregó el job image de su propia corrida.
  it('staging y producción despliegan el digest que publicó su corrida, aunque la etiqueta cambie después', () => {
    expect(keyIn(step(job('image'), 'Digest de la imagen publicada'), 'id')).toBe('digest');
    expect(job('image')).toMatch(/^ {4}outputs:\n {6}ref: \$\{\{ steps\.digest\.outputs\.ref \}\}$/m);
    const digestA = `ghcr.io/o/r@sha256:${'a'.repeat(64)}`;
    const digestB = `ghcr.io/o/r@sha256:${'b'.repeat(64)}`;
    for (const name of ['staging', 'production']) {
      const ref = envOf(job(name), 4).IMAGE_REF;
      expect(evaluate(inner(ref), { needs: { image: { outputs: { ref: digestA } } } })).toBe(digestA);
      expect(evaluate(inner(ref), { needs: { image: { outputs: { ref: digestB } } } })).toBe(digestB);
      expect(job(name)).not.toMatch(/\$IMAGE:\$SHA/);
    }
    // producción lee las salidas de image: tiene que depender de ese job directamente.
    expect(jobKey(job('production'), 'needs')).toMatch(/\bimage\b/);
  });

  it.each(['staging', 'production'])('%s vuelve a la versión anterior si algo falla desde el cambio, con lo que atendía antes', (name) => {
    const block = job(name);
    expect(keyIn(step(block, 'Release que atiende'), 'id')).toBe('serving');
    expect(keyIn(step(block, 'Cambiar de versión'), 'id')).toBe('deploy');
    const gate = envOf(step(block, 'El commit desciende del release actual'), 8);
    expect(gate).toEqual({ CURRENT: '${{ steps.serving.outputs.release }}', FIRST_DEPLOY: '${{ steps.serving.outputs.first }}' });
    const back = step(block, 'Volver a la versión anterior');
    expect(keyIn(back, 'if')).toBe("failure() && steps.deploy.outcome != 'skipped'");
    expect(envOf(back, 8)).toEqual({
      PREVIOUS_IMAGE: '${{ steps.serving.outputs.image }}',
      PREVIOUS_RELEASE: '${{ steps.serving.outputs.release }}',
      FIRST_DEPLOY: '${{ steps.serving.outputs.first }}',
    });
  });

  it('cada entorno es el suyo en el servidor y verifica contra su propia URL, la que sirve Caddy', () => {
    const caddy = read('deploy/lightsail/proxy/caddy/Caddyfile');
    for (const name of ['staging', 'production']) {
      const block = job(name);
      const env = envOf(block, 4);
      expect(env.ENVIRONMENT).toBe(name);
      expect(env.URL).toBe(URLS[name]);
      expect(keyIn(block, 'url')).toBe(env.URL);
      expect(keyIn(block, 'fetch-depth')).toBe('0');
      // El sitio del Caddyfile con ese nombre pasa a la API de ese entorno (el alias de compose).
      const site = caddy.match(new RegExp(`^${new URL(env.URL).host.replace(/\./g, '\\.')} \\{\\n([\\s\\S]*?)^\\}`, 'm'))?.[1];
      expect(site).toMatch(new RegExp(`^\\treverse_proxy api-${name}:3000 \\{$`, 'm'));
    }
    expect(read('deploy/lightsail/compose.yml')).toContain('aliases: ["api-${ENVIRONMENT:?falta ENVIRONMENT}"]');
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  // Los secretos del servidor van solo al paso que escribe la clave; el GITHUB_TOKEN, solo al que
  // baja la imagen. Ningún otro paso los ve.
  it.each(['staging', 'production'])('en %s, los secretos LIGHTSAIL_* solo los lee el paso de acceso y el token solo el que baja la imagen', (name) => {
    const block = job(name);
    const withSecrets = stepsOf(block).filter((st) => st.includes('secrets.')).map((st) => st.match(/^name: (.+)$/m)?.[1]);
    expect(withSecrets).toEqual(['Acceso SSH al servidor', 'Bajar la imagen']);
    expect(envOf(step(block, 'Acceso SSH al servidor'), 8)).toEqual({
      LIGHTSAIL_HOST: '${{ secrets.LIGHTSAIL_HOST }}',
      LIGHTSAIL_SSH_KEY: '${{ secrets.LIGHTSAIL_SSH_KEY }}',
      LIGHTSAIL_KNOWN_HOSTS: '${{ secrets.LIGHTSAIL_KNOWN_HOSTS }}',
    });
    expect(envOf(step(block, 'Bajar la imagen'), 8)).toEqual({ GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
    expect(envOf(block, 4)).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('no queda nada de Fly', () => {
    expect(yml).not.toMatch(/fly/i);
    for (const f of ['fly.toml', 'deploy/fly']) expect(existsSync(join(ROOT, f))).toBe(false);
  });
});

// Dante crea los secretos: los mismos tres en cada environment (un servidor para los dos). Los
// docs tienen que dar exactamente los nombres que lee el workflow.
describe('secretos de los environments', () => {
  const secrets = [...new Set([...yml.matchAll(/secrets\.(LIGHTSAIL_\w+)/g)].map((m) => m[1]))];

  it('el workflow lee tres secretos del servidor', () => {
    expect(secrets.sort()).toEqual(['LIGHTSAIL_HOST', 'LIGHTSAIL_KNOWN_HOSTS', 'LIGHTSAIL_SSH_KEY']);
  });

  it.each(['README.md', 'docs/api/operacion.md'])('%s: los tres, en los dos environments', (f) => {
    const text = read(f);
    const loop = text.match(/^for env in staging production; do\n([\s\S]*?)^done$/m)?.[1] ?? '';
    const set = [...loop.matchAll(/^ {2}gh secret set (\w+) --env "\$env"/gm)].map((m) => m[1]);
    expect(set.sort()).toEqual(secrets.sort());
  });
});

// La cola del grupo de concurrencia, como la documenta GitHub: con cancel-in-progress la
// corrida nueva cancela la que corre; si no, espera. Con queue: single (el valor por defecto)
// puede haber un solo pendiente y el nuevo cancela al que esperaba; con queue: max esperan
// todos (hasta 100) y arrancan en orden de llegada. Devuelve los commits que llegan a correr.
/** El bloque `concurrency` de un job (6 espacios de indentación), o undefined. */
function concurrencyOf(block: string): Record<string, string> | undefined {
  const m = block.match(/^ {4}concurrency:\n((?: {6}.+\n)+)/m);
  if (!m) return undefined;
  return Object.fromEntries([...m[1].matchAll(/^ {6}([\w-]+): (.+)$/gm)].map((e) => [e[1], e[2].trim()]));
}
const jobBlock = (name: string) => {
  const jobsText = yml.slice(yml.indexOf('\njobs:\n') + 1);
  const m = jobsText.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w+:\\n|$(?![\\s\\S]))`, 'm'));
  if (!m) throw new Error(`deploy.yml no tiene el job ${name}`);
  return m[1];
};
function simulateQueue(c: Record<string, string>, arrivals: string[]): string[] {
  const known = new Set(['group', 'cancel-in-progress', 'queue']);
  for (const k of Object.keys(c)) if (!known.has(k)) throw new Error(`clave de concurrency no soportada: ${k}`);
  const queue = c.queue ?? 'single';
  if (!['single', 'max'].includes(queue)) throw new Error(`queue no soportada: ${queue}`);
  if (queue === 'max' && c['cancel-in-progress'] === 'true') throw new Error('queue: max con cancel-in-progress es inválido');
  const ran: string[] = [];
  let running: string | null = null;
  let pending: string[] = [];
  for (const sha of arrivals) {
    if (running === null) { running = sha; continue; }
    if (c['cancel-in-progress'] === 'true') { running = sha; continue; }
    pending = queue === 'max' ? [...pending, sha].slice(0, 100) : [sha];
  }
  for (let r: string | undefined = running ?? undefined; r !== undefined; r = pending.shift()) ran.push(r);
  return ran;
}

describe('concurrencia del deploy', () => {
  it('el simulador reproduce la cola por defecto: un re-run viejo desplaza al pendiente', () => {
    expect(simulateQueue({ group: 'deploy', 'cancel-in-progress': 'false' }, ['A', 'B', 'viejo'])).toEqual(['A', 'viejo']);
    expect(() => simulateQueue({ group: 'deploy', 'cancel-in-progress': 'true', queue: 'max' }, [])).toThrow(/inválido/);
    expect(() => simulateQueue({ group: 'deploy', otra: 'x' }, [])).toThrow(/no soportada/);
  });

  it.each(['staging', 'production'])(
    'en %s, con A desplegándose y B pendiente, un re-run del deploy de un release viejo no cancela a B', (name) => {
      const c = concurrencyOf(jobBlock(name));
      expect(c?.group).toBe(`deploy-${name}`);
      // A no se corta, B llega a desplegarse, y el viejo corre después (y lo frena el gate).
      expect(simulateQueue(c!, ['A', 'B', 'viejo'])).toEqual(['A', 'B', 'viejo']);
      expect(simulateQueue(c!, ['A', 'B', 'C', 'viejo', 'D'])).toEqual(['A', 'B', 'C', 'viejo', 'D']);
    });

  // Un grupo del workflow lo retiene la corrida entera, también mientras production espera la
  // aprobación: el staging de los releases siguientes quedaría frenado detrás de esa aprobación.
  it('la concurrencia es por entorno: una aprobación pendiente de producción no frena el staging siguiente', () => {
    expect(yml).not.toMatch(/^concurrency:/m);
    expect(concurrencyOf(jobBlock('image'))).toBeUndefined();
    expect(concurrencyOf(jobBlock('staging'))?.group).not.toBe(concurrencyOf(jobBlock('production'))?.group);
  });
});

// La configuración del servidor. Lo único que se publica son los puertos 80 y 443 de Caddy:
// Postgres y la API no tienen `ports`, y la base está solo en la red interna de su proyecto (sin
// salida), así que ni Caddy la alcanza. Postgres usa la imagen de docker compose, con el volumen
// montado donde compose monta el suyo: en postgres:18 el directorio de datos por defecto es
// /var/lib/postgresql/18/docker, dentro de ese montaje; un destino distinto, o un PGDATA que lo
// saque de ahí, dejaría los datos en la capa del contenedor y se perderían al recrearlo.
describe('servidor de Lightsail', () => {
  const env = read('deploy/lightsail/compose.yml');
  const proxy = read('deploy/lightsail/proxy/compose.yml');
  const compose = read('docker-compose.yml');
  /** El bloque de un servicio (2 espacios) de un compose, sin las líneas de comentario. */
  const service = (text: string, name: string) => {
    const m = text.match(new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n|\\s*#.*\\n)+)`, 'm'));
    if (!m) throw new Error(`no hay un servicio ${name}`);
    return m[1].split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  };

  it('Postgres no se publica: ningún servicio del entorno tiene ports y la base no está en la red del proxy', () => {
    expect(env).not.toMatch(/^\s*ports:/m);
    expect(env).not.toMatch(/^\s*network_mode:/m);
    expect(service(env, 'db')).not.toMatch(/networks:|edge/);
    expect(service(env, 'api')).toMatch(/^ {6}edge:$/m);
    // La red propia del proyecto es interna: la base no tiene salida.
    expect(env).toMatch(/^networks:\n {2}default:\n {4}internal: true\n/m);
  });

  it('solo Caddy publica puertos: 80 y 443', () => {
    expect([...proxy.matchAll(/^\s*- "(.+)"$/gm)].map((m) => m[1]).filter((p) => /^\d+:\d+$/.test(p))).toEqual(['80:80', '443:443']);
    expect(service(proxy, 'caddy')).toMatch(/^ {4}networks: \[edge\]$/m);
    expect(proxy).toMatch(/^ {6}- caddy_data:\/data$/m);
  });

  it('Postgres usa la imagen de docker compose, con el volumen donde compose monta el suyo y sin PGDATA', () => {
    const image = (text: string) => service(text, 'db').match(/^ {4}image: (.+)$/m)?.[1];
    const mount = (text: string) => service(text, 'db').match(/^ {6}- pgdata:(\S+)$/m)?.[1];
    expect(image(env)).toBe(image(compose));
    expect(mount(compose)).toBe('/var/lib/postgresql');
    expect(mount(env)).toBe(mount(compose));
    expect(env).not.toMatch(/PGDATA/);
    expect(compose).not.toMatch(/PGDATA/);
  });

  // Issue #36: ningún secreto llega como variable de entorno, que `docker inspect` muestra. Son
  // archivos de secrets/ (los genera setup.sh) montados como secrets de compose, cada uno solo en
  // el servicio que lo usa, que recibe su ruta en <VAR>_FILE. La credencial de administrador de la
  // base la recibe solo el bootstrap (migrate), no la API que atiende.
  const SECRETS: Record<string, Record<string, string>> = {
    db: { POSTGRES_PASSWORD: 'postgres_password' },
    migrate: { DATABASE_ADMIN_URL: 'database_admin_url', API_DB_PASSWORD: 'api_db_password' },
    api: { DATABASE_URL: 'database_url', INTERNAL_TOKEN: 'internal_token' },
  };
  const SECRET_VARS = Object.values(SECRETS).flatMap((s) => Object.keys(s));
  /** Las variables (en mayúsculas, 6 espacios) de environment de un servicio, con su valor. */
  const environment = (block: string) => {
    const m = block.match(/^ {4}environment:\n((?: {6}.*\n)+)/m);
    return Object.fromEntries([...(m?.[1] ?? '').matchAll(/^ {6}([A-Z][A-Z0-9_]*): (.*)$/gm)].map((x) => [x[1], x[2]]));
  };
  const mounted = (block: string) => block.match(/^ {4}secrets: \[(.*)\]$/m)?.[1].split(', ') ?? [];

  it('ningún servicio recibe un secreto en environment ni en env_file: solo la ruta en <VAR>_FILE', () => {
    expect(env).not.toMatch(/env_file/);
    for (const [name, secrets] of Object.entries(SECRETS)) {
      const vars = environment(service(env, name));
      for (const v of SECRET_VARS) expect(vars, `${name}: ${v}`).not.toHaveProperty(v);
      for (const [v, secret] of Object.entries(secrets)) expect(vars[`${v}_FILE`], `${name}: ${v}_FILE`).toBe(`/run/secrets/${secret}`);
    }
  });

  it('cada servicio monta solo sus secretos, de un archivo de secrets/ cada uno; la API nunca la credencial de administrador', () => {
    for (const [name, secrets] of Object.entries(SECRETS)) expect(mounted(service(env, name)), name).toEqual(Object.values(secrets));
    expect(service(proxy, 'caddy')).not.toMatch(/secrets/);
    const top = env.match(/^secrets:\n((?: {2}.*\n?)+)/m)?.[1] ?? '';
    const files = Object.fromEntries([...top.matchAll(/^ {2}(\w+):\n {4}file: (\S+)$/gm)].map((x) => [x[1], x[2]]));
    const all = Object.values(SECRETS).flatMap((s) => Object.values(s));
    expect(files).toEqual(Object.fromEntries(all.map((s) => [s, `secrets/${s}`])));
    expect(service(env, 'api')).not.toMatch(/DATABASE_ADMIN_URL|database_admin_url|POSTGRES_PASSWORD|postgres_password|API_DB_PASSWORD|api_db_password/);
  });

  // Sin Swarm, compose monta cada secreto con el dueño y el modo del servidor. setup.sh deja 600
  // los que lee root (el entrypoint de Postgres, antes de bajar a postgres) y 640 con el grupo de
  // node los de los servicios que corren con la imagen de la API (USER node, gid 1000 en
  // node:22-alpine; drill-docker.sh lo verifica con Docker real). Las listas tienen que coincidir.
  it('setup.sh y remote.sh conocen los mismos secretos que compose.yml, con los permisos de quien los lee', () => {
    const setup = read('deploy/lightsail/setup.sh');
    const list = (name: string) => setup.match(new RegExp(`^${name}=\\((.*)\\)$`, 'm'))?.[1].split(' ');
    expect(list('ROOT_SECRETS')).toEqual(mounted(service(env, 'db')));
    expect(list('APP_SECRETS')).toEqual([...mounted(service(env, 'migrate')), ...mounted(service(env, 'api'))]);
    expect(setup).toMatch(/^APP_GID=1000$/m);
    const dockerfile = read('Dockerfile');
    expect(dockerfile.match(/^FROM (\S+)$/gm)?.at(-1)).toBe('FROM node:22-alpine');
    expect(dockerfile).toMatch(/^USER node$/m);
    const remote = read('deploy/lightsail/remote.sh').match(/for f in (.*); do\n\s+\[ -f "\$DIR\/secrets\/\$f" \]/)?.[1].split(' ');
    expect(remote?.sort()).toEqual([...list('ROOT_SECRETS')!, ...list('APP_SECRETS')!].sort());
  });

  // Ni la API ni el bootstrap bajan imágenes (no hay credenciales de GHCR acá).
  it('la API y el bootstrap corren con la imagen del release, sin bajarla', () => {
    expect(service(env, 'migrate')).toMatch(/^ {4}command: \["node", "dist\/db\/bootstrap\.js"\]$/m);
    expect(service(env, 'migrate')).toMatch(/^ {4}profiles: \[migrate\]$/m);
    for (const s of ['api', 'migrate']) {
      expect(service(env, s)).toMatch(/^ {4}image: \$\{IMAGE:\?falta IMAGE\}$/m);
      expect(service(env, s)).toMatch(/^ {4}pull_policy: never$/m);
    }
    expect(service(env, 'api')).toMatch(/^ {6}RELEASE: \$\{RELEASE:\?falta RELEASE\}$/m);
  });

  it('la base, la API y Caddy vuelven solos después de reiniciar el servidor', () => {
    for (const s of ['db', 'api']) expect(service(env, s)).toMatch(/^ {4}restart: unless-stopped$/m);
    expect(service(proxy, 'caddy')).toMatch(/^ {4}restart: unless-stopped$/m);
  });
});

// deploy/release-check.sh. before, con CURRENT y FIRST_DEPLOY (lo que atiende, leído del servidor)
// y un repositorio temporal; after, con un curl simulado: responde, en orden, cada línea de
// RESPONSES (una por llamada; una línea `!<código>` falla con ese código de salida) y cuenta las
// llamadas en CALLS. `sleep` también se simula: anota cuánto durmió y no espera.
describe('release-check.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'prueba',
    GIT_AUTHOR_EMAIL: 'prueba@example.com',
    GIT_COMMITTER_NAME: 'prueba',
    GIT_COMMITTER_EMAIL: 'prueba@example.com',
  };

  const tmp = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  const stubs = (responses: string[]) => {
    const dir = tmp('release-check-');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const responsesFile = join(dir, 'responses');
    const callsFile = join(dir, 'calls');
    const sleepsFile = join(dir, 'sleeps');
    writeFileSync(responsesFile, responses.join('\n') + '\n');
    writeFileSync(callsFile, '');
    writeFileSync(sleepsFile, '');
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      `echo "$*" >> '${callsFile}'`,
      `n=$(wc -l < '${callsFile}')`,
      `line=$(sed -n "\${n}p" '${responsesFile}')`,
      'case "$line" in',
      '  "!"*) echo "curl: simulado: falla" >&2; exit "${line#!}" ;;',
      '  *) printf "%s" "$line" ;;',
      'esac',
    ].join('\n') + '\n');
    writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> '${sleepsFile}'\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    return {
      bin,
      calls: () => readFileSync(callsFile, 'utf8').split('\n').filter(Boolean),
      sleeps: () => readFileSync(sleepsFile, 'utf8').split('\n').filter(Boolean),
    };
  };

  const check = (mode: string, bin: string, env: Record<string, string>, cwd = ROOT) =>
    spawnSync('bash', [SCRIPT, mode], {
      cwd,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/', ...GIT_ENV, ...env },
    });

  const health = (release: string | null, ok = true) =>
    JSON.stringify(ok ? { ok, db: 'up', release, users: '4' } : { ok, db: 'down', release });

  /** Repositorio con tres commits en línea: devuelve sus SHA en orden. */
  const repoWithThreeCommits = () => {
    const repo = tmp('release-check-repo-');
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    const shas: string[] = [];
    for (const n of ['uno', 'dos', 'tres']) {
      writeFileSync(join(repo, 'f'), n);
      git('add', 'f');
      git('commit', '-q', '--no-verify', '-m', n);
      shas.push(git('rev-parse', 'HEAD'));
    }
    return { repo, shas };
  };

  it('sin modo, o sin SHA o URL, no hace nada y sale con 2 o con 1', () => {
    const { bin, calls } = stubs([]);
    expect(check('', bin, { SHA, URL: 'https://x.sslip.io' }).status).toBe(2);
    expect(check('after', bin, { URL: 'https://x.sslip.io' }).status).toBe(1);
    expect(check('after', bin, { SHA }).status).toBe(1);
    expect(calls()).toEqual([]);
  });

  describe('before: el commit a desplegar desciende del release que atiende', () => {
    const before = (repo: string, sha: string, current: string, first = 'false') =>
      check('before', stubs([]).bin, { SHA: sha, CURRENT: current, FIRST_DEPLOY: first }, repo);

    it('despliega un commit posterior al release actual, sin mirar /health', () => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin, calls } = stubs([]);
      const r = check('before', bin, { SHA: shas[2], CURRENT: shas[1], FIRST_DEPLOY: 'false' }, repo);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`${shas[2]} desciende de ${shas[1]}`);
      expect(calls()).toEqual([]);
    });

    it('frena un commit anterior al release actual: un release viejo (un re-run) no pisa uno nuevo', () => {
      const { repo, shas } = repoWithThreeCommits();
      const r = before(repo, shas[0], shas[2]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`DEPLOY FRENADO: ${shas[0]} no desciende del release actual (${shas[2]})`);
    });

    it('frena un commit de otra rama, aunque el release sea un ancestro de la base', () => {
      const { repo, shas } = repoWithThreeCommits();
      const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).stdout.trim();
      git('checkout', '-q', '-b', 'otra', shas[0]);
      writeFileSync(join(repo, 'f'), 'otra');
      git('commit', '-q', '--no-verify', '-am', 'otra');
      expect(before(repo, git('rev-parse', 'HEAD'), shas[1]).status).toBe(1);
    });

    it('vuelve a desplegar el mismo commit', () => {
      const { repo, shas } = repoWithThreeCommits();
      const r = before(repo, shas[2], shas[2]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('se vuelve a desplegar el mismo commit');
    });

    it('el primer deploy del entorno (sin release) pasa', () => {
      const { repo, shas } = repoWithThreeCommits();
      const r = before(repo, shas[0], '', 'true');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`primer deploy de ${shas[0]}`);
    });

    // Un release vacío solo cuenta como "no hay" si el paso que lo leyó lo dijo: si su salida no
    // llegó, el gate no puede saber qué atiende y no deja pasar.
    it.each([
      ['un release vacío sin FIRST_DEPLOY', '', ''],
      ['un release vacío con FIRST_DEPLOY=false', '', 'false'],
      ['un release con FIRST_DEPLOY=true', 'x', 'true'],
    ])('frena con %s', (_name, current, first) => {
      const { repo, shas } = repoWithThreeCommits();
      const r = before(repo, shas[2], current === 'x' ? shas[1] : current, first);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no se sabe qué release atiende el entorno');
    });

    it('frena con un release que no está en la historia', () => {
      const { repo, shas } = repoWithThreeCommits();
      const r = before(repo, shas[2], 'f'.repeat(40));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no está en la historia/);
    });
  });

  describe('after: /health atiende el commit desplegado', () => {
    const env = { SHA, URL: 'https://x.sslip.io', HEALTH_ATTEMPTS: '4', HEALTH_INTERVAL: '7' };
    const OLD = 'b'.repeat(40);

    it('reintenta mientras release sea el anterior y termina bien cuando atiende el SHA', () => {
      const { bin, calls, sleeps } = stubs([health(OLD), health(OLD), health(SHA)]);
      const r = check('after', bin, env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`atiende ${SHA} con ok: true (intento 3 de 4)`);
      expect(calls()).toEqual(Array(3).fill('-sS --max-time 10 https://x.sslip.io/health'));
      expect(sleeps()).toEqual(['7', '7']);
    });

    it('con el release anterior en todos los intentos, falla al llegar al límite', () => {
      const { bin, calls, sleeps } = stubs([health(OLD), health(OLD), health(OLD), health(OLD), health(SHA)]);
      const r = check('after', bin, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`después de 4 intentos /health no atiende ${SHA} con ok: true`);
      expect(calls()).toHaveLength(4);
      expect(sleeps()).toEqual(['7', '7', '7']);    // no duerme después del último
    });

    it('un error de transporte o un 503 con el SHA también se reintentan: no es curl --retry', () => {
      const { bin, calls } = stubs(['!7', health(SHA, false), '', health(SHA)]);
      const r = check('after', bin, env);
      expect(r.status).toBe(0);
      expect(calls()).toHaveLength(4);
    });

    it('ok: false con el SHA correcto no alcanza', () => {
      const { bin } = stubs([health(SHA, false), health(SHA, false), health(SHA, false), health(SHA, false)]);
      expect(check('after', bin, env).status).toBe(1);
    });

    it('por defecto son 30 intentos cada 5 segundos', () => {
      const { bin, calls, sleeps } = stubs(Array(40).fill(health(OLD)));
      const r = check('after', bin, { SHA, URL: 'https://x.sslip.io' });
      expect(r.status).toBe(1);
      expect(calls()).toHaveLength(30);
      expect(sleeps()).toEqual(Array(29).fill('5'));
    });
  });
});

// Scripts con dependencias externas simuladas: un `bin` con ejecutables que anotan sus
// argumentos (y su stdin) y responden lo que cada caso necesita.
function fakeBin(scripts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-fake-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  return { dir, bin, log, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}
const runScript = (script: string, args: string[], bin: string, env: Record<string, string>, cwd = ROOT) =>
  spawnSync('bash', [join(ROOT, script), ...args], {
    cwd, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/', ...env },
  });

describe('image-digest.sh', () => {
  const IMAGE = 'ghcr.io/dante0x95/cocos-challenge-a';
  const digest = (c: string) => `sha256:${c.repeat(64)}`;
  const withDocker = (repoDigests: string[]) => fakeBin({
    docker: `echo "$*" >> "$CALLS"\nprintf '%s\\n' ${repoDigests.map((d) => `'${d}'`).join(' ')}`,
  });

  it('entrega la referencia por digest del repo de la imagen y la escribe en $GITHUB_OUTPUT', () => {
    const f = withDocker([`ghcr.io/otro/repo@${digest('c')}`, `${IMAGE}@${digest('a')}`]);
    const out = join(f.dir, 'output');
    const r = runScript('deploy/image-digest.sh', [], f.bin, { IMAGE, SHA, GITHUB_OUTPUT: out, CALLS: f.log });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${IMAGE}@${digest('a')}`);
    expect(readFileSync(out, 'utf8')).toBe(`ref=${IMAGE}@${digest('a')}\n`);
    expect(f.calls()).toEqual([`inspect --format {{range .RepoDigests}}{{println .}}{{end}} ${IMAGE}:${SHA}`]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('cada publicación da su propio digest: la etiqueta sobrescrita no cambia el de una corrida anterior', () => {
    const refs = ['a', 'b'].map((c) => {
      const f = withDocker([`${IMAGE}@${digest(c)}`]);
      const r = runScript('deploy/image-digest.sh', [], f.bin, { IMAGE, SHA, CALLS: f.log });
      rmSync(f.dir, { recursive: true, force: true });
      return r.stdout.trim();
    });
    expect(refs).toEqual([`${IMAGE}@${digest('a')}`, `${IMAGE}@${digest('b')}`]);
  });

  it.each([
    ['sin digest (la imagen no se publicó)', []],
    ['solo digests de otro repo', [`ghcr.io/otro/repo@${digest('a')}`]],
    ['un digest que no es sha256 de 64 hex', [`${IMAGE}@sha256:abc`]],
  ])('falla %s y no escribe nada', (_name, repoDigests) => {
    const f = withDocker(repoDigests as string[]);
    const out = join(f.dir, 'output');
    writeFileSync(out, '');
    const r = runScript('deploy/image-digest.sh', [], f.bin, { IMAGE, SHA, GITHUB_OUTPUT: out, CALLS: f.log });
    expect(r.status).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('');
    rmSync(f.dir, { recursive: true, force: true });
  });
});

// deploy/release-gate.sh en un repositorio temporal: main con tres commits (origin/main en el
// último), una rama `otra` con un commit fuera de main y tags sobre ellos. `gh` responde, en
// orden, cada línea de RESPONSES (la última se repite; `!<código>` falla con ese código) y anota
// sus argumentos; `sleep` anota cuánto durmió y no espera.
describe('release-gate.sh', () => {
  const REPO = 'dante0x95/cocos-challenge-a';
  const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'prueba',
    GIT_AUTHOR_EMAIL: 'prueba@example.com', GIT_COMMITTER_NAME: 'prueba', GIT_COMMITTER_EMAIL: 'prueba@example.com' };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** shas: los tres de main y `other`, el de la rama. Tags: v1.0.0 → main[0], v1.1.0 (anotado) → main[2], v2.0.0 → other. */
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-gate-repo-'));
    dirs.push(dir);
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    const main: string[] = [];
    for (const n of ['uno', 'dos', 'tres']) {
      writeFileSync(join(dir, 'f'), n);
      git('add', 'f');
      git('commit', '-q', '--no-verify', '-m', n);
      main.push(git('rev-parse', 'HEAD'));
    }
    git('checkout', '-q', '-b', 'otra', main[1]);
    writeFileSync(join(dir, 'f'), 'otra');
    git('commit', '-q', '--no-verify', '-am', 'otra');
    const other = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', main[2]);
    git('tag', 'v1.0.0', main[0]);
    git('tag', '-a', 'v1.1.0', '-m', 'v1.1.0', main[2]);
    git('tag', 'v2.0.0', other);
    return { dir, main, other };
  };

  const checkRun = (id: number, status: string, conclusion: string | null, app = 'github-actions') =>
    ({ id, name: 'ci', status, conclusion, started_at: '2026-10-30T12:00:00Z', app: { slug: app } });
  const checks = (...runs: ReturnType<typeof checkRun>[]) => JSON.stringify({ total_count: runs.length, check_runs: runs });
  const green = checks(checkRun(1, 'completed', 'success'));

  const gate = (env: Record<string, string>, responses: string[], cwd: string) => {
    const f = fakeBin({
      gh: [
        'echo "gh $*" >> "$CALLS"',
        'n=$(grep -c "^gh " "$CALLS")',
        'total=$(wc -l < "$RESPONSES")',
        '[ "$n" -le "$total" ] || n=$total',
        'line=$(sed -n "${n}p" "$RESPONSES")',
        'case "$line" in "!"*) echo "gh: simulado: falla" >&2; exit "${line#!}" ;; *) printf "%s" "$line" ;; esac',
      ].join('\n'),
      sleep: 'echo "sleep $1" >> "$CALLS"',
    });
    dirs.push(f.dir);
    const responsesFile = join(f.dir, 'responses');
    writeFileSync(responsesFile, responses.join('\n') + '\n');
    const r = runScript('deploy/release-gate.sh', [], f.bin,
      { ...GIT, REPO, CALLS: f.log, RESPONSES: responsesFile, CI_ATTEMPTS: '4', CI_INTERVAL: '7', ...env }, cwd);
    const calls = f.calls();
    return { ...r, gh: calls.filter((c) => c.startsWith('gh ')), sleeps: calls.filter((c) => c.startsWith('sleep ')).map((c) => c.slice(6)) };
  };
  const apiCall = (sha: string) => `gh api repos/${REPO}/commits/${sha}/check-runs?check_name=ci&per_page=100`;

  it('deja pasar un tag vX.Y.Z de main con el ci en verde, también anotado', () => {
    const { dir, main } = repo();
    for (const [tag, sha] of [['v1.0.0', main[0]], ['v1.1.0', main[2]]]) {
      const r = gate({ TAG: tag, SHA: sha }, [green], dir);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`${tag} (${sha}): vX.Y.Z, en main y con ci en verde: se despliega`);
      expect(r.gh).toEqual([apiCall(sha)]);
    }
  });

  it.each(['1.1.0', 'v1.1', 'v1.1.0-rc.1', 'v1.1.0+build', 'v01.1.0', 'v1.1.0.0', 'V1.1.0', 'release-1', 'v1.1.0 ', ''])(
    'frena el tag inválido "%s" sin mirar git ni el ci', (tag) => {
      // Un directorio que no es un repositorio: el formato se mira antes que git.
      const dir = mkdtempSync(join(tmpdir(), 'release-gate-empty-'));
      dirs.push(dir);
      const r = gate({ TAG: tag, SHA }, [green], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(tag === '' ? /falta TAG/ : /DEPLOY FRENADO: el tag '.*' no es vX\.Y\.Z/);
      expect(r.gh).toEqual([]);
    });

  it('frena un tag sobre un commit que no está en main, sin mirar el ci', () => {
    const { dir, other } = repo();
    const r = gate({ TAG: 'v2.0.0', SHA: other }, [green], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`DEPLOY FRENADO: v2.0.0 (${other}) no está en main`);
    expect(r.gh).toEqual([]);
  });

  it('frena un tag que apunta a otro commit que el del release (se movió), o que no existe', () => {
    const { dir, main } = repo();
    const moved = gate({ TAG: 'v1.0.0', SHA: main[2] }, [green], dir);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain(`el tag v1.0.0 apunta a ${main[0]} y el release se publicó sobre ${main[2]}`);
    const missing = gate({ TAG: 'v9.9.9', SHA: main[2] }, [green], dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('el tag v9.9.9 no está en este checkout');
    expect([...moved.gh, ...missing.gh]).toEqual([]);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'])(
    'frena un commit con el ci en %s, sin esperar', (conclusion) => {
      const { dir, main } = repo();
      const r = gate({ TAG: 'v1.1.0', SHA: main[2] }, [checks(checkRun(1, 'completed', conclusion))], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`DEPLOY FRENADO: el ci de ${main[2]} terminó en ${conclusion}`);
      expect(r.gh).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    });

  it('vale el último ci (id mayor): un re-run en verde despliega, un re-run en rojo no', () => {
    const { dir, main } = repo();
    const fixed = gate({ TAG: 'v1.1.0', SHA: main[2] },
      [checks(checkRun(9, 'completed', 'success'), checkRun(3, 'completed', 'failure'))], dir);
    expect(fixed.status).toBe(0);
    const broken = gate({ TAG: 'v1.1.0', SHA: main[2] },
      [checks(checkRun(3, 'completed', 'success'), checkRun(9, 'completed', 'failure'))], dir);
    expect(broken.status).toBe(1);
  });

  it('espera mientras el ci no empezó o corre, y despliega cuando termina en verde', () => {
    const { dir, main } = repo();
    const r = gate({ TAG: 'v1.1.0', SHA: main[2] },
      [checks(), checks(checkRun(1, 'in_progress', null)), checks(checkRun(1, 'queued', null)), green], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('intento 1 de 4: ci de');
    expect(r.gh).toHaveLength(4);
    expect(r.sleeps).toEqual(['7', '7', '7']);
  });

  it('frena un commit sin ci al llegar al límite; un check ci de otra app no cuenta', () => {
    const { dir, main } = repo();
    const r = gate({ TAG: 'v1.1.0', SHA: main[2] }, [checks(checkRun(1, 'completed', 'success', 'otra-app'))], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`después de 4 intentos el ci de ${main[2]} no terminó en verde (sigue sin correr)`);
    expect(r.gh).toHaveLength(4);
    expect(r.sleeps).toEqual(['7', '7', '7']);    // no duerme después del último
  });

  it('por defecto espera 40 intentos cada 30 segundos', () => {
    const { dir, main } = repo();
    const r = gate({ TAG: 'v1.1.0', SHA: main[2], CI_ATTEMPTS: '', CI_INTERVAL: '' }, [checks(checkRun(1, 'in_progress', null))], dir);
    expect(r.status).toBe(1);
    expect(r.gh).toHaveLength(40);
    expect(r.sleeps).toEqual(Array(39).fill('30'));
  });

  it('frena si no puede leer el ci, o sin SHA o REPO', () => {
    const { dir, main } = repo();
    const r = gate({ TAG: 'v1.1.0', SHA: main[2] }, ['!1'], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no se pudo leer el check ci de ${main[2]}`);
    expect(gate({ TAG: 'v1.1.0' }, [green], dir).status).toBe(1);
    expect(gate({ TAG: 'v1.1.0', SHA: main[2], REPO: '' }, [green], dir).gh).toEqual([]);
  });
});

// El servidor simulado: un directorio que hace de /opt/cocos (COCOS_ROOT), preparado como lo
// deja setup.sh, y un repositorio git con una copia de deploy/ y tres commits. `ssh` corre el
// comando que recibe en esta máquina (con el stdin que recibe), así que remote.sh corre de verdad.
// `docker` anota cada llamada (con IMAGE y RELEASE del --env-file, si hay) y lleva en
// <entorno>/.running qué API atiende: `up ... api` la cambia, `rm ... api` la saca. `curl` responde
// /health de esa API: ok con su RELEASE (o con SERVED, si está: otro release atendiendo), salvo
// que esté en BROKEN (503, ok: false), y falla sin API.
// DOCKER_FAIL (una regex sobre la llamada, con IMAGE y RELEASE) hace fallar las que coinciden.
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'prueba',
  GIT_AUTHOR_EMAIL: 'prueba@example.com', GIT_COMMITTER_NAME: 'prueba', GIT_COMMITTER_EMAIL: 'prueba@example.com' };
const TOKEN = 'ghs_tokenDelJobQueNoTieneQueQuedar0123456789';
/** Una cadena como literal de una regex (ERE de bash o de JS). */
const ere = (t: string) => t.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&');
const imageOf = (c: string) => `ghcr.io/dante0x95/cocos-challenge-a@sha256:${c.repeat(64)}`;

function server() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-server-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'opt-cocos');
  const repo = join(dir, 'repo');
  const calls = join(dir, 'calls');
  for (const d of [bin, root, join(dir, 'tmp'), join(dir, 'home'), join(dir, 'runner')]) mkdirSync(d);
  writeFileSync(calls, '');
  const scripts: Record<string, string> = {
    ssh: [
      // Las opciones y el host se anotan en CALLS; el comando (el último argumento, con el script
      // entero) en CALLS.ssh, que también se revisa: un secreto ahí estaría en los argumentos de
      // ssh y del bash remoto. Corre acá, con el stdin que recibió.
      'cmd="${*: -1}"',
      'echo "ssh ${*:1:$#-1}" >> "$CALLS"',
      'printf "%s\\n" "$cmd" >> "$CALLS.ssh"',
      'exec bash -c "$cmd"',
    ].join('\n'),
    docker: [
      'line="$*"; envfile=""; project=""; a=("$@")',
      'for ((i = 0; i < ${#a[@]}; i++)); do case "${a[i]}" in --env-file) envfile="${a[i+1]}" ;; -p) project="${a[i+1]}" ;; esac; done',
      'if [ -n "$envfile" ]; then image="$(sed -n "s/^IMAGE=//p" "$envfile")"; release="$(sed -n "s/^RELEASE=//p" "$envfile")"; line="$line [IMAGE=$image RELEASE=$release]"; fi',
      'echo "docker $line" >> "$CALLS"',
      'if [ -n "${DOCKER_FAIL:-}" ] && [[ "$line" =~ $DOCKER_FAIL ]]; then echo "docker simulado: falla: $line" >&2; exit 1; fi',
      'env="${project#cocos-}"',
      'case "$1" in',
      // Como docker: la credencial va a config.json del DOCKER_CONFIG (o de ~/.docker).
      '  login) cfg="${DOCKER_CONFIG:-$HOME/.docker}"; mkdir -p "$cfg"; printf \'{"auths":{"ghcr.io":{"auth":"%s"}}}\' "$(cat)" > "$cfg/config.json" ;;',
      '  compose)',
      '    case " $* " in',
      // psql en el contenedor de la base (remote.sh smoke-user): anota el SQL y responde un id.
      '      *" exec -T db psql "*) cat > "$CALLS.sql.$env"; printf "%s\\n" "${SMOKE_DB_USERID-41}" ;;',
      '      *" up "*" api "*) printf "%s %s\\n" "$image" "$release" > "$COCOS_ROOT/$env/.running" ;;',
      '      *" rm "*" api "*) rm -f "$COCOS_ROOT/$env/.running" ;;',
      '    esac ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    curl: [
      'url="${*: -1}"',
      'echo "curl $url" >> "$CALLS"',
      'case "$url" in *//staging.*) env=staging ;; *) env=production ;; esac',
      'f="$COCOS_ROOT/$env/.running"',
      '[ -f "$f" ] || { echo "curl: (7) sin API" >&2; exit 7; }',
      'release="${SERVED:-$(cut -d" " -f2 "$f")}"',
      'if [[ " ${BROKEN:-} " == *" $release "* ]]; then printf \'{"ok":false,"db":"down","release":"%s"}\' "$release";',
      'else printf \'{"ok":true,"db":"up","release":"%s","users":"4"}\' "$release"; fi',
    ].join('\n'),
    sleep: ':',
    // deploy/smoke.mjs corre con `node` (su shebang): este lo anota con URL, SHA y SMOKE_USERID y
    // pasa si la API de ese entorno atiende, salvo que su release esté en SMOKE_BROKEN.
    node: [
      'echo "node $* [URL=${URL:-} SHA=${SHA:-} SMOKE_USERID=${SMOKE_USERID:-}]" >> "$CALLS"',
      'case "${URL:-}" in *//staging.*) env=staging ;; *) env=production ;; esac',
      'f="$COCOS_ROOT/$env/.running"',
      '[ -f "$f" ] || { echo "SMOKE FALLIDO: simulado: sin API" >&2; exit 1; }',
      'release="$(cut -d" " -f2 "$f")"',
      'if [[ " ${SMOKE_BROKEN:-} " == *" $release "* ]]; then echo "SMOKE FALLIDO: simulado" >&2; exit 1; fi',
      'echo "== SMOKE OK (simulado)"',
    ].join('\n'),
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // Lo que deja setup.sh en cada entorno: un archivo por secreto.
  for (const env of ['staging', 'production']) {
    mkdirSync(join(root, env, 'secrets'), { recursive: true });
    for (const f of SECRET_FILES) writeFileSync(join(root, env, 'secrets', f), `${f}-secreto`, { mode: 0o600 });
  }
  // El checkout del release: deploy/ del commit actual y tres commits en línea.
  cpSync(join(ROOT, 'deploy'), join(repo, 'deploy'), { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (const n of ['uno', 'dos', 'tres']) {
    writeFileSync(join(repo, 'f'), n);
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', n);
    shas.push(git('rev-parse', 'HEAD'));
  }
  const baseEnv = {
    PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), ...GIT,
    CALLS: calls, COCOS_ROOT: root, RUNNER_TEMP: join(dir, 'runner'), HEALTH_ATTEMPTS: '2',
    GITHUB_ACTOR: 'dante0x95', COMPOSE_WAIT_TIMEOUT: '7',
  };
  const secrets = { LIGHTSAIL_HOST: '203.0.113.7', LIGHTSAIL_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nclave\n-----END OPENSSH PRIVATE KEY-----', LIGHTSAIL_KNOWN_HOSTS: '203.0.113.7 ssh-ed25519 AAAAhost', GITHUB_TOKEN: TOKEN };
  return {
    dir, root, repo, shas, secrets,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    clearCalls: () => writeFileSync(calls, ''),
    running: (env: string) => (existsSync(join(root, env, '.running')) ? readFileSync(join(root, env, '.running'), 'utf8').trim() : null),
    state: (env: string, file = 'release.env') => (existsSync(join(root, env, file)) ? readFileSync(join(root, env, file), 'utf8') : null),
    /** El SQL que recibió psql en la base de ese entorno (remote.sh smoke-user), o null. */
    sql: (env: string) => (existsSync(`${calls}.sql.${env}`) ? readFileSync(`${calls}.sql.${env}`, 'utf8') : null),
    /** deploy.sh o release-check.sh en el checkout, con el entorno de un paso. */
    run: (cmd: string, env: Record<string, string>, input?: string) =>
      spawnSync('bash', ['-c', cmd], { cwd: repo, encoding: 'utf8', input, env: { ...baseEnv, ...env } }),
    /** Todos los archivos que quedaron, en el servidor y en el runner, con su contenido. */
    files: () => {
      const out: { path: string; text: string }[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) { if (p !== join(repo, '.git')) walk(p); } else out.push({ path: p, text: readFileSync(p, 'utf8') });
        }
      };
      walk(dir);
      return out;
    },
  };
}
type Server = ReturnType<typeof server>;
const releaseEnv = (image: string, sha: string, env: string) => `IMAGE=${image}\nRELEASE=${sha}\nENVIRONMENT=${env}\n`;

/**
 * Un job de deploy ejecutado como lo corre GitHub: cada paso con su `if` (por defecto success()),
 * el entorno del workflow, del job y del paso (con sus expresiones evaluadas: env.*, needs.*,
 * secrets.* y las salidas de los pasos anteriores, leídas de $GITHUB_OUTPUT), y el `run` de
 * verdad en el checkout del servidor simulado. Devuelve los `run` que corrieron y cómo terminó.
 */
function execJob(s: Server, name: string, sha: string, image: string, extra: Record<string, string> = {}) {
  const block = job(name);
  const steps: Record<string, { outcome: string; outputs: Record<string, string> }> = {};
  const ctx = (): Ctx => ({ env: { SHA: sha, TAG: 'v1.0.0' }, needs: { image: { outputs: { ref: image } } }, secrets: s.secrets, steps });
  const resolveAll = (vars: Record<string, string>) =>
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.startsWith('${{') ? String(evaluate(inner(v), ctx()) ?? '') : v]));
  let status = 'success';
  const ran: string[] = [];
  const output = join(s.dir, 'github-output');
  for (const st of stepsOf(block)) {
    const run = keyIn(st, 'run');
    let outcome = 'skipped';
    const outputs: Record<string, string> = {};
    if (evaluate(keyIn(st, 'if') ?? 'success()', { job: { status }, steps })) {
      outcome = 'success';
      if (run) {
        ran.push(run);
        writeFileSync(output, '');
        const r = s.run(run, { SHA: sha, ...resolveAll(envOf(block, 4)), ...resolveAll(envOf(st, 8)), GITHUB_OUTPUT: output, ...extra });
        for (const m of readFileSync(output, 'utf8').matchAll(/^(\w+)=(.*)$/gm)) outputs[m[1]] = m[2];
        if (r.status !== 0) { outcome = 'failure'; status = 'failure'; }
      }
    }
    const id = keyIn(st, 'id');
    if (id) steps[id] = { outcome, outputs };
  }
  return { ran, status };
}

describe.each(['staging', 'production'])('el job %s contra el servidor simulado', (name) => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) rmSync(s.dir, { recursive: true, force: true });
  });
  const fresh = () => { const s = server(); servers.push(s); return s; };
  const DEPLOY_FLOW = FLOWS[name];
  /** Los pasos hasta `last`, incluido, en el orden del entorno. */
  const upTo = (last: string) => DEPLOY_FLOW.slice(0, DEPLOY_FLOW.indexOf(last) + 1);
  const [I0, I1, I2] = [imageOf('a'), imageOf('b'), imageOf('c')];

  it('el primer deploy y uno posterior: cada uno corre el bootstrap con su imagen antes de cambiar la API, y atiende su commit', () => {
    const s = fresh();
    const first = execJob(s, name, s.shas[0], I0);
    expect(first).toEqual({ ran: DEPLOY_FLOW.slice(0, -1), status: 'success' });
    expect(s.running(name)).toBe(`${I0} ${s.shas[0]}`);
    expect(s.state(name)).toBe(releaseEnv(I0, s.shas[0], name));

    s.clearCalls();
    expect(execJob(s, name, s.shas[2], I2)).toEqual({ ran: DEPLOY_FLOW.slice(0, -1), status: 'success' });
    expect(s.running(name)).toBe(`${I2} ${s.shas[2]}`);
    expect(s.state(name, 'release.previous.env')).toBe(releaseEnv(I0, s.shas[0], name));
    // En el servidor: bajar la imagen, la base, el bootstrap con la imagen nueva y recién después
    // la API, en el proyecto del entorno.
    const docker = s.calls().filter((c) => c.startsWith('docker '));
    const tag = `[IMAGE=${I2} RELEASE=${s.shas[2]}]`;
    expect(docker.map((c) => c.replace(/ -p cocos-\w+ --project-directory \S+ -f \S+ --env-file \S+/, ''))).toEqual([
      `docker login ghcr.io -u dante0x95 --password-stdin`,
      `docker pull -q ${I2}`,
      `docker image inspect ${I2}`,
      `docker compose up -d --wait --wait-timeout 7 db ${tag}`,
      `docker compose run --rm -T --no-deps -e RELEASE=${s.shas[2]} -e SERVING_RELEASE=${s.shas[0]} migrate ${tag}`,
      // Solo staging: el usuario del smoke, con psql en la base, antes de cambiar la API.
      ...(name === 'staging' ? [`docker compose exec -T db psql -U postgres -d cocos -X -q -A -t -v ON_ERROR_STOP=1 -1 -f - ${tag}`] : []),
      `docker compose up -d --wait --wait-timeout 7 --no-deps api ${tag}`,
    ]);
    expect(docker.slice(3).every((c) => c.includes(` -p cocos-${name} --project-directory ${join(s.root, name)} `))).toBe(true);
    // Lo que se instaló es el compose.yml del commit.
    expect(s.state(name, 'compose.yml')).toBe(read('deploy/lightsail/compose.yml'));
  });

  it('si /health no atiende el commit nuevo, vuelve a la imagen y el release anteriores y el job queda en rojo', () => {
    const s = fresh();
    execJob(s, name, s.shas[0], I0);
    s.clearCalls();
    const r = execJob(s, name, s.shas[1], I1, { BROKEN: s.shas[1] });
    expect(r).toEqual({ ran: [...upTo(RUN.after), RUN.rollback], status: 'failure' });
    expect(s.running(name)).toBe(`${I0} ${s.shas[0]}`);
    expect(s.state(name)).toBe(releaseEnv(I0, s.shas[0], name));
    // La vuelta atrás recrea la API con la imagen anterior, sin correr el bootstrap anterior, y
    // verifica que /health atienda otra vez el release anterior.
    const after = s.calls().slice(s.calls().findIndex((c) => c.includes(`--no-deps api [IMAGE=${I1}`)) + 1);
    expect(after.filter((c) => c.startsWith('docker '))).toEqual([
      expect.stringMatching(new RegExp(`up -d --wait --wait-timeout 7 --no-deps api \\[IMAGE=${ere(I0)} RELEASE=${s.shas[0]}\\]$`)),
    ]);
    expect(after.filter((c) => c.startsWith('curl')).at(-1)).toBe(`curl ${URLS[name]}/health`);
  });

  // Issue #39, plan de pruebas 4: el contrato que exige el bootstrap es el del release que
  // atiende (SERVING_RELEASE, de release.env), no el del último bootstrap. Después de una vuelta
  // atrás, el release siguiente se verifica contra el restaurado; test/bootstrap/contract prueba
  // con Postgres real que ese contrato sigue registrado y que el restaurado sigue escribiendo.
  it('después de una vuelta atrás, el bootstrap siguiente recibe como SERVING_RELEASE el release restaurado, no el que falló', () => {
    const s = fresh();
    const migrate = () => s.calls().filter((c) => / run --rm .* migrate /.test(c))
      .map((c) => /-e RELEASE=(\S*) -e SERVING_RELEASE=(\S*) migrate /.exec(c)!.slice(1));
    execJob(s, name, s.shas[0], I0);
    expect(migrate()).toEqual([[s.shas[0], '']]);   // primer deploy: no atiende ninguno

    s.clearCalls();
    expect(execJob(s, name, s.shas[1], I1, { BROKEN: s.shas[1] }).status).toBe('failure');
    expect(migrate()).toEqual([[s.shas[1], s.shas[0]]]);
    expect(s.running(name)).toBe(`${I0} ${s.shas[0]}`);

    s.clearCalls();
    expect(execJob(s, name, s.shas[2], I2).status).toBe('success');
    expect(migrate()).toEqual([[s.shas[2], s.shas[0]]]);
    expect(s.running(name)).toBe(`${I2} ${s.shas[2]}`);
  });

  it('si la API nueva no queda sana al cambiar, vuelve a la anterior', () => {
    const s = fresh();
    execJob(s, name, s.shas[0], I0);
    const r = execJob(s, name, s.shas[1], I1, { DOCKER_FAIL: `--no-deps api \\[IMAGE=${ere(I1)}` });
    expect(r).toEqual({ ran: [...upTo(RUN.switch), RUN.rollback], status: 'failure' });
    expect(s.running(name)).toBe(`${I0} ${s.shas[0]}`);
    expect(s.state(name)).toBe(releaseEnv(I0, s.shas[0], name));
  });

  it('si el bootstrap falla, no cambia de versión ni vuelve atrás: sigue la API anterior', () => {
    const s = fresh();
    execJob(s, name, s.shas[0], I0);
    s.clearCalls();
    const r = execJob(s, name, s.shas[1], I1, { DOCKER_FAIL: 'run --rm' });
    expect(r).toEqual({ ran: upTo(RUN.bootstrap), status: 'failure' });
    expect(s.calls().some((c) => / api \[/.test(c))).toBe(false);
    expect(s.running(name)).toBe(`${I0} ${s.shas[0]}`);
    expect(s.state(name)).toBe(releaseEnv(I0, s.shas[0], name));
  });

  it('un release anterior al que atiende (un re-run viejo) se frena antes de bajar nada: el servidor no cambia', () => {
    const s = fresh();
    execJob(s, name, s.shas[2], I2);
    s.clearCalls();
    const r = execJob(s, name, s.shas[0], I0);
    expect(r).toEqual({ ran: upTo(RUN.before), status: 'failure' });
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
    expect(s.running(name)).toBe(`${I2} ${s.shas[2]}`);
    expect(s.state(name)).toBe(releaseEnv(I2, s.shas[2], name));
  });

  it('con un release.env inválido en el servidor, el job frena antes de bajar nada y la API sigue', () => {
    const s = fresh();
    execJob(s, name, s.shas[2], I2);
    writeFileSync(join(s.root, name, 'release.env'), `IMAGE=${I2}\nENVIRONMENT=${name}\n`);
    s.clearCalls();
    const r = execJob(s, name, s.shas[0], I0);
    expect(r).toEqual({ ran: upTo(RUN.current), status: 'failure' });
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
    expect(s.running(name)).toBe(`${I2} ${s.shas[2]}`);
  });

  // La vuelta atrás termina bien solo si /health, por la URL pública, atiende otra vez el release
  // anterior: si sigue caída, o atiende otro release, el paso falla y no dice que volvió.
  it.each([
    ['/health sigue fallando', (prev: string) => ({ BROKEN: prev })],
    ['/health atiende otro release', () => ({ SERVED: 'f'.repeat(40) })],
  ])('si después de volver %s, la vuelta atrás falla', (_label, health) => {
    const s = fresh();
    execJob(s, name, s.shas[0], I0);
    const step = (cmd: string, env: Record<string, string>, input?: string) =>
      s.run(cmd, { ENVIRONMENT: name, URL: URLS[name], IMAGE_REF: I1, SHA: s.shas[1], ...env }, input);
    expect(step('deploy/lightsail/deploy.sh bootstrap', {}, read('deploy/lightsail/compose.yml')).status).toBe(0);
    expect(step('deploy/lightsail/deploy.sh switch', {}).status).toBe(0);
    const r = step('deploy/lightsail/deploy.sh rollback',
      { FIRST_DEPLOY: 'false', PREVIOUS_IMAGE: I0, PREVIOUS_RELEASE: s.shas[0], ...health(s.shas[0]) });
    // El servidor sí volvió (la API anterior corre), pero desde afuera no se confirma.
    expect(s.running(name)).toBe(`${I0} ${s.shas[0]}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`/health no atiende ${s.shas[0]}`);
    expect(r.stdout).not.toContain('atiende otra vez');
  });

  it('el mismo commit se puede volver a desplegar', () => {
    const s = fresh();
    execJob(s, name, s.shas[1], I1);
    expect(execJob(s, name, s.shas[1], I1).status).toBe('success');
  });

  it('si el primer deploy falla, saca la API y el entorno queda sin release: el siguiente vuelve a ser el primero', () => {
    const s = fresh();
    const r = execJob(s, name, s.shas[1], I1, { BROKEN: s.shas[1] });
    expect(r).toEqual({ ran: [...upTo(RUN.after), RUN.rollback], status: 'failure' });
    expect(s.running(name)).toBeNull();
    expect(s.state(name)).toBeNull();
    expect(execJob(s, name, s.shas[0], I0).status).toBe('success');
  });

  it('el token del job no queda en el servidor ni en ningún argumento', () => {
    const s = fresh();
    execJob(s, name, s.shas[0], I0);
    expect(s.calls().filter((c) => c.includes(TOKEN))).toEqual([]);
    // Los archivos incluyen CALLS.ssh: los comandos remotos, con sus argumentos.
    expect(readFileSync(`${join(s.dir, 'calls')}.ssh`, 'utf8')).toContain(' pull ');
    expect(s.files().filter((f) => f.text.includes(TOKEN)).map((f) => f.path)).toEqual([]);
    // docker login lo recibió (por stdin) en una configuración temporal, que ya no está.
    const login = s.calls().find((c) => c.startsWith('docker login'))!;
    expect(login).toBe('docker login ghcr.io -u dante0x95 --password-stdin');
    expect(readdirSync(join(s.dir, 'tmp'))).toEqual([]);
    expect(existsSync(join(s.dir, 'home', '.docker'))).toBe(false);
  });

  it('el entorno no toca al otro', () => {
    const s = fresh();
    execJob(s, name, s.shas[0], I0);
    const other = name === 'staging' ? 'production' : 'staging';
    expect(s.state(other)).toBeNull();
    expect(s.calls().filter((c) => c.includes(`cocos-${other}`) || c.includes(join(s.root, other)))).toEqual([]);
  });
});

// Issue #51, plan de pruebas 3 y 4: el smoke funcional después del cambio, contra la URL pública.
// En staging, el flujo de órdenes con el usuario que prepara smoke-user (antes del cambio); si
// falla, la vuelta atrás, y el job en rojo deja producción sin desplegar. En producción, solo
// lecturas, sin usuario del smoke.
describe('el smoke funcional en el deploy', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) rmSync(s.dir, { recursive: true, force: true });
  });
  const fresh = () => { const s = server(); servers.push(s); return s; };
  const [I0, I1] = [imageOf('a'), imageOf('b')];
  const smokeCalls = (s: Server) => s.calls().filter((c) => c.startsWith('node '));

  it('los pasos: staging prepara el usuario del smoke y corre el flujo con él; producción, solo lecturas', () => {
    const user = step(job('staging'), 'Usuario del smoke');
    expect(keyIn(user, 'id')).toBe('smoke');
    expect(keyIn(user, 'if')).toBeUndefined();
    expect(envOf(step(job('staging'), 'Smoke funcional'), 8)).toEqual({ SMOKE_USERID: '${{ steps.smoke.outputs.userid }}' });
    expect(keyIn(step(job('staging'), 'Smoke funcional'), 'if')).toBeUndefined();
    const readOnly = step(job('production'), 'Smoke de solo lectura');
    expect(keyIn(readOnly, 'if')).toBeUndefined();
    expect(envOf(readOnly, 8)).toEqual({});
    expect(job('production')).not.toMatch(/smoke-user|SMOKE_USERID|smoke\.mjs write/);
    // Node para el smoke, de la misma acción que el CI.
    const ciSetup = read('.github/workflows/ci.yml').match(/^ {6}- (uses: actions\/setup-node@.+)$/m)![1];
    for (const name of ['staging', 'production']) {
      const setup = stepsOf(job(name)).filter((st) => st.startsWith('uses: actions/setup-node@'));
      expect(setup).toHaveLength(1);
      expect(keyIn(setup[0], 'node-version')).toBe('22');
      expect(setup[0].split('\n')[0]).toBe(ciSetup);
    }
    expect(statSync(join(ROOT, 'deploy/smoke.mjs')).mode & 0o111).not.toBe(0);
    expect(read('deploy/smoke.mjs').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('staging: el usuario del smoke antes del cambio, y el smoke después de /health, con ese usuario y por la URL de staging', () => {
    const s = fresh();
    expect(execJob(s, 'staging', s.shas[0], I0, { SMOKE_DB_USERID: '57' })).toEqual({ ran: FLOWS.staging.slice(0, -1), status: 'success' });
    expect(smokeCalls(s)).toEqual([`node deploy/smoke.mjs write [URL=${URLS.staging} SHA=${s.shas[0]} SMOKE_USERID=57]`]);
    // psql recibe el SQL del commit, en la base de staging, después del bootstrap y antes de la API.
    expect(s.sql('staging')).toBe(read('deploy/lightsail/smoke-user.sql'));
    const calls = s.calls();
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    expect(at(/ run --rm .* migrate /)).toBeLessThan(at(/ exec -T db psql /));
    expect(at(/ exec -T db psql /)).toBeLessThan(at(/ --no-deps api /));
    expect(calls.length - 1 - [...calls].reverse().findIndex((c) => c.startsWith('curl '))).toBeLessThan(at(/^node /));
    expect(calls.find((c) => / exec -T db psql /.test(c))).toContain(' -p cocos-staging ');
  });

  it('staging: un smoke fallido vuelve a la versión anterior, el job queda en rojo y producción no corre', () => {
    const s = fresh();
    execJob(s, 'staging', s.shas[0], I0);
    s.clearCalls();
    const r = execJob(s, 'staging', s.shas[1], I1, { SMOKE_BROKEN: s.shas[1] });
    expect(r).toEqual({ ran: FLOWS.staging, status: 'failure' });
    expect(s.running('staging')).toBe(`${I0} ${s.shas[0]}`);
    expect(s.state('staging')).toBe(releaseEnv(I0, s.shas[0], 'staging'));
    // El smoke corrió contra el release nuevo, ya atendiendo; la vuelta atrás, después.
    expect(smokeCalls(s)).toEqual([`node deploy/smoke.mjs write [URL=${URLS.staging} SHA=${s.shas[1]} SMOKE_USERID=41]`]);
    // Producción depende de staging sin `if`: con staging en rojo, GitHub no la corre.
    expect(jobKey(job('production'), 'needs')).toMatch(/\bstaging\b/);
    expect(jobKey(job('production'), 'if')).toBeUndefined();
    expect(s.state('production')).toBeNull();
  });

  it('staging: si el primer deploy falla en el smoke, la API sale y el entorno queda sin release', () => {
    const s = fresh();
    const r = execJob(s, 'staging', s.shas[0], I0, { SMOKE_BROKEN: s.shas[0] });
    expect(r).toEqual({ ran: FLOWS.staging, status: 'failure' });
    expect(s.running('staging')).toBeNull();
    expect(s.state('staging')).toBeNull();
  });

  it('staging: si no se puede preparar el usuario del smoke, no cambia de versión ni vuelve atrás', () => {
    const s = fresh();
    execJob(s, 'staging', s.shas[0], I0);
    s.clearCalls();
    const r = execJob(s, 'staging', s.shas[1], I1, { DOCKER_FAIL: 'exec -T db psql' });
    expect(r).toEqual({ ran: FLOWS.staging.slice(0, FLOWS.staging.indexOf(RUN.smokeUser) + 1), status: 'failure' });
    expect(s.calls().some((c) => / api \[/.test(c))).toBe(false);
    expect(smokeCalls(s)).toEqual([]);
    expect(s.running('staging')).toBe(`${I0} ${s.shas[0]}`);
  });

  it('producción: solo el smoke de lectura, sin usuario del smoke ni escrituras', () => {
    const s = fresh();
    expect(execJob(s, 'production', s.shas[0], I0)).toEqual({ ran: FLOWS.production.slice(0, -1), status: 'success' });
    expect(smokeCalls(s)).toEqual([`node deploy/smoke.mjs read [URL=${URLS.production} SHA=${s.shas[0]} SMOKE_USERID=]`]);
    expect(s.calls().filter((c) => /psql|smoke-user/.test(c))).toEqual([]);
    // Los argumentos de remote.sh van después del script (citado): ninguna llamada es smoke-user.
    expect(readFileSync(`${join(s.dir, 'calls')}.ssh`, 'utf8')).not.toMatch(/' remote\.sh smoke-user /);
    expect(readFileSync(`${join(s.dir, 'calls')}.ssh`, 'utf8')).toMatch(/' remote\.sh switch production /);
    expect(s.sql('production')).toBeNull();
  });

  it('producción: un smoke de lectura fallido vuelve a la versión anterior', () => {
    const s = fresh();
    execJob(s, 'production', s.shas[0], I0);
    const r = execJob(s, 'production', s.shas[1], I1, { SMOKE_BROKEN: s.shas[1] });
    expect(r).toEqual({ ran: FLOWS.production, status: 'failure' });
    expect(s.running('production')).toBe(`${I0} ${s.shas[0]}`);
  });
});

describe('deploy.sh y remote.sh', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) rmSync(s.dir, { recursive: true, force: true });
  });
  const fresh = () => { const s = server(); servers.push(s); return s; };
  const I0 = imageOf('a');
  const access = (s: Server, env: Record<string, string> = {}) =>
    s.run('deploy/lightsail/deploy.sh access', { ENVIRONMENT: 'staging', ...s.secrets, ...env });

  it('access: la clave y el host fijado quedan en RUNNER_TEMP, con permisos 600, y ssh los usa', () => {
    const s = fresh();
    expect(access(s).status).toBe(0);
    const d = join(s.dir, 'runner', 'lightsail');
    expect(readFileSync(join(d, 'key'), 'utf8')).toBe(`${s.secrets.LIGHTSAIL_SSH_KEY}\n`);
    expect(readFileSync(join(d, 'known_hosts'), 'utf8')).toBe(`${s.secrets.LIGHTSAIL_KNOWN_HOSTS}\n`);
    for (const f of ['key', 'known_hosts', 'config']) expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
    const config = readFileSync(join(d, 'config'), 'utf8');
    for (const line of ['HostName 203.0.113.7', 'User deploy', `IdentityFile ${d}/key`, 'IdentitiesOnly yes',
      `UserKnownHostsFile ${d}/known_hosts`, 'StrictHostKeyChecking yes', 'BatchMode yes']) {
      expect(config).toContain(`  ${line}\n`);
    }
    s.run('deploy/lightsail/deploy.sh current', { ENVIRONMENT: 'staging' });
    expect(s.calls()).toEqual([`ssh -F ${d}/config lightsail`]);
  });

  it.each(['LIGHTSAIL_HOST', 'LIGHTSAIL_SSH_KEY', 'LIGHTSAIL_KNOWN_HOSTS'])('access frena sin %s', (secret) => {
    const s = fresh();
    const r = access(s, { [secret]: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`falta el secreto ${secret}`);
  });

  it('current: sin release, first=true; con release, la imagen y el commit; sin setup.sh, frena', () => {
    const s = fresh();
    access(s);
    const out = join(s.dir, 'out');
    const current = (env: string) => {
      writeFileSync(out, '');
      const r = s.run('deploy/lightsail/deploy.sh current', { ENVIRONMENT: env, GITHUB_OUTPUT: out });
      return { ...r, output: readFileSync(out, 'utf8') };
    };
    expect(current('staging').output).toBe('release=\nimage=\nfirst=true\n');
    writeFileSync(join(s.root, 'staging', 'release.env'), releaseEnv(I0, s.shas[0], 'staging'));
    expect(current('staging').output).toBe(`release=${s.shas[0]}\nimage=${I0}\nfirst=false\n`);
    rmSync(join(s.root, 'production', 'secrets', 'internal_token'));
    const r = current('production');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('el servidor no está preparado');
    expect(r.output).toBe('');
  });

  // Un release.env que existe pero no dice qué atiende no es un primer deploy: si lo fuera, el gate
  // dejaría pasar cualquier commit y la vuelta atrás sacaría la API.
  it.each([
    ['vacío', ''],
    ['sin RELEASE', `IMAGE=${imageOf('a')}\nENVIRONMENT=staging\n`],
    ['sin IMAGE', `RELEASE=${'a'.repeat(40)}\nENVIRONMENT=staging\n`],
    ['con un RELEASE que no es un SHA', `IMAGE=${imageOf('a')}\nRELEASE=main\nENVIRONMENT=staging\n`],
    ['con dos RELEASE', `IMAGE=${imageOf('a')}\nRELEASE=${'a'.repeat(40)}\nRELEASE=${'b'.repeat(40)}\n`],
  ])('current frena con un release.env %s, sin escribir salidas', (_name, content) => {
    const s = fresh();
    access(s);
    writeFileSync(join(s.root, 'staging', 'release.env'), content);
    const out = join(s.dir, 'out');
    writeFileSync(out, '');
    const r = s.run('deploy/lightsail/deploy.sh current', { ENVIRONMENT: 'staging', GITHUB_OUTPUT: out });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no tiene un RELEASE y una IMAGE válidos');
    expect(readFileSync(out, 'utf8')).toBe('');
  });

  it('switch sin el bootstrap de esa imagen y ese commit no toca la API', () => {
    const s = fresh();
    access(s);
    const r = s.run('deploy/lightsail/deploy.sh switch', { ENVIRONMENT: 'staging', IMAGE_REF: I0, SHA: s.shas[0] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no terminó bien en staging');
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
  });

  // Un bootstrap que falla deja escritos el compose y el release.env nuevos (los necesita para
  // correr), pero no la confirmación: un switch posterior de esa misma versión se rechaza.
  it.each([
    ['la base no queda sana', 'up -d --wait --wait-timeout [0-9]+ db'],
    ['migrate falla', 'run --rm'],
  ])('si el bootstrap falla porque %s, un switch posterior de esa versión no toca la API ni el estado', (_name, failing) => {
    const s = fresh();
    access(s);
    const deploy = (cmd: string, sha: string, image: string, env: Record<string, string> = {}) =>
      s.run(`deploy/lightsail/deploy.sh ${cmd}`, { ENVIRONMENT: 'staging', IMAGE_REF: image, SHA: sha, ...env }, cmd === 'bootstrap' ? read('deploy/lightsail/compose.yml') : undefined);
    expect(deploy('bootstrap', s.shas[0], I0).status).toBe(0);
    expect(deploy('switch', s.shas[0], I0).status).toBe(0);
    const I1 = imageOf('b');
    expect(deploy('bootstrap', s.shas[1], I1, { DOCKER_FAIL: failing }).status).toBe(1);
    expect(existsSync(join(s.root, 'staging', 'release.next.env'))).toBe(true);
    s.clearCalls();
    const r = deploy('switch', s.shas[1], I1);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no terminó bien en staging');
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
    expect(s.running('staging')).toBe(`${I0} ${s.shas[0]}`);
    expect(s.state('staging')).toBe(releaseEnv(I0, s.shas[0], 'staging'));
  });

  it('la confirmación del bootstrap sirve para un solo switch: otro cambio necesita otro bootstrap', () => {
    const s = fresh();
    access(s);
    const env = { ENVIRONMENT: 'staging', IMAGE_REF: I0, SHA: s.shas[0] };
    expect(s.run('deploy/lightsail/deploy.sh bootstrap', env, read('deploy/lightsail/compose.yml')).status).toBe(0);
    expect(s.run('deploy/lightsail/deploy.sh switch', env).status).toBe(0);
    expect(existsSync(join(s.root, 'staging', 'bootstrap.ok'))).toBe(false);
    expect(s.run('deploy/lightsail/deploy.sh switch', env).status).toBe(1);
  });

  it('bootstrap frena sin la imagen bajada, sin tocar la base', () => {
    const s = fresh();
    access(s);
    const r = s.run('deploy/lightsail/deploy.sh bootstrap', { ENVIRONMENT: 'staging', IMAGE_REF: I0, SHA: s.shas[0], DOCKER_FAIL: '^image inspect' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('falta el paso pull');
    expect(s.calls().filter((c) => c.startsWith('docker compose'))).toEqual([]);
  });

  it.each([
    ['una imagen por etiqueta', 'ghcr.io/o/r:v1', 'a'.repeat(40), 'no es una referencia por digest'],
    ['un commit que no es un SHA', imageOf('a'), 'main', 'no es el SHA de un commit'],
  ])('remote.sh rechaza %s', (_name, ref, sha, message) => {
    const s = fresh();
    access(s);
    const r = s.run('deploy/lightsail/deploy.sh bootstrap', { ENVIRONMENT: 'staging', IMAGE_REF: ref, SHA: sha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
  });

  it('remote.sh rechaza un entorno desconocido', () => {
    const s = fresh();
    access(s);
    const r = s.run('deploy/lightsail/deploy.sh current', { ENVIRONMENT: 'otro' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("entorno desconocido: 'otro'");
  });

  // La vuelta atrás sin la salida de current (o con una que no cierra) no adivina: no toca nada.
  it.each([
    ['sin FIRST_DEPLOY', { PREVIOUS_IMAGE: imageOf('a'), PREVIOUS_RELEASE: 'a'.repeat(40) }],
    ['primer deploy con un release anterior', { FIRST_DEPLOY: 'true', PREVIOUS_IMAGE: imageOf('a'), PREVIOUS_RELEASE: 'a'.repeat(40) }],
    ['sin release anterior y FIRST_DEPLOY=false', { FIRST_DEPLOY: 'false' }],
  ])('rollback no toca nada %s', (_name, env) => {
    const s = fresh();
    access(s);
    s.clearCalls();
    const r = s.run('deploy/lightsail/deploy.sh rollback', { ENVIRONMENT: 'staging', URL: URLS.staging, ...env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no se sabe a qué volver');
    expect(s.calls()).toEqual([]);
  });

  it('rollback frena si ni lo que atiende ni lo guardado como anterior es el release anterior', () => {
    const s = fresh();
    access(s);
    writeFileSync(join(s.root, 'staging', 'release.env'), releaseEnv(imageOf('c'), s.shas[2], 'staging'));
    s.clearCalls();
    const r = s.run('deploy/lightsail/deploy.sh rollback', { ENVIRONMENT: 'staging', URL: URLS.staging,
      FIRST_DEPLOY: 'false', PREVIOUS_IMAGE: I0, PREVIOUS_RELEASE: s.shas[0] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no se toca nada');
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
  });
});

// deploy.sh smoke-user y remote.sh smoke-user (issue #51): el usuario del smoke existe solo en
// staging. Producción se frena en los dos lados, antes de tocar la base.
describe('smoke-user', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) rmSync(s.dir, { recursive: true, force: true });
  });
  const I0 = imageOf('a');
  /** Un servidor con el bootstrap de I0 terminado en `env` (lo que exige smoke-user). */
  const bootstrapped = (env = 'staging') => {
    const s = server();
    servers.push(s);
    s.run('deploy/lightsail/deploy.sh access', { ENVIRONMENT: env, ...s.secrets });
    const r = s.run('deploy/lightsail/deploy.sh bootstrap', { ENVIRONMENT: env, IMAGE_REF: I0, SHA: s.shas[0] }, read('deploy/lightsail/compose.yml'));
    expect(r.status).toBe(0);
    s.clearCalls();
    return s;
  };
  const smokeUser = (s: Server, env: Record<string, string> = {}) => {
    const out = join(s.dir, 'out');
    writeFileSync(out, '');
    const r = s.run('deploy/lightsail/deploy.sh smoke-user', { ENVIRONMENT: 'staging', GITHUB_OUTPUT: out, ...env });
    return { ...r, output: readFileSync(out, 'utf8') };
  };

  it('en staging, después del bootstrap: el id que devuelve psql queda en userid= de $GITHUB_OUTPUT', () => {
    const s = bootstrapped();
    const r = smokeUser(s, { SMOKE_DB_USERID: '73' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.output).toBe('userid=73\n');
    expect(r.stdout).toContain('usuario del smoke en staging: 73');
    expect(s.sql('staging')).toBe(read('deploy/lightsail/smoke-user.sql'));
    // No consume la confirmación del bootstrap: el switch sigue habilitado.
    expect(s.run('deploy/lightsail/deploy.sh switch', { ENVIRONMENT: 'staging', IMAGE_REF: I0, SHA: s.shas[0] }).status).toBe(0);
  });

  it('en producción frena en deploy.sh, sin SSH, y remote.sh también lo rechaza sin tocar la base', () => {
    const s = bootstrapped('production');
    const r = smokeUser(s, { ENVIRONMENT: 'production' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('el usuario del smoke existe solo en staging, no en production');
    expect(s.calls()).toEqual([]);
    const direct = s.run('bash deploy/lightsail/remote.sh smoke-user production', {}, read('deploy/lightsail/smoke-user.sql'));
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain("el usuario del smoke existe solo en staging, no en 'production'");
    expect(s.calls()).toEqual([]);
    expect(s.sql('production')).toBeNull();
  });

  it('sin un bootstrap terminado, no toca la base', () => {
    const s = server();
    servers.push(s);
    s.run('deploy/lightsail/deploy.sh access', { ENVIRONMENT: 'staging', ...s.secrets });
    s.clearCalls();
    const r = smokeUser(s);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('el usuario del smoke va después del paso bootstrap');
    expect(s.calls().filter((c) => c.startsWith('docker '))).toEqual([]);
    expect(r.output).toBe('');
  });

  it.each([['vacía', ''], ['que no es un id', 'ERROR'], ['con dos ids', '7\n8']])('frena con una respuesta de psql %s, sin escribir userid', (_name, answer) => {
    const s = bootstrapped();
    const r = smokeUser(s, { SMOKE_DB_USERID: answer });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no devolvió un id');
    expect(r.output).toBe('');
  });
});

// deploy/lightsail/smoke-docker.sh, el smoke del CI, con un `docker` simulado que lleva qué
// alias hay en cada red ($CALLS.net.<red>: "alias proyecto" por línea; la API entra a las redes de
// su compose al hacer `up` y sale con `down`). Usa su propio proyecto (cocos-smoke-staging, nunca
// cocos-staging ni cocos) y su propia red externa (cocos-smoke-edge): el api-staging de un staging
// local en cocos-edge sigue siendo el único destino de ese nombre. El registro es el candado: si
// otra ejecución lo tiene, no sigue ni borra nada ajeno. Corre bootstrap, smoke-user y switch de
// remote.sh y el smoke dos veces con el mismo usuario; si la API no queda sana (una imagen que no
// arranca), no corre el smoke, falla y limpia solo lo suyo.
describe('smoke-docker.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const DIGEST = `localhost:5056/cocos-smoke@sha256:${'d'.repeat(64)}`;
  const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  /** Un staging local ya levantado: su API, con el alias api-staging, en cocos-edge, que usa su Caddy. */
  const EXISTING_EDGE = 'api-staging cocos-staging\ncaddy cocos-proxy\n';
  const run = (env: Record<string, string> = {}) => {
    const f = fakeBin({
      docker: [
        'echo "docker $*" >> "$CALLS"',
        '[ -n "${FAIL:-}" ] && [[ "$*" =~ $FAIL ]] && { echo "docker simulado: falla: $*" >&2; exit 1; }',
        'file=""; project=""; a=("$@")',
        'for ((i = 0; i < ${#a[@]}; i++)); do case "${a[i]}" in -f) file="${a[i+1]}" ;; -p) project="${a[i+1]}" ;; esac; done',
        'case "$*" in',
        '  *"ps -aq --filter label=com.docker.compose.project=cocos-smoke-staging") printf "%s" "${PS_PROJECT:-}" ;;',
        '  *"volume ls -q --filter name=cocos-smoke-staging_") printf "%s" "${VOL_NAME:-}" ;;',
        '  *"network ls -q --filter name=^cocos-smoke-edge$") printf "%s" "${NET_EDGE:-}" ;;',
        // El nombre de un contenedor es único: si otra ejecución ya lo tomó, create falla.
        '  "create --name cocos-smoke-registry "*) [ -z "${REGISTRY_TAKEN:-}" ] || { echo "Conflict: name in use" >&2; exit 1; }; echo reg123 ;;',
        '  "run -d --name cocos-smoke-registry "*) [ -z "${REGISTRY_TAKEN:-}" ] || { echo "Conflict: name in use" >&2; exit 1; } ;;',
        '  "network create "*) touch "$CALLS.net.$3"; echo net456 ;;',
        `  "image inspect --format"*) echo '${DIGEST}' ;;`,
        '  *" exec -T db psql "*) cat >/dev/null; n=$(grep -c " exec -T db psql " "$CALLS"); if [ "$n" = 1 ]; then echo 31; else echo "${SECOND_ID:-31}"; fi ;;',
        // La API entra a la red interna de su proyecto y a la red edge de su compose, con su alias
        // (API_EXTRA_NET: además a otra, como si el compose la nombrara).
        '  "compose "*" up "*" api") cp "$file" "$CALLS.compose"; edge="$(sed -n "s/^    name: //p" "$file")"',
        '    for n in "$edge" ${API_EXTRA_NET:-}; do sed -i.bak "/ $project\\$/d" "$CALLS.net.$n" 2>/dev/null || true; echo "api-staging $project" >> "$CALLS.net.$n"; done',
        '    printf "%s\\n" "${project}_default" "$edge" ${API_EXTRA_NET:-} > "$CALLS.api-nets" ;;',
        '  "compose "*" ps -q api") echo api789 ;;',
        '  "inspect -f "*" api789") cat "$CALLS.api-nets" ;;',
        '  "compose "*" down -v") for n in "$CALLS".net.*; do case "$n" in *.bak) ;; *) sed -i.bak "/ $project\\$/d" "$n" ;; esac; done ;;',
        '  *"/smoke/smoke.mjs "*) [ -z "${SMOKE_FAIL:-}" ] || exit 1 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    });
    dirs.push(f.dir);
    writeFileSync(`${f.log}.net.cocos-edge`, EXISTING_EDGE);
    const r = runScript('deploy/lightsail/smoke-docker.sh', ['cocos:ci'], f.bin, { CALLS: f.log, TMPDIR: f.dir, ...env });
    const calls = f.calls();
    const net = (name: string) => (existsSync(`${f.log}.net.${name}`) ? readFileSync(`${f.log}.net.${name}`, 'utf8') : null);
    const compose = existsSync(`${f.log}.compose`) ? readFileSync(`${f.log}.compose`, 'utf8') : null;
    return { ...r, calls, net, compose,
      smokes: calls.filter((c) => c.includes('/smoke/smoke.mjs')).map((c) => c.split(' ').slice(-2).join(' ')),
      removed: calls.filter((c) => /^docker (rm|rmi|network rm|volume rm) |^docker compose .* down/.test(c)),
      leftovers: readdirSync(f.dir).filter((e) => e !== 'bin' && !e.startsWith('calls')) };
  };

  it('sin la imagen local no empieza', () => {
    const r = run({ FAIL: '^image inspect cocos:ci$' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no está la imagen cocos:ci');
    expect(r.calls).toEqual(['docker image inspect cocos:ci']);
  });

  it.each([
    ['contenedores del proyecto', { PS_PROJECT: 'abc' }, 'contenedores del proyecto cocos-smoke-staging'],
    ['un volumen del proyecto', { VOL_NAME: 'cocos-smoke-staging_pgdata' }, 'volúmenes cocos-smoke-staging_*'],
    ['la red del ensayo', { NET_EDGE: 'fed' }, 'la red cocos-smoke-edge'],
  ])('con %s no sigue: borra solo el registro que acaba de crear', (_name, existing, what) => {
    const r = run(existing);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`NO SE CORRE: ya hay ${what}`);
    expect(r.removed).toEqual(['docker rm -f -v reg123']);
    expect(r.calls.some((c) => /network create|^docker compose|^docker tag/.test(c))).toBe(false);
    expect(r.leftovers).toEqual([]);
  });

  // CR-5: no hay nada antes de empezar, pero otra ejecución toma el registro primero (create falla
  // por el nombre). La rechazada no sigue y no borra el registro, la red ni la imagen de la otra.
  it('si otra ejecución tiene el registro, no sigue ni borra nada', () => {
    const r = run({ REGISTRY_TAKEN: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('NO SE CORRE: ya hay un contenedor cocos-smoke-registry');
    expect(r.removed).toEqual([]);
    expect(r.calls.some((c) => /^docker (start|tag|push|network)|^docker compose/.test(c))).toBe(false);
    expect(r.leftovers).toEqual([]);
  });

  it('con la API sana: bootstrap, usuario del smoke y switch, write dos veces con el mismo usuario y read; después limpia', () => {
    const r = run();
    expect(r.stderr).not.toContain('FALLIDO');
    expect(r.status).toBe(0);
    expect(r.smokes).toEqual(['/smoke/smoke.mjs write', '/smoke/smoke.mjs write', '/smoke/smoke.mjs read']);
    const smoke = r.calls.find((c) => c.includes('/smoke/smoke.mjs write'))!;
    expect(smoke).toContain('--network cocos-smoke-staging_default --entrypoint node');
    expect(smoke).toContain(`-e URL=http://api:3000 -e SHA=${HEAD} -e SMOKE_USERID=31 ${DIGEST}`);
    const compose = r.calls.filter((c) => c.startsWith('docker compose'));
    expect(compose.every((c) => c.includes(' -p cocos-smoke-staging '))).toBe(true);
    expect(r.calls.some((c) => / -p cocos-(staging|production) | -p cocos /.test(c))).toBe(false);
    // Borra lo suyo, por id, y nada más.
    expect(r.removed).toEqual([expect.stringMatching(/^docker compose -p cocos-smoke-staging .* down -v$/),
      'docker rm -f -v reg123', 'docker network rm net456', 'docker rmi localhost:5056/cocos-smoke:smoke']);
    expect(r.leftovers).toEqual([]);
  });

  // CR-1 y CR-4: el aislamiento no es solo el nombre del proyecto. Con un staging local en
  // cocos-edge (su API con el alias api-staging, lo que resuelve su Caddy), el ensayo no entra a
  // esa red: su compose usa cocos-smoke-edge, y api-staging en cocos-edge sigue siendo uno solo.
  it('no entra a cocos-edge: el api-staging existente sigue siendo el único destino de ese nombre', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.net('cocos-edge')).toBe(EXISTING_EDGE);
    expect(r.calls.filter((c) => c.includes('cocos-edge') && !c.includes('cocos-smoke-edge'))).toEqual([]);
    expect(r.calls).toContain('docker network create cocos-smoke-edge');
    // El compose instalado es el del commit con la red edge renombrada, y nada más.
    expect(r.compose).toBe(read('deploy/lightsail/compose.yml').replace(/^ {4}name: cocos-edge$/m, '    name: cocos-smoke-edge'));
    expect(r.compose!.split('\n').filter((l) => !l.trim().startsWith('#') && l.includes('cocos-edge'))).toEqual([]);
  });

  it('frena si la API del ensayo quedó también en otra red, sin correr el smoke', () => {
    const r = run({ API_EXTRA_NET: 'cocos-edge' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('la API del ensayo está en las redes');
    expect(r.smokes).toEqual([]);
    // Al limpiar, down -v la saca: el api-staging existente vuelve a ser el único.
    expect(r.net('cocos-edge')).toBe(EXISTING_EDGE);
  });

  it('una imagen cuya API no arranca frena en el switch, sin correr el smoke, y limpia', () => {
    const r = run({ FAIL: 'up -d --wait --wait-timeout [0-9]+ --no-deps api' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SMOKE CON DOCKER FALLIDO: 1: el switch falló');
    expect(r.smokes).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith('docker compose')).at(-1)).toMatch(/ down -v$/);
    expect(r.leftovers).toEqual([]);
  });

  it('un smoke fallido lo pone en rojo', () => {
    const r = run({ SMOKE_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SMOKE CON DOCKER FALLIDO: 2: la primera corrida de write falló');
  });

  it('si después de una corrida completa smoke-user da otro usuario, el flujo no dejó al usuario en cero', () => {
    const r = run({ SECOND_ID: '32' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('smoke-user dio otro usuario (32 y no 31)');
  });
});

// deploy/lightsail/drill-docker.sh usa el proyecto fijo cocos-staging de remote.sh y al terminar
// hace `down -v`: si en el Docker local ya hay algo de ese proyecto (un volumen sin contenedores,
// como deja un `down` sin -v, también), no empieza ni crea nada, así que tampoco lo borra. Con un
// `docker` simulado que anota cada llamada y responde los listados con EXISTING.
describe('drill-docker.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const drill = (existing: Record<string, string>, fail = '') => {
    const f = fakeBin({
      docker: [
        'echo "docker $*" >> "$CALLS"',
        '[ -n "$FAIL" ] && [[ "$*" == *"$FAIL"* ]] && exit 1',
        'case "$*" in',
        '  *"ps -aq --filter label=com.docker.compose.project=cocos-staging") printf "%s" "${PS_PROJECT:-}" ;;',
        '  *"volume ls -q --filter label=com.docker.compose.project=cocos-staging") printf "%s" "${VOL_PROJECT:-}" ;;',
        '  *"volume ls -q --filter name=cocos-staging_") printf "%s" "${VOL_NAME:-}" ;;',
        '  *"ps -aq --filter name=cocos-drill-registry") printf "%s" "${PS_REGISTRY:-}" ;;',
        '  *"ps -aq --filter name=cocos-drill-pg") printf "%s" "${PS_PG:-}" ;;',
        '  *"volume ls -q --filter name=cocos-drill-secrets") printf "%s" "${VOL_SECRETS:-}" ;;',
        'esac',
      ].join('\n'),
    });
    dirs.push(f.dir);
    const r = runScript('deploy/lightsail/drill-docker.sh', [], f.bin, { CALLS: f.log, FAIL: fail, TMPDIR: f.dir, ...existing });
    return { ...r, calls: f.calls(), leftovers: readdirSync(f.dir).filter((e) => !['bin', 'calls'].includes(e)) };
  };
  const LISTS = [
    'docker ps -aq --filter label=com.docker.compose.project=cocos-staging',
    'docker volume ls -q --filter label=com.docker.compose.project=cocos-staging',
    'docker volume ls -q --filter name=cocos-staging_',
    'docker ps -aq --filter name=cocos-drill-registry',
    'docker ps -aq --filter name=cocos-drill-pg',
    'docker volume ls -q --filter name=cocos-drill-secrets',
  ];

  it.each([
    ['un volumen cocos-staging_pgdata sin contenedores', { VOL_NAME: 'cocos-staging_pgdata' }, 'volúmenes cocos-staging_*'],
    ['un volumen con la etiqueta del proyecto', { VOL_PROJECT: 'otro_nombre' }, 'volúmenes del proyecto cocos-staging'],
    ['contenedores del proyecto', { PS_PROJECT: 'abc123' }, 'contenedores del proyecto cocos-staging'],
    ['el contenedor del registro', { PS_REGISTRY: 'def456' }, 'un contenedor cocos-drill-registry'],
    ['el Postgres del ensayo de permisos', { PS_PG: 'fed987' }, 'un contenedor cocos-drill-pg'],
    ['el volumen del ensayo de permisos', { VOL_SECRETS: 'cocos-drill-secrets' }, 'un volumen cocos-drill-secrets'],
  ])('con %s no empieza: solo lista, no crea ni borra nada', (_name, existing, what) => {
    const r = drill(existing);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`NO SE ENSAYA: ya hay ${what}`);
    expect(r.calls.every((c) => LISTS.includes(c))).toBe(true);
    expect(r.leftovers).toEqual([]);
  });

  it('si no puede consultar Docker, no empieza', () => {
    const r = drill({}, 'volume ls');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('NO SE ENSAYA: no se pudo consultar Docker');
    expect(r.calls.every((c) => LISTS.includes(c))).toBe(true);
  });

  it('sin nada del proyecto, pasa las comprobaciones y empieza por el registro', () => {
    const r = drill({}, 'run -d --name cocos-drill-registry');
    expect(r.calls.slice(0, LISTS.length)).toEqual(LISTS);
    expect(r.calls[LISTS.length]).toMatch(/^docker run -d --name cocos-drill-registry /);
    // Falla al crear el registro: la limpieza no toca volúmenes (no hubo compose).
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => / down -v|volume rm/.test(c))).toBe(false);
  });
});

// deploy/lightsail/setup.sh, en el servidor con sudo. Corre con `id`, `getent`, `useradd`,
// `usermod`, `chown` y `docker` simulados (anotan sus argumentos) sobre directorios temporales
// en lugar de /opt/cocos y /home/deploy.
describe('setup.sh', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDeployDeployDeployDeployDeployDeployDeploy cocos-deploy';
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const machine = () => {
    const f = fakeBin({
      id: 'echo "${FAKE_UID:-0}"',
      getent: 'echo "getent $*" >> "$CALLS"; [ -f "$USERS/$2" ]',
      useradd: 'echo "useradd $*" >> "$CALLS"; touch "$USERS/${*: -1}"',
      usermod: 'echo "usermod $*" >> "$CALLS"',
      chown: 'echo "chown $*" >> "$CALLS"',
      docker: 'echo "docker $*" >> "$CALLS"; [ "$1 $2" != "network inspect" ] || [ -f "$USERS/.network" ] || { touch "$USERS/.network"; exit 1; }',
      sleep: ':',
    });
    dirs.push(f.dir);
    const users = join(f.dir, 'users');
    mkdirSync(users);
    const root = join(f.dir, 'opt-cocos');
    const home = join(f.dir, 'home-deploy');
    const run = (args: string[], env: Record<string, string> = {}) => {
      writeFileSync(f.log, '');
      const r = runScript('deploy/lightsail/setup.sh', args, f.bin, { CALLS: f.log, USERS: users, COCOS_ROOT: root, DEPLOY_HOME: home, ...env });
      return { ...r, calls: f.calls() };
    };
    /** Los cinco archivos de secrets/ de un entorno, con su contenido. */
    const secretsOf = (env: string) => Object.fromEntries(SECRET_FILES.map((f) => [f, readFileSync(join(root, env, 'secrets', f), 'utf8')]));
    /** Los .env de la versión anterior (issue #34), como los escribía setup.sh. */
    const legacy = (env: string, v: { pg: string; api: string; token: string }) => {
      mkdirSync(join(root, env), { recursive: true });
      writeFileSync(join(root, env, 'db.env'), `POSTGRES_PASSWORD=${v.pg}\n`, { mode: 0o600 });
      writeFileSync(join(root, env, 'migrate.env'), `DATABASE_ADMIN_URL=postgresql://postgres:${v.pg}@db:5432/cocos\nAPI_DB_PASSWORD=${v.api}\n`, { mode: 0o600 });
      writeFileSync(join(root, env, 'api.env'), `DATABASE_URL=postgresql://api:${v.api}@db:5432/cocos\nINTERNAL_TOKEN=${v.token}\n`, { mode: 0o600 });
    };
    const legacyFiles = (env: string) => ['db.env', 'migrate.env', 'api.env'].map((f) => readFileSync(join(root, env, f), 'utf8'));
    return { root, home, run, secretsOf, legacy, legacyFiles };
  };
  const coherent = (s: Record<string, string>) => ({
    pg: s.postgres_password, api: s.api_db_password, token: s.internal_token,
    admin: s.database_admin_url === `postgresql://postgres:${s.postgres_password}@db:5432/cocos`,
    url: s.database_url === `postgresql://api:${s.api_db_password}@db:5432/cocos`,
  });

  // Issue #36: un archivo por secreto, sin salto final, en secrets/ (700). Sin Swarm, compose los
  // monta con el dueño y el modo del servidor: postgres_password 600 (lo lee root), los de api y
  // migrate 640 con el grupo 1000 (node), puesto después del chown -R que deja el de deploy.
  it('genera los secretos de cada entorno una vez, coherentes entre sí, un archivo cada uno, sin imprimirlos', () => {
    const m = machine();
    const r = m.run([KEY]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const values: string[] = [];
    const chownR = r.calls.indexOf(`chown -R deploy:deploy ${m.root}`);
    expect(chownR).toBeGreaterThanOrEqual(0);
    for (const env of ['staging', 'production']) {
      expect(r.stdout).toContain(`== ${env}: secretos nuevos`);
      expect(statSync(join(m.root, env)).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(m.root, env)).sort()).toEqual(['secrets']);
      const dir = join(m.root, env, 'secrets');
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir).sort()).toEqual([...SECRET_FILES].sort());
      expect(statSync(join(dir, 'postgres_password')).mode & 0o777).toBe(0o600);
      expect(r.calls.some((c) => c.startsWith('chown') && c.endsWith(join(dir, 'postgres_password')))).toBe(false);
      for (const f of ['database_admin_url', 'api_db_password', 'database_url', 'internal_token']) {
        expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o640);
        expect(r.calls.indexOf(`chown deploy:1000 ${join(dir, f)}`), f).toBeGreaterThan(chownR);
      }
      const c = coherent(m.secretsOf(env));
      expect(c.admin && c.url).toBe(true);
      values.push(c.pg, c.api, c.token);
    }
    for (const v of values) {
      expect(v).toMatch(/^[0-9a-f]{48}$/);   // sin salto de línea
      expect(r.stdout + r.stderr + r.calls.join('\n')).not.toContain(v);
    }
    expect(new Set(values).size).toBe(6);
    expect(statSync(m.root).mode & 0o777).toBe(0o700);
  });

  it('es idempotente: la segunda vez no cambia ningún secreto ni recrea el usuario', () => {
    const m = machine();
    m.run([KEY]);
    const before = ['staging', 'production'].map(m.secretsOf);
    const r = m.run([KEY]);
    expect(r.status).toBe(0);
    expect(['staging', 'production'].map(m.secretsOf)).toEqual(before);
    expect(r.stdout).toContain('== staging: secretos ya generados, sin cambios');
    expect(r.stdout).toContain('== production: secretos ya generados, sin cambios');
    expect(r.calls.filter((c) => c.startsWith('useradd'))).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith('docker network create'))).toEqual([]);
  });

  // Un servidor preparado con la versión anterior tiene db.env, migrate.env y api.env y una base
  // ya creada con esas contraseñas: se migran una sola vez con los mismos valores, sin generar
  // nada. Los .env quedan (un rollback a un release anterior los usa) y no se vuelven a leer.
  it('migra los .env existentes a archivos con los mismos valores, una sola vez, y los deja como estaban', () => {
    const m = machine();
    const old = { pg: 'pg-de-la-base-creada', api: 'api-de-la-base-creada', token: 'token-en-uso' };
    m.legacy('staging', old);
    const files = m.legacyFiles('staging');
    const r = m.run([KEY]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('== staging: secretos migrados de db.env, migrate.env y api.env, con los mismos valores');
    expect(r.stdout).toContain('== production: secretos nuevos');
    expect(m.secretsOf('staging')).toEqual({
      postgres_password: old.pg,
      database_admin_url: `postgresql://postgres:${old.pg}@db:5432/cocos`,
      api_db_password: old.api,
      database_url: `postgresql://api:${old.api}@db:5432/cocos`,
      internal_token: old.token,
    });
    for (const v of Object.values(old)) expect(r.stdout + r.stderr + r.calls.join('\n')).not.toContain(v);
    expect(m.legacyFiles('staging')).toEqual(files);
    for (const f of ['db.env', 'migrate.env', 'api.env']) expect(statSync(join(m.root, 'staging', f)).mode & 0o777).toBe(0o600);
    expect(statSync(join(m.root, 'staging', 'secrets', 'internal_token')).mode & 0o777).toBe(0o640);

    // Una sola vez: después, los .env no se vuelven a leer aunque cambien.
    const migrated = m.secretsOf('staging');
    writeFileSync(join(m.root, 'staging', 'api.env'), 'DATABASE_URL=otra\nINTERNAL_TOKEN=otro\n');
    const again = m.run([KEY]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('== staging: secretos ya generados, sin cambios');
    expect(m.secretsOf('staging')).toEqual(migrated);
  });

  it.each([
    ['sin una variable', (env: string, root: string) => writeFileSync(join(root, env, 'api.env'), 'DATABASE_URL=postgresql://api:x@db:5432/cocos\n'), 'api.env tiene 0 líneas INTERNAL_TOKEN='],
    ['con una variable repetida', (env: string, root: string) => writeFileSync(join(root, env, 'db.env'), 'POSTGRES_PASSWORD=a\nPOSTGRES_PASSWORD=b\n'), 'db.env tiene 2 líneas POSTGRES_PASSWORD='],
    ['con una variable vacía', (env: string, root: string) => writeFileSync(join(root, env, 'migrate.env'), 'DATABASE_ADMIN_URL=postgresql://postgres:a@db:5432/cocos\nAPI_DB_PASSWORD=\n'), 'API_DB_PASSWORD está vacío en'],
    ['sin uno de los tres', (env: string, root: string) => rmSync(join(root, env, 'migrate.env')), 'tiene 2 de los 3 .env de la versión anterior y ningún secreto'],
  ])('con .env de la versión anterior %s frena sin escribir ningún secreto ni tocar los .env', (_name, edit, message) => {
    const m = machine();
    m.legacy('production', { pg: 'pg', api: 'api', token: 'token' });
    edit('production', m.root);
    const files = readdirSync(join(m.root, 'production')).sort().map((f) => [f, readFileSync(join(m.root, 'production', f), 'utf8')]);
    const r = m.run([KEY]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(existsSync(join(m.root, 'production', 'secrets'))).toBe(false);
    expect(readdirSync(join(m.root, 'production')).sort().map((f) => [f, readFileSync(join(m.root, 'production', f), 'utf8')])).toEqual(files);
  });

  it('frena si a un entorno le falta uno de sus secretos: no regenera contraseñas que la base ya tiene', () => {
    const m = machine();
    m.run([KEY]);
    const before = m.secretsOf('staging');
    rmSync(join(m.root, 'production', 'secrets', 'api_db_password'));
    const r = m.run([KEY]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('secrets tiene 4 de los 5 secretos');
    expect(existsSync(join(m.root, 'production', 'secrets', 'api_db_password'))).toBe(false);
    expect(m.secretsOf('staging')).toEqual(before);
  });

  it('el usuario deploy, en el grupo docker, con solo la clave de deploy y restringida', () => {
    const m = machine();
    const r = m.run([KEY]);
    expect(r.calls).toContain(`useradd --create-home --home-dir ${m.home} --shell /bin/bash deploy`);
    expect(r.calls).toContain('usermod -aG docker deploy');
    const keys = join(m.home, '.ssh', 'authorized_keys');
    expect(readFileSync(keys, 'utf8')).toBe(`restrict ${KEY}\n`);
    expect(statSync(keys).mode & 0o777).toBe(0o600);
    expect(statSync(join(m.home, '.ssh')).mode & 0o777).toBe(0o700);
    // Otra clave reemplaza a la anterior: rotarla es volver a correrlo.
    const other = KEY.replace('Deploy', 'Otra');
    m.run([other]);
    expect(readFileSync(keys, 'utf8')).toBe(`restrict ${other}\n`);
  });

  it('instala el proxy del commit y lo levanta en la red cocos-edge', () => {
    const m = machine();
    const r = m.run([KEY]);
    expect(readFileSync(join(m.root, 'proxy/compose.yml'), 'utf8')).toBe(read('deploy/lightsail/proxy/compose.yml'));
    expect(readFileSync(join(m.root, 'proxy/caddy/Caddyfile'), 'utf8')).toBe(read('deploy/lightsail/proxy/caddy/Caddyfile'));
    const proxy = `docker compose -p cocos-proxy --project-directory ${m.root}/proxy -f ${m.root}/proxy/compose.yml`;
    expect(r.calls.filter((c) => c.startsWith('docker'))).toEqual([
      'docker compose version',
      'docker network inspect cocos-edge',
      'docker network create cocos-edge',
      `${proxy} up -d`,
      `${proxy} exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
    ]);
  });

  it.each([
    ['sin clave', [], {}],
    ['con una clave que no es ssh-ed25519', ['ssh-rsa AAAAB3Nza cocos'], {}],
    ['con una clave en dos líneas', [`${KEY}\nssh-ed25519 AAAAotra`], {}],
    ['sin sudo', [KEY], { FAKE_UID: '1000' }],
  ])('frena %s, sin tocar nada', (_name, args, env) => {
    const m = machine();
    const r = m.run(args as string[], env as Record<string, string>);
    expect(r.status).toBe(1);
    expect(existsSync(m.root)).toBe(false);
    expect(r.calls.filter((c) => !c.startsWith('docker compose version'))).toEqual([]);
  });
});

// deploy/drills.sh release y rerun (issues #30 y #34), sin el servidor ni GitHub: un repositorio temporal
// con origin en un repositorio bare local (main con dos commits y tags), `curl` que responde
// /health con HEALTH, y un `gh` simulado que lee y escribe el estado de las corridas en STATE:
// cada corrida con su tag (headBranch), su commit y sus intentos (conclusión y log).
describe('drills.sh', () => {
  const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'prueba',
    GIT_AUTHOR_EMAIL: 'prueba@example.com', GIT_COMMITTER_NAME: 'prueba', GIT_COMMITTER_EMAIL: 'prueba@example.com' };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  type Attempt = { conclusion: string; log: string };
  type Run = { databaseId: number; headBranch: string; headSha: string; attempts: Attempt[] };
  type State = { latest: string; runs: Run[]; rerun?: Attempt };

  const GH = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, 'gh ' + args.join(' ') + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = (v) => {
  const q = opt('--jq');
  process.stdout.write(q ? execFileSync('jq', ['-r', q], { input: JSON.stringify(v), encoding: 'utf8' }) : JSON.stringify(v) + '\\n');
};
const run = () => state.runs.find((r) => String(r.databaseId) === args[2]);
const cmd = args[0] + ' ' + args[1];
if (cmd === 'auth status') process.exit(0);
if (cmd === 'release view') { out({ tagName: state.latest }); process.exit(0); }
if (cmd === 'run list') {
  const runs = state.runs.filter((r) => (!opt('--branch') || r.headBranch === opt('--branch')) && (!opt('--commit') || r.headSha === opt('--commit')));
  out(runs.slice(0, Number(opt('--limit') || 20)).map((r) => ({ databaseId: r.databaseId, headSha: r.headSha })));
  process.exit(0);
}
if (cmd === 'run view') {
  const r = run();
  const a = r.attempts[(opt('--attempt') ? Number(opt('--attempt')) : r.attempts.length) - 1];
  if (args.includes('--log')) { process.stdout.write(a.log + '\\n'); process.exit(0); }
  out({ attempt: r.attempts.length, conclusion: a.conclusion });
  process.exit(0);
}
if (cmd === 'run rerun') {
  if (state.rerun) run().attempts.push(state.rerun);
  fs.writeFileSync(process.env.STATE, JSON.stringify(state));
  process.exit(0);
}
if (cmd === 'run watch') process.exit(run().attempts.at(-1).conclusion === 'success' ? 0 : 1);
console.error('gh simulado: no soportado: ' + args.join(' '));
process.exit(9);
`;

  /** main: dos commits; v1.0.0 → main[0]; v1.1.0 y v1.1.1 → main[1] (dos tags, el mismo commit). */
  const setup = () => {
    const f = fakeBin({ curl: 'printf "%s" "$HEALTH"', sleep: 'echo "sleep $1" >> "$CALLS"' });
    dirs.push(f.dir);
    writeFileSync(join(f.bin, 'gh'), GH);
    chmodSync(join(f.bin, 'gh'), 0o755);
    const repo = join(f.dir, 'repo');
    const remote = join(f.dir, 'remote.git');
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    mkdirSync(join(repo, 'deploy'), { recursive: true });
    for (const file of ['deploy/drills.sh']) {
      writeFileSync(join(repo, file), readFileSync(join(ROOT, file)));
      chmodSync(join(repo, file), statSync(join(ROOT, file)).mode);
    }
    git(f.dir, 'init', '-q', '--bare', remote);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '--no-verify', '-m', 'uno');
    const main = [git(repo, 'rev-parse', 'HEAD')];
    writeFileSync(join(repo, 'f'), 'dos');
    git(repo, 'add', 'f');
    git(repo, 'commit', '-q', '--no-verify', '-m', 'dos');
    main.push(git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'tag', 'v1.0.0', main[0]);
    git(repo, 'tag', 'v1.1.0', main[1]);
    git(repo, 'tag', 'v1.1.1', main[1]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main', '--tags');
    const stateFile = join(f.dir, 'state.json');
    const drill = (args: string[], state: State, serving: string) => {
      writeFileSync(stateFile, JSON.stringify(state));
      writeFileSync(f.log, '');
      const r = spawnSync('bash', [join(repo, 'deploy/drills.sh'), ...args], {
        cwd: repo, encoding: 'utf8',
        env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/', ...GIT, CALLS: f.log, STATE: stateFile,
          HEALTH: JSON.stringify({ ok: true, db: 'up', release: serving }) },
      });
      return { ...r, calls: f.calls() };
    };
    return { main, drill };
  };

  const deployed = (tag: string, sha: string) =>
    `gate\tVersión de main con ci en verde\t== ${tag} (${sha}): vX.Y.Z, en main y con ci en verde: se despliega\n` +
    `production\t/health atiende el commit\t== atiende ${sha} con ok: true (intento 1 de 30)`;
  const stopped = (sha: string, current: string) =>
    `staging\tEl commit desciende del release actual\tDEPLOY FRENADO: ${sha} no desciende del release actual (${current})`;

  describe('release', () => {
    it('aprueba el release cuya corrida lo nombra, pasó y /health atiende su commit', () => {
      const { main, drill } = setup();
      const r = drill(['release', 'v1.1.1'], {
        latest: 'v1.1.1',
        runs: [{ databaseId: 12, headBranch: 'v1.1.1', headSha: main[1], attempts: [{ conclusion: 'success', log: deployed('v1.1.1', main[1]) }] }],
      }, main[1]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`v1.1.1 pasó por el deploy 12 y /health atiende ${main[1]}`);
      expect(r.calls).toContain(`gh run list --workflow deploy --event release --branch v1.1.1 --commit ${main[1]} --json databaseId --limit 1 --jq .[0].databaseId // empty`);
    });

    it('sin tag, ensaya el último release publicado', () => {
      const { main, drill } = setup();
      const r = drill(['release'], {
        latest: 'v1.1.1',
        runs: [{ databaseId: 12, headBranch: 'v1.1.1', headSha: main[1], attempts: [{ conclusion: 'success', log: deployed('v1.1.1', main[1]) }] }],
      }, main[1]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('== release: v1.1.1');
    });

    // Dos tags sobre el mismo commit: la corrida del primero no prueba nada del segundo.
    it('con dos tags sobre el mismo commit y solo la corrida del primero, el del segundo espera y falla', () => {
      const { main, drill } = setup();
      const r = drill(['release', 'v1.1.1'], {
        latest: 'v1.1.1',
        runs: [{ databaseId: 11, headBranch: 'v1.1.0', headSha: main[1], attempts: [{ conclusion: 'success', log: deployed('v1.1.0', main[1]) }] }],
      }, main[1]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('ENSAYO FALLIDO: release: v1.1.1 no disparó el workflow de deploy en 5 minutos');
      expect(r.calls.filter((c) => c.startsWith('sleep '))).toHaveLength(30);
      expect(r.calls.some((c) => c.startsWith('gh run watch'))).toBe(false);
    });

    it('falla si la corrida que encuentra no es la de ese tag (su gate nombra otro)', () => {
      const { main, drill } = setup();
      const r = drill(['release', 'v1.1.1'], {
        latest: 'v1.1.1',
        runs: [{ databaseId: 11, headBranch: 'v1.1.1', headSha: main[1], attempts: [{ conclusion: 'success', log: deployed('v1.1.0', main[1]) }] }],
      }, main[1]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('el deploy 11 no es el de v1.1.1');
    });
  });

  describe('rerun', () => {
    // El deploy de v1.0.0 ya se había frenado una vez: su intento 1 tiene el log del gate.
    const old = (main: string[]): Run =>
      ({ databaseId: 21, headBranch: 'v1.0.0', headSha: main[0], attempts: [{ conclusion: 'failure', log: stopped(main[0], main[1]) }] });

    it('aprueba cuando el intento nuevo se frena en el gate de ancestría, mirando ese intento', () => {
      const { main, drill } = setup();
      const r = drill(['rerun'], { latest: 'v1.1.1', runs: [old(main)], rerun: { conclusion: 'failure', log: stopped(main[0], main[1]) } }, main[1]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('espera el intento 2 del deploy 21');
      expect(r.calls).toContain('gh run rerun 21');
      expect(r.calls).toContain('gh run view 21 --attempt 2 --json conclusion --jq .conclusion');
      expect(r.calls).toContain('gh run view 21 --attempt 2 --log');
    });

    it('si el intento nuevo no empieza, falla al agotar el plazo sin usar el resultado del anterior', () => {
      const { main, drill } = setup();
      const r = drill(['rerun'], { latest: 'v1.1.1', runs: [old(main)] }, main[1]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('ENSAYO FALLIDO: rerun: el intento nuevo del deploy 21 no empezó en 5 minutos (sigue en el 1)');
      expect(r.calls.filter((c) => c.startsWith('sleep '))).toHaveLength(60);
      expect(r.calls.some((c) => c.startsWith('gh run watch') || c.includes('--log'))).toBe(false);
    });

    it('falla si el intento nuevo falló por otro motivo, aunque el anterior se haya frenado en el gate', () => {
      const { main, drill } = setup();
      const r = drill(['rerun'], { latest: 'v1.1.1', runs: [old(main)], rerun: { conclusion: 'failure', log: 'image\tConstruir la imagen\terror' } }, main[1]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('el intento 2 del deploy 21 falló por otro motivo');
    });

    it('falla si el intento nuevo terminó bien', () => {
      const { main, drill } = setup();
      const r = drill(['rerun'], { latest: 'v1.1.1', runs: [old(main)], rerun: { conclusion: 'success', log: deployed('v1.0.0', main[0]) } }, main[1]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('el deploy del release viejo terminó bien');
    });
  });
});
