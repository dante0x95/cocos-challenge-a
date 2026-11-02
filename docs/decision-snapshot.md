# Cómo se calcula el balance: lo que se midió

> Resumen. Calcular el balance recorriendo todas las órdenes del usuario en cada request es simple y correcto, y con un índice parcial por usuario alcanza con margen para el perfil de usuarios del challenge: 3 ms por lectura, p99 ≤ 26 ms a 400 requests por segundo. Tiene un límite estructural: con usuarios de historia larga (más de 100.000 órdenes ejecutadas) colapsa desde 5 requests por segundo, y no se degrada de a poco. Se midió también una alternativa con una caché del balance regenerable (snapshot + delta) que resuelve ese caso en el mismo hardware: 100 requests por segundo sobre esos usuarios con p99 de 11 ms, a cambio de operar una caché que siempre hay que tener caliente. Este entregable implementa la variante simple (A); la caché queda medida para cuando ese perfil de usuario exista. Este documento explica cómo se midió y qué salió.

**El respaldo, en este repo.** El harness del benchmark está en [`bench/`](../bench), con las salidas crudas de cada corrida en [`bench/results`](../bench/results), y cada parte tiene su documento:

- [Variantes](benchmark/variantes.md): qué es Z, A y C, qué SQL y qué código implementa cada una y en qué difieren.
- [Datos](benchmark/datos.md): el generador, sus parámetros y la seed, las cohortes, la verificación contra el oráculo y cómo se regeneran los dumps.
- [Corridas](benchmark/corridas.md): k6, las escaleras de RPS, la infraestructura y cómo se corre una celda de punta a punta.
- [Resultados](benchmark/resultados.md): cada número con el archivo del que sale, los planes de ejecución, el calentamiento de C y lo que no tiene salida guardada.

## 1. La pregunta

El enunciado pide calcular tenencia y pesos disponibles "utilizando todos los movimientos pertinentes que hay en la tabla `orders`". Así, el costo de cada lectura y de cada autorización crece con la historia del usuario: es O(historia). La pregunta es a partir de qué historia eso deja de alcanzar, y si una alternativa lo resuelve sin perder la propiedad de que `orders` es la única fuente de verdad.

## 2. Qué se comparó

| Variante | Qué es |
|---|---|
| **Z: línea base** | El esquema de `database.sql` tal cual (solo claves primarias y foráneas) y la implementación directa: `SUM … GROUP BY` sobre las órdenes del usuario en cada request, sin lock y con el dinero en `number`. Sirve para saber de dónde se parte. |
| **A: calcular al leer** | El esquema migrado de este repo (índices parciales, `balance_seq`, cash en centavos, CHECKs, trigger) y el protocolo de escritura con lock e idempotencia. El balance se recalcula desde `orders` en cada lectura y cada autorización. |
| **C: snapshot + delta** | A más dos tablas de snapshot. Lectura y autorización parten del snapshot y aplican el delta. El snapshot se republica dentro de la transacción de la orden cada `K = 500` movimientos, o cuando falta. Se midió de dos formas: **fría** (sin snapshots al empezar) y **caliente** (todos los snapshots publicados antes de medir). |

Esquema, índices, protocolo de escritura y código de cada una: [variantes](benchmark/variantes.md).

Se descartó sin medir una tabla de balances actualizada en cada orden: obliga a mantener dos verdades sincronizadas en cada escritura, y un error queda grabado para siempre. C es la misma idea con dos diferencias: la frontera y la frecuencia son controladas, y el snapshot se recalcula con la misma función que la lectura completa, así que se puede tirar y regenerar.

## 3. Cómo se midió

**Datos.** Un generador determinista (seed fija, mismo resultado en cada corrida) produjo:

| | |
|---|---|
| Usuarios | 70.000 |
| Órdenes | 22,2 millones |
| Instrumentos | 1.000, con 5 años de cotizaciones diarias (días hábiles) |
| Cohortes por cantidad de órdenes ejecutadas | 80 % alrededor de 50 · 15 % alrededor de 500 · 4 % alrededor de 2.000 · 1 % alrededor de 5.000 · **10 "ballenas" con entre 100.000 y 250.000** |
| Órdenes pendientes | 20 % de los usuarios con entre 1 y 50 LIMIT `NEW`; 5 ballenas con 2.000 cada una |
| Orden de ejecución ≠ orden de creación | ~12 % de las ejecutadas son LIMIT ejecutadas días después de crearse |
| Validez | Cada historia se simuló contra el oráculo de los tests antes de escribirse: ninguna viola las reglas de saldo ni de tenencia |

Se usaron 70.000 usuarios y no 10.000 para llegar a ~20 millones de órdenes conservando la forma de las cohortes. Con 10.000 usuarios, una de las dos metas había que resignarla. Cómo se genera, se carga y se verifica: [datos](benchmark/datos.md).

**Infraestructura.** Todo en Docker, en una sola máquina:

| Contenedor | Recursos |
|---|---|
| Postgres 18 | 2 CPU, 2 GB de RAM, `shared_buffers` 512 MB, `work_mem` 8 MB |
| API (la misma API HTTP para las tres variantes) | 2 CPU, 1 GB, pool de 20 conexiones, deadline de escritura de 4 s (el de entonces; hoy los tiempos son los de [D-20](decisiones.md#d-20)) |
| k6 (generador de carga) | aparte |

Antes de cada corrida, la base se restauraba desde el mismo dump y se le hacía `VACUUM ANALYZE`: todas las corridas parten del mismo estado. Los pasos de cada corrida y cómo repetir una: [corridas](benchmark/corridas.md).

**Carga.** k6 con tasa de llegada constante (`constant-arrival-rate`): se ofrece una cantidad fija de requests por segundo, haya o no respuesta. Cada request lleva una `Idempotency-Key` única.

| Escenario | Mezcla |
|---|---|
| `read-heavy` | 90 % `GET /portfolio`, 8 % compras, 2 % depósitos; usuarios elegidos según el peso de cada cohorte |
| `whale` | Todo el tráfico sobre las 10 ballenas: aísla el efecto del tamaño de la historia |

**Criterio de éxito.** p99 menor a 500 ms, menos de 0,1 % de fallos y ninguna request descartada por el generador. Se fijó antes de medir, igual que la regla de decisión:

1. Si A cumple en los dos escenarios hasta 400 RPS → A.
2. Si A falla por el tamaño de la historia (`whale` cae antes que `read-heavy` y el plan de ejecución muestra tiempo proporcional a las filas) y C caliente cumple → C.
3. Si caen todos los escenarios juntos → es falta de capacidad, no un problema de A ni de C.
4. Si C caliente no mejora `whale` al menos 2× sobre A → C no se justifica.

## 4. Resultados

p99 en milisegundos, GET / POST. "Colapso" = más del 95 % de las requests vencieron a los 60 s.

| Escenario / RPS | Z | A | C frío | C caliente |
|---|---|---|---|---|
| read-heavy 1–5 | colapso | — | — | — |
| read-heavy 100 | — | 19 / 11 | 17 / 45 | **5 / 11** |
| read-heavy 200 | — | 17 / 10 | 25 / 66 | **8 / 17** |
| read-heavy 400 | — | 23 / 26 | 87 / 149 (148 descartadas) | **3 / 7** |
| whale 1 | colapso | — | — | — |
| whale 2 | — | 795 / 91 | 62 / 30 | **20 / 15** |
| whale 5 | — | colapso (97 %) | colapso (99,8 %) | **22 / 17** |
| whale 20 | — | colapso | colapso | **14 / 10** |
| whale 100 | — | — | colapso | **11 / 7** |

Las corridas sin marca tuvieron menos de 0,01 % de fallos y ninguna request descartada. Las celdas "—" no se corrieron: no aportaban (Z ya colapsaba a 1–5 RPS; A ya colapsaba en `whale` a 5). Cada celda sale del JSON de k6 de su corrida ([resultados](benchmark/resultados.md#cada-corrida)), y `bench/check-results.ts` comprueba esta tabla contra esos archivos.

Una sola request, sin carga:

| | Z | A | C caliente |
|---|---|---|---|
| `GET /portfolio` de un usuario típico | 3–4 s | 3 ms | 2 ms |
| `GET /portfolio` de una ballena | 10 s | 560 ms | 12 ms |

Estas lecturas sueltas se midieron a mano y su salida no se guardó; tampoco la de los tamaños de los índices y de la base de Z. Lo versionado más cercano a cada uno: [números sin salida cruda](benchmark/resultados.md#números-sin-salida-cruda).

Tamaños: base A/C 4,35 GB (el índice parcial de órdenes ejecutadas ocupa 1,14 GB); snapshots de los 70.000 usuarios, 81 MB; calentar a los 70.000 tardó 281–303 s.

## 5. Lectura de los números

- **De Z a A**, casi todo lo explica un índice parcial por usuario sobre las órdenes ejecutadas: sin él, cada request recorre los 22 millones de filas. Lo demás de A (lock, idempotencia, `balance_seq`, CHECKs) no se nota en latencia. Se justifica por corrección, y eso lo prueban los tests, no k6.
- **A** cumple holgadamente en `read-heavy` hasta 400 RPS (p99 ≤ 26 ms), pero cae en `whale` a 5 RPS. El plan de ejecución de una ballena muestra el recorrido de 100.000–250.000 filas: ~0,6 s de CPU por lectura. Con 2 CPU, eso da unas 3 lecturas por segundo de capacidad. Pasado ese punto la cola crece sin límite: **colapsa, no se degrada** ([los planes y `pg_stat_statements`](benchmark/resultados.md#por-qué-a-colapsa-en-whale)).
- **C caliente** cumple en todo lo medido, incluido `whale` a 100 RPS con p99 de 11 / 7 ms. Mejora `whale` 40× a 2 RPS (795 → 20 ms) y pasa de 2 RPS sostenibles a 100.
- **C fría es peor que A.** En `whale`, las lecturas frías saturan la CPU; el escritor que publicaría el snapshot no llega a terminar antes de su deadline (4 s) y se cancela. En 5 minutos no se publicó ningún snapshot. **No se recupera sola** ([snapshots al terminar cada corrida](benchmark/resultados.md#c-fría-no-se-calienta-sola)).

Aplicando la regla fijada de antemano: (1) no se cumple; (2) sí se cumple; (3) no aplica, porque los escenarios no cayeron juntos; (4) se supera con margen. Es decir: **cuando haya usuarios con cientos de miles de órdenes consultados a más de 2 requests por segundo, C es la respuesta**, y está medida.

## 6. Por qué este entregable implementa A

- El enunciado pide calcular tenencia y pesos "utilizando todos los movimientos pertinentes que hay en la tabla `orders`". A es exactamente eso, con una sola fuente y nada que calentar ni reconciliar.
- El perfil que hace caer a A (más de 100.000 órdenes ejecutadas por usuario, consultadas a más de 2 requests por segundo) no está en el dataset del challenge ni se desprende del enunciado. Con el perfil medido en `read-heavy` (80 % de usuarios con ~50 órdenes, 1 % con ~5.000), A cumple el criterio de éxito hasta 400 RPS.
- C cuesta operar: dos tablas más, la publicación de la caché dentro de la transacción de cada orden, una versión del cálculo con barrera de despliegue, un calentamiento obligatorio antes de aceptar tráfico (281–303 s para 70.000 usuarios) y una reconciliación periódica. Cada una de esas piezas es superficie para errores que A no tiene.
- El límite de A es estructural (crece con la historia) y no se arregla con más hardware. Por eso se midió la salida antes de necesitarla: el día que aparezca ese perfil, la decisión ya está tomada con números y no bajo presión.

## 7. Qué cambiaría al pasar a C

Lo que A ya tiene y C reutiliza: el índice parcial, el protocolo de escritura con lock, `balance_seq` como orden de ejecución y una sola implementación del fold (`app.c_state`). C agrega una tabla de snapshot por usuario, la republicación cada `K` movimientos dentro de la transacción de la orden, el calentamiento en el bootstrap y la reconciliación. El fold no cambia: parte del snapshot en vez de cero.

## 8. Qué no se midió (y por qué no cambia la lectura)

- Un solo perfil de recursos (2 CPU / 2 GB) y una repetición por corrida, en una máquina que no estaba aislada (en el mismo Docker corría otro Postgres) y cuyo hardware no quedó registrado. Los números absolutos tienen ese margen; las relaciones entre variantes (40×, 2 → 100 RPS) son demasiado grandes para que cambie el resultado.
- No se corrieron un escenario de escritura intensiva, un escenario de contención sobre un mismo usuario, ni un barrido de `K`. `K = 500` quedó fijo.
- Las escaleras de RPS se ajustaron después de la primera corrida: `whale` se midió en {2, 5, 20, 100} porque A ya colapsaba a 5.
- Durante la primera corrida apareció un error de implementación: la consulta de autorización filtraba `status IN ('FILLED','NEW')`, que no aprovecha índices parciales por `status`, y terminaba recorriendo toda la tabla. Se corrigió antes de medir (tres subconsultas, cada una con el `status` exacto de su índice). La regla quedó anotada en `db/migrations/003_orders_ledger.sql`.
