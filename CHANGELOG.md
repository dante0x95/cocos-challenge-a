# Cambios

Una sección por versión publicada (un GitHub Release `vX.Y.Z`, que despliega en staging y después en producción: [D-29](docs/decisiones.md#d-29)). Cada línea dice qué cambia para quien usa la API o la opera, con el PR que lo trae. **Antes de publicar** lista los pasos de operación que la versión exige: se hacen antes de `gh release create` ([`docs/api/operacion.md`](docs/api/operacion.md#desplegar-en-lightsail)). Este archivo es la fuente de las notas; `--generate-notes` solo agrega la lista de PRs.

## v0.2.1 — sin publicar

### Antes de publicar

Nada.

### Operación y deploy

- **Volver a correr un deploy cortado ya no borra el último release sano** ([#65](https://github.com/dante0x95/cocos-challenge-a/pull/65)): el cambio de versión queda sin confirmar hasta que pasan `/health` y el smoke (`switch.pending`, que borra el paso nuevo `Confirmar el cambio`). Si el job se corta antes (cancelado, runner perdido, timeout), el re-run toma como lo que atiende el último release confirmado, no pisa su respaldo y, si vuelve a fallar en cualquier paso, vuelve a él. Antes, el re-run tomaba el release roto como el anterior y la vuelta atrás no tenía a dónde volver. No borrar `switch.pending` a mano ([operación](docs/api/operacion.md#operación)).
- **Re-ejecutar el deploy de un release viejo ya no reinstala sus funciones sobre la base de uno más nuevo** ([#61](https://github.com/dante0x95/cocos-challenge-a/pull/61)): después de una vuelta atrás, la base queda con las migraciones del release que falló; si se vuelve a correr el deploy del anterior, su bootstrap frena antes de tocar nada y nombra las migraciones que no conoce, y la versión que atiende sigue igual. Un release cuyas funciones escriben algo que el anterior no sabe leer trae una migración ([D-24](docs/decisiones.md#d-24)).
- **El ensayo con Docker borra solo lo suyo y avisa si no pudo** ([#64](https://github.com/dante0x95/cocos-challenge-a/pull/64)): `deploy/lightsail/drill-docker.sh` borra por id solo lo que creó (ya no un `cocos-drill-pg` o un registro de otro) y comprueba que `down -v` no deje nada de `cocos-staging`. Si algo queda, lo nombra, deja su registro como candado para que el ensayo siguiente se rechace y sale distinto de 0: un `ENSAYO OK` ya no esconde restos.

### API

- **Un cash negativo heredado marca la historia y lo informa el bootstrap** ([#74](https://github.com/dante0x95/cocos-challenge-a/pull/74)): si una compra o un retiro heredados `FILLED` sin fondos dejan `cash.neto` negativo, `GET /portfolio` responde `has_inconsistent_history: true` (antes, `false`: solo la marcaba una venta sin tenencia), y el bootstrap lo informa como `historia: usuario N — cash negativo` sin abortar, como un corto. La marca se va cuando un depósito lo cubre. La migración `011` no cambia nada: hace que el despliegue verifique una vez la base existente ([D-01](docs/decisiones.md#d-01), [D-02](docs/decisiones.md#d-02)).
- **Una LIMIT ya no confirma un movimiento que la MARKET rechaza por el tope de cash** ([#73](https://github.com/dante0x95/cocos-challenge-a/pull/73)): con un cash heredado fuera de ±10¹⁵ ARS, el executor validaba solo el borde de arriba en una venta y nada en una compra, y ejecutaba lo que `POST /orders` como MARKET responde `422 LIMIT`. Ahora cancela esa LIMIT con `cancel_reason: "LIMIT"`, igual que cualquier otra que violaría [D-14](docs/decisiones.md#d-14). Solo afecta a historias heredadas.
- **Un usuario con la historia fuera de los tipos recibe `409`, no `500` para siempre** ([#62](https://github.com/dante0x95/cocos-challenge-a/pull/62)): si su historia heredada no entra en los tipos del cálculo (`overflow` en el log del bootstrap), `GET /portfolio` y `POST /orders` responden `409 HISTORY_OVERFLOW` y dicen que no se reintenta; consultar y cancelar sus órdenes sigue andando. El executor lo informa en `overflow_users` y deja sus LIMIT pendientes, en vez de anotarlas en `errors` en cada corrida. La reserva del portfolio ya no responde `500` cuando las pendientes heredadas suman más que un `bigint`.

### Proceso

- **`ready-gate` vuelve a devolver a borrador un PR marcado ready sin `codex/review`** ([#59](https://github.com/dante0x95/cocos-challenge-a/pull/59)): el `GITHUB_TOKEN` del workflow no podía convertirlo ("Resource not accessible by integration") porque `convertPullRequestToDraft` exige `contents: write` además de `pull-requests: write`. El merge ya lo frenaba el ruleset; ahora también vuelve a valer la regla de CONTRIBUTING.

### Documentación

- **Los comandos del servidor funcionan en zsh** ([#55](https://github.com/dante0x95/cocos-challenge-a/pull/55)): `docs/api/operacion.md` y el README llaman `LIGHTSAIL_HOST` a la IP del servidor y la escriben `${LIGHTSAIL_HOST}`: en zsh, `HOST` ya existe (el nombre de la Mac), así que si no se definía los comandos apuntaban en silencio a la propia máquina, y `$HOST:c` se comía los dos puntos del `scp`, que copiaba en local. La clave de Lightsail queda como marcador. v0.2.0 queda con su fecha.
- **Qué pasó con las claves de v0.1.0 al rechazar `amount: 1000.0`, y la regla para la próxima vez** ([#71](https://github.com/dante0x95/cocos-challenge-a/pull/71)): en las 24 h siguientes a v0.2.0, el reintento de una clave de v0.1.0 con un número decimal recibía `400` en vez del replay; mandándolo como string se obtiene el replay ([D-13](docs/decisiones.md#d-13), [D-19](docs/decisiones.md#d-19)). Una validación que rechace algo que la versión anterior aceptaba primero reconoce la clave existente, o rechaza antes recién 24 h + 1 min después ([D-19](docs/decisiones.md#d-19), CONTRIBUTING).
- **La comparación del benchmark Z / A / C, en una página para presentar** ([#77](https://github.com/dante0x95/cocos-challenge-a/pull/77)): [`docs/comparaciones.md`](docs/comparaciones.md) resume las tres variantes, el dataset, los escenarios con su criterio de éxito, los p99 por escenario y RPS, el calentamiento de C y por qué se entrega A y cuándo C. No agrega mediciones: los números son los del benchmark de [`decision-snapshot.md`](docs/decision-snapshot.md).

## v0.2.0 — 2026-10-31

### Antes de publicar

1. **Volver a correr `setup.sh` en el servidor** (por [#50](https://github.com/dante0x95/cocos-challenge-a/pull/50)): migra los secretos de cada entorno de `db.env`, `migrate.env` y `api.env` a los archivos de `secrets/`, con los mismos valores. Los comandos y lo que tiene que imprimir, en [Secretos como archivos](docs/api/operacion.md#secretos-como-archivos), paso 1. Sin esto, el deploy frena en `Release que atiende` sin cambiar nada.
2. Después de publicar: verificar que `docker inspect` no muestra ningún secreto (paso 3 de esa misma sección). Los `.env` se borran recién después del segundo release con #50 (paso 4).

El smoke de staging ([#52](https://github.com/dante0x95/cocos-challenge-a/pull/52)) no pide nada en el servidor: su usuario lo crea el propio deploy de staging la primera vez.

### Operación y deploy

- **Un smoke funcional antes de producción** ([#52](https://github.com/dante0x95/cocos-challenge-a/pull/52)): después de cambiar de versión y de `/health`, staging corre el flujo de órdenes por la URL pública (depósito y replay, compras y ventas `MARKET` por `size` y por `amount`, una LIMIT que reserva y se cancela, retiro, portfolio exacto, búsqueda y los `400`) con un usuario que existe solo en staging (`smoke@staging.invalid`); si falla, staging vuelve a la versión anterior y producción no se despliega. Producción corre solo lecturas. El CI corre el mismo smoke contra la imagen de cada PR, levantada con Docker Compose como en el deploy.
- **Los secretos llegan como archivos, no como variables de entorno** ([#50](https://github.com/dante0x95/cocos-challenge-a/pull/50)): la contraseña de la base, la del rol `api` y el token interno ya no aparecen en `docker inspect` ni en el entorno de ningún proceso. La app acepta `<VAR>_FILE` (`DATABASE_URL_FILE`, `INTERNAL_TOKEN_FILE`, `DATABASE_ADMIN_URL_FILE`, …). El primer deploy recrea la base de cada entorno (el volumen sigue): la API anterior puede responder `503` reintentables unos segundos.
- **Un release ya no puede dejar sin escribir a la versión que atiende** ([#47](https://github.com/dante0x95/cocos-challenge-a/pull/47)): el bootstrap aborta, sin cambiar la base, si una función que llama la versión anterior deja de resolver; el CI corre las pruebas de escritura del release anterior sobre la base nueva. Un cambio de firma va en dos releases (expand/contract, [D-24](docs/decisiones.md#d-24)).
- **Una LIMIT heredada por encima del tope no se ejecuta** ([#44](https://github.com/dante0x95/cocos-challenge-a/pull/44)): una `NEW` con importe mayor a 10¹⁵ ARS la cancela el executor, o el bootstrap al migrar una base, con `cancel_reason = 'LIMIT'`, y el log lo informa.

### API

- **Ninguna entrada del cliente responde `500`** ([#46](https://github.com/dante0x95/cocos-challenge-a/pull/46)): un carácter de control en `q` o en `Idempotency-Key`, un parámetro de ruta mal codificado (`/portfolio/%FF`) o un charset que no se soporta responden `400` (o `415`) con qué corregir.
- **Los números del body se validan por cómo están escritos** ([#43](https://github.com/dante0x95/cocos-challenge-a/pull/43)): `100.0`, `1e2` o un monto con decimales enviado como número JSON responden `400` y piden el valor como string, en vez de convertirse en silencio en otro monto.
- **Una clave de idempotencia se puede reutilizar recién desde 24 h + 1 min** ([#45](https://github.com/dante0x95/cocos-challenge-a/pull/45)): un reintento que empezó dentro de las 24 h siempre recibe la respuesta original, nunca un `422` falso.

### Documentación

- **Los docs al día después de v0.1.0** ([#48](https://github.com/dante0x95/cocos-challenge-a/pull/48)): cada suite con su fila en `docs/testing.md`, los errores que faltaban en `docs/api/orders.md`, el token interno sin imprimir la contraseña del rol `api`; un test frena una suite sin fila o un link al repositorio de la otra variante.
- **Este CHANGELOG** ([#52](https://github.com/dante0x95/cocos-challenge-a/pull/52)): la fuente de las notas de cada versión, con los pasos de operación que exige.

## v0.1.0 — 2026-10-30

Primera versión publicada, sobre `159b0f0`: la API de portfolio, búsqueda de instrumentos y órdenes (`MARKET`, `LIMIT`, depósitos y retiros, idempotencia, cancelación) sobre Postgres 18, con la lógica en PL/pgSQL. El deploy en AWS Lightsail al publicar un release `vX.Y.Z` ([#33](https://github.com/dante0x95/cocos-challenge-a/pull/33), [#35](https://github.com/dante0x95/cocos-challenge-a/pull/35)): gate, una imagen en GHCR por digest, staging y después producción, cada uno con su Postgres detrás de Caddy con HTTPS, el bootstrap antes de cambiar de versión, `/health` sobre el commit y la vuelta atrás si falla.

**Antes de publicar** (la primera vez): la clave de deploy, `setup.sh` en el servidor y los secretos `LIGHTSAIL_*` de los environments ([La primera vez](docs/api/operacion.md#la-primera-vez)).
