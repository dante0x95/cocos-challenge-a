// El deploy a Fly (D-29, issue #12) despliega solo commits de main con el CI en verde, y
// exactamente ese commit: lo frena si no desciende del release que atiende y, después,
// exige que /health lo atienda. Dos partes, sin red:
//
// 1. .github/workflows/deploy.yml: su disparador y su condición real, con un evaluador mínimo
//    de expresiones de GitHub Actions (solo lo que el workflow usa: contextos github.* y env.*,
//    strings, true/false/null, ==, !=, !, &&, || y paréntesis; otra sintaxis hace fallar el
//    test, así que cambiar la condición obliga a mirar este archivo), y el orden de sus pasos.
// 2. deploy/fly/release-check.sh, el script que corren esos pasos, con un `curl` simulado que
//    responde lo que cada caso necesita y un repositorio git temporal con tres commits.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const yml = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const SCRIPT = join(ROOT, 'deploy/fly/release-check.sh');

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
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^(github|env|needs|steps)\./.test(t)) return t.split('.').reduce<unknown>((o, k) => (o as Ctx | undefined)?.[k], ctx);
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
const run = (conclusion: string, event: string) => ({
  github: { event: { workflow_run: { conclusion, event, head_sha: SHA, head_branch: 'main' } } },
});
const deploys = (conclusion: string, event: string) => Boolean(evaluate(valueOf('if'), run(conclusion, event)));

describe('workflow de deploy', () => {
  it('el evaluador rechaza lo que no entiende', () => {
    expect(() => evaluate("contains(github.ref, 'main')", {})).toThrow(/sintaxis no soportada/);
    expect(() => evaluate('>-', {})).toThrow(/sintaxis no soportada/);
    expect(() => evaluate('vars.DEPLOY', {})).toThrow(/sintaxis no soportada/);
    expect(() => evaluate('1 == 1', {})).toThrow(/sintaxis no soportada/);
  });

  it('el evaluador interpreta los literales: la condición con `|| true` desplegaría un CI fallido', () => {
    const loose = `${valueOf('if')} || true`;
    for (const conclusion of ['failure', 'cancelled']) {
      expect(evaluate(loose, run(conclusion, 'push'))).toBe(true);
    }
    expect(evaluate(`${valueOf('if')} && false`, run('success', 'push'))).toBe(false);
    expect(evaluate('github.event.workflow_run.head_sha != null', run('success', 'push'))).toBe(true);
  });

  it('solo lo dispara el CI de main al terminar', () => {
    const on = yml.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1];
    expect(on).toBe('  workflow_run:\n    workflows: [ci]\n    types: [completed]\n    branches: [main]\n');
  });

  it('despliega un push a main con el CI en verde', () => {
    expect(deploys('success', 'push')).toBe(true);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'action_required', 'neutral', 'stale'])(
    'no despliega un push con el CI en %s', (conclusion) => {
      expect(deploys(conclusion, 'push')).toBe(false);
    });

  it.each(['pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule'])(
    'no despliega un CI en verde disparado por %s', (event) => {
      expect(deploys('success', event)).toBe(false);
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

  it('despliega exactamente el commit que pasó el CI, con RELEASE igual a ese SHA, y la imagen lleva ese SHA', () => {
    expect(evaluate(inner(valueOf('SHA')), run('success', 'push'))).toBe(SHA);
    expect(valueOf('IMAGE')).toBe('ghcr.io/${{ github.repository }}');
    expect(yml).toMatch(/^\s*run: docker build -t "\$IMAGE:\$SHA" \.$/m);
  });

  // Los scripts y la configuración de cada entorno salen del mismo commit que la imagen.
  it.each(['image', 'staging', 'production'])('el job %s hace checkout del commit que pasó el CI', (name) => {
    const checkouts = stepsOf(job(name)).filter((st) => st.startsWith('uses: actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(keyIn(checkouts[0], 'ref')).toBe('${{ env.SHA }}');
  });

  it('tres etapas en orden: la imagen una vez, staging con ella, producción con la misma y detrás de su environment', () => {
    expect([...jobs.matchAll(/^  (\w+):\n/gm)].map((m) => m[1])).toEqual(['image', 'staging', 'production']);
    expect(jobKey(job('staging'), 'needs')).toBe('image');
    expect(jobKey(job('production'), 'needs')).toBe('[image, staging]');
    expect(keyIn(job('staging'), 'name')).toBe('staging');
    expect(keyIn(job('production'), 'name')).toBe('production');
    // La condición del CI va en el primer job; los otros dependen de él.
    expect(jobKey(job('image'), 'if')).toBeDefined();
    expect(jobKey(job('staging'), 'if')).toBeUndefined();
    expect(jobKey(job('production'), 'if')).toBeUndefined();
  });

  it('la imagen se construye y publica una sola vez en GHCR; staging y producción solo despliegan su digest', () => {
    expect(runsOf(job('image'))).toEqual([
      'echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin',
      'docker build -t "$IMAGE:$SHA" .',
      'docker push "$IMAGE:$SHA"',
      'deploy/fly/image-digest.sh',
    ]);
    expect(keyIn(job('image'), 'packages')).toBe('write');
    for (const name of ['staging', 'production']) {
      expect(job(name)).not.toMatch(/docker build|packages: write/);
    }
    const deployFlow = (config: string) => [
      'deploy/fly/release-check.sh before',
      'deploy/fly/rollback.sh record',
      `flyctl deploy --config ${config} --image "$IMAGE_REF" --env "RELEASE=$SHA"`,
      'deploy/fly/release-check.sh after',
      'deploy/fly/rollback.sh restore',
    ];
    expect(runsOf(job('staging'))).toEqual(deployFlow('deploy/fly/staging.toml'));
    expect(runsOf(job('production'))).toEqual(deployFlow('fly.toml'));
  });

  // La etiqueta <IMAGE>:<SHA> se puede sobrescribir entre el staging de una corrida y la
  // aprobación de su producción (otra corrida del mismo commit reconstruye y publica); los dos
  // entornos despliegan el digest que entregó el job image de su propia corrida.
  it('staging y producción despliegan el digest que publicó su corrida, aunque la etiqueta cambie después', () => {
    expect(keyIn(step(job('image'), 'Digest de la imagen publicada'), 'id')).toBe('digest');
    expect(job('image')).toMatch(/^ {4}outputs:\n {6}ref: \$\{\{ steps\.digest\.outputs\.ref \}\}$/m);
    const digestA = `ghcr.io/o/r@sha256:${'a'.repeat(64)}`;
    const digestB = `ghcr.io/o/r@sha256:${'b'.repeat(64)}`;
    for (const name of ['staging', 'production']) {
      const ref = keyIn(job(name), 'IMAGE_REF')!;
      // Corrida 1: su job image publicó A. Después, la corrida 2 sobrescribió la etiqueta con B:
      // lo que resuelve cada entorno de la corrida 1 sigue siendo A.
      expect(evaluate(inner(ref), { needs: { image: { outputs: { ref: digestA } } } })).toBe(digestA);
      expect(evaluate(inner(ref), { needs: { image: { outputs: { ref: digestB } } } })).toBe(digestB);
      expect(runsOf(job(name)).filter((r) => r.startsWith('flyctl deploy'))).toEqual([expect.stringContaining('--image "$IMAGE_REF"')]);
      expect(job(name)).not.toMatch(/\$IMAGE:\$SHA/);
    }
    // producción lee las salidas de image: tiene que depender de ese job directamente.
    expect(jobKey(job('production'), 'needs')).toMatch(/\bimage\b/);
  });

  // Si /health deja de atender el commit después de que el tráfico pasó a la versión nueva, el
  // entorno vuelve a la imagen y el release que atendían antes del deploy.
  it.each(['staging', 'production'])('%s vuelve a la imagen anterior solo si falla la verificación de después del deploy', (name) => {
    const block = job(name);
    expect(keyIn(step(block, 'El commit desciende del release actual'), 'id')).toBe('gate');
    expect(keyIn(step(block, 'Imagen que atiende'), 'id')).toBe('serving');
    expect(keyIn(step(block, 'Deploy'), 'id')).toBe('deploy');
    const back = step(block, 'Volver a la imagen anterior');
    expect(keyIn(back, 'if')).toBe("failure() && steps.deploy.outcome == 'success'");
    expect(keyIn(back, 'PREVIOUS_IMAGE')).toBe('${{ steps.serving.outputs.image }}');
    expect(keyIn(back, 'PREVIOUS_RELEASE')).toBe('${{ steps.gate.outputs.previous }}');
    expect(keyIn(back, 'FLY_API_TOKEN')).toBe('${{ secrets.FLY_API_TOKEN }}');
    // Cada entorno vuelve atrás en su propia app.
    expect(keyIn(block, 'CONFIG')).toBe(name === 'staging' ? 'deploy/fly/staging.toml' : 'fly.toml');
    expect(runsOf(block).find((r) => r.startsWith('flyctl deploy'))).toContain(`--config ${keyIn(block, 'CONFIG')} `);
  });

  it('cada entorno verifica contra su propia URL, con la historia completa para el gate', () => {
    for (const name of ['staging', 'production']) {
      const block = job(name);
      const url = keyIn(block, 'URL');
      expect(url).toMatch(/^https:\/\/[a-z0-9-]+\.fly\.dev$/);
      expect(keyIn(block, 'url')).toBe(url);
      expect(keyIn(block, 'fetch-depth')).toBe('0');
    }
    expect(keyIn(job('staging'), 'URL')).not.toBe(keyIn(job('production'), 'URL'));
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('staging y producción son apps distintas con bases distintas, y la misma configuración', () => {
    const app = (f: string) => readFileSync(join(ROOT, f), 'utf8').match(/^app = "(.+)"$/m)?.[1];
    expect(app('fly.toml')).toBe('cocos-challenge-a-api');
    expect(app('deploy/fly/staging.toml')).toBe('cocos-challenge-a-staging');
    expect(app('deploy/fly/db.toml')).toBe('cocos-challenge-a-db');
    expect(app('deploy/fly/staging-db.toml')).toBe('cocos-challenge-a-staging-db');
    const strip = (f: string) => readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('app = ')).join('\n');
    expect(strip('deploy/fly/staging.toml')).toBe(strip('fly.toml'));
    expect(strip('deploy/fly/staging-db.toml')).toBe(strip('deploy/fly/db.toml'));
  });
});

// Un token de deploy de Fly se acota a una sola app (`fly tokens create deploy -a <app>`; un
// segundo -a no suma la otra). Cada environment de GitHub lleva el token de su app en su propio
// secreto FLY_API_TOKEN, que es el que leen los jobs de ese environment.
describe('tokens de deploy', () => {
  const docs = ['README.md', 'docs/api/operacion.md'];
  const tokenLines = (f: string) => readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => l.includes('fly tokens create deploy'));

  it.each(docs)('%s: un token por app, guardado en el secreto del environment de esa app', (f) => {
    const lines = tokenLines(f);
    expect(lines).toHaveLength(2);
    const app = (cfg: string) => readFileSync(join(ROOT, cfg), 'utf8').match(/^app = "(.+)"$/m)?.[1];
    expect(lines.map((l) => l.trim())).toEqual([
      `fly tokens create deploy -a ${app('deploy/fly/staging.toml')} | gh secret set FLY_API_TOKEN --env staging`,
      `fly tokens create deploy -a ${app('fly.toml')} | gh secret set FLY_API_TOKEN --env production`,
    ]);
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
    'en %s, con A desplegándose y B pendiente, un re-run del CI de un commit viejo no cancela a B', (name) => {
      const c = concurrencyOf(jobBlock(name));
      expect(c?.group).toBe(`deploy-${name}`);
      // A no se corta, B llega a desplegarse, y el viejo corre después (y lo frena el gate).
      expect(simulateQueue(c!, ['A', 'B', 'viejo'])).toEqual(['A', 'B', 'viejo']);
      expect(simulateQueue(c!, ['A', 'B', 'C', 'viejo', 'D'])).toEqual(['A', 'B', 'C', 'viejo', 'D']);
    });

  // Un grupo del workflow lo retiene la corrida entera, también mientras production espera la
  // aprobación: el staging de los merges siguientes quedaría frenado detrás de esa aprobación.
  it('la concurrencia es por entorno: una aprobación pendiente de producción no frena el staging siguiente', () => {
    expect(yml).not.toMatch(/^concurrency:/m);
    expect(concurrencyOf(jobBlock('image'))).toBeUndefined();
    expect(concurrencyOf(jobBlock('staging'))?.group).not.toBe(concurrencyOf(jobBlock('production'))?.group);
  });
});

// Postgres en Fly (deploy/fly/db.toml): la misma imagen que docker compose, con el volumen
// montado donde compose monta el suyo. En postgres:18 el directorio de datos por defecto es
// /var/lib/postgresql/18/docker, dentro de ese montaje; un destino distinto, o un PGDATA que lo
// saque de ahí, dejaría los datos en el disco efímero de la máquina. Que efectivamente
// sobrevivan a reemplazarla lo ensaya deploy/fly/drills.sh persistence, a mano, contra Fly.
describe('Postgres en Fly', () => {
  const dbToml = readFileSync(join(ROOT, 'deploy/fly/db.toml'), 'utf8');
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const section = (toml: string, name: string) => {
    const m = toml.match(new RegExp(`^\\[${name}\\]\\n((?:[ \\t]+.+\\n)+)`, 'm'));
    if (!m) throw new Error(`db.toml no tiene [${name}]`);
    return Object.fromEntries([...m[1].matchAll(/^\s*(\w+) = "(.*)"$/gm)].map((e) => [e[1], e[2]]));
  };

  it('usa la imagen de docker compose, con el volumen montado donde compose monta el suyo', () => {
    const composeDb = compose.match(/^ {2}db:\n((?: {4}.*\n)+)/m)?.[1] ?? '';
    expect(section(dbToml, 'build').image).toBe(composeDb.match(/^ {4}image: (.+)$/m)?.[1]);
    const composeMount = composeDb.match(/^ {6}- pgdata:(\S+)$/m)?.[1];
    expect(composeMount).toBe('/var/lib/postgresql');
    expect(section(dbToml, 'mounts')).toEqual({ source: 'pgdata', destination: composeMount });
  });

  it('no cambia el directorio de datos de la imagen (PGDATA), que queda dentro del volumen', () => {
    expect(dbToml).not.toMatch(/PGDATA/);
    expect(compose).not.toMatch(/PGDATA/);
  });

  it('el ensayo de persistencia lee el montaje de db.toml', () => {
    const drills = readFileSync(join(ROOT, 'deploy/fly/drills.sh'), 'utf8');
    expect(drills).toContain("sed -n 's/^ *destination = \"\\(.*\\)\"$/\\1/p' deploy/fly/db.toml");
    expect(drills).toMatch(/^ {2}persistence\) drill_persistence ;;$/m);
  });
});

// deploy/fly/release-check.sh con un curl simulado: responde, en orden, cada línea de
// RESPONSES (una por llamada; una línea `!<código>` falla con ese código de salida) y cuenta
// las llamadas en CALLS. `sleep` también se simula: anota cuánto durmió y no espera.
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
    expect(check('', bin, { SHA, URL: 'https://x.fly.dev' }).status).toBe(2);
    expect(check('after', bin, { URL: 'https://x.fly.dev' }).status).toBe(1);
    expect(check('after', bin, { SHA }).status).toBe(1);
    expect(calls()).toEqual([]);
  });

  describe('before: el commit a desplegar desciende del release que atiende', () => {
    it('anota en $GITHUB_OUTPUT el release que atiende: al que vuelve rollback.sh restore', () => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin } = stubs([health(shas[1])]);
      const out = join(tmp('release-check-out-'), 'output');
      writeFileSync(out, '');
      const r = check('before', bin, { SHA: shas[2], URL: 'https://x.fly.dev', GITHUB_OUTPUT: out }, repo);
      expect(r.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(`previous=${shas[1]}\n`);
    });

    it('despliega un commit posterior al release actual', () => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin, calls } = stubs([health(shas[1])]);
      const r = check('before', bin, { SHA: shas[2], URL: 'https://x.fly.dev' }, repo);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`${shas[2]} desciende de ${shas[1]}`);
      expect(calls()).toEqual(['-sS --max-time 10 https://x.fly.dev/health']);
    });

    it('frena un commit anterior al release actual: un re-run del CI de un commit viejo no despliega', () => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin } = stubs([health(shas[2])]);
      const r = check('before', bin, { SHA: shas[0], URL: 'https://x.fly.dev' }, repo);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`DEPLOY FRENADO: ${shas[0]} no desciende del release actual (${shas[2]})`);
    });

    it('frena un commit de otra rama, aunque el release sea un ancestro de la base', () => {
      const { repo, shas } = repoWithThreeCommits();
      const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).stdout.trim();
      git('checkout', '-q', '-b', 'otra', shas[0]);
      writeFileSync(join(repo, 'f'), 'otra');
      git('commit', '-q', '--no-verify', '-am', 'otra');
      const other = git('rev-parse', 'HEAD');
      const { bin } = stubs([health(shas[1])]);
      expect(check('before', bin, { SHA: other, URL: 'https://x.fly.dev' }, repo).status).toBe(1);
    });

    it('vuelve a desplegar el mismo commit', () => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin } = stubs([health(shas[2])]);
      const r = check('before', bin, { SHA: shas[2], URL: 'https://x.fly.dev' }, repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('se vuelve a desplegar el mismo commit');
    });

    it('lee el release también de un 503 con la base caída', () => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin } = stubs([health(shas[1], false)]);
      expect(check('before', bin, { SHA: shas[2], URL: 'https://x.fly.dev' }, repo).status).toBe(0);
    });

    it.each([
      ['un release que no está en la historia', health('f'.repeat(40)), /no está en la historia/],
      ['release null (sin RELEASE configurado)', health(null), /no informa release/],
      ['una respuesta que no es JSON', '<html>502</html>', /no devolvió JSON/],
      ['curl que falla', '!7', /no responde/],
    ])('frena con %s', (_name, response, message) => {
      const { repo, shas } = repoWithThreeCommits();
      const { bin } = stubs([response]);
      const r = check('before', bin, { SHA: shas[2], URL: 'https://x.fly.dev' }, repo);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(message);
    });
  });

  describe('after: /health atiende el commit desplegado', () => {
    const env = { SHA, URL: 'https://x.fly.dev', HEALTH_ATTEMPTS: '4', HEALTH_INTERVAL: '7' };
    const OLD = 'b'.repeat(40);

    it('reintenta mientras release sea el anterior y termina bien cuando atiende el SHA', () => {
      const { bin, calls, sleeps } = stubs([health(OLD), health(OLD), health(SHA)]);
      const r = check('after', bin, env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`atiende ${SHA} con ok: true (intento 3 de 4)`);
      expect(calls()).toHaveLength(3);
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
      const r = check('after', bin, { SHA, URL: 'https://x.fly.dev' });
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
    const r = runScript('deploy/fly/image-digest.sh', [], f.bin, { IMAGE, SHA, GITHUB_OUTPUT: out, CALLS: f.log });
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
      const r = runScript('deploy/fly/image-digest.sh', [], f.bin, { IMAGE, SHA, CALLS: f.log });
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
    const r = runScript('deploy/fly/image-digest.sh', [], f.bin, { IMAGE, SHA, GITHUB_OUTPUT: out, CALLS: f.log });
    expect(r.status).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('');
    rmSync(f.dir, { recursive: true, force: true });
  });
});

describe('rollback.sh', () => {
  const OLD = `ghcr.io/o/r@sha256:${'a'.repeat(64)}`;
  const NEW = `ghcr.io/o/r@sha256:${'b'.repeat(64)}`;
  const PREV = 'p'.repeat(40);
  const machine = (id: string, image: string, group = 'app', state = 'started') =>
    ({ id, state, config: { image, metadata: { fly_process_group: group } } });
  // flyctl: `machines list` responde MACHINES; `machine update` se anota. curl: responde, en
  // orden, cada línea de HEALTH (la última se repite).
  const fakes = (machines: unknown[], health: string[]) => {
    const f = fakeBin({
      flyctl: [
        'echo "flyctl $*" >> "$CALLS"',
        'case "$1 $2" in',
        '  "machines list") cat "$MACHINES" ;;',
        '  "machine update") exit "${UPDATE_EXIT:-0}" ;;',
        '  *) echo "flyctl simulado: no soportado: $*" >&2; exit 9 ;;',
        'esac',
      ].join('\n'),
      curl: [
        'echo "curl $*" >> "$CALLS"',
        'n=$(grep -c "^curl " "$CALLS")',
        'total=$(wc -l < "$HEALTH")',
        '[ "$n" -le "$total" ] || n=$total',
        'sed -n "${n}p" "$HEALTH" | tr -d "\\n"',
      ].join('\n'),
      sleep: ':',
    });
    writeFileSync(join(f.dir, 'machines.json'), JSON.stringify(machines));
    writeFileSync(join(f.dir, 'health'), health.join('\n') + '\n');
    const env = {
      CALLS: f.log, MACHINES: join(f.dir, 'machines.json'), HEALTH: join(f.dir, 'health'),
      CONFIG: 'deploy/fly/staging.toml', URL: 'https://cocos-challenge-a-staging.fly.dev', HEALTH_ATTEMPTS: '3',
    };
    return { ...f, env };
  };
  const body = (release: string, ok = true) => JSON.stringify({ ok, db: ok ? 'up' : 'down', release });

  it('record: la imagen de las máquinas de la API de la app del CONFIG, en $GITHUB_OUTPUT', () => {
    const f = fakes([machine('m1', OLD), machine('m2', OLD), machine('r1', NEW, 'release_command'), machine('m0', NEW, 'app', 'destroyed')], []);
    const out = join(f.dir, 'output');
    const r = runScript('deploy/fly/rollback.sh', ['record'], f.bin, { ...f.env, GITHUB_OUTPUT: out });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(`image=${OLD}\n`);
    expect(f.calls()).toEqual(['flyctl machines list --app cocos-challenge-a-staging --json']);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it.each([
    ['sin máquinas de la API', [machine('r1', OLD, 'release_command')]],
    ['con dos imágenes a la vez', [machine('m1', OLD), machine('m2', NEW)]],
  ])('record falla %s', (_name, machines) => {
    const f = fakes(machines, []);
    expect(runScript('deploy/fly/rollback.sh', ['record'], f.bin, f.env).status).toBe(1);
    rmSync(f.dir, { recursive: true, force: true });
  });

  // El caso que bluegreen no cubre: el deploy terminó, el tráfico pasó a la versión nueva y
  // /health dejó de atender el commit. Las máquinas vuelven a la imagen anterior, sin correr el
  // release_command (machine update, no deploy), y /health vuelve a atender el release anterior.
  it('restore: vuelve cada máquina de la API a la imagen anterior y exige que /health atienda el release anterior', () => {
    const f = fakes([machine('m1', NEW), machine('m2', NEW), machine('r1', NEW, 'release_command')],
      [body(SHA, false), body(PREV)]);
    const r = runScript('deploy/fly/rollback.sh', ['restore'], f.bin, { ...f.env, PREVIOUS_IMAGE: OLD, PREVIOUS_RELEASE: PREV });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`atiende otra vez ${PREV}`);
    expect(f.calls()).toEqual([
      'flyctl machines list --app cocos-challenge-a-staging --json',
      `flyctl machine update m1 --app cocos-challenge-a-staging --image ${OLD} --env RELEASE=${PREV} --yes`,
      `flyctl machine update m2 --app cocos-challenge-a-staging --image ${OLD} --env RELEASE=${PREV} --yes`,
      'curl -sS --max-time 10 https://cocos-challenge-a-staging.fly.dev/health',
      'curl -sS --max-time 10 https://cocos-challenge-a-staging.fly.dev/health',
    ]);
    expect(f.calls().some((c) => c.startsWith('flyctl deploy'))).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('restore falla si después de volver /health no atiende el release anterior', () => {
    const f = fakes([machine('m1', NEW)], [body(SHA, false)]);
    const r = runScript('deploy/fly/rollback.sh', ['restore'], f.bin, { ...f.env, PREVIOUS_IMAGE: OLD, PREVIOUS_RELEASE: PREV });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no atiende ${PREV}`);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('restore falla si una máquina no se puede actualizar, y sin imagen o release anterior no toca nada', () => {
    const f = fakes([machine('m1', NEW)], [body(PREV)]);
    expect(runScript('deploy/fly/rollback.sh', ['restore'], f.bin,
      { ...f.env, PREVIOUS_IMAGE: OLD, PREVIOUS_RELEASE: PREV, UPDATE_EXIT: '1' }).status).toBe(1);
    expect(f.calls().some((c) => c.startsWith('curl'))).toBe(false);
    writeFileSync(f.log, '');
    expect(runScript('deploy/fly/rollback.sh', ['restore'], f.bin, { ...f.env, PREVIOUS_RELEASE: PREV }).status).toBe(1);
    expect(runScript('deploy/fly/rollback.sh', ['restore'], f.bin, { ...f.env, PREVIOUS_IMAGE: OLD }).status).toBe(1);
    expect(f.calls()).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

// deploy/fly/setup.sh con `fly` y `curl` simulados, en un repositorio temporal parado en main
// con los archivos que usa: crea cada app y su base desde la configuración elegida (CONFIG y
// DB_CONFIG, por defecto producción), y los secretos van a la app correcta por stdin, nunca en
// los argumentos ni en la salida.
describe('setup.sh', () => {
  const FILES = ['deploy/fly/setup.sh', 'deploy/fly/release-check.sh', 'fly.toml',
    'deploy/fly/db.toml', 'deploy/fly/staging.toml', 'deploy/fly/staging-db.toml'];
  const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'prueba',
    GIT_AUTHOR_EMAIL: 'prueba@example.com', GIT_COMMITTER_NAME: 'prueba', GIT_COMMITTER_EMAIL: 'prueba@example.com' };

  const setup = (env: Record<string, string>) => {
    const f = fakeBin({
      fly: [
        'echo "fly $*" >> "$CALLS"',
        'if [ "$1 $2" = "secrets import" ]; then { echo "--- $*"; cat; } >> "$SECRETS"; fi',
      ].join('\n'),
      // /health de la app recién desplegada: atiende el HEAD del repositorio temporal.
      curl: 'echo "curl $*" >> "$CALLS"\nprintf \'{"ok":true,"db":"up","release":"%s"}\' "$(git -C "$REPO" rev-parse HEAD)"',
      sleep: ':',
    });
    const repo = join(f.dir, 'repo');
    for (const file of FILES) {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), readFileSync(join(ROOT, file)));
      chmodSync(join(repo, file), statSync(join(ROOT, file)).mode);
    }
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'setup');
    const secrets = join(f.dir, 'secrets');
    writeFileSync(secrets, '');
    const r = spawnSync('bash', [join(repo, 'deploy/fly/setup.sh')], {
      cwd: repo, encoding: 'utf8',
      env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/', ...GIT,
        CALLS: f.log, SECRETS: secrets, REPO: repo, HEALTH_ATTEMPTS: '1', ...env },
    });
    const result = { r, sha: git('rev-parse', 'HEAD'), calls: f.calls(), secrets: readFileSync(secrets, 'utf8') };
    rmSync(f.dir, { recursive: true, force: true });
    return result;
  };

  /** Secretos importados por app: { app: { CLAVE: valor } }. */
  const imported = (text: string) => {
    const byApp: Record<string, Record<string, string>> = {};
    let app = '';
    for (const line of text.split('\n').filter(Boolean)) {
      const header = line.match(/^--- secrets import --app (\S+) --stage$/);
      if (header) { app = header[1]; byApp[app] = {}; continue; }
      const [k, ...v] = line.split('=');
      byApp[app][k] = v.join('=');
    }
    return byApp;
  };

  it.each([
    ['producción, por defecto', {}, 'cocos-challenge-a-api', 'cocos-challenge-a-db', 'fly.toml', 'deploy/fly/db.toml'],
    ['staging, con CONFIG y DB_CONFIG', { CONFIG: 'deploy/fly/staging.toml', DB_CONFIG: 'deploy/fly/staging-db.toml' },
      'cocos-challenge-a-staging', 'cocos-challenge-a-staging-db', 'deploy/fly/staging.toml', 'deploy/fly/staging-db.toml'],
  ])('%s: apps, volumen, secretos y deploys sobre la configuración elegida', (_name, env, api, db, config, dbConfig) => {
    const { r, sha, calls, secrets } = setup(env as Record<string, string>);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(calls).toEqual([
      `fly apps create ${db} --org personal`,
      `fly volumes create pgdata --app ${db} --region gru --size 1 --yes`,
      `fly secrets import --app ${db} --stage`,
      `fly deploy --config ${dbConfig} --ha=false`,
      `fly apps create ${api} --org personal`,
      `fly secrets import --app ${api} --stage`,
      `fly deploy --config ${config} --ha=false --remote-only --image-label ${sha} --env RELEASE=${sha}`,
      `curl -sS --max-time 10 https://${api}.fly.dev/health`,
    ]);
    const s = imported(secrets);
    expect(Object.keys(s)).toEqual([db, api]);
    expect(Object.keys(s[db])).toEqual(['POSTGRES_PASSWORD']);
    expect(Object.keys(s[api])).toEqual(['DATABASE_ADMIN_URL', 'API_DB_PASSWORD', 'DATABASE_URL', 'INTERNAL_TOKEN']);
    const pg = s[db].POSTGRES_PASSWORD;
    const apiPassword = s[api].API_DB_PASSWORD;
    expect(s[api].DATABASE_ADMIN_URL).toBe(`postgresql://postgres:${pg}@${db}.internal:5432/cocos`);
    expect(s[api].DATABASE_URL).toBe(`postgresql://api:${apiPassword}@${db}.internal:5432/cocos`);
    // Contraseñas y token generados, distintos entre sí, y fuera de argumentos y salida.
    const values = [pg, apiPassword, s[api].INTERNAL_TOKEN];
    for (const v of values) {
      expect(v).toMatch(/^[0-9a-f]{48}$/);
      expect(calls.join('\n')).not.toContain(v);
      expect(r.stdout + r.stderr).not.toContain(v);
    }
    expect(new Set(values).size).toBe(3);
  });

  it('cada configuración apunta a su propia base: staging nunca recibe la URL de la base de producción', () => {
    const prod = imported(setup({}).secrets)['cocos-challenge-a-api'];
    const staging = imported(setup({ CONFIG: 'deploy/fly/staging.toml', DB_CONFIG: 'deploy/fly/staging-db.toml' }).secrets)['cocos-challenge-a-staging'];
    expect(prod.DATABASE_URL).toContain('@cocos-challenge-a-db.internal:');
    expect(staging.DATABASE_URL).toContain('@cocos-challenge-a-staging-db.internal:');
    expect(staging.DATABASE_ADMIN_URL).not.toContain('@cocos-challenge-a-db.internal:');
  });
});
