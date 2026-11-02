// El lab de Z, A y C (issue #72, lab/README.md). Dos cosas que se pueden romper sin que nada más lo
// note:
//   - El lab no entra en el entregable: ni la imagen, ni el deploy de Lightsail, ni un workflow lo
//     usan. Los cambios en lab/ no pueden cambiar lo que despliegan staging y producción.
//   - Los comandos de lab/README.md los copia Dante en la terminal de macOS, zsh interactivo, como
//     los de docs/api/operacion.md (test/unit/ops-commands, #55). Se corren los que preparan la
//     instancia en `zsh -f -i` y en bash, con ssh y scp simulados (anotan sus argumentos, no
//     conectan), y lab/deploy.sh setup tiene que llamarlos con la clave y el destino documentados.
//   - Lo que lab/check.ts exige de cada variante (lab/check-lib.ts), con una historia chica de compra,
//     venta y recompra a distinto precio: v2 contra el oráculo, v1 contra v2 y contra su propia
//     definición de costo, y cada respuesta cronometrada. Con controles que la rompen.
// La prueba de punta a punta del lab (las tres variantes con los mismos números) es lab/e2e.sh: con
// Docker y el generador del benchmark, a mano. C contra Postgres real: test/db/lab-c.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareA, compareTimed, compareZ, expectedA, expectedZ, parseRow } from '../../lab/check-lib.js';

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

describe('lo que exige lab/check.ts (lab/check-lib.ts)', () => {
  // CASH_IN 100.000; BUY 10 @ 100; SELL 4 @ 120; BUY 5 @ 90; pendientes: SELL 2 @ 150 y BUY 1 @ 50.
  // A (D-09): costo 1.000 → 600 al vender 4 de 10 → 1.050 al recomprar; cash 99.030.
  // Z: promedio de todas las compras, 1.450 / 15 = 96,6667 por acción → 1.063,333333.
  const rows = [
    '1,66,1,10000000,0.01,MARKET,CASH_IN,FILLED,2026-10-01 10:00:00,1',
    '2,7,1,10,100.00,MARKET,BUY,FILLED,2026-10-01 10:01:00,2',
    '3,7,1,4,120.00,MARKET,SELL,FILLED,2026-10-02 10:00:00,3',
    '4,7,1,5,90.00,MARKET,BUY,FILLED,2026-10-03 10:00:00,4',
    '5,7,1,2,150.00,LIMIT,SELL,NEW,2026-10-04 10:00:00,',
    '6,7,1,1,50.00,LIMIT,BUY,NEW,2026-10-04 10:01:00,',
    '7,7,1,3,80.00,LIMIT,BUY,CANCELLED,2026-10-04 10:02:00,',
  ].map(parseRow);
  const position = {
    instrumentid: 7, ticker: 'ABC', name: 'ABC S.A.', qty: '11', acciones_reservadas: '2', acciones_disponibles: '9',
    price: '110.00', price_date: '2026-10-23', valor: '1210.00', retorno_diario_pct: '1.00', inconsistent: false,
  };
  const head = { userid: 1, valor_total: '100240.00', cash: { neto: '99030.00', reservado: '50.00', disponible: '98980.00' }, valuation_complete: true, has_inconsistent_history: false };
  const a = { ...head, positions: [{ ...position, costo_total: '1050.000000', costo_unitario: '95.4545', resultado: '160.00', rendimiento_pct: '15.24' }] };
  const z = { ...head, positions: [{ ...position, costo_total: '1063.333333', costo_unitario: '96.6667', resultado: '146.67', rendimiento_pct: '13.79' }] };
  const withPosition = (p: any, change: Record<string, unknown>) => ({ ...p, positions: [{ ...p.positions[0], ...change }] });

  it('v2 que coincide con el oráculo pasa; con un centavo de costo, una reserva o el cash de otra forma, falla', () => {
    expect(compareA(1, a, expectedA(rows))).toEqual([]);
    expect(compareA(1, withPosition(a, { costo_total: '1050.000001' }), expectedA(rows))).not.toEqual([]);
    expect(compareA(1, withPosition(a, { acciones_reservadas: '0' }), expectedA(rows))).not.toEqual([]);
    expect(compareA(1, { ...a, cash: { ...a.cash, neto: '99030.01' } }, expectedA(rows))).not.toEqual([]);
    expect(compareA(1, { ...a, positions: [] }, expectedA(rows))).not.toEqual([]);
  });

  it('v1 con el costo del promedio de compras pasa; con el costo en cero, con el de A o con otro valor, falla', () => {
    expect(compareZ(1, z, a, expectedZ(rows))).toEqual([]);
    expect(compareZ(1, withPosition(z, { costo_total: '0.000000' }), a, expectedZ(rows))).not.toEqual([]);
    expect(compareZ(1, withPosition(z, { costo_total: '1050.000000' }), a, expectedZ(rows))).not.toEqual([]);
    expect(compareZ(1, withPosition(z, { costo_unitario: '95.4545' }), a, expectedZ(rows))).not.toEqual([]);
    expect(compareZ(1, withPosition(z, { resultado: '160.00' }), a, expectedZ(rows))).not.toEqual([]);
    expect(compareZ(1, withPosition(z, { rendimiento_pct: '15.24' }), a, expectedZ(rows))).not.toEqual([]);
    expect(compareZ(1, withPosition(z, { valor: '1210.01' }), a, expectedZ(rows))).not.toEqual([]);
    expect(compareZ(1, { ...z, valor_total: '100240.01' }, a, expectedZ(rows))).not.toEqual([]);
  });

  it('cada respuesta cronometrada tiene que ser 200 con el mismo cuerpo que la primera', () => {
    expect(compareTimed('x', [{ status: 200, text: '{}' }, { status: 200, text: '{}' }])).toEqual([]);
    expect(compareTimed('x', [{ status: 200, text: '{}' }, { status: 503, text: '{}' }])).not.toEqual([]);
    expect(compareTimed('x', [{ status: 200, text: '{}' }, { status: 200, text: '{"otro":1}' }])).not.toEqual([]);
    expect(compareTimed('x', [{ status: 500, text: '{}' }, { status: 500, text: '{}' }])).not.toEqual([]);
  });
});
