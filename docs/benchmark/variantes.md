# Las tres variantes del benchmark: Z, A y C

> Parte del respaldo de [`docs/decision-snapshot.md`](../decision-snapshot.md). Qué es cada variante que se midió, qué SQL y qué código la implementan, y en qué difiere de las otras dos. Sirve también de base para exponer cada una con su propia API y comparar `GET /portfolio` entre versiones.

Las tres se midieron con la misma superficie HTTP (`GET /portfolio/:userid` y `POST /orders`, con el mismo JSON), el mismo dataset y los mismos scripts de k6. Lo que cambia es la base y quién calcula el balance.

## Dónde está cada una

| | Z: línea base | A: calcular al leer | C: snapshot + delta |
|---|---|---|---|
| Base | `base.dump`: esquema de `database.sql` sin migrar + dataset ([`bench/gen/load-z.sh`](../../bench/gen/load-z.sh)) | `bench.dump`: migrado + dataset ([`bench/gen/load.sh`](../../bench/gen/load.sh)) | `bench.dump` + las tablas y funciones de C, que [`bench/reset.sh`](../../bench/reset.sh) instala con `WITH_C=1` |
| SQL | ninguno | [`10_migrate.sql`](../../bench/sql/10_migrate.sql), [`20_schema_roles.sql`](../../bench/sql/20_schema_roles.sql), [`21_functions.sql`](../../bench/sql/21_functions.sql) | lo de A + [`30_c_tables.sql`](../../bench/sql/30_c_tables.sql) y [`31_c_functions.sql`](../../bench/sql/31_c_functions.sql) |
| API | [`bench/app/src/naive/app.ts`](../../bench/app/src/naive/app.ts) (`APP_MODE=naive`), rol `postgres` | [`bench/app/src/app.ts`](../../bench/app/src/app.ts) y `routes/` (`APP_MODE=a`), rol `api` | la misma que A: C reemplaza las funciones con la misma firma |
| `bench/run.sh` | `VARIANT=Z` | `VARIANT=A` | `VARIANT=C-frio` o `VARIANT=C-caliente` |

`bench/app` es la API que se midió, copiada del repositorio del benchmark en el commit `10d8bf4` ("Fases 12-13"), no la de `src/` de este repo. [`bench/app/src/server.ts`](../../bench/app/src/server.ts) elige la variante con `APP_MODE`. El compose del benchmark la arma desde ahí ([`bench/docker/Dockerfile.app`](../../bench/docker/Dockerfile.app)).

La A que entrega este repo (`db/migrations/` y `db/functions/`) desciende de la A medida: los mismos tres índices parciales ([`003_orders_ledger.sql`](../../db/migrations/003_orders_ledger.sql)), el mismo protocolo de escritura con lock e idempotencia y el mismo fold, que acá se llama `app.c_state` ([`020_balance.sql`](../../db/functions/020_balance.sql)). Después del benchmark cambió en lo que registran [`docs/decisiones.md`](../decisiones.md) y el [CHANGELOG](../../CHANGELOG.md): por ejemplo, los tiempos de escritura ([D-20](../decisiones.md#d-20)) y la regla para cubrir un corto heredado (comprar sobre `qty < 0` no suma costo a las acciones que cierran el corto). Ninguno de esos cambios toca el dataset del benchmark: el generador nunca produce cortos (el único es el del usuario 1, que viene de `database.sql`).

## Z: línea base

Es el esquema del enunciado tal cual y la implementación directa, "como lo haría alguien resolviendo rápido". No es correcta: es la vara.

- **Esquema.** `users`, `instruments`, `orders` y `marketdata` en `public`, con solo claves primarias y foráneas ([`000_seed.sql`](../../db/migrations/000_seed.sql) es ese `database.sql`). Postgres no crea índices para las claves foráneas: no hay ningún índice sobre `orders.userid` ni sobre `marketdata.instrumentid`. El cash va en el formato original: `CASH_IN`/`CASH_OUT` con `price = 1` y `size` en pesos enteros (`load-z.sh` convierte los centavos del generador). No hay `balance_seq`.
- **Lectura.** `GET /portfolio` hace una consulta para el usuario, una `SUM` sobre sus órdenes para el cash (neto y reservado), un `GROUP BY instrumentid` con `JOIN instruments` para las posiciones y, por cada posición, la última cotización (`ORDER BY date DESC LIMIT 1`). Sin índices, cada consulta sobre `orders` recorre las 22 millones de filas.
- **Escritura.** `POST /orders` lee el disponible sin lock, decide en la aplicación e inserta. No hay idempotencia (la `Idempotency-Key` se ignora) ni lock: dos órdenes simultáneas pueden gastar el mismo saldo. Las LIMIT quedan `NEW`.
- **Dinero.** `Number` (float); el costo promedio es Σ compras / Σ acciones compradas, sin descontar las ventas.

## A: calcular al leer

El balance se recalcula desde `orders` en cada lectura y en cada autorización. Es lo que entrega este repo ([D-16](../decisiones.md#d-16)).

**Esquema** ([`10_migrate.sql`](../../bench/sql/10_migrate.sql), [`20_schema_roles.sql`](../../bench/sql/20_schema_roles.sql)):

- Todo en el esquema `app`, del rol `app_owner`. El rol `api` solo tiene `SELECT` y `EXECUTE` sobre las funciones de escritura: no puede escribir ninguna tabla.
- Cash en centavos (`price = 0.01`, `size` = centavos) y `balance_seq`: el orden de ejecución por usuario, `1, 2, 3…` sin huecos, solo en las `FILLED`. La migración lo completa sobre la historia existente.
- `CHECK`s sobre `side`, `type`, `status`, la forma de una orden de cash y `(status = 'FILLED') = (balance_seq IS NOT NULL)`; `marketdata` única por `(instrumentid, date)`; tablas `idempotency_keys` y `settings`.
- Trigger `orders_guard`: prohíbe `DELETE`, una orden solo pasa de `NEW` a `FILLED` o `CANCELLED` sin cambiar otro campo, y una `FILLED` lleva `balance_seq = max + 1` del usuario.

**Índices** (los tres parciales, el corazón de la diferencia con Z):

| Índice | Definición | Lo usa |
|---|---|---|
| `orders_filled_by_user` | `(userid, balance_seq) INCLUDE (instrumentid, side, size, price) WHERE status = 'FILLED'` | el fold y el cash de la autorización |
| `orders_new_by_user` | `(userid) INCLUDE (instrumentid, side, size, price) WHERE status = 'NEW'` | las reservas |
| `orders_balance_seq` | `UNIQUE (userid, balance_seq) WHERE balance_seq IS NOT NULL` | el último `balance_seq` del usuario |

**Lectura** ([`21_functions.sql`](../../bench/sql/21_functions.sql)): `app.read_portfolio(userid)` llama a `app.fold_user`, un bucle PL/pgSQL que recorre las `FILLED` de compra y venta del usuario en orden `(instrumentid, balance_seq)` y lleva cantidad y costo promedio por instrumento, en enteros (centavos y micro-pesos). Suma el cash de todas las `FILLED`, agrega las reservas de las `NEW` y busca la última cotización válida de cada posición. Sin lock: la función es `STABLE` y lee una sola foto MVCC. El costo crece con la cantidad de órdenes ejecutadas del usuario.

**Escritura**: `app.place_order` es la única vía:

1. `deploy_barrier`: lock compartido de despliegue.
2. Valida los argumentos, antes de tomar el lock.
3. `pg_advisory_xact_lock(hashtext('user-balance'), userid)`: un escritor por usuario a la vez.
4. Reclama la clave de idempotencia (`INSERT … ON CONFLICT DO NOTHING`). Si ya existía con el mismo request, devuelve la respuesta guardada.
5. Precio (`valid_close`) y cantidad (por `size` o por `amount`).
6. Autoriza con tres subconsultas, cada una con el `status` exacto de su índice parcial: cash y posición sobre las `FILLED`, reservas sobre las `NEW`, `max(balance_seq)`. Es un agregado SQL, también O(historia), pero un index-only scan es mucho más barato que el bucle de la lectura. Un filtro `status IN ('FILLED','NEW')` no usaría ningún índice parcial y recorrería toda la tabla: es el error que apareció en la primera corrida ([§8](../decision-snapshot.md#8-qué-no-se-midió-y-por-qué-no-cambia-la-lectura)).
7. Inserta la orden, con `balance_seq = último + 1` si queda `FILLED`, y guarda la respuesta junto a la clave.

`execute_limit` y `cancel_order` toman el mismo lock. La API abre una transacción por orden con `lock_timeout` de 2 s, `statement_timeout` de 5 s y un deadline de 4 s (`REQUEST_DEADLINE_MS`), que cancela la sentencia en curso y responde `503` ([`bench/app/src/db/pool.ts`](../../bench/app/src/db/pool.ts)).

## C: snapshot + delta

A más una caché regenerable del balance. Se puede tirar en cualquier momento: la próxima lectura vuelve a la historia completa.

**Tablas** ([`30_c_tables.sql`](../../bench/sql/30_c_tables.sql)):

- `app.balance_snapshots`: por usuario, `last_seq` (la frontera), `cash`, `algo_version`, `has_inconsistent` y `updated_at`.
- `app.snapshot_positions`: por usuario e instrumento, `qty` (distinta de 0, puede ser negativa con `inconsistent`) y `cost_total`.
- `settings.snapshot_k`: `K`, cada cuántos movimientos fuera del snapshot se republica. En el benchmark, `K = 500` (`SNAPSHOT_K`).

**Estado** ([`31_c_functions.sql`](../../bench/sql/31_c_functions.sql)): `app.c_state(userid)` parte del snapshot si su `algo_version` es la activa, y aplica con la misma regla que A el delta: las `FILLED` con `balance_seq > last_seq`. Sin snapshot válido, el delta es la historia entera: cuesta lo mismo que A.

**Lectura**: `app.read_portfolio` tiene la misma firma y las mismas columnas que en A, sobre `c_state`. Leer nunca publica.

**Escritura**: `place_order`, `execute_limit` y `cancel_order` tienen la misma firma que en A. Autorizan con `c_state` más las reservas y, después del `INSERT` y bajo el mismo lock, llaman a `app.c_publish`. Publica si el delta llegó a `K` (compactación) o si no había snapshot válido y hay historia (reconstrucción). El replay de una clave de idempotencia nunca publica. Publicar es un upsert de la cabecera y un `DELETE` + `INSERT` de las posiciones.

**Operación**:

- `app.warm_snapshot(userid)` publica el snapshot de un usuario, si consigue el lock sin esperar. [`bench/warm.sh`](../../bench/warm.sh) lo llama para todos los usuarios con historia, de la historia más larga a la más corta, en una transacción por usuario.
- `app.reconcile(userid)` compara `c_state` con el fold completo de A y, si difieren, borra el snapshot (el próximo escritor lo regenera).
- `app.set_algo_version` cambia la versión del cálculo con el lock exclusivo de despliegue: los snapshots de la versión anterior dejan de valer.
- **Fría** = sin snapshots al empezar (las tablas recién creadas). **Caliente** = `bench/warm.sh` antes de medir (`bench/run.sh` lo corre con `VARIANT=C-caliente`).
- Volver de C a A es correr `21_functions.sql` otra vez.

## En qué difieren

| | Z | A | C |
|---|---|---|---|
| Índice por usuario sobre `orders` | ninguno | tres parciales (`FILLED`, `NEW`, `balance_seq`) | los de A |
| Dinero | `Number` (float) | enteros: centavos y micro-pesos | como A |
| Orden de ejecución | no existe | `balance_seq` | como A, y es la frontera del snapshot |
| Lock de escritura | no | advisory lock por usuario | como A |
| Idempotencia | no | `idempotency_keys` | como A |
| Costo de una lectura | toda la tabla | O(órdenes ejecutadas del usuario), bucle PL/pgSQL | O(snapshot + delta ≤ K) caliente; como A sin snapshot |
| Costo de una autorización | toda la tabla | O(historia), agregado sobre índices | O(snapshot + delta) |
| Estado extra | no | no | dos tablas, `K`, versión del cálculo |
| Qué hay que operar | nada | nada | calentar antes de aceptar tráfico, reconciliar, barrera de versión |

## Para exponer cada variante con su propia API

Lo que necesita cada una para levantarse por separado y responder el mismo `GET /portfolio/:userid`:

- **Una base por variante.** A y C instalan funciones con la misma firma en el mismo esquema `app`: en una misma base, la última que se instala gana. Z necesita el esquema sin migrar en `public`. Tres contenedores de Postgres (o tres bases), cada uno desde su dump.
- **Z**: `base.dump` y `bench/app` con `APP_MODE=naive`. Se conecta como `postgres`, porque el esquema sin migrar no tiene roles propios.
- **A**: `bench.dump` (o `bench.dump` + `21_functions.sql`, que `reset.sh` reaplica siempre) y `bench/app` con `APP_MODE=a` y el rol `api`.
- **C**: lo de A + `30_c_tables.sql` y `31_c_functions.sql`, con `snapshot_k` fijado, y `bench/warm.sh` antes de aceptar tráfico: sin calentar, C es peor que A (ver [resultados](resultados.md#c-fría-no-se-calienta-sola)).
- **El mismo JSON, no la misma semántica.** Z imita la forma de la respuesta de A para que k6 sea el mismo, pero sus montos salen de floats y su costo promedio no descuenta las ventas: comparar respuestas de Z con las de A o C muestra diferencias de valor, no solo de latencia. A y C sí tienen que coincidir siempre; `reconcile` es esa comparación hecha en la base.
- **Los ids del dataset.** Usuarios desde el 1000 (las ballenas son del 1000 al 1009) e instrumentos del 1000 al 1999; los cuatro usuarios del challenge siguen con sus ids. La lista de cada cohorte está en `bench/gen/out/cohorts.json` ([datos](datos.md)).
