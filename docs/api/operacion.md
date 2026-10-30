# Salud y operación

## `GET /health`

```json
{ "ok": true, "db": "up", "release": "de01a01a…", "users": "4" }
```

- `release` es el commit desplegado (variable `RELEASE`, la fija el deploy en Fly); `null` si no está configurada, como en `docker compose`.
- Si la base no responde, `503` con `{ "ok": false, "db": "down", "release": … }`: `release` va igual, para saber qué commit atiende.

Lo usan el healthcheck de docker compose, el check de las máquinas nuevas en Fly (bluegreen) y el workflow de deploy, antes y después de desplegar ([D-29](../decisiones.md#d-29)).

## `/internal/*`

Requieren la cabecera `X-Internal-Token` con el valor de `INTERNAL_TOKEN` (`401` si no coincide). Si `INTERNAL_TOKEN` no está configurado, estas rutas no existen (`404`). Todos son `POST` y son idempotentes.

| Ruta | Qué hace |
|---|---|
| `/internal/execute-limits` | Ejecuta las LIMIT `NEW` que la cotización vigente cruza, a su precio límite. Cada una en su transacción; la decisión final la toma `app.execute_limit_outcome`, bajo el lock ([D-28](../decisiones.md#d-28)). Responde `{ candidates, executed, not_crossed, cancelled, errors }`. `cancelled` lista `{ order_id, reason: "LIMIT" }` de las que se cancelaron porque ejecutarlas violaría los límites de [D-14](../decisiones.md#d-14); esas órdenes quedan con `cancel_reason: "LIMIT"`. |
| `/internal/cleanup-idempotency` | Borra las claves de idempotencia de más de 24 h ([D-19](../decisiones.md#d-19)). |

## Cuando la base se reinicia

Un reinicio de Postgres (mantenimiento, failover, `pg_terminate_backend`) corta todas las conexiones del pool. Las ociosas se descartan solas (el pool recibe el evento `error`, lo registra con `scope: "pg-pool-idle"` y sigue); la siguiente request abre una conexión nueva. Este listener protege solo a las conexiones ociosas. Una request cuya consulta estaba en vuelo recibe el error de la conexión cortada y hoy responde `500 INTERNAL`: su resultado es desconocido (la escritura pudo confirmarse) y `POST /orders` se reintenta con la misma `Idempotency-Key`, que devuelve la orden si existe ([D-20](../decisiones.md#d-20)). El proceso no se reinicia. `GET /health` responde `503` con `db: "down"` mientras la base no contesta y vuelve a `200` sola.

## Jobs periódicos

Con `JOBS_ENABLED=true` (activo en docker compose y en Fly), la API corre la limpieza de idempotencia cada hora (`CLEANUP_EVERY_MS`). Cada usuario se procesa en su propia transacción y con try-lock, así que nunca bloquea escrituras; que dos máquinas la corran a la vez durante un deploy solo duplica trabajo. En producción iría a un worker aparte.

El executor de LIMIT no tiene job ([D-28](../decisiones.md#d-28)): en producción lo llamaría un cron externo cada N minutos, con `POST /internal/execute-limits` y el token ([D-29](../decisiones.md#d-29)).

## Desplegar un cambio en las funciones

```bash
pnpm db:bootstrap      # o: docker compose run --rm migrate
```

Aplica las migraciones pendientes y reaplica `db/functions` en una sola transacción, con la barrera de despliegue: se puede correr con la API activa; las escrituras esperan hasta el `COMMIT` (o responden `503` y se reintentan) y, si algo falla, no queda nada aplicado. Una migración nueva va en un archivo nuevo de `db/migrations`; nunca se edita una ya aplicada ([D-24](../decisiones.md#d-24)).

En Fly lo corre el `release_command` de cada deploy, antes de cambiar de versión: si falla, sale con 1 y el deploy se corta ([D-29](../decisiones.md#d-29)).

## Desplegar en Fly.io

Cada commit de `main` con el check `ci` en verde se despliega solo (`.github/workflows/deploy.yml`, [D-29](../decisiones.md#d-29)). No hay nada que correr a mano, salvo la primera vez:

```bash
git switch main && git pull
fly auth login
deploy/fly/setup.sh                                              # apps, volumen, secretos y primer deploy
fly tokens create deploy -a cocos-challenge-a-api | gh secret set FLY_API_TOKEN
```

- **Un deploy en rojo.** `gh run list --workflow deploy` y `gh run view <id> --log`. Si frenó antes de `flyctl deploy`, el commit no desciende del release que atiende (un re-run del `ci` de un commit viejo, por ejemplo): no cambió nada. Si falló el `release_command`, el bootstrap no dejó nada aplicado y la versión anterior sigue; `fly logs -a cocos-challenge-a-api` tiene el error. Si falló el check de `/health`, las máquinas nuevas no recibieron tráfico.
- **Re-desplegar** es volver a correr el workflow de ese commit (`gh run rerun <id>`).
- **Ensayos** (`deploy/fly/drills.sh`, a mano, con `flyctl` y `gh` autenticados; no corren en el CI): el último merge pasó por `ci` y deploy y `/health` lo atiende (`merge`, conviene después del primer merge), un deploy roto (bootstrap que falla, `/health` en `503`, re-run del `ci` de un commit viejo) y los datos de Postgres después de redesplegar la base (`persistence`, corta la API mientras la base reinicia).
- **Token interno** para `/internal/*`: `fly ssh console -a cocos-challenge-a-api -C 'printenv INTERNAL_TOKEN'`.

**Cambio de hash de idempotencia.** Si cambia cómo se calcula el hash de `POST /orders`, las claves vigentes (24 h) guardan el hash viejo y su reintento respondería `422`. El cambio tiene que aceptar también el hash anterior, solo para reconocer claves existentes y dentro de la misma llamada a `app.place_order`, hasta que vence la ventana; después se borra esa compatibilidad. Así se hizo al canonizar `amount` y `price` ([D-19](../decisiones.md#d-19)).

## Antigüedad máxima de una cotización

```sql
UPDATE app.settings SET price_max_age_days = 7;    -- recomendado en producción
UPDATE app.settings SET price_max_age_days = NULL; -- por defecto: sin límite (datos de 2023)
```
