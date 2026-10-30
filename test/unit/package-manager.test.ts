// El proyecto se instala solo con pnpm (issue #6): pnpm-lock.yaml es el único lockfile
// versionado, los de otros gestores y las copias .bak quedan ignorados, y el pnpm que fija
// package.json es el mismo que instala el Dockerfile.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const isTracked = (path: string) => git('ls-files', '--', path).stdout.trim() === path;

// --no-index: mira solo las reglas de .gitignore, esté o no el archivo versionado.
const isIgnored = (path: string) => {
  const { status, stderr } = git('check-ignore', '--no-index', '-q', '--', path);
  if (status !== 0 && status !== 1) throw new Error(`git check-ignore falló: ${stderr}`);
  return status === 0;
};

describe('lockfiles', () => {
  it('pnpm-lock.yaml es el único lockfile versionado', () => {
    expect(isTracked('pnpm-lock.yaml')).toBe(true);
    expect(isTracked('package-lock.json')).toBe(false);
    expect(isTracked('pnpm-lock.yaml.bak')).toBe(false);
  });

  it('.gitignore excluye package-lock.json y cualquier .bak, pero no pnpm-lock.yaml', () => {
    expect(isIgnored('package-lock.json')).toBe(true);
    expect(isIgnored('pnpm-lock.yaml.bak')).toBe(true);
    expect(isIgnored('db/seed.sql.bak')).toBe(true);
    expect(isIgnored('pnpm-lock.yaml')).toBe(false);
  });

  it('packageManager fija el mismo pnpm que instala el Dockerfile', () => {
    const { packageManager } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
    const installed = dockerfile.match(/npm install -g (pnpm@\S+)/)?.[1];
    expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(installed).toBe(packageManager);
  });
});
