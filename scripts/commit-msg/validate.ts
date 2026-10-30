// Formato obligatorio de commits y PRs (CONTRIBUTING.md). Con squash merge, el título y la
// descripción del PR son el commit que queda en main: por eso la misma regla vale para los dos.
//
//   <tipo>(<alcance>): <resumen en imperativo, ≤ 72 caracteres>
//
//   Problema:
//   Valor para el negocio:
//   Solución:            (al menos un ítem "- ")
//   Cómo se probó:       ("- automático: …" y "- manual: …")
//   Refs: #<issue>[, #<issue>…]
//
// Después de Refs solo se aceptan trailers de git ("Clave: valor"), líneas en blanco, la línea
// "🤖 Generated with …", URLs sueltas y un pie libre separado por una línea "---": lo que
// agregan las herramientas al final.

export const TYPES = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'ci'] as const;
export const MAX_SUMMARY = 72;

const SECTIONS = ['Problema:', 'Valor para el negocio:', 'Solución:', 'Cómo se probó:'] as const;
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9-]*\\))?: (\\S.*)$`);
const REFS = /^Refs: #\d+(, #\d+)*$/;
const FOOTER_LINE = /^([A-Z][A-Za-z-]+: \S.*|🤖 .*|https?:\/\/\S+)$/;

/** Líneas sin comentarios ni espacios finales, y sin líneas en blanco al principio y al final. */
function clean(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')     // comentarios HTML de la plantilla del PR
    .split('\n')
    .filter((l) => !l.startsWith('#'))   // comentarios que agrega git al editar el mensaje
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Devuelve la lista de errores de un mensaje de commit; vacía si es válido. */
export function validateMessage(raw: string): string[] {
  const lines = clean(raw);
  return validate(lines[0] ?? '', lines.slice(1));
}

/**
 * Título y descripción de un PR. El título se valida tal cual: la limpieza de comentarios de
 * git es solo para la descripción, así una línea de la descripción nunca reemplaza al título.
 */
export function validatePullRequest(title: string, body: string): string[] {
  return validate(title.trim(), ['', ...clean(body)]);
}

/** `title` es la primera línea; `rest`, las siguientes (la primera tiene que estar en blanco). */
function validate(title: string, rest: string[]): string[] {
  const lines = [title, ...rest];
  const errors: string[] = [];

  const m = HEADER.exec(title);
  if (!m) {
    errors.push(`título inválido: "${title}". Formato: <tipo>(<alcance>): <resumen>, con tipo en ${TYPES.join(', ')}`);
  } else {
    if (title.length > MAX_SUMMARY) errors.push(`título de ${title.length} caracteres; máximo ${MAX_SUMMARY}`);
    if (title.endsWith('.')) errors.push('el título no termina en punto');
  }
  if (lines.length > 1 && lines[1] !== '') errors.push('la segunda línea debe estar en blanco');

  // Posición de cada sección, en orden.
  const body = lines.slice(2);
  const at = (header: string) => body.findIndex((l) => l === header || l.startsWith(header + ' '));
  const positions = SECTIONS.map(at);
  const refsAt = body.findIndex((l) => l.startsWith('Refs:'));
  SECTIONS.forEach((s, i) => { if (positions[i] < 0) errors.push(`falta la sección "${s}"`); });
  if (refsAt < 0) errors.push('falta la línea "Refs: #<issue>"');
  const found = [...positions, refsAt].filter((p) => p >= 0);
  if (found.some((p, i) => i > 0 && p < found[i - 1])) {
    errors.push(`las secciones van en este orden: ${[...SECTIONS, 'Refs:'].join(' → ')}`);
  }
  if (errors.length) return errors;

  // Contenido de cada sección: desde su encabezado hasta el siguiente.
  const bounds = [...positions, refsAt];
  const content = (i: number) => {
    const inline = body[bounds[i]].slice(SECTIONS[i].length).trim();
    const rest = body.slice(bounds[i] + 1, bounds[i + 1]).filter((l) => l.trim() !== '');
    return inline ? [inline, ...rest] : rest;
  };
  SECTIONS.forEach((s, i) => { if (content(i).length === 0) errors.push(`la sección "${s}" está vacía`); });
  if (!content(2).some((l) => l.startsWith('- '))) errors.push('"Solución:" necesita al menos un ítem "- …"');
  const tested = content(3);
  if (!tested.some((l) => /^- automático: \S/.test(l))) errors.push('"Cómo se probó:" necesita "- automático: …"');
  if (!tested.some((l) => /^- manual: \S/.test(l))) errors.push('"Cómo se probó:" necesita "- manual: …" (o "- manual: n/a")');

  if (!REFS.test(body[refsAt])) errors.push(`Refs inválido: "${body[refsAt]}". Formato: Refs: #12 o Refs: #12, #13`);
  // Un pie separado por "---" (lo agregan las herramientas al crear el PR) no se valida.
  const tail = body.slice(refsAt + 1);
  const separator = tail.indexOf('---');
  const extra = (separator < 0 ? tail : tail.slice(0, separator)).filter((l) => l !== '' && !FOOTER_LINE.test(l));
  if (extra.length) errors.push(`después de Refs solo van trailers (Clave: valor); sobra: "${extra[0]}"`);
  return errors;
}
