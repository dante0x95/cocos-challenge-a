// El lab de Z, A y C (issue #72, lab/README.md). Dos cosas que se pueden romper sin que nada más lo
// note:
//   - El lab no entra en el entregable: ni la imagen, ni el deploy de Lightsail, ni un workflow lo
//     usan. Los cambios en lab/ no pueden cambiar lo que despliegan staging y producción.
//   - Los comandos de lab/README.md los copia Dante en la terminal de macOS, zsh interactivo, como
//     los de docs/api/operacion.md (test/unit/ops-commands, #55). Se corren los que preparan la
//     instancia en `zsh -f -i` y en bash, con ssh y scp simulados (anotan sus argumentos, no
//     conectan), y lab/deploy.sh setup tiene que llamarlos con la clave y el destino documentados.
// La prueba de punta a punta del lab (las tres variantes con los mismos números) es lab/e2e.sh: con
// Docker y el generador del benchmark, a mano.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const LAB_README = read('lab/README.md');
const IP = '203.0.113.10';
const hasZsh = spawnSync('zsh', ['-fc', 'true']).status === 0;

const bashBlocks = (md: string) => [...md.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
/** Los bloques que definen las variables de la instancia y el que la prepara. */
const setupBlocks = (md: string) => bashBlocks(md).filter((b) => /LIGHTSAIL_LAB_|lab\/deploy\.sh setup/.test(b));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run(shell: 'zsh' | 'bash', md: string): { calls: string[][]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lab-commands-'));
  dirs.push(dir);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, '.ssh/cocos-lab.pem'), 'clave privada de prueba\n');
  writeFileSync(log, '');
  for (const cmd of ['ssh', 'scp']) {
    writeFileSync(join(bin, cmd), `#!/bin/sh\n{ printf '%s' '${cmd}'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "$CALLS_LOG"\n`);
    chmodSync(join(bin, cmd), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CALLS_LOG: log, HOST: 'mi-mac.local', TERM: 'dumb' };
  const args = shell === 'zsh' ? ['-f', '-i'] : ['--norc', '--noprofile', '-i'];
  const r = spawnSync(shell, args, { input: `${setupBlocks(md).join('\n')}\nexit\n`, env, cwd: ROOT, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f'));
  return { calls, stderr: r.stderr ?? '' };
}

/** Lo que está mal en las llamadas de `lab/deploy.sh setup`. */
function problems({ calls, stderr }: { calls: string[][]; stderr: string }): string[] {
  const out: string[] = [];
  const frenado = stderr.split('\n').filter((l) => /FRENADO|command not found|not found:/.test(l));
  if (frenado.length) out.push(...frenado);
  const scp = calls.filter((c) => c[0] === 'scp');
  const ssh = calls.filter((c) => c[0] === 'ssh');
  if (scp.length !== 1) out.push(`${scp.length} scp, se espera 1`);
  if (ssh.length !== 1) out.push(`${ssh.length} ssh, se espera 1`);
  for (const c of [...scp, ...ssh]) {
    const key = c[c.indexOf('-i') + 1] ?? '';
    if (!key.endsWith('/home/.ssh/cocos-lab.pem')) out.push(`${c[0]} con la clave "${key}"`);
  }
  if (scp[0] && scp[0].slice(-2).join(' ') !== `lab/remote/setup.sh ubuntu@${IP}:cocos-lab-setup.sh`) {
    out.push(`scp ${scp[0].slice(-2).join(' ')}`);
  }
  if (ssh[0] && ssh[0].slice(-2).join(' ') !== `ubuntu@${IP} sudo bash cocos-lab-setup.sh && rm cocos-lab-setup.sh`) {
    out.push(`ssh ${ssh[0].slice(-2).join(' ')}`);
  }
  return out;
}

describe('el lab no entra en el entregable', () => {
  it('la imagen no copia lab/', () => {
    expect(read('Dockerfile')).not.toMatch(/\blab\b/);
  });

  it('ningún workflow ni deploy/ nombra lab/', () => {
    const files = [
      ...readdirSync(resolve(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      ...readdirSync(resolve(ROOT, 'deploy'), { recursive: true, encoding: 'utf8' }).map((f) => `deploy/${f}`)
        .filter((f) => /\.(sh|yml|mjs|sql)$|Caddyfile$/.test(f)),
    ];
    expect(files).toContain('.github/workflows/deploy.yml');
    expect(files).toContain('deploy/lightsail/compose.yml');
    expect(files.filter((f) => /\blab\//.test(read(f)))).toEqual([]);
  });
});

describe('comandos de lab/README.md', () => {
  it('zsh está disponible (en el CI lo instala el workflow)', () => {
    expect(hasZsh || !process.env.CI, 'sin zsh en el CI: esta suite no probaría lo que importa').toBe(true);
  });

  it('hay un bloque con las variables y uno que prepara la instancia', () => {
    expect(setupBlocks(LAB_README).some((b) => b.includes(`LIGHTSAIL_LAB_HOST=${IP}`))).toBe(true);
    expect(setupBlocks(LAB_README).some((b) => b.includes('lab/deploy.sh setup'))).toBe(true);
  });

  for (const shell of ['zsh', 'bash'] as const) {
    it.skipIf(shell === 'zsh' && !hasZsh)(`en ${shell} interactivo: setup copia y corre setup.sh con la clave y el host documentados`, () => {
      expect(problems(run(shell, LAB_README))).toEqual([]);
    });
  }

  it('ningún bloque lleva un comentario después de un comando', () => {
    const withComment = bashBlocks(LAB_README).flatMap((b) => b.split('\n'))
      .filter((l) => /(^|\s)#(\s|$)/.test(l.replace(/'[^']*'|"[^"]*"/g, '')));
    expect(withComment).toEqual([]);
  });

  it.skipIf(!hasZsh)('control: con un comentario después de LIGHTSAIL_LAB_KEY, en zsh la clave no se define y setup frena', () => {
    const mutated = LAB_README.replace(/^LIGHTSAIL_LAB_KEY=(.*)$/m, 'LIGHTSAIL_LAB_KEY=$1   # la clave del lab');
    expect(mutated).not.toBe(LAB_README);
    const found = problems(run('zsh', mutated)).join('\n');
    expect(found).toMatch(/falta LIGHTSAIL_LAB_KEY/);
    expect(found).toMatch(/0 scp/);
  });

  it.skipIf(!hasZsh)('control: con la IP sin exportar, setup frena sin conectarse', () => {
    const mutated = LAB_README.replace(/^export LIGHTSAIL_LAB_HOST /m, 'export ');
    expect(mutated).not.toBe(LAB_README);
    expect(problems(run('zsh', mutated)).join('\n')).toMatch(/falta LIGHTSAIL_LAB_HOST/);
  });
});
