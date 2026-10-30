// CLI del formato de commits y PRs (CONTRIBUTING.md).
//
//   tsx scripts/commit-msg/check.ts --file <ruta>        un mensaje (hook commit-msg)
//   tsx scripts/commit-msg/check.ts --range <base>..<head>  cada commit del rango (CI)
//   tsx scripts/commit-msg/check.ts --pr                 título + descripción del PR, de
//                                                        las variables PR_TITLE y PR_BODY (CI)
// Sale con 1 si algún mensaje es inválido e imprime qué corregir.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateMessage, validatePullRequest } from './validate.js';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });

function report(label: string, errors: string[]): boolean {
  if (errors.length === 0) return true;
  console.error(`✗ ${label}`);
  for (const e of errors) console.error(`  - ${e}`);
  return false;
}

function main(argv: string[]): number {
  const [mode, arg] = argv;
  let ok = true;
  if (mode === '--file' && arg) {
    ok = report('mensaje de commit', validateMessage(readFileSync(arg, 'utf8')));
  } else if (mode === '--range' && arg) {
    const shas = git('rev-list', '--reverse', arg).split('\n').filter(Boolean);
    if (shas.length === 0) { console.error(`sin commits en ${arg}`); return 1; }
    for (const sha of shas) {
      if (git('rev-list', '--parents', '-n', '1', sha).trim().split(' ').length > 2) {
        console.error(`✗ ${sha.slice(0, 7)}: commit de merge; el PR se integra por squash, rebasear sobre main`);
        ok = false;
        continue;
      }
      ok = report(`commit ${sha.slice(0, 7)}`, validateMessage(git('log', '-1', '--format=%B', sha))) && ok;
    }
  } else if (mode === '--pr') {
    ok = report('título y descripción del PR', validatePullRequest(process.env.PR_TITLE ?? '', process.env.PR_BODY ?? ''));
  } else {
    console.error('uso: check.ts --file <ruta> | --range <base>..<head> | --pr');
    return 1;
  }
  if (ok) console.log('✓ formato correcto');
  else console.error('\nFormato en CONTRIBUTING.md#formato-de-commits-y-prs');
  return ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
