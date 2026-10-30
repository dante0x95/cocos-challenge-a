// Doble de `codex exec` para test/unit/codex-review.test.ts. Guarda los argumentos en
// FAKE_DIR/codex-args.json, el prompt en FAKE_DIR/codex-input.md y el schema que recibe en
// FAKE_DIR/codex-schema.json; escribe en -o la salida de FAKE_DIR/codex-out.json. Un
// inspected_commit "HEAD" se reemplaza por el commit del checkout (-C).
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

writeFileSync(join(dir, 'codex-args.json'), JSON.stringify(args));
writeFileSync(join(dir, 'codex-input.md'), readFileSync(0, 'utf8'));
// Sin schema, codex no restringe la salida: el doble falla como fallaría la gate.
if (!flag('--output-schema')) {
  console.error('fake-codex: falta --output-schema');
  process.exit(1);
}
copyFileSync(flag('--output-schema'), join(dir, 'codex-schema.json'));
let out = readFileSync(join(dir, 'codex-out.json'), 'utf8');
try {
  const parsed = JSON.parse(out);
  if (parsed.inspected_commit === 'HEAD') {
    parsed.inspected_commit = execFileSync('git', ['-C', flag('-C'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  out = JSON.stringify(parsed);
} catch {
  // Salida que no es JSON: se escribe tal cual, el script tiene que rechazarla.
}
writeFileSync(flag('-o'), out);
