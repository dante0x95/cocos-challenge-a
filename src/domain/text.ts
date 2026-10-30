// Strings del cliente que llegan a Postgres (issue #40, D-30).
// Un carácter de control no es texto: Postgres no puede guardar U+0000 en `text` (rechaza el
// parámetro con 22021) y el resto no tiene uso legítimo en una búsqueda ni en una clave. Se rechazan
// en la frontera, con un 400 que dice qué campo, sin consultar la base.
import type { z } from 'zod';

// \p{Cc}: los controles de Unicode, exactamente C0 (U+0000–U+001F), DEL (U+007F) y C1 (U+0080–U+009F).
const CONTROL_CHAR = /\p{Cc}/u;
const WITHOUT_CONTROL_CHARS = /^\P{Cc}*$/u;

export const controlCharsMessage = (field: string) => `${field} no admite caracteres de control`;

/** true si `s` tiene algún carácter de control (C0, DEL o C1). */
export const hasControlChars = (s: string): boolean => CONTROL_CHAR.test(s);

/**
 * El refinamiento para todo string de entrada que llegue a la base. Se aplica después de los
 * checks anteriores del schema, también de `trim()`: lo que se valida es lo que llegaría a Postgres.
 */
export const withoutControlChars = (schema: z.ZodString, field: string): z.ZodString =>
  schema.regex(WITHOUT_CONTROL_CHARS, controlCharsMessage(field));
