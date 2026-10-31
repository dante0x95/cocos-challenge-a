// Los comandos de operación de docs/api/operacion.md se copian tal cual en una terminal, y la de
// macOS es zsh interactivo. Al preparar el servidor para v0.2.0 fallaron tres cosas que bash no ve:
// en zsh `HOST` ya existe (el nombre de la máquina), `$HOST:c` es un modificador que se come los dos
// puntos del destino de scp, y un `#` después de un comando no es un comentario (INTERACTIVE_COMMENTS
// viene apagado), así que `LIGHTSAIL_KEY=… # …` no define la clave. Esta suite corre los bloques que
// hablan con el servidor en `zsh -f -i` y en bash, con ssh, scp, gh y git simulados (anotan sus
// argumentos, no conectan ni escriben; ssh devuelve una clave de host conocida), y exige los
// argumentos efectivos, también el cuerpo completo de LIGHTSAIL_KNOWN_HOSTS. Los controles verifican que
// cada una de esas tres variantes la hace fallar.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const DOC = readFileSync(resolve(ROOT, 'docs/api/operacion.md'), 'utf8');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const IP = '18.227.203.30';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaClaveDeHostDePrueba';
const SHELLS = ['zsh', 'bash'] as const;
type Shell = (typeof SHELLS)[number];

const hasZsh = spawnSync('zsh', ['-fc', 'true']).status === 0;

/** Los bloques ```bash de un markdown. */
const bashBlocks = (md: string) => [...md.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
/** Los que preparan o consultan el servidor con las variables de "La primera vez". */
const serverBlocks = (md: string) => bashBlocks(md).filter((b) => /\bLIGHTSAIL_(HOST|KEY)\b|\$\{?HOST\b/.test(b));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Corre los bloques del servidor de `md` en `shell` y devuelve cada llamada a ssh/scp/gh/git y el stderr. */
function run(shell: Shell, md: string): { calls: string[][]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ops-commands-'));
  dirs.push(dir);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, '.ssh/cocos-deploy'), 'clave privada de prueba\n');
  writeFileSync(join(home, '.ssh/cocos-deploy.pub'), 'ssh-ed25519 AAAAprueba cocos-deploy\n');
  writeFileSync(log, '');
  for (const cmd of ['ssh', 'scp', 'gh', 'git']) {
    const stub = join(bin, cmd);
    // Una línea por llamada, los argumentos separados por un carácter que no aparece en ellos.
    // ssh devuelve una clave de host conocida si se le pide (el paso que arma KNOWN).
    const hostKey = cmd === 'ssh' ? `case "$*" in *ssh_host_ed25519_key.pub*) echo '${HOST_KEY} root@cocos';; esac\n` : '';
    writeFileSync(stub, `#!/bin/sh\n{ printf '%s' '${cmd}'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "$CALLS_LOG"\n${hostKey}`);
    chmodSync(stub, 0o755);
  }
  const script = serverBlocks(md).join('\n');
  // HOST simula el nombre de la máquina: zsh lo define siempre; bash no, y así ve lo mismo.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CALLS_LOG: log, HOST: 'mi-mac.local', TERM: 'dumb' };
  const args = shell === 'zsh' ? ['-f', '-i'] : ['--norc', '--noprofile', '-i'];
  const r = spawnSync(shell, args, { input: `${script}\nexit\n`, env, cwd: ROOT, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f'));
  return { calls, stderr: r.stderr ?? '' };
}

/** Lo que está mal en las llamadas que hicieron los comandos documentados. */
function problems({ calls, stderr }: { calls: string[][]; stderr: string }): string[] {
  const out: string[] = [];
  const notFound = stderr.split('\n').filter((l) => /command not found|not found:/.test(l));
  if (notFound.length) out.push(`comandos que la terminal no reconoce: ${notFound.join(' | ')}`);
  const keys = new Set(['~/.ssh/TU-CLAVE-DE-LIGHTSAIL.pem', '~/.ssh/cocos-deploy']);
  const remote = calls.filter((c) => c[0] === 'ssh' || c[0] === 'scp');
  if (!remote.length) out.push('ningún ssh ni scp');
  for (const c of remote) {
    const i = c.indexOf('-i');
    const key = i > 0 ? c[i + 1] : undefined;
    const shown = key?.replace(/^.*\/\.ssh\//, '~/.ssh/');
    if (!key || !keys.has(shown!)) out.push(`${c[0]} con la clave "${key ?? ''}"`);
    const target = c[0] === 'ssh' ? c.find((a, j) => j > 0 && a.includes('@')) : c[c.length - 1];
    const ok = c[0] === 'ssh' ? [`ubuntu@${IP}`, `deploy@${IP}`] : [`ubuntu@${IP}:cocos-setup`];
    if (!target || !ok.includes(target)) out.push(`${c[0]} hacia "${target ?? ''}"`);
  }
  if (!calls.some((c) => c[0] === 'scp')) out.push('ningún scp');
  const hostSecrets = calls.filter((c) => c[0] === 'gh' && c[3] === 'LIGHTSAIL_HOST');
  if (hostSecrets.length !== 2) out.push(`LIGHTSAIL_HOST se fija ${hostSecrets.length} veces, no 2`);
  for (const c of hostSecrets) if (c[c.indexOf('--body') + 1] !== IP) out.push(`LIGHTSAIL_HOST = "${c[c.indexOf('--body') + 1]}"`);
  const knownHosts = calls.filter((c) => c[0] === 'gh' && c[3] === 'LIGHTSAIL_KNOWN_HOSTS');
  if (knownHosts.length !== 2) out.push(`LIGHTSAIL_KNOWN_HOSTS se fija ${knownHosts.length} veces, no 2`);
  for (const c of knownHosts) {
    const body = c[c.indexOf('--body') + 1];
    if (body !== `${IP} ${HOST_KEY}`) out.push(`LIGHTSAIL_KNOWN_HOSTS = "${body}"`);
  }
  return out;
}

describe('comandos de operación (docs/api/operacion.md)', () => {
  it('zsh está disponible (en el CI lo instala el workflow)', () => {
    expect(hasZsh || !process.env.CI, 'sin zsh en el CI: esta suite no probaría lo que importa').toBe(true);
  });

  it('hay bloques que preparan el servidor', () => {
    expect(serverBlocks(DOC).length).toBeGreaterThanOrEqual(5);
  });

  for (const shell of SHELLS) {
    it.skipIf(shell === 'zsh' && !hasZsh)(`en ${shell} interactivo: la clave, el host y el destino de scp llegan como se documentan`, () => {
      expect(problems(run(shell, DOC))).toEqual([]);
    });
  }

  it('ningún bloque de comandos de operacion.md ni del README lleva un comentario después de un comando', () => {
    const withComment = [...bashBlocks(DOC), ...bashBlocks(README)]
      .flatMap((b) => b.split('\n'))
      .filter((l) => /(^|\s)#(\s|$)/.test(l.replace(/'[^']*'|"[^"]*"/g, '')));
    expect(withComment).toEqual([]);
  });

  // Controles, en zsh: cada una de las tres variantes que fallaron al preparar v0.2.0 se ve.
  describe.skipIf(!hasZsh)('controles', () => {
    it('con $HOST en vez de ${LIGHTSAIL_HOST}, falla', () => {
      const mutated = DOC.replaceAll('${LIGHTSAIL_HOST}', '$HOST');
      expect(mutated).not.toBe(DOC);
      expect(problems(run('zsh', mutated)).join('\n')).toMatch(/hacia "ubuntu@mi-mac/);
    });

    it('con "ubuntu@$LIGHTSAIL_HOST:cocos-setup" (sin llaves), el scp no va al servidor', () => {
      const mutated = DOC.replaceAll('"ubuntu@${LIGHTSAIL_HOST}:cocos-setup"', '"ubuntu@$LIGHTSAIL_HOST:cocos-setup"');
      expect(mutated).not.toBe(DOC);
      expect(problems(run('zsh', mutated))).toContain(`scp hacia "ubuntu@${IP}ocos-setup"`);
    });

    it('con KNOWN sin la clave del host, falla', () => {
      const mutated = DOC.replace(/^KNOWN=.*$/m, 'KNOWN="${LIGHTSAIL_HOST} "');
      expect(mutated).not.toBe(DOC);
      expect(problems(run('zsh', mutated))).toContain(`LIGHTSAIL_KNOWN_HOSTS = "${IP} "`);
    });

    it('con un comentario después de LIGHTSAIL_KEY, la clave no se define', () => {
      const mutated = DOC.replace(/^LIGHTSAIL_KEY=(.*)$/m, 'LIGHTSAIL_KEY=$1   # la clave de Lightsail');
      expect(mutated).not.toBe(DOC);
      const found = problems(run('zsh', mutated)).join('\n');
      expect(found).toMatch(/comandos que la terminal no reconoce/);
      expect(found).toMatch(/con la clave ""/);
    });
  });
});
