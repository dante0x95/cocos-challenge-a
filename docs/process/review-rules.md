# Reglas de revisión

Lo que el revisor (Codex) verifica en cada PR, además de que el PR resuelva su issue. Cada regla cita su fuente; ante una contradicción entre un PR y estas fuentes, el PR está mal o tiene que actualizar la fuente en el mismo PR.

## R-1 · Dinero y números (D-05, D-09, D-13, D-14)
- Dinero, cantidades e ids grandes nunca pasan por `Number`: `BigInt` en la API, `numeric`/`bigint` en SQL. No se registra ningún parser de `pg` que devuelva `Number` para `int8` (OID 20) ni `numeric` (OID 1700).
- La entrada con más decimales de los permitidos **se rechaza**, no se redondea. La salida JSON lleva importes, precios, cantidades e ids como string con escala fija.
- Redondeo: half-even sobre la fracción exacta, donde lo dice D-09. Ningún float en un cálculo de dinero.
- Ningún movimiento se confirma si deja el cash o una posición fuera de los límites de D-14.

## R-2 · Protocolo de escritura (D-17, D-18, D-22)
- Toda escritura de órdenes pasa por una función de la base que hace, en este orden y en una transacción: barrera de despliegue → lock del usuario → lectura → decisión → escritura.
- Ninguna lectura que participe en una decisión ocurre antes del lock. Ninguna función acepta un saldo, una decisión o una secuencia calculados afuera.
- El rol `api` no gana `INSERT`/`UPDATE`/`DELETE` sobre ninguna tabla.
- `balance_seq` se asigna solo al pasar a `FILLED`, bajo el lock.

## R-3 · Idempotencia y tiempos (D-19, D-20)
- El replay devuelve exactamente la respuesta original y no lee estado, no decide ni publica.
- Dos requests equivalentes dan el mismo hash.
- Un error de timeout o de lock termina en `503` sin orden ni clave reclamada.

## R-4 · Pruebas (docs/testing.md)
- Lo que toca Postgres se prueba contra Postgres real; nunca se mockea la base.
- Concurrencia con conexiones reales y barreras con locks, nunca con `setTimeout`.
- Cada prueba fija un comportamiento verificable o una propiedad que un error real rompería. Una prueba que seguiría pasando con el defecto que dice cubrir es un hallazgo.
- Un PR que arregla un defecto incluye un test que falla sin el arreglo.
- No se debilita, saltea ni borra un test para que el CI pase.

## R-5 · API (D-13, D-26, D-27)
- Un recurso de otro usuario responde igual que uno inexistente (mismo status y mismo cuerpo).
- Los errores tienen código estable (`docs/api/*.md`); un `500` por un caso de negocio previsible es un hallazgo.

## R-6 · Calidad
- Cambio mínimo para el issue: nada fuera de alcance, ni código especulativo.
- Nombres claros; sin duplicación de lógica de dominio entre la API y la base salvo el oráculo de `test/oracle`.
- Los docs (`docs/decisiones.md`, `docs/api/*.md`, `docs/testing.md`) se actualizan en el mismo PR cuando el comportamiento cambia.

## R-7 · Idioma (CONTRIBUTING.md)
- Código e identificadores en inglés.
- Comentarios, nombres de tests, mensajes de error de la API, docs, commits y PRs en español.
