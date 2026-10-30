// Doble de `gh` para test/unit/codex-review.test.ts. Responde las lecturas que hace
// scripts/codex-review.sh con los archivos de FAKE_DIR y registra cada llamada en
// FAKE_DIR/calls.jsonl, para que el test verifique qué se publicó y qué no.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR;
const fixture = (name) => readFileSync(join(dir, name), 'utf8');
const args = process.argv.slice(2);

const VALUE_FLAGS = new Set(['-X', '-f', '-F', '-q', '--input', '--json', '-H']);
let method = 'GET';
let query = null;
let input = null;
const fields = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) {
    const v = args[++i];
    if (a === '-X') method = v;
    else if (a === '-q') query = v;
    else if (a === '--input') input = v;
    else if (a === '-f' || a === '-F') {
      const eq = v.indexOf('=');
      fields[v.slice(0, eq)] = v.slice(eq + 1);
    }
  } else if (!a.startsWith('-')) positional.push(a);
}
const stdin = input === '-' ? JSON.parse(readFileSync(0, 'utf8')) : null;
const endpoint = positional[0] === 'api' ? positional[1] : positional.slice(0, 2).join(' ');
const mutation = endpoint === 'graphql' && /^\s*mutation/.test(fields.query ?? '');
appendFileSync(join(dir, 'calls.jsonl'),
  JSON.stringify({ method, endpoint, fields, stdin, write: method !== 'GET' || mutation }) + '\n');

if (positional[0] === 'repo') {
  console.log('acme/demo');
} else if (endpoint === 'user') {
  console.log(query === '.login' ? 'dante' : JSON.stringify({ login: 'dante' }));
} else if (endpoint === 'pr view') {
  process.stdout.write(fixture('pr.json'));
} else if (endpoint === 'pr checks') {
  process.stdout.write(fixture('checks.json'));
} else if (endpoint === 'issue view') {
  console.log(JSON.stringify({ number: Number(positional[2]), title: 'Issue de prueba', body: 'Plan de pruebas: ...' }));
} else if (endpoint === 'graphql') {
  process.stdout.write(mutation ? '{}' : fixture('threads.json'));
} else if (method === 'GET' && endpoint.endsWith('/reviews')) {
  process.stdout.write(JSON.stringify([JSON.parse(fixture('reviews.json'))])); // --paginate --slurp
} else if (method === 'GET' && /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(endpoint)) {
  process.stdout.write(JSON.stringify([JSON.parse(fixture('issue-comments.json'))])); // --paginate --slurp
} else if (method === 'POST' && endpoint.endsWith('/reviews') && query === '.html_url') {
  console.log('https://github.com/acme/demo/pull/8#pullrequestreview-1');
} else if (method === 'POST') {
  console.log('{}');
} else {
  console.error(`fake-gh: llamada no prevista: ${args.join(' ')}`);
  process.exit(1);
}
