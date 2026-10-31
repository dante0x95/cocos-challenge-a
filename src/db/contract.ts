// Contrato de esta versión con la base (D-24, issue #39): las funciones de app.* que la API invoca,
// con los tipos con los que las llama. Viaja en la imagen (dist/db/contract.js) y el bootstrap lo
// registra en public.api_contract. El bootstrap de la versión siguiente lo verifica antes del
// COMMIT: si una de estas llamadas deja de resolver, o api deja de poder ejecutarla, aborta sin
// aplicar nada y esta versión sigue escribiendo (durante el deploy y después de una vuelta atrás).
//
// test/unit/contract.test.ts falla si src/ llama a una función app.* que no está acá (o con otra
// cantidad de argumentos), o si acá hay una que src/ ya no llama. Los tipos los verifica el propio
// bootstrap, que también comprueba el contrato de la versión que despliega.
//
// Las firmas van en la forma canónica de regprocedure (`integer`, no `int`), sin espacios.
export const API_CONTRACT: readonly string[] = [
  'app.cancel_order_outcome(integer,bigint)',
  'app.cleanup_candidates()',
  'app.cleanup_idempotency(integer)',
  'app.execute_limit_outcome(bigint)',
  'app.health()',
  'app.limit_candidates(integer,bigint,integer)',
  'app.place_order(integer,text,text,text,text,integer,integer,numeric,numeric,text)',
  'app.read_portfolio(integer)',
  'app.unaccent_immutable(text)',
];

export interface ContractCall { name: string; args: string[] }

/** `app.f(t1,t2)` → { name: 'f', args: ['t1', 't2'] }. Una firma con otra forma es un error del contrato. */
export function parseSignature(signature: string): ContractCall {
  const m = /^app\.([a-z_][a-z0-9_]*)\(([^()]*)\)$/.exec(signature);
  if (!m) throw new Error(`firma inválida en el contrato de la API: ${signature}`);
  return { name: m[1], args: m[2] === '' ? [] : m[2].split(',') };
}
