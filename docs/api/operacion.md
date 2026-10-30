# Salud y operación

## `GET /health`

```json
{ "ok": true, "db": "up", "users": "4" }
```

Si la base no responde, devuelve `503` con `{ "ok": false, "db": "down" }`. Lo usa el healthcheck de docker compose.

## `/internal/*`

Requieren la cabecera `X-Internal-Token` con el valor de `INTERNAL_TOKEN` (`401` si no coincide). Si `INTERNAL_TOKEN` no está configurado, estas rutas no existen (`404`). Todos son `POST` y son idempotentes.

| Ruta | Qué hace |
|---|---|
| `/internal/execute-limits` | Ejecuta las LIMIT `NEW` que la cotización vigente cruza, a su precio límite. Cada una en su transacción; la decisión final la toma `app.execute_limit_outcome`, bajo el lock ([D-28](../decisiones.md#d-28)). Responde `{ candidates, executed, not_crossed, cancelled, errors }`. `cancelled` lista `{ order_id, reason: "LIMIT" }` de las que se cancelaron porque ejecutarlas violaría los límites de [D-14](../decisiones.md#d-14); esas órdenes quedan con `cancel_reason: "LIMIT"`. |
| `/internal/cleanup-idempotency` | Borra las claves de idempotencia de más de 24 h ([D-19](../decisiones.md#d-19)). |

## Jobs periódicos

Con `JOBS_ENABLED=true` (activo en docker compose), la API corre la limpieza de idempotencia cada hora (`CLEANUP_EVERY_MS`). Cada usuario se procesa en su propia transacción y con try-lock, así que nunca bloquea escrituras. En producción irían a un worker aparte.

## Desplegar un cambio en las funciones

```bash
pnpm db:bootstrap      # o: docker compose run --rm migrate
```

Aplica las migraciones pendientes y reaplica `db/functions` en una sola transacción, con la barrera de despliegue: se puede correr con la API activa; las escrituras esperan hasta el `COMMIT` (o responden `503` y se reintentan) y, si algo falla, no queda nada aplicado. Una migración nueva va en un archivo nuevo de `db/migrations`; nunca se edita una ya aplicada ([D-24](../decisiones.md#d-24)).

**Cambio de hash de idempotencia.** Si cambia cómo se calcula el hash de `POST /orders`, las claves vigentes (24 h) guardan el hash viejo y su reintento respondería `422`. El cambio tiene que aceptar también el hash anterior, solo para reconocer claves existentes y dentro de la misma llamada a `app.place_order`, hasta que vence la ventana; después se borra esa compatibilidad. Así se hizo al canonizar `amount` y `price` ([D-19](../decisiones.md#d-19)).

## Antigüedad máxima de una cotización

```sql
UPDATE app.settings SET price_max_age_days = 7;    -- recomendado en producción
UPDATE app.settings SET price_max_age_days = NULL; -- por defecto: sin límite (datos de 2023)
```
