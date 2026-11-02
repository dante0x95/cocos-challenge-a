# Comparación de las variantes Z, A y C

> Resumen para presentar el benchmark que respalda [`decision-snapshot.md`](decision-snapshot.md). Los datos, el harness y las salidas crudas de k6 de cada corrida están en el [PR #75](https://github.com/dante0x95/cocos-challenge-a/pull/75); este documento no agrega mediciones, solo las ordena.

## Las tres variantes

Las tres responden la misma API HTTP (`GET /portfolio/:userid` y `POST /orders`, con el mismo JSON) sobre el mismo dataset y con los mismos scripts de k6. Cambian la base y quién calcula el balance.

| Variante | Qué es |
|---|---|
| **Z: línea base** | El esquema de `database.sql` tal cual, sin índices por usuario, y una implementación directa: sin lock, sin idempotencia, dinero en float. No es correcta: es la vara. |
| **A: calcular al leer** | Lo que entrega este repo ([D-16](decisiones.md#d-16)): esquema migrado con tres índices parciales por usuario, `balance_seq`, cash en centavos, lock por usuario e idempotencia. El balance se recalcula desde `orders` en cada lectura y cada autorización. |
| **C: snapshot + delta** | A más una caché regenerable: un snapshot del balance por usuario, que se republica dentro de la transacción de la orden cada `K = 500` movimientos. Lectura y autorización parten del snapshot y aplican el delta. Se midió **fría** (sin snapshots al empezar) y **caliente** (todos publicados antes de medir). |

## El dataset

Generado de forma determinista (seed 42), con cada historia simulada contra el oráculo de los tests antes de escribirse: ninguna viola las reglas de saldo ni de tenencia.

| | |
|---|---|
| Usuarios | 70.000 |
| Instrumentos | 1.000, con 5 años de cotizaciones diarias (1.305 días hábiles) |
| Órdenes | 22.208.286: 20.234.866 `FILLED`, 1.022.123 `REJECTED`, 590.395 `CANCELLED`, 360.891 `NEW` y las 11 del challenge |
| Orden de ejecución ≠ orden de creación | 12,1 % de las ejecutadas son LIMIT ejecutadas días después de crearse |
| Pendientes | 13.877 usuarios con LIMIT `NEW` (entre 1 y 50); las 5 primeras ballenas, 2.000 cada una |

Cohortes, por cantidad de órdenes ejecutadas:

| Cohorte | Proporción | Órdenes ejecutadas | Usuarios |
|---|---|---|---|
| `median` | 80 % | alrededor de 50 | 55.944 |
| `p90` | 15 % | alrededor de 500 | 10.544 |
| `p99` | 4 % | alrededor de 2.000 | 2.795 |
| `p999` | 1 % | alrededor de 5.000 | 707 |
| **ballenas** | 10 (ids 1000–1009) | entre 106.177 y 239.945 | 10 |

## La infraestructura

Todo en Docker, en una sola máquina:

| Contenedor | Recursos |
|---|---|
| Postgres 18 | 2 CPU, 2 GB; `shared_buffers` 512 MB, `work_mem` 8 MB |
| API (la misma para las tres variantes) | 2 CPU, 1 GB; pool de 20 conexiones, deadline de escritura de 4 s (el de entonces; hoy rige [D-20](decisiones.md#d-20)) |
| k6 0.54.0 | sin límite |

Cada corrida restaura la base desde el mismo dump y le hace `VACUUM ANALYZE`, precalienta 2 minutos sin medir y mide 5 minutos. Una repetición por corrida, en una máquina que no estaba aislada y cuyo hardware no quedó registrado: los números absolutos tienen ese margen; las relaciones entre variantes (40×, de 2 a 100 RPS) son demasiado grandes para que cambie el resultado.

## Escenarios y criterio de éxito

k6 con tasa de llegada constante: se ofrece una cantidad fija de requests por segundo, haya o no respuesta. Cada `POST` lleva una `Idempotency-Key` única.

| Escenario | Mezcla | RPS medidos |
|---|---|---|
| `read-heavy` | 90 % `GET /portfolio`, 8 % compras o retiros, 2 % depósitos; usuarios según el peso de cada cohorte | Z: 1, 2, 5 · A y C: 100, 200, 400 |
| `whale` | 90 % `GET /portfolio`, 10 % compras o retiros, todo sobre las 10 ballenas | Z: 1 · A: 2, 5, 20 · C: 2, 5, 20, 100 |

**Criterio de éxito**, fijado antes de medir: p99 menor a 500 ms en `GET` y en `POST`, menos de 0,1 % de fallos y ninguna request descartada por el generador.

**Regla de decisión**, fijada también antes:

1. Si A cumple en los dos escenarios hasta 400 RPS → A.
2. Si A falla por el tamaño de la historia y C caliente cumple → C.
3. Si caen todos los escenarios juntos → falta capacidad, no es un problema de A ni de C.
4. Si C caliente no mejora `whale` al menos 2× sobre A → C no se justifica.

## Resultados

p99 en milisegundos, `GET` / `POST`. "Colapso" = más del 95 % de las requests vencieron a los 60 s.

| Escenario / RPS | Z | A | C fría | C caliente |
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

Las celdas sin marca tuvieron menos de 0,01 % de fallos y ninguna request descartada. "—" = no se corrió, porque no aportaba: Z ya colapsaba a 1–5 RPS y A en `whale` a 5.

Una sola request, sin carga:

| `GET /portfolio` | Z | A | C caliente |
|---|---|---|---|
| Usuario típico | 3–4 s | 3 ms | 2 ms |
| Ballena | 10 s | 560 ms | 12 ms |

Estas lecturas sueltas se tomaron a mano y su salida no se guardó. Lo más cercano versionado: la media de `read_portfolio` en A durante `whale 2` fue de 544 ms.

**Por qué A colapsa en `whale`.** La lectura de A recorre todas las órdenes ejecutadas del usuario. El mismo plan, con la base caliente, tarda 9,8 ms para un usuario mediano y 821,6 ms para una ballena, cuyas órdenes no entran en `work_mem` y se ordenan en disco. Con ~0,54 s de base por lectura y 2 CPU, la capacidad es de unas 3,7 lecturas de ballena por segundo: `whale 2` pide 1,8 y cumple; `whale 5` pide 4,5 y la cola crece sin límite. **Colapsa, no se degrada.**

## Tamaños y calentamiento de C

| | |
|---|---|
| Base A/C restaurada | 4,35 GB (el índice parcial de órdenes ejecutadas, 1,14 GB) |
| Base Z | 2,39 GB |
| Snapshots de C | 70.001 (los 70.000 usuarios y el usuario 1 del challenge), 81 MB |
| Calentar todos los snapshots | 281–303 s |

**C fría no se calienta sola.** El snapshot de un usuario se publica cuando escribe, no cuando lee. En `read-heavy` los escritores van publicando (14.823 snapshots al terminar `read-heavy 400`), pero mientras tanto las lecturas cuestan como en A y las reconstrucciones pesan: 148 iteraciones descartadas. En `whale 2`, la primera escritura de cada ballena publicó su snapshot y desde ahí fue como C caliente. En `whale 5` no se publicó ninguno en 5 minutos: las lecturas frías ocupan la CPU y ninguna escritura termina antes de su deadline de 4 s.

## Conclusión

- **De Z a A**, casi todo lo explica el índice parcial por usuario: sin él, cada request recorre los 22 millones de filas. Lo demás de A (lock, idempotencia, `balance_seq`) no se nota en latencia: se justifica por corrección.
- **Se entrega A.** Cumple el criterio con margen en `read-heavy` hasta 400 RPS (p99 ≤ 26 ms), es exactamente lo que pide el enunciado (calcular desde `orders`) y no tiene nada que calentar ni reconciliar. El perfil que la hace caer no está en el dataset del challenge.
- **Su límite es estructural**: con historias de más de 100.000 órdenes ejecutadas consultadas a más de 2 requests por segundo, colapsa, y más hardware no lo arregla.
- **C es la respuesta para ese perfil**, y está medida: mejora `whale` 40× a 2 RPS (795 → 20 ms) y pasa de 2 RPS sostenibles a 100 (p99 11 / 7 ms). A cambio, hay que operarla: dos tablas más, una versión del cálculo con barrera de despliegue, reconciliación y un calentamiento obligatorio antes de aceptar tráfico, porque fría es peor que A.

El detalle de la decisión, lo que no se midió y qué cambiaría al pasar a C: [`decision-snapshot.md`](decision-snapshot.md).
