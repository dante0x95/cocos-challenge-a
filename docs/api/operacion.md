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
| `/internal/execute-limits` | Ejecuta las LIMIT `NEW` que la cotización vigente cruza, a su precio límite. Cada una en su transacción; la decisión final la toma `app.execute_limit_outcome`, bajo el lock ([D-28](../decisiones.md#d-28)). Parámetros en la query string, todos opcionales: `max` (tamaño del lote, 1–10000, por defecto 500), `per_user` (a lo sumo N órdenes por usuario por corrida, 1–10000, por defecto 50), `after_id` (cursor: solo órdenes con id mayor; por defecto 0) y `max_ms` (presupuesto de la corrida, 1–600000, por defecto 10000). Un valor que no es un entero sin signo, repetido o un parámetro desconocido → `400`. Responde `{ candidates, executed, not_crossed, cancelled, errors, skipped_users, skipped_instruments, after_id, remaining }`: `cancelled` lista `{ order_id, reason }` de las que el executor canceló en vez de ejecutar: `reason: "LIMIT"`, porque ejecutarlas violaría los límites de [D-14](../decisiones.md#d-14); `reason: "UNBACKED"`, porque no tenían respaldo (venta sin las acciones, compra sin el cash: solo una orden heredada de una base preexistente, [D-12](../decisiones.md#d-12)). Esas órdenes quedan con ese mismo `cancel_reason`; `skipped_users`, los usuarios cuyo lock no se consiguió (`55P03`), y `skipped_instruments`, los instrumentos que se quedaron sin cotización válida entre la selección y la ejecución (`APP01`): sus demás órdenes del lote no se intentaron y no están en `errors`; `after_id` es el cursor para la corrida siguiente (`null` solo cuando el lote se agotó: la próxima empieza de cero; si el presupuesto venció antes de procesar ninguna, es el mismo cursor recibido, también `"0"`); `remaining`, cuántas candidatas del lote no se intentaron porque venció `max_ms`. |
| `/internal/cleanup-idempotency` | Borra las claves de idempotencia vencidas hace más de un minuto (más viejas que `settings.idempotency_ttl`, 24 h, más un minuto de margen para los requests en curso). Solo recupera espacio: el vencimiento lo decide `app.place_order` al reclamar la clave, con el mismo plazo, así que una clave vencida que el job todavía no borró ya no da replay ni `422` ([D-19](../decisiones.md#d-19)). |

Recorrer todas las pendientes:

```bash
curl -s -X POST -H "X-Internal-Token: $INTERNAL_TOKEN" 'http://localhost:3000/internal/execute-limits?max=500&max_ms=10000'
# → { ..., "after_id": "1234", "remaining": 0 }: repetir con ?after_id=1234 hasta que after_id sea null
```

## Cuando la base se reinicia

Un reinicio de Postgres (mantenimiento, failover, `pg_terminate_backend`) corta todas las conexiones del pool. Las ociosas se descartan solas (el pool recibe el evento `error`, lo registra con `scope: "pg-pool-idle"` y sigue); la siguiente request abre una conexión nueva. Este listener protege solo a las conexiones ociosas. Una request cuya consulta estaba en vuelo recibe el error de la conexión cortada y responde `503 CONNECTION_LOST` con `Retry-After` ([errores de `POST /orders`](orders.md#errores)): su resultado es desconocido (la escritura pudo confirmarse) y `POST /orders` se reintenta con la misma `Idempotency-Key`, que devuelve la orden si existe ([D-20](../decisiones.md#d-20)). El proceso no se reinicia. `GET /health` responde `503` con `db: "down"` mientras la base no contesta y vuelve a `200` sola.

## Jobs periódicos

Con `JOBS_ENABLED=true` (activo en docker compose y en Fly), la API corre la limpieza de idempotencia cada hora (`CLEANUP_EVERY_MS`). Cada usuario se procesa en su propia transacción y con try-lock, así que nunca bloquea escrituras; que dos máquinas la corran a la vez durante un deploy solo duplica trabajo. Con `JOBS_ENABLED=false` las claves vencidas se acumulan hasta que alguien llame a `/internal/cleanup-idempotency`, pero vencen igual: la limpieza no es parte de la regla de negocio. En producción iría a un worker aparte.

El executor de LIMIT no tiene job ([D-28](../decisiones.md#d-28)): en producción lo llamaría un cron externo cada N minutos, con `POST /internal/execute-limits` y el token ([D-29](../decisiones.md#d-29)).

## Desplegar un cambio en las funciones

```bash
pnpm db:bootstrap      # o: docker compose run --rm migrate
```

Aplica las migraciones pendientes y reaplica `db/functions` en una sola transacción, con la barrera de despliegue: se puede correr con la API activa; las escrituras esperan hasta el `COMMIT` (o responden `503` y se reintentan) y, si algo falla, no queda nada aplicado. Una migración nueva va en un archivo nuevo de `db/migrations`; nunca se edita una ya aplicada ([D-24](../decisiones.md#d-24)). Si aplicó alguna, verifica la historia: un corto heredado ([D-01](../decisiones.md#d-01)) o una historia fuera de los tipos ([D-14](../decisiones.md#d-14)) se informan, y una LIMIT `NEW` sin respaldo se cancela con `cancel_reason: "UNBACKED"` y se informa en el log (`historia: usuario N — reserva: …`, `orden N cancelada`), bajo el lock de ese usuario ([D-24](../decisiones.md#d-24)). Solo un cash que no cierra aborta el despliegue.

En Fly lo corre el `release_command` de cada deploy, antes de cambiar de versión: si falla, sale con 1 y el deploy se corta ([D-29](../decisiones.md#d-29)).

## Desplegar en Fly.io

Cada commit de `main` con el check `ci` en verde se despliega solo (`.github/workflows/deploy.yml`, [D-29](../decisiones.md#d-29)), en tres etapas: la imagen se construye una vez y se publica en GHCR con el SHA como etiqueta; `staging` la despliega; `production` despliega la misma imagen después de la aprobación manual del environment `production`. No hay nada que correr a mano, salvo la primera vez:

```bash
git switch main && git pull
fly auth login
deploy/fly/setup.sh                                              # producción: apps, volumen, secretos y primer deploy
CONFIG=deploy/fly/staging.toml DB_CONFIG=deploy/fly/staging-db.toml deploy/fly/setup.sh   # staging, igual
fly tokens create deploy -a cocos-challenge-a-staging | gh secret set FLY_API_TOKEN --env staging
fly tokens create deploy -a cocos-challenge-a-api | gh secret set FLY_API_TOKEN --env production
```

Y dos cosas en GitHub, una sola vez: el paquete `cocos-challenge-a` de GHCR tiene que ser **público** (Packages → el paquete → Package settings → Change visibility) para que Fly pueda bajar la imagen con `--image`; y los environments `staging` y `production` (Settings → Environments) creados antes de los dos `gh secret set --env` de arriba, con **required reviewers** en `production`, que es lo que convierte el job `production` en una aprobación manual. Sin eso, producción se despliega sola detrás de staging.

- **Un deploy en rojo.** `gh run list --workflow deploy` y `gh run view <id> --log`. Si frenó antes de `flyctl deploy`, el commit no desciende del release que atiende (un re-run del `ci` de un commit viejo, por ejemplo): no cambió nada. Si falló el `release_command`, el bootstrap no dejó nada aplicado y la versión anterior sigue; `fly logs -a cocos-challenge-a-api` tiene el error. Si falló el check de `/health`, las máquinas nuevas no recibieron tráfico. Si falló el deploy o la verificación de después (`/health atiende el commit`), el paso `Volver a la imagen anterior` devolvió a la imagen y el release de antes cada máquina de la API que no estaba así (si el deploy falló antes de conmutar, ninguna), sin correr el `release_command`; su log dice si `/health` atiende otra vez ese release. Si ese paso también falló, el entorno quedó en la versión nueva: `flyctl machines list -a <app>` y `deploy/fly/rollback.sh restore` a mano, con `PREVIOUS_IMAGE` y `PREVIOUS_RELEASE` del log.
- **Re-desplegar** es volver a correr el workflow de ese commit (`gh run rerun <id>`). Re-corre la construcción de la imagen (misma etiqueta) y las dos etapas; la aprobación de producción se vuelve a pedir.
- **Staging en rojo, producción no**: el job `production` no corre (`needs: staging`); lo que atiende producción no cambia. Un deploy de staging con una migración nueva corre su `release_command` contra la base de staging antes de que esa migración llegue a producción.
- **Ensayos** (`deploy/fly/drills.sh`, a mano, con `flyctl` y `gh` autenticados; no corren en el CI): el último merge pasó por `ci` y deploy y `/health` lo atiende (`merge`, conviene después del primer merge), un deploy roto (bootstrap que falla, `/health` en `503`, re-run del `ci` de un commit viejo) y los datos de Postgres después de redesplegar la base (`persistence`, corta la API mientras la base reinicia).
- **Token interno** para `/internal/*`: `fly ssh console -a cocos-challenge-a-api -C 'printenv INTERNAL_TOKEN'`.

**Cambio de hash de idempotencia.** Si cambia cómo se calcula el hash de `POST /orders`, las claves vigentes (24 h) guardan el hash viejo y su reintento respondería `422`. El cambio tiene que aceptar también el hash anterior, solo para reconocer claves existentes y dentro de la misma llamada a `app.place_order`, hasta que vence la ventana; después se borra esa compatibilidad. Como el vencimiento lo decide `place_order` con `created_at`, la ventana termina 24 h después del despliegue aunque la limpieza no haya corrido. Así se hizo al canonizar `amount` y `price` ([D-19](../decisiones.md#d-19)).

## Vencimiento de las claves de idempotencia

```sql
UPDATE app.settings SET idempotency_ttl = '12 hours';  -- por defecto: 24 h (D-19)
UPDATE app.settings SET idempotency_ttl = DEFAULT;
```

Es la única fuente del plazo (`app.idempotency_ttl()`): la usan `app.place_order` para decidir si una clave venció y la limpieza para borrarla (un minuto después de que vence). Cambiarlo rige para la próxima transacción, también sobre las claves ya grabadas.

## Antigüedad máxima de una cotización

```sql
UPDATE app.settings SET price_max_age_days = 7;    -- recomendado en producción
UPDATE app.settings SET price_max_age_days = NULL; -- por defecto: sin límite (datos de 2023)
```
