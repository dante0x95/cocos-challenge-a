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
    if (/^(github|env)\./.test(t)) return t.split('.').reduce<unknown>((o, k) => (o as Ctx | undefined)?.[k], ctx);
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

  it('despliega exactamente el commit que pasó el CI, con RELEASE igual a ese SHA', () => {
    expect(evaluate(inner(valueOf('SHA')), run('success', 'push'))).toBe(SHA);
    expect(valueOf('ref')).toBe('${{ env.SHA }}');
    expect(yml).toMatch(/^\s*run: flyctl deploy --remote-only --image-label "\$SHA" --env "RELEASE=\$SHA"$/m);
  });

  it('antes de desplegar verifica que el commit desciende del release actual, con la historia completa; después, que /health lo atiende', () => {
    const runs = [...yml.matchAll(/^\s*run: (.+)$/gm)].map((m) => m[1]);
    expect(runs).toEqual([
      'deploy/fly/release-check.sh before',
      'flyctl deploy --remote-only --image-label "$SHA" --env "RELEASE=$SHA"',
      'deploy/fly/release-check.sh after',
    ]);
    // El gate compara commits: hace falta la historia, no solo el commit.
    expect(valueOf('fetch-depth')).toBe('0');
    // El script lee SHA y URL del entorno del job, y la URL es la del entorno de GitHub.
    const url = valueOf('URL');
    expect(url).toMatch(/^https:\/\/[a-z0-9-]+\.fly\.dev$/);
    expect(valueOf('url')).toBe(url);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

// La cola del grupo de concurrencia, como la documenta GitHub: con cancel-in-progress la
// corrida nueva cancela la que corre; si no, espera. Con queue: single (el valor por defecto)
// puede haber un solo pendiente y el nuevo cancela al que esperaba; con queue: max esperan
// todos (hasta 100) y arrancan en orden de llegada. Devuelve los commits que llegan a correr.
function concurrencyBlock() {
  const m = yml.match(/^concurrency:\n((?: {2}.+\n)+)/m);
  if (!m) throw new Error('deploy.yml no tiene un bloque concurrency');
  return Object.fromEntries([...m[1].matchAll(/^ {2}([\w-]+): (.+)$/gm)].map((e) => [e[1], e[2].trim()]));
}
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

  it('con A desplegándose y B pendiente, un re-run del CI de un commit viejo no cancela a B', () => {
    const c = concurrencyBlock();
    expect(c.group).toBe('deploy');
    // A no se corta, B llega a desplegarse, y el viejo corre después (y lo frena el gate).
    expect(simulateQueue(c, ['A', 'B', 'viejo'])).toEqual(['A', 'B', 'viejo']);
    expect(simulateQueue(c, ['A', 'B', 'C', 'viejo', 'D'])).toEqual(['A', 'B', 'C', 'viejo', 'D']);
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
