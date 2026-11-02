# Resultados del benchmark, trazables a sus salidas crudas

> Parte del respaldo de [`docs/decision-snapshot.md`](../decision-snapshot.md#4-resultados). Cada número de las tablas sale de un archivo de [`bench/results`](../../bench/results), y [`bench/check-results.ts`](../../bench/check-results.ts) lo comprueba: la tabla de §4 de `decision-snapshot.md` y las dos de este documento contra los JSON de k6 y los `-restore.txt`. Lo que no tiene salida versionada está declarado en [Números sin salida cruda](#números-sin-salida-cruda).

```bash
pnpm exec tsx bench/check-results.ts
```

## Cada corrida

Perfil `medium` (2 CPU, 2 GB), 5 minutos medidos después de 2 de precalentamiento. Latencias en ms, del resumen de k6 (`http_req_duration{op:get}` y `{op:post}`, sin el precalentamiento); fallos = `http_req_failed` en %; descartadas = `dropped_iterations`. La primera columna de enlaces es el JSON de donde sale la fila; los otros, la salida de k6, el `EXPLAIN` y `pg_stat_statements` de esa corrida ([qué es cada archivo](corridas.md#qué-hace-benchrunsh-en-cada-celda)).

| Escenario | RPS | Variante | GET p50 | GET p95 | GET p99 | POST p50 | POST p99 | Fallos % | Descartadas | Iteraciones | Salidas |
|---|---|---|---|---|---|---|---|---|---|---|---|
| read-heavy | 1 | Z | 60000 | 60001 | 60003 | 60001 | 60002 | 100,000 | 0 | 270 | [json](../../bench/results/medium-read-heavy-1-Z.json) · [k6](../../bench/results/medium-read-heavy-1-Z-k6.txt) · [pgss](../../bench/results/medium-read-heavy-1-Z-pgss.txt) |
| read-heavy | 2 | Z | 60000 | 60003 | 60004 | 60000 | 60017 | 100,000 | 21 | 520 | [json](../../bench/results/medium-read-heavy-2-Z.json) · [k6](../../bench/results/medium-read-heavy-2-Z-k6.txt) · [explain](../../bench/results/medium-read-heavy-2-Z-explain.txt) · [pgss](../../bench/results/medium-read-heavy-2-Z-pgss.txt) |
| read-heavy | 5 | Z | 60002 | 60005 | 60005 | 60002 | 60005 | 100,000 | 101 | 125 | [json](../../bench/results/medium-read-heavy-5-Z.json) |
| read-heavy | 50 | A | 3 | 11 | 23 | 5 | 42 | 0,033 | 0 | 3001 | [json](../../bench/results/medium-read-heavy-50-A.json) |
| read-heavy | 100 | A | 2 | 8 | 19 | 4 | 11 | 0,003 | 0 | 30001 | [json](../../bench/results/medium-read-heavy-100-A.json) · [k6](../../bench/results/medium-read-heavy-100-A-k6.txt) · [explain](../../bench/results/medium-read-heavy-100-A-explain.txt) · [pgss](../../bench/results/medium-read-heavy-100-A-pgss.txt) |
| read-heavy | 100 | C-frio | 2 | 7 | 17 | 5 | 45 | 0,010 | 0 | 30001 | [json](../../bench/results/medium-read-heavy-100-C-frio.json) · [k6](../../bench/results/medium-read-heavy-100-C-frio-k6.txt) · [explain](../../bench/results/medium-read-heavy-100-C-frio-explain.txt) · [pgss](../../bench/results/medium-read-heavy-100-C-frio-pgss.txt) |
| read-heavy | 100 | C-caliente | 2 | 4 | 5 | 5 | 11 | 0,007 | 0 | 30000 | [json](../../bench/results/medium-read-heavy-100-C-caliente.json) · [k6](../../bench/results/medium-read-heavy-100-C-caliente-k6.txt) · [explain](../../bench/results/medium-read-heavy-100-C-caliente-explain.txt) · [pgss](../../bench/results/medium-read-heavy-100-C-caliente-pgss.txt) |
| read-heavy | 200 | A | 2 | 7 | 17 | 3 | 10 | 0,010 | 0 | 60001 | [json](../../bench/results/medium-read-heavy-200-A.json) · [k6](../../bench/results/medium-read-heavy-200-A-k6.txt) · [explain](../../bench/results/medium-read-heavy-200-A-explain.txt) · [pgss](../../bench/results/medium-read-heavy-200-A-pgss.txt) |
| read-heavy | 200 | C-frio | 2 | 8 | 25 | 4 | 66 | 0,005 | 0 | 60001 | [json](../../bench/results/medium-read-heavy-200-C-frio.json) · [k6](../../bench/results/medium-read-heavy-200-C-frio-k6.txt) · [explain](../../bench/results/medium-read-heavy-200-C-frio-explain.txt) · [pgss](../../bench/results/medium-read-heavy-200-C-frio-pgss.txt) |
| read-heavy | 200 | C-caliente | 2 | 2 | 8 | 4 | 17 | 0,007 | 0 | 60000 | [json](../../bench/results/medium-read-heavy-200-C-caliente.json) · [k6](../../bench/results/medium-read-heavy-200-C-caliente-k6.txt) · [explain](../../bench/results/medium-read-heavy-200-C-caliente-explain.txt) · [pgss](../../bench/results/medium-read-heavy-200-C-caliente-pgss.txt) |
| read-heavy | 400 | A | 1 | 7 | 23 | 2 | 26 | 0,009 | 0 | 120001 | [json](../../bench/results/medium-read-heavy-400-A.json) · [k6](../../bench/results/medium-read-heavy-400-A-k6.txt) · [explain](../../bench/results/medium-read-heavy-400-A-explain.txt) · [pgss](../../bench/results/medium-read-heavy-400-A-pgss.txt) |
| read-heavy | 400 | C-frio | 1 | 8 | 87 | 4 | 149 | 0,007 | 148 | 119852 | [json](../../bench/results/medium-read-heavy-400-C-frio.json) · [k6](../../bench/results/medium-read-heavy-400-C-frio-k6.txt) · [explain](../../bench/results/medium-read-heavy-400-C-frio-explain.txt) · [pgss](../../bench/results/medium-read-heavy-400-C-frio-pgss.txt) |
| read-heavy | 400 | C-caliente | 1 | 2 | 3 | 2 | 7 | 0,005 | 0 | 120000 | [json](../../bench/results/medium-read-heavy-400-C-caliente.json) · [k6](../../bench/results/medium-read-heavy-400-C-caliente-k6.txt) · [explain](../../bench/results/medium-read-heavy-400-C-caliente-explain.txt) · [pgss](../../bench/results/medium-read-heavy-400-C-caliente-pgss.txt) |
| whale | 1 | Z | 60000 | 60003 | 60004 | 60000 | 60003 | 100,000 | 0 | 270 | [json](../../bench/results/medium-whale-1-Z.json) · [k6](../../bench/results/medium-whale-1-Z-k6.txt) · [explain](../../bench/results/medium-whale-1-Z-explain.txt) · [pgss](../../bench/results/medium-whale-1-Z-pgss.txt) |
| whale | 2 | A | 557 | 780 | 795 | 52 | 91 | 0,000 | 0 | 600 | [json](../../bench/results/medium-whale-2-A.json) · [k6](../../bench/results/medium-whale-2-A-k6.txt) · [explain](../../bench/results/medium-whale-2-A-explain.txt) · [pgss](../../bench/results/medium-whale-2-A-pgss.txt) |
| whale | 2 | C-frio | 12 | 20 | 62 | 11 | 30 | 0,000 | 0 | 600 | [json](../../bench/results/medium-whale-2-C-frio.json) · [k6](../../bench/results/medium-whale-2-C-frio-k6.txt) · [explain](../../bench/results/medium-whale-2-C-frio-explain.txt) · [pgss](../../bench/results/medium-whale-2-C-frio-pgss.txt) |
| whale | 2 | C-caliente | 13 | 17 | 20 | 10 | 15 | 0,000 | 0 | 601 | [json](../../bench/results/medium-whale-2-C-caliente.json) · [k6](../../bench/results/medium-whale-2-C-caliente-k6.txt) · [explain](../../bench/results/medium-whale-2-C-caliente-explain.txt) · [pgss](../../bench/results/medium-whale-2-C-caliente-pgss.txt) |
| whale | 5 | A | 60000 | 60000 | 60001 | 59999 | 60002 | 96,813 | 194 | 1161 | [json](../../bench/results/medium-whale-5-A.json) · [k6](../../bench/results/medium-whale-5-A-k6.txt) · [explain](../../bench/results/medium-whale-5-A-explain.txt) · [pgss](../../bench/results/medium-whale-5-A-pgss.txt) |
| whale | 5 | C-frio | 60000 | 60007 | 60007 | 59999 | 60007 | 99,828 | 195 | 1160 | [json](../../bench/results/medium-whale-5-C-frio.json) · [k6](../../bench/results/medium-whale-5-C-frio-k6.txt) · [explain](../../bench/results/medium-whale-5-C-frio-explain.txt) · [pgss](../../bench/results/medium-whale-5-C-frio-pgss.txt) |
| whale | 5 | C-caliente | 13 | 18 | 22 | 10 | 17 | 0,000 | 0 | 1501 | [json](../../bench/results/medium-whale-5-C-caliente.json) · [k6](../../bench/results/medium-whale-5-C-caliente-k6.txt) · [explain](../../bench/results/medium-whale-5-C-caliente-explain.txt) · [pgss](../../bench/results/medium-whale-5-C-caliente-pgss.txt) |
| whale | 20 | A | 60000 | 60003 | 60004 | 60000 | 60004 | 98,507 | 3467 | 2345 | [json](../../bench/results/medium-whale-20-A.json) · [k6](../../bench/results/medium-whale-20-A-k6.txt) · [explain](../../bench/results/medium-whale-20-A-explain.txt) · [pgss](../../bench/results/medium-whale-20-A-pgss.txt) |
| whale | 20 | C-frio | 60000 | 60003 | 60005 | 60000 | 60004 | 100,000 | 3501 | 2330 | [json](../../bench/results/medium-whale-20-C-frio.json) · [k6](../../bench/results/medium-whale-20-C-frio-k6.txt) · [explain](../../bench/results/medium-whale-20-C-frio-explain.txt) · [pgss](../../bench/results/medium-whale-20-C-frio-pgss.txt) |
| whale | 20 | C-caliente | 10 | 13 | 14 | 6 | 10 | 0,000 | 0 | 6001 | [json](../../bench/results/medium-whale-20-C-caliente.json) · [k6](../../bench/results/medium-whale-20-C-caliente-k6.txt) · [explain](../../bench/results/medium-whale-20-C-caliente-explain.txt) · [pgss](../../bench/results/medium-whale-20-C-caliente-pgss.txt) |
| whale | 100 | C-frio | 59999 | 60001 | 60003 | 59999 | 60008 | 100,000 | 27501 | 2500 | [json](../../bench/results/medium-whale-100-C-frio.json) · [k6](../../bench/results/medium-whale-100-C-frio-k6.txt) · [explain](../../bench/results/medium-whale-100-C-frio-explain.txt) · [pgss](../../bench/results/medium-whale-100-C-frio-pgss.txt) |
| whale | 100 | C-caliente | 8 | 10 | 11 | 5 | 7 | 0,000 | 0 | 30001 | [json](../../bench/results/medium-whale-100-C-caliente.json) · [k6](../../bench/results/medium-whale-100-C-caliente-k6.txt) · [explain](../../bench/results/medium-whale-100-C-caliente-explain.txt) · [pgss](../../bench/results/medium-whale-100-C-caliente-pgss.txt) |

Son los mismos números que [`bench/results/summary-compare.md`](../../bench/results/summary-compare.md), que armó `bench/summarize.ts` al terminar el benchmark, ordenados por variante y con los enlaces. Las corridas con 60.000 ms en todas las columnas son las que vencieron por timeout: k6 corta cada request a los 60 s.

## De esta tabla a la de `decision-snapshot.md`

La tabla de [§4](../decision-snapshot.md#4-resultados) muestra, por celda, el p99 de `GET` / `POST` de la corrida de esa fila, redondeado a ms:

- **"colapso"**: más del 95 % de las requests falló y la mediana de `GET` está en el timeout de 60 s. Entre paréntesis, el % de fallos (`whale 5` en A: 96,813 % → "97 %"; en C fría: 99,828 % → "99,8 %").
- **"(148 descartadas)"**: las `dropped_iterations` de esa corrida (`read-heavy 400` en C fría).
- Una celda sin marca tiene menos de 0,01 % de fallos y ninguna descartada.
- **"read-heavy 1–5"** de Z son las tres corridas a 1, 2 y 5 RPS, las tres colapsadas.
- **"—"**: no hay corrida.

`bench/check-results.ts` aplica estas mismas reglas. Lo hacen fallar una celda que no coincide con su JSON, una "—" con corrida, una fila sin sus cuatro variantes, una corrida que no aparece en ninguna celda (salvo el humo de A a 50 RPS, que no está en la matriz) o que falta en la tabla de arriba, y una corrida de C caliente sin su fila de calentamiento. Antes de dar el resultado, aplica en memoria mutaciones de las tablas (un número cambiado, una fila, una celda o una tabla borrada) y falla si alguna no la detecta.

## Por qué A colapsa en `whale`

La lectura de A recorre todas las órdenes ejecutadas del usuario, y una ballena tiene entre 106.177 y 239.945 ([datos](datos.md#el-generador)). Las salidas de las corridas de A lo muestran así:

| | Mediano (36000) | Ballena (1004) | Salida |
|---|---|---|---|
| `EXPLAIN (ANALYZE, BUFFERS)` de `read_portfolio`, al terminar `whale 2` | 9,8 ms; 1.681 bloques | 821,6 ms; 6.493 bloques y 1.116 de archivo temporal | [explain](../../bench/results/medium-whale-2-A-explain.txt) |
| Lo mismo al terminar `read-heavy 400` | 15,9 ms | 874,5 ms | [explain](../../bench/results/medium-read-heavy-400-A-explain.txt) |

| Corrida | `read_portfolio`: llamadas, media | Salida |
|---|---|---|
| `read-heavy 400` (casi todo usuarios chicos) | 107.947, 1,53 ms | [pgss](../../bench/results/medium-read-heavy-400-A-pgss.txt) |
| `whale 2` | 548, 543,71 ms | [pgss](../../bench/results/medium-whale-2-A-pgss.txt) |
| `whale 5` | 637, 10.318,50 ms | [pgss](../../bench/results/medium-whale-5-A-pgss.txt) |

- **El costo es por fila.** `read_portfolio` es una función: el `EXPLAIN` muestra un solo `Function Scan` y no el bucle de adentro. Lo que lo muestra es la diferencia entre un mediano y una ballena con la misma función, el mismo plan y la base caliente: ~10 ms contra ~820 ms. Las órdenes de la ballena no entran en `work_mem` (8 MB): el `ORDER BY instrumentid, balance_seq` del fold se ordena en disco, que es el archivo temporal.
- **La capacidad.** En `whale 2`, cada lectura de una ballena tomó en promedio 0,54 s de base. Con 2 CPU, eso da unas 3,7 lecturas por segundo. `whale 2` pide 1,8 lecturas por segundo (el 90 % de 2): cumple, con p99 de 795 ms. `whale 5` pide 4,5: más que la capacidad.
- **Colapsa, no se degrada.** Pasada la capacidad, la cola crece durante toda la corrida: la media de `read_portfolio` en `whale 5` sube a 10,3 s (esperando CPU), las requests vencen a los 60 s (96,8 % de fallos) y k6 se queda sin usuarios virtuales (194 descartadas).
- **C caliente**, la misma ballena: 8,0 ms y 2.520 bloques, sin archivo temporal ([explain](../../bench/results/medium-whale-2-C-caliente-explain.txt)), y `read_portfolio` con 6,98 ms de media en `whale 5` ([pgss](../../bench/results/medium-whale-5-C-caliente-pgss.txt)): recorre el snapshot y a lo sumo `K = 500` movimientos.
- **Z**, para comparar: la consulta de posiciones de un mediano es un `Parallel Seq Scan` de `orders` que descarta 22.208.092 filas para quedarse con 201 ([explain](../../bench/results/medium-read-heavy-2-Z-explain.txt)). Tardó 50 s porque se tomó con la cola de la carga todavía corriendo en la base.

## C caliente: el calentamiento

`bench/warm.sh` antes de cada corrida de C caliente: un `warm_snapshot` por usuario con historia, de la más larga a la más corta. Los 70.001 snapshots son los 70.000 usuarios del dataset y el usuario 1 del challenge (los otros tres no tienen órdenes).

| Corrida de C caliente | Calentamiento | Snapshots | Tamaño | Restore + `VACUUM` |
|---|---|---|---|---|
| [read-heavy 100](../../bench/results/medium-read-heavy-100-C-caliente-restore.txt) | 300 s | 70.001 | 81 MB | 81 s |
| [read-heavy 200](../../bench/results/medium-read-heavy-200-C-caliente-restore.txt) | 303 s | 70.001 | 81 MB | 78 s |
| [read-heavy 400](../../bench/results/medium-read-heavy-400-C-caliente-restore.txt) | 290 s | 70.001 | 81 MB | 86 s |
| [whale 2](../../bench/results/medium-whale-2-C-caliente-restore.txt) | 288 s | 70.001 | 81 MB | 83 s |
| [whale 5](../../bench/results/medium-whale-5-C-caliente-restore.txt) | 284 s | 70.001 | 81 MB | 75 s |
| [whale 20](../../bench/results/medium-whale-20-C-caliente-restore.txt) | 281 s | 70.001 | 81 MB | 73 s |
| [whale 100](../../bench/results/medium-whale-100-C-caliente-restore.txt) | 292 s | 70.001 | 81 MB | 76 s |

## C fría no se calienta sola

Cuántos snapshots había al terminar cada corrida de C fría (empezó sin ninguno):

| Corrida | Snapshots al terminar | Salida |
|---|---|---|
| `read-heavy 200` | 7.931 | [snapshots](../../bench/results/medium-read-heavy-200-C-frio-snapshots.txt) |
| `read-heavy 400` | 14.823 | [snapshots](../../bench/results/medium-read-heavy-400-C-frio-snapshots.txt) |
| `whale 2` | 10 | [snapshots](../../bench/results/medium-whale-2-C-frio-snapshots.txt) |
| `whale 5` | 0 | [snapshots](../../bench/results/medium-whale-5-C-frio-snapshots.txt) |
| `whale 20` | 0 | [snapshots](../../bench/results/medium-whale-20-C-frio-snapshots.txt) |
| `whale 100` | 0 | [snapshots](../../bench/results/medium-whale-100-C-frio-snapshots.txt) |

(`read-heavy 100` en C fría no dejó `-snapshots.txt`: [corridas](corridas.md#qué-hace-benchrunsh-en-cada-celda).)

- En `read-heavy`, los escritores van publicando: cada usuario que recibe un `POST` sin snapshot lo reconstruye. Mientras tanto, las lecturas de los que no tienen snapshot cuestan lo mismo que en A, y las reconstrucciones pesan: `read-heavy 400` descartó 148 iteraciones y su p99 de `POST` es 149 ms (3 / 7 en C caliente).
- En `whale 2`, la primera escritura de cada ballena publicó su snapshot (los 10) y desde ahí todo fue como en C caliente: p99 de 62 / 30 ms.
- En `whale 5` no se publicó ninguno en 5 minutos. Las lecturas frías ocupan la CPU (la media de `read_portfolio` es de 10,8 s) y ningún `place_order` llega a terminar: el JSON de k6 no registra ninguna orden creada, `place_order` no aparece entre las 5 sentencias de [`pg_stat_statements`](../../bench/results/medium-whale-5-C-frio-pgss.txt), donde sí aparecen 49 llamadas a `pg_cancel_backend`, que es como la API corta una escritura al vencer su deadline de 4 s. Sin escrituras no hay publicación, y sin publicación las lecturas siguen siendo frías.

## Números sin salida cruda

Lo que `decision-snapshot.md` cita y no está en `bench/results`, de dónde salió y lo más cercano que sí está versionado:

| Número | De dónde salió | Lo versionado más cercano |
|---|---|---|
| `GET /portfolio` sin carga: Z 3–4 s (típico) y 10 s (ballena); A 3 ms y 560 ms; C caliente 2 ms y 12 ms | lecturas sueltas a mano, sin carga, cuya salida no se guardó | el `EXPLAIN` al terminar cada corrida, todavía con la base caliente de la carga: en las corridas de A que no colapsaron, 6–16 ms (mediano) y 822–877 ms (ballena); C caliente 5–10 ms y 8–13 ms. La media de `read_portfolio` en A `whale 2`: 544 ms. Para Z no hay nada útil: su `EXPLAIN` se tomó con la cola de la carga corriendo (50 s) |
| Índice parcial de ejecutadas: 1,14 GB; `orders_balance_seq`: 0,6 GB | la salida de `bench/gen/load.sh`, que no se guardó | el tamaño de la base, 4.350 MB, en [`run-A.log`](../../bench/results/run-A.log); `load.sh` los vuelve a imprimir |
| Base de Z: 2,39 GB | la salida de `bench/reset.sh` de las corridas de Z, que no se guardó | ninguno; `bench/gen/load-z.sh` y `reset.sh` lo imprimen |
| 22,2 millones de órdenes | el dataset | [`run-A.log`](../../bench/results/run-A.log): 22.208.286 |
| ~10 % de LIMIT ejecutadas días después | el comentario del generador | el `summary` de `cohorts.json`, que se regenera igual: 12,14 % ([datos](datos.md#el-generador)) |

## Lo que no se midió

Está en [§8 de `decision-snapshot.md`](../decision-snapshot.md#8-qué-no-se-midió-y-por-qué-no-cambia-la-lectura). Dos cosas más que muestran las salidas:

- **La máquina no estaba aislada.** `docker stats` registró, además del benchmark, otro Postgres de otro proyecto corriendo en el mismo Docker (`commerce-engine-postgres-1` en los `-stats.csv`). El hardware del host no quedó registrado.
- **Una repetición por celda**, y algunas corridas de C fría se repitieron por cortes de la matriz ([corridas](corridas.md#qué-hace-benchrunsh-en-cada-celda)): vale la última.
