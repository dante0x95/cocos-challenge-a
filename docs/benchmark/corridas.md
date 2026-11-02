# Cómo se corrió el benchmark y cómo se corre una celda

> Parte del respaldo de [`docs/decision-snapshot.md`](../decision-snapshot.md#3-cómo-se-midió). Qué carga se generó, con qué recursos, con qué criterio y qué deja cada corrida en `bench/results`. Nada de esto corre en el CI ni entra en la imagen de la API (`.dockerignore` excluye `bench/`).

## Infraestructura

Todo en Docker, en una sola máquina, con [`bench/docker/docker-compose.yml`](../../bench/docker/docker-compose.yml) (proyecto `cocos-bench`):

| Servicio | Imagen | Recursos |
|---|---|---|
| `pg-medium` | `postgres:18` con el dump horneado ([`Dockerfile`](../../bench/docker/Dockerfile)), sin volumen: cada `up` parte del mismo estado | 2 CPU, 2 GB; [`medium.conf`](../../bench/docker/conf/medium.conf): `shared_buffers` 512 MB, `work_mem` 8 MB, `effective_cache_size` 1.536 MB, `pg_stat_statements` |
| `app` | `node:22-alpine` con [`bench/app`](../../bench/app) ([`Dockerfile.app`](../../bench/docker/Dockerfile.app)) | 2 CPU, 1 GB; `PG_POOL_MAX` 20, `REQUEST_DEADLINE_MS` 4.000 |
| `k6` | `grafana/k6:0.54.0` | sin límite |

El compose define también `pg-small` (1 CPU, 512 MB), `pg-large` (4 CPU, 8 GB) y `pg-neon` (0,25 CPU, 1 GB, la configuración de Neon de [`neon-settings.csv`](../../bench/results/neon-settings.csv)); el benchmark usó solo `medium`.

Al arrancar, los scripts de [`bench/docker`](../../bench/docker) agregan la configuración del perfil (`00-conf.sh`), restauran el dump con `pg_restore -j 2` (`01-restore.sh`), recrean los roles y privilegios del esquema `app`, que `pg_dump --no-owner --no-privileges` no conserva (`02-grants.sh`), y hacen `VACUUM ANALYZE` de `orders`, para que los index-only scans no tengan que ir a la tabla (`03-vacuum.sh`).

## La carga

[`bench/k6/lib.js`](../../bench/k6/lib.js) es común a los escenarios:

- **Tasa de llegada constante** (`constant-arrival-rate`): `RPS` iteraciones por segundo durante `DURATION`, haya o no respuesta; hasta 500 usuarios virtuales. Si no hay ninguno libre, k6 descarta la iteración (`dropped_iterations`). Cada iteración es una request; el timeout de k6 es el de defecto, 60 s.
- **Qué es un fallo**: cualquier respuesta que no sea `200`, `201` o `422`. Una orden `REJECTED` (`201`) y un `422 NO_PRICE` son respuestas de negocio.
- **Débito**: 70 % `BUY` MARKET por `amount` `20000.00` sobre un instrumento al azar del 1000 al 1999 (más que cualquier precio del dataset: nunca `400` por monto) y 30 % `CASH_OUT` de `10.00`. **Crédito**: `CASH_IN` de `100.00`. Cada `POST` lleva una `Idempotency-Key` única.
- **Usuarios**: de `cohorts.json`. Según la población, 80 % `median`, 15 % `p90`, 4 % `p99` y 1 % `p999`; o una ballena al azar.

| Escenario | Mezcla | Usuarios | ¿Se corrió? |
|---|---|---|---|
| [`read-heavy`](../../bench/k6/read-heavy.js) | 90 % `GET /portfolio`, 8 % débito, 2 % crédito | según la población | sí |
| [`whale`](../../bench/k6/whale.js) | 90 % `GET /portfolio`, 10 % débito | las 10 ballenas | sí |
| [`write-heavy`](../../bench/k6/write-heavy.js) | 50 % `GET`, 40 % débito, 10 % crédito | según la población | no |
| [`same-user`](../../bench/k6/same-user.js) | 50 % `GET`, 50 % `POST`, sobre un solo usuario (`-e USER=`, por defecto el primer `p90`) | uno | no |

**Escaleras de RPS** que se corrieron (salvo Z en `read-heavy` 5, son los valores por defecto de [`bench/run.sh`](../../bench/run.sh)):

| | `read-heavy` | `whale` |
|---|---|---|
| Z | 1, 2 y 5 | 1 |
| A | 100, 200, 400 | 2, 5, 20 |
| C fría y caliente | 100, 200, 400 | 2, 5, 20, 100 |

`whale` se midió en {2, 5, 20, 100} y no en {100…800} como estaba planeado, porque A ya colapsaba a 5 ([§8](../decision-snapshot.md#8-qué-no-se-midió-y-por-qué-no-cambia-la-lectura)). Z en `read-heavy` 5 y A en `read-heavy` 50 se corrieron con k6 a mano y solo dejaron el JSON. La de A a 50 es un humo fuera de la matriz y no está en la tabla de resultados; por sus números (0,033 % de fallos) es posterior a la corrección de la autorización.

## El criterio de éxito

Fijado antes de medir, junto con la regla de decisión ([§3](../decision-snapshot.md#3-cómo-se-midió)): p99 menor a 500 ms en `GET` y en `POST`, menos de 0,1 % de fallos y ninguna iteración descartada. Los mismos umbrales están declarados en `lib.js` como `thresholds` que no abortan: el benchmark reporta, no corta.

## Qué hace `bench/run.sh` en cada celda

Una celda es un escenario a una tasa sobre una variante. Para cada una, `run.sh`:

1. **Restaura** la base de la variante en un contenedor nuevo (`bench/reset.sh`: `bench.dump` para A y C, `base.dump` para Z) y reaplica las funciones de A o de C con `K = 500`. Tiempo → `-restore.txt`.
2. **Calienta C** si la variante es `C-caliente` (`bench/warm.sh`, se agrega a `-restore.txt`).
3. Levanta la API con el modo y el rol de la variante y espera `/health`.
4. **Precalienta** `WARMUP` (2 min) con el mismo escenario y tasa, sin medir → `-warmup.json`.
5. Pone en cero `pg_stat_statements` y **mide** `DURATION` (5 min) → `.json` (el resumen de k6, la fuente de los números) y `-k6.txt` (la salida de k6). Mientras tanto, `docker stats` cada 10 s → `-stats.csv`.
6. Guarda las 5 sentencias con más tiempo total → `-pgss.txt`.
7. Guarda el `EXPLAIN (ANALYZE, BUFFERS)` de la lectura de un usuario mediano (36000) y de una ballena (1004) → `-explain.txt`. En Z, una consulta de posiciones como la de su API, solo para el mediano.
8. En C, cuántos snapshots hay, cuándo se publicó el último, cuánto ocupan y las filas muertas de `snapshot_positions` → `-snapshots.txt`.

Los archivos se llaman `<perfil>-<escenario>-<rps>-<variante>.*`, por ejemplo `medium-whale-2-A.json`. `bench/results/run-A.log` y `run-C.log` son la salida de `run.sh` de esas matrices, con los tiempos de cada corrida (`corrida completa`): entre 507 y 603 s por celda de A y entre 781 y 808 s por celda de C caliente, que suma los ~300 s del calentamiento. En `run-C.log`, `read-heavy` 200 y 400 de C fría aparecen dos veces: la que vale es la última, que es la que quedó en `bench/results`. `read-heavy` 100 de C fría está incompleta fuera de k6: su `-explain.txt` es un error (corrió la consulta de Z, que no existe en el esquema de A), no dejó `-snapshots.txt` y su log termina después de la medida. Su `.json` y su `-k6.txt` están completos y coinciden.

[`bench/summarize.ts`](../../bench/summarize.ts) arma con los `.json` la tabla de [`summary-compare.md`](../../bench/results/summary-compare.md) (y `summary-Z.md`):

```bash
pnpm exec tsx bench/summarize.ts --compare A,Z,C-frio,C-caliente
```

[`bench/check-results.ts`](../../bench/check-results.ts) comprueba que las tablas de [resultados](resultados.md) y de `decision-snapshot.md` coinciden con esos `.json`. No corre en el CI: se corre después de tocar esos docs o `bench/results`.

```bash
pnpm exec tsx bench/check-results.ts
```

## Correr una celda de punta a punta

Por ejemplo `whale 2` en A, desde un clon limpio. Necesita Docker, `psql` y `pg_dump` 18 en el host, y `pnpm install`.

**1. Los datos** (una vez; [datos](datos.md#regenerar-todo)):

```bash
bench/dump/seed.sh
```

```bash
pnpm exec tsx bench/gen/generate.ts --out bench/gen/out
```

```bash
bench/gen/load.sh medium
```

**2. La celda**, en `bench/results-local` para no pisar las salidas versionadas:

```bash
VARIANT=A SCENARIOS=whale RPS_WHALE=2 RESULTS=bench/results-local bench/run.sh
```

```bash
pnpm exec tsx bench/summarize.ts --dir bench/results-local --variant A
```

Otras celdas cambian `VARIANT` (`Z`, `A`, `C-frio`, `C-caliente`; Z necesita además `bench/gen/load-z.sh medium`), `SCENARIOS` y `RPS_<ESCENARIO>` (`RPS_READ_HEAVY`, `RPS_WHALE`). `DURATION` y `WARMUP` acortan la corrida; `SKIP_DONE=1` saltea las celdas que ya tienen su `.json`.

- **Puertos ocupados**: `BENCH_PG_PORT` y `BENCH_APP_PORT` cambian los del host (5434 y 3000 en `medium`). Los demás se hablan por la red del compose.
- **`reset.sh` borra el proyecto `cocos-bench`** (`down -v`) antes de cada celda: no correr dos benchmarks a la vez en la misma máquina.

**Lo que se comprobó en este repo.** Desde un clon limpio, con el dataset chico (`--users 200`, que conserva las 10 ballenas) y una corrida corta (`DURATION=1m WARMUP=30s`, `BENCH_PG_PORT=55434 BENCH_APP_PORT=53000`), los pasos de arriba dieron para `whale 2` en A un p99 de 1.046 ms en `GET` y 75 ms en `POST`, sin fallos ni descartadas, y `read_portfolio` con 662 ms de media en `pg_stat_statements` (el benchmark: 795 / 91 ms y 544 ms). Con el dataset completo, una celda de A tarda unos 9 minutos.
