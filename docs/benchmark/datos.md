# El dataset del benchmark: cómo se genera, se carga y se verifica

> Parte del respaldo de [`docs/decision-snapshot.md`](../decision-snapshot.md#3-cómo-se-midió). Los dumps (`bench.dump` 402 MB, `base.dump` 347 MB) y los CSV generados (1,6 GB) no se versionan: se regeneran con lo que sigue, desde un clon limpio y con Docker.

## De dónde sale cada dump

```
db/migrations/000_seed.sql ──bench/dump/seed.sh──▶ trading.dump (la base del challenge)
                                                       │
bench/gen/generate.ts ──▶ bench/gen/out/*.csv ─────────┤
                                                       ├─bench/gen/load.sh──▶ bench.dump (A y C)
                                                       └─bench/gen/load-z.sh▶ base.dump (Z)
```

1. **`trading.dump`**: la base del challenge (4 usuarios, 66 instrumentos, 11 órdenes, 126 cotizaciones). En el benchmark salió de Neon con [`bench/dump/pull-neon.sh`](../../bench/dump/pull-neon.sh), que necesita la URL de la base de Neon. Desde acá se arma con [`bench/dump/seed.sh`](../../bench/dump/seed.sh) desde [`000_seed.sql`](../../db/migrations/000_seed.sql), el `database.sql` del enunciado. Se comprobó que son la misma base: restaurados en un Postgres 18, el dump de Neon y el de `seed.sh` tienen las mismas filas en las cuatro tablas y el mismo `pg_dump -s`.
2. **Los CSV**: [`bench/gen/generate.ts`](../../bench/gen/generate.ts), determinista.
3. **`bench.dump`**: [`bench/gen/load.sh`](../../bench/gen/load.sh) migra `trading.dump` (A) y le carga los CSV.
4. **`base.dump`**: [`bench/gen/load-z.sh`](../../bench/gen/load-z.sh) carga los mismos CSV sobre `trading.dump` sin migrar (Z).

Los dos dumps de A/C y Z tienen las mismas órdenes; cambian el esquema y el formato del cash.

## El generador

```bash
pnpm exec tsx bench/gen/generate.ts --users 70000 --instruments 1000 --seed 42 --out bench/gen/out
```

| Parámetro | Default | Qué es |
|---|---|---|
| `--users` | 70000 | usuarios generados, con ids desde el 1000 |
| `--instruments` | 1000 | instrumentos, ids del 1000 al 1999, tickers al azar |
| `--seed` | 42 | semilla del PRNG (`mulberry32`): mismos parámetros, mismos archivos |
| `--end` | 2026-10-23 | último día hábil con cotización (ninguna fecha futura) |
| `--years` | 5 | años de cotizaciones diarias, solo días hábiles (1.305 días) |
| `--ars` | 66 | id del instrumento ARS del challenge, donde van los movimientos de cash |
| `--out` | `bench/gen/out` | `users.csv`, `instruments.csv`, `marketdata.csv`, `orders.csv` y `cohorts.json` |

Los ids del challenge (usuarios 1–4, instrumentos 1–66) quedan intactos.

**Cotizaciones.** Cada instrumento arranca entre 100 y 5.000 ARS y hace un paseo al azar de ±3 % diario, con `high`, `low`, `open` y `previousclose` coherentes.

**Cohortes.** Los 10 primeros usuarios son ballenas; los demás se reparten al azar. El objetivo es la cantidad de órdenes ejecutadas (`FILLED`) de cada usuario:

| Cohorte | Proporción | Órdenes ejecutadas (objetivo) | Instrumentos que opera (sorteados) | Usuarios (seed 42) |
|---|---|---|---|---|
| `median` | 80 % | log-normal alrededor de 50 | hasta 3–25 | 55.944 |
| `p90` | 15 % | alrededor de 500 | hasta 3–25 | 10.544 |
| `p99` | 4 % | alrededor de 2.000 | hasta 3–25 | 2.795 |
| `p999` | 1 % | alrededor de 5.000 | hasta 3–25 | 707 |
| `whale` | los 10 primeros (ids 1000–1009) | entre 100.000 y 250.000 | hasta 200 | 10 |

Pendientes al final: las 5 primeras ballenas tienen 2.000 LIMIT `NEW` cada una y el 20 % de los demás, entre 1 y 50 (13.877 usuarios con `NEW`, cohorte `withNew`). Son compras a la mitad del precio: nunca se ejecutan.

**Cada historia la decide el oráculo.** El generador simula a cada usuario, de a un evento por vez, con el oráculo de los tests ([`bench/app/test/oracle/fold.ts`](../../bench/app/test/oracle/fold.ts), escrito aparte del SQL), y escribe cada orden con el estado que el oráculo le dio. Ninguna historia viola las reglas de saldo ni de tenencia: lo que no alcanza queda `REJECTED`. La mezcla de eventos:

| Evento | Probabilidad | Cómo |
|---|---|---|
| `CASH_IN` | 6 % (y el primero de cada usuario) | el primero fondea: 50 millones de ARS a una ballena, entre 200.000 y 5 millones a los demás |
| `CASH_OUT` | 4 % | el 30 % pide más que el disponible y queda `REJECTED` |
| `BUY` MARKET | 40 % | el 5 % pide más que el disponible y queda `REJECTED` |
| `SELL` MARKET | 36 % | el 4 % vende más que lo que tiene y queda `REJECTED` |
| LIMIT | 14 % | 60 % compra, 40 % venta, cerca del cierre: se ejecuta a su precio el primer día (de los 30 siguientes) que el cierre la cruza; si no, se cancela entre 5 y 40 días después |

**Orden de creación ≠ orden de ejecución.** Las filas se escriben en orden de creación (`id`) y `balance_seq` sigue la ejecución de cada usuario. Las LIMIT que se ejecutan días después de crearse son el 12,1 % de las ejecutadas (2.457.093 de 20.234.866): un `ORDER BY id` daría otro resultado que un `ORDER BY balance_seq`.

**Lo que dio con la seed 42** (el `summary` de `cohorts.json`): 20.234.866 `FILLED`, 1.022.123 `REJECTED`, 590.395 `CANCELLED` y 360.891 `NEW`, que con las 11 del challenge son las 22.208.286 órdenes que cuenta [`bench/results/run-A.log`](../../bench/results/run-A.log).

**Determinismo.** Regenerado desde este repo con los parámetros por defecto (tarda unos 2 minutos), `generate.ts` produce los cuatro CSV byte por byte iguales a los del benchmark (comprobado con `sha256`) y el mismo `cohorts.json`. Las ballenas no dependen de `--users`: con `--users 200` salen las mismas 10, con entre 106.177 y 239.945 órdenes ejecutadas.

## La carga

**A y C** ([`bench/gen/load.sh`](../../bench/gen/load.sh)):

1. `bench/reset.sh` sobre `trading.dump`: auditoría ([`00_audit.sql`](../../bench/sql/00_audit.sql)), migración ([`10_migrate.sql`](../../bench/sql/10_migrate.sql), que comprueba que el inventario de cada usuario es el mismo antes y después), esquema y roles, y funciones.
2. `COPY` de los CSV con el trigger `orders_guard` apagado y sin los índices de `orders`.
3. Los tres índices parciales, el trigger de nuevo, la secuencia de `orders.id` y `VACUUM ANALYZE`.
4. Verificación en bloque de lo que el trigger habría comprobado fila a fila: `FILLED` si y solo si tiene `balance_seq`, y `balance_seq` consecutiva desde 1 por usuario. Si falla, aborta.
5. Imprime tamaños, órdenes por estado y las 10 historias más largas, y escribe `bench/dump/bench.dump`.

**Z** ([`bench/gen/load-z.sh`](../../bench/gen/load-z.sh)): `trading.dump` sin migrar; `COPY` de usuarios, instrumentos y cotizaciones, y las órdenes por una tabla intermedia que vuelve el cash al formato original (pesos enteros a `price = 1`) y descarta `balance_seq`. Sin índices nuevos. Escribe `bench/dump/base.dump`.

Con el dataset completo, `bench.dump` pesa 402 MB y la base restaurada ocupa 4.350 MB ([`run-A.log`](../../bench/results/run-A.log)).

## La verificación contra el oráculo

[`bench/gen/verify.ts`](../../bench/gen/verify.ts) toma una muestra (las 10 ballenas y hasta 20 usuarios de cada cohorte, `--sample 100`), vuelve a simular su historia desde la base con el oráculo (las `FILLED` en orden de `balance_seq`, después las `NEW`) y compara el resultado con `app.read_portfolio` en los dos sentidos: cash y reservado; cantidad, costo, marca y acciones reservadas de cada posición que devuelve la base, y que cada posición del oráculo esté en la base. Sale con 1 si algún usuario difiere o si la muestra está vacía. Prueba dos cosas a la vez: que la historia cargada es válida y que el fold de A coincide con el oráculo.

```bash
DUMP=bench.dump bench/reset.sh medium
DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5434/trading pnpm exec tsx bench/gen/verify.ts --sample 100
```

[`bench/test/verify-negative.sh`](../../bench/test/verify-negative.sh) es su control negativo contra un Postgres real (fuera del CI): arma la base del challenge con las funciones de A, le da una historia al usuario 2 por `app.place_order`, comprueba que `verify.ts` da 0 diferencias y después sabotea `read_portfolio` para que pierda las posiciones y deje el cash: `verify.ts` tiene que salir con 1 y nombrar las que faltan. Con la versión anterior de `verify.ts`, que solo miraba las posiciones devueltas, ese sabotaje pasaba.

```bash
bench/test/verify-negative.sh
```

La salida de esta verificación sobre el dataset completo no quedó guardada en `bench/results`. Sobre el dataset de 200 usuarios (las 10 ballenas incluidas), en este repo, verificó 74 usuarios (la muestra sin repetidos) con 0 diferencias.

## Regenerar todo

Desde la raíz del repo, con Docker, `psql` y `pg_dump` 18 y `pnpm install` hecho:

```bash
bench/dump/seed.sh
```

```bash
pnpm exec tsx bench/gen/generate.ts --out bench/gen/out
```

```bash
bench/gen/load.sh medium
```

```bash
bench/gen/load-z.sh medium
```

Si el puerto del perfil (5434 para `medium`) está ocupado, `BENCH_PG_PORT=<otro>` delante de cada comando. Cómo se corre una celda con esos dumps: [corridas](corridas.md).
