// Las notas de cada versión (CHANGELOG.md, issue #51) no quedan incompletas en silencio. La sección
// "sin publicar" (la próxima versión) nombra, con link, cada PR que entró a main desde el último
// tag vX.Y.Z, leído de la historia (`git log <tag>..HEAD`, el "(#N)" del squash); una versión ya
// publicada (su tag existe) tiene fecha y no dice "sin publicar". Además, lo que pide el issue #51
// para v0.2.0: sus PRs (#43 a #48, #50 y #52) y, en "Antes de publicar", volver a correr setup.sh
// según "Secretos como archivos" (#50). Los controles verifican que quitar un PR o ese paso falla.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CHANGELOG = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
const REPO = 'https://github.com/dante0x95/cocos-challenge-a/pull/';
const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

interface Section { version: string; label: string; body: string }

/** Las secciones `## vX.Y.Z — <fecha o "sin publicar">`, en orden. */
function sections(text: string): Section[] {
  const heads = [...text.matchAll(/^## (v\d+\.\d+\.\d+) — (.+)$/gm)];
  return heads.map((m, i) => ({
    version: m[1], label: m[2].trim(),
    body: text.slice(m.index! + m[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined),
  }));
}
/** Los PRs con link a este repositorio en un texto. */
const linkedPrs = (text: string) => new Set([...text.matchAll(/\]\(https:\/\/github\.com\/dante0x95\/cocos-challenge-a\/pull\/(\d+)\)/g)].map((m) => Number(m[1])));
/** La subsección `### <título>` de una sección. */
const subsection = (body: string, title: string) => {
  const start = body.indexOf(`### ${title}\n`);
  if (start < 0) return null;
  const next = body.indexOf('\n### ', start + 1);
  return body.slice(start, next < 0 ? undefined : next);
};

/** Lo que está mal en el CHANGELOG, dados los tags publicados y los PRs desde el último. */
function problems(text: string, tags: string[], prsSinceLastTag: number[]): string[] {
  const out: string[] = [];
  const all = sections(text);
  const unreleased = all.filter((s) => s.label === 'sin publicar');
  if (unreleased.length > 1) out.push('hay más de una sección "sin publicar"');
  if (unreleased.length && all[0] !== unreleased[0]) out.push('la sección "sin publicar" va primero');
  for (const s of all) {
    if (tags.includes(s.version) && s.label === 'sin publicar') out.push(`${s.version} ya se publicó: su sección necesita la fecha`);
    if (s.label !== 'sin publicar' && !/^\d{4}-\d{2}-\d{2}$/.test(s.label)) out.push(`${s.version}: "${s.label}" no es una fecha ni "sin publicar"`);
  }
  for (const tag of tags) if (!all.some((s) => s.version === tag)) out.push(`falta la sección de ${tag}, que ya se publicó`);
  const next = unreleased[0];
  if (next) {
    const linked = linkedPrs(next.body);
    for (const pr of prsSinceLastTag) if (!linked.has(pr)) out.push(`${next.version} no nombra #${pr}, que entró después del último tag`);
  }
  // Issue #51, plan de pruebas 5.
  const v020 = all.find((s) => s.version === 'v0.2.0');
  if (v020) {
    const linked = linkedPrs(v020.body);
    for (const pr of [43, 44, 45, 46, 47, 48, 50, 52]) if (!linked.has(pr)) out.push(`v0.2.0 no nombra #${pr}`);
    const before = subsection(v020.body, 'Antes de publicar');
    if (!before) out.push('v0.2.0 no tiene "Antes de publicar"');
    else if (!/setup\.sh/.test(before) || !before.includes('(docs/api/operacion.md#secretos-como-archivos)')) {
      out.push('v0.2.0: "Antes de publicar" no pide volver a correr setup.sh según "Secretos como archivos"');
    }
  }
  return out;
}

/** Los tags vX.Y.Z en la historia de HEAD, del más nuevo al más viejo. */
const tags = git('tag', '--list', '--merged', 'HEAD', '--sort=-version:refname').split('\n').filter((t) => VERSION.test(t));
/** Los PRs (el "(#N)" final del asunto, como lo deja el squash) desde el último tag. */
const prsSince = (tag: string | undefined) => (tag ? git('log', '--no-merges', '--format=%s', `${tag}..HEAD`) : '')
  .split('\n').map((l) => /\(#(\d+)\)$/.exec(l)?.[1]).filter(Boolean).map(Number);

describe('CHANGELOG.md', () => {
  it('está al día con la historia: cada PR desde el último tag, y cada versión publicada con su fecha', () => {
    expect(tags.length, 'sin tags vX.Y.Z: el checkout necesita la historia y los tags').toBeGreaterThan(0);
    expect(problems(CHANGELOG, tags, prsSince(tags[0]))).toEqual([]);
  });

  it('la próxima versión tiene "Antes de publicar"', () => {
    const next = sections(CHANGELOG).find((s) => s.label === 'sin publicar');
    expect(next && subsection(next.body, 'Antes de publicar')).toBeTruthy();
  });

  it('cada link a un PR va a este repositorio', () => {
    const links = [...CHANGELOG.matchAll(/\]\((https:\/\/github\.com\/[^)]+\/pull\/\d+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((l) => !l.startsWith(REPO))).toEqual([]);
  });

  // Controles: el chequeo ve lo que tiene que ver.
  it('control: sin la línea de #43 o sin el paso de setup.sh, falla', () => {
    const withoutPr = CHANGELOG.split('\n').filter((l) => !l.includes('/pull/43)')).join('\n');
    expect(problems(withoutPr, ['v0.1.0'], [43])).toEqual(expect.arrayContaining(['v0.2.0 no nombra #43', 'v0.2.0 no nombra #43, que entró después del último tag']));
    const withoutSetup = CHANGELOG.replace(/^1\. \*\*Volver a correr `setup\.sh`.*$/m, '1. Nada.');
    expect(withoutSetup).not.toBe(CHANGELOG);
    expect(problems(withoutSetup, ['v0.1.0'], [])).toContain('v0.2.0: "Antes de publicar" no pide volver a correr setup.sh según "Secretos como archivos"');
  });

  it('control: un PR nuevo sin nombrar, o una versión publicada sin fecha, falla', () => {
    expect(problems(CHANGELOG, ['v0.1.0'], [999])).toEqual(['v0.2.0 no nombra #999, que entró después del último tag']);
    expect(problems(CHANGELOG, ['v0.2.0', 'v0.1.0'], [])).toEqual(['v0.2.0 ya se publicó: su sección necesita la fecha']);
    expect(problems(CHANGELOG, ['v0.3.0', 'v0.1.0'], [])).toContain('falta la sección de v0.3.0, que ya se publicó');
  });
});
