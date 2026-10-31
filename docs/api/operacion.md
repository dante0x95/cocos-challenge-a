# Salud y operación

## `GET /health`

```json
{ "ok": true, "db": "up", "release": "de01a01a…", "users": "4" }
```

- `release` es el commit desplegado (variable `RELEASE`, la fija el deploy); `null` si no está configurada, como en `docker compose`.
- Si la base no responde, `503` con `{ "ok": false, "db": "down", "release": … }`: `release` va igual, para saber qué commit atiende.

Lo usan el healthcheck de docker compose (también en el servidor, antes de dar por buena la API nueva) y el workflow de deploy, por la URL pública, después de cambiar de versión ([D-29](../decisiones.md#d-29)).

## `/internal/*`

Requieren la cabecera `X-Internal-Token` con el valor de `INTERNAL_TOKEN` (`401` si no coincide). Si `INTERNAL_TOKEN` no está configurado, estas rutas no existen (`404`). Todos son `POST` y son idempotentes.

| Ruta | Qué hace |
|---|---|
| `/internal/execute-limits` | Ejecuta las LIMIT `NEW` que la cotización vigente cruza, a su precio límite. Cada una en su transacción; la decisión final la toma `app.execute_limit_outcome`, bajo el lock ([D-28](../decisiones.md#d-28)). Parámetros en la query string, todos opcionales: `max` (tamaño del lote, 1–10000, por defecto 500), `per_user` (a lo sumo N órdenes por usuario por corrida, 1–10000, por defecto 50), `after_id` (cursor: solo órdenes con id mayor; por defecto 0) y `max_ms` (presupuesto de la corrida, 1–600000, por defecto 10000). Un valor que no es un entero sin signo, repetido o un parámetro desconocido → `400`. Responde `{ candidates, executed, not_crossed, cancelled, errors, skipped_users, skipped_instruments, after_id, remaining }`: `cancelled` lista `{ order_id, reason }` de las que el executor canceló en vez de ejecutar: `reason: "LIMIT"`, porque ejecutarlas violaría los límites de [D-14](../decisiones.md#d-14); `reason: "UNBACKED"`, porque no tenían respaldo (venta sin las acciones, compra sin el cash: solo una orden heredada de una base preexistente, [D-12](../decisiones.md#d-12)). Esas órdenes quedan con ese mismo `cancel_reason`; `skipped_users`, los usuarios cuyo lock no se consiguió (`55P03`), y `skipped_instruments`, los instrumentos que se quedaron sin cotización válida entre la selección y la ejecución (`APP01`): sus demás órdenes del lote no se intentaron y no están en `errors`; `after_id` es el cursor para la corrida siguiente (`null` solo cuando el lote se agotó: la próxima empieza de cero; si el presupuesto venció antes de procesar ninguna, es el mismo cursor recibido, también `"0"`); `remaining`, cuántas candidatas del lote no se intentaron porque venció `max_ms`. |
| `/internal/cleanup-idempotency` | Borra las claves de idempotencia que `app.place_order` ya puede reclamar desde hace más de un minuto (más viejas que `settings.idempotency_ttl`, 24 h, más dos minutos: el minuto en que `place_order` todavía no las reclama y uno de margen para los requests en curso). Solo recupera espacio: el vencimiento lo decide `app.place_order` al reclamar la clave, así que una clave reclamable que el job todavía no borró ya no da replay ni `422` ([D-19](../decisiones.md#d-19)). |

Recorrer todas las pendientes:

```bash
curl -s -X POST -H "X-Internal-Token: $INTERNAL_TOKEN" 'http://localhost:3000/internal/execute-limits?max=500&max_ms=10000'
# → { ..., "after_id": "1234", "remaining": 0 }: repetir con ?after_id=1234 hasta que after_id sea null
```

## Cuando la base se reinicia

Un reinicio de Postgres (mantenimiento, failover, `pg_terminate_backend`) corta todas las conexiones del pool. Las ociosas se descartan solas (el pool recibe el evento `error`, lo registra con `scope: "pg-pool-idle"` y sigue); la siguiente request abre una conexión nueva. Este listener protege solo a las conexiones ociosas. Una request cuya consulta estaba en vuelo recibe el error de la conexión cortada y responde `503 CONNECTION_LOST` con `Retry-After` ([errores de `POST /orders`](orders.md#errores)): su resultado es desconocido (la escritura pudo confirmarse) y `POST /orders` se reintenta con la misma `Idempotency-Key`, que devuelve la orden si existe ([D-20](../decisiones.md#d-20)). El proceso no se reinicia. `GET /health` responde `503` con `db: "down"` mientras la base no contesta y vuelve a `200` sola.

## Jobs periódicos

Con `JOBS_ENABLED=true` (activo en docker compose y en el servidor), la API corre la limpieza de idempotencia cada hora (`CLEANUP_EVERY_MS`). Cada usuario se procesa en su propia transacción y con try-lock, así que nunca bloquea escrituras; que dos procesos la corran a la vez solo duplica trabajo. Con `JOBS_ENABLED=false` las claves vencidas se acumulan hasta que alguien llame a `/internal/cleanup-idempotency`, pero vencen igual: la limpieza no es parte de la regla de negocio. En producción iría a un worker aparte.

El executor de LIMIT no tiene job ([D-28](../decisiones.md#d-28)): en producción lo llamaría un cron externo cada N minutos, con `POST /internal/execute-limits` y el token ([D-29](../decisiones.md#d-29)).

## Desplegar un cambio en las funciones

```bash
pnpm db:bootstrap      # o: docker compose run --rm migrate
```

Aplica las migraciones pendientes y reaplica `db/functions` en una sola transacción, con la barrera de despliegue: se puede correr con la API activa; las escrituras esperan hasta el `COMMIT` (o responden `503` y se reintentan) y, si algo falla, no queda nada aplicado. Una migración nueva va en un archivo nuevo de `db/migrations`; nunca se edita una ya aplicada ([D-24](../decisiones.md#d-24)). Si aplicó alguna, verifica la historia: un corto heredado ([D-01](../decisiones.md#d-01)) o una historia fuera de los tipos ([D-14](../decisiones.md#d-14)) se informan, y una LIMIT `NEW` sin respaldo se cancela con `cancel_reason: "UNBACKED"` y se informa en el log (`historia: usuario N — reserva: …`, `orden N cancelada`), bajo el lock de ese usuario ([D-24](../decisiones.md#d-24)). Solo un cash que no cierra aborta el despliegue.

En el servidor lo corre cada deploy, con la imagen nueva y antes de cambiar de versión: si falla, sale con 1 y el deploy se corta sin cambiar nada ([D-29](../decisiones.md#d-29)).

## Desplegar en Lightsail

Se despliega al **publicar una versión**: un GitHub Release con tag `vX.Y.Z` sobre un commit de `main` con el check `ci` en verde (`.github/workflows/deploy.yml`, [D-29](../decisiones.md#d-29)). Un merge a `main` corre solo el CI. Para publicar una versión, después de mergear:

1. Las notas de la versión están en [`CHANGELOG.md`](../../CHANGELOG.md), la fuente: una sección por versión con lo que cambia para quien usa u opera el sistema y, en **Antes de publicar**, los pasos de operación que esa versión exige (hacerlos antes del paso 2). El PR que cierra la versión la completa con todo lo que entró desde el tag anterior: `test/unit/changelog` exige que la sección "sin publicar" nombre cada PR mergeado desde el último tag. Después de publicar, el PR siguiente cambia "sin publicar" por la fecha y abre la sección de la versión que sigue (si no, ese test frena el CI).
2. Publicar el release. `--generate-notes` agrega la lista de PRs de GitHub; el texto del release puede ser la sección del CHANGELOG (`--notes-file` con esa sección), o el link a ella.

```bash
gh release create vX.Y.Z --target main --generate-notes
```

`--target main` toma el último commit de `main`. Para publicar uno anterior que también esté en `main`, su SHA en lugar de `main`. Lo que pasa después, en cuatro etapas:

1. **gate**: el tag es `vX.Y.Z` (sin sufijos: `v1.2.3-rc.1` no se despliega), apunta al commit del release, ese commit está en `main` y su `ci` terminó en verde (si todavía corre, espera hasta 20 minutos). Si no, el workflow queda en rojo con el motivo (`DEPLOY FRENADO: …`) y no se construye ni se despliega nada.
2. **image**: la imagen se construye una vez y se publica en GHCR con dos etiquetas, el SHA y la versión (`ghcr.io/dante0x95/cocos-challenge-a:vX.Y.Z`).
3. **staging** (`https://staging.18-227-203-30.sslip.io`) la despliega por digest, por SSH: el commit tiene que descender del release que atiende, baja la imagen, corre el bootstrap con la API anterior atendiendo, prepara el usuario del smoke, cambia la API, exige que `/health` atienda el commit y corre el smoke funcional (`deploy/smoke.mjs write`: depósito y replay, compras y ventas `MARKET` por `size` y por `amount`, una LIMIT que reserva y se cancela, retiro, el portfolio exacto, la búsqueda y los `400`); si el cambio, `/health` o el smoke fallan, vuelve a la versión anterior.
4. **production** (`https://18-227-203-30.sslip.io`): lo mismo, con la misma imagen, solo si staging terminó en verde, y con el smoke de **solo lectura** (`deploy/smoke.mjs read`: `/health`, la búsqueda y dos `GET` inválidos): en producción no se escriben órdenes ni existe el usuario del smoke. No hay aprobación manual: publicar el release es la aprobación.

**El usuario del smoke** existe solo en staging: `smoke@staging.invalid`. Lo prepara cada deploy de staging (`deploy.sh smoke-user`, con `deploy/lightsail/smoke-user.sql` corrido como superusuario en la base de staging), sin nada que hacer en el servidor: la primera vez lo crea, y después lo reutiliza mientras el smoke lo haya dejado en cero. Si una corrida falló a la mitad y le quedó cash, una posición o una LIMIT `NEW`, lo retira (`smoke-retirado-<id>@staging.invalid`, con su historia para mirar qué pasó) y crea otro ([D-29](../decisiones.md#d-29)). Para ver sus órdenes: `GET /portfolio/<id>` en staging, con el id del log del paso `Usuario del smoke`.

Qué versión atiende cada entorno: Settings → Environments (el último deployment, con el tag) o `release` de `/health`, que es el SHA (`git tag --points-at <sha>`).

### La primera vez

Una sola vez, antes del primer release, desde la raíz del repo parado en `main`, con `gh` autenticado y la clave por defecto de la instancia que se baja de la consola de Lightsail (Account → SSH keys). Nada de esto lo hace el workflow.

**Ya se hizo** para este servidor, antes de v0.1.0. Para verificar que sigue preparado, sin cambiar nada:

```bash
ssh -i ~/.ssh/cocos-deploy -o IdentitiesOnly=yes deploy@18.227.203.30 docker ps   # la clave de deploy entra y lista Caddy y los entornos
for env in staging production; do gh secret list --env "$env"; done              # LIGHTSAIL_HOST, LIGHTSAIL_SSH_KEY y LIGHTSAIL_KNOWN_HOSTS en cada uno
```

```bash
git switch main && git pull
HOST=18.227.203.30
LIGHTSAIL_KEY=~/.ssh/LightsailDefaultKey-us-east-2.pem
```

La primera conexión SSH a la instancia (el primer comando del paso 2) pide aceptar la huella de la clave del host. Antes de aceptarla, compararla con la que muestra `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` en la consola de Lightsail (Connect using SSH, en el navegador): el paso 3 lee la clave del host por esa conexión y la fija en Actions, así que una huella aceptada sin verificar es la que el deploy va a dar por buena.

1. La clave de deploy, dedicada: sin passphrase, porque la usa GitHub Actions.

```bash
ssh-keygen -t ed25519 -N '' -C cocos-deploy -f ~/.ssh/cocos-deploy
```

2. Preparar el servidor con [`deploy/lightsail/setup.sh`](../../deploy/lightsail/setup.sh): el usuario `deploy` con esa clave, los secretos de cada entorno (generados en el servidor, sin imprimirse, un archivo cada uno en `/opt/cocos/<entorno>/secrets`) y Caddy. Es idempotente: volver a correrlo no cambia los secretos, actualiza el proxy y, con otra clave, la reemplaza.

```bash
ssh -i "$LIGHTSAIL_KEY" "ubuntu@$HOST" rm -rf cocos-setup
scp -i "$LIGHTSAIL_KEY" -r deploy/lightsail "ubuntu@$HOST:cocos-setup"
ssh -i "$LIGHTSAIL_KEY" "ubuntu@$HOST" "sudo bash cocos-setup/setup.sh '$(cat ~/.ssh/cocos-deploy.pub)'"
ssh -i ~/.ssh/cocos-deploy -o IdentitiesOnly=yes "deploy@$HOST" docker ps
```

El primero borra una copia anterior (con una copia ya en el servidor, `scp -r` copiaría adentro de ella). El último prueba la clave de deploy: tiene que listar el contenedor de Caddy.

3. La clave del host, leída por la conexión que ya es de confianza (la de la clave por defecto), para fijarla en Actions:

```bash
KNOWN="$HOST $(ssh -i "$LIGHTSAIL_KEY" "ubuntu@$HOST" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)"
```

4. Los secretos de los environments `staging` y `production` (los mismos en los dos: es un solo servidor):

```bash
for env in staging production; do
  gh secret set LIGHTSAIL_HOST --env "$env" --body "$HOST"
  gh secret set LIGHTSAIL_SSH_KEY --env "$env" < ~/.ssh/cocos-deploy
  gh secret set LIGHTSAIL_KNOWN_HOSTS --env "$env" --body "$KNOWN"
done
```

5. Los dos environments solo aceptan deploys de tags `v*` (deployment branch policy). Con el plan Pro y el repo privado, `production` no puede tener reviewers obligatorios: publicar el release es la aprobación.

```bash
for env in staging production; do
  gh api -X PUT "repos/dante0x95/cocos-challenge-a/environments/$env" --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  gh api -X POST "repos/dante0x95/cocos-challenge-a/environments/$env/deployment-branch-policies" -f name='v*' -f type=tag
done
```

6. El primer release, y el ensayo que verifica que llegó:

```bash
gh release create v0.1.0 --target main --generate-notes
deploy/drills.sh release v0.1.0
```

El primer deploy de cada entorno no tiene release anterior: el gate de ancestría lo deja pasar, y si falla, la API sale y el entorno queda vacío hasta el próximo release. El primer `/health` tarda unos segundos más: Caddy pide el certificado de cada nombre. El paquete de GHCR puede quedar privado: cada deploy baja la imagen con el token de su job.

### Secretos como archivos

Desde [#36](https://github.com/dante0x95/cocos-challenge-a/issues/36) los secretos no llegan a los contenedores como variables de entorno (las muestra `docker inspect`): son archivos de `/opt/cocos/<entorno>/secrets/`, uno por secreto, que compose monta en `/run/secrets/` solo en el servicio que los usa ([D-29](../decisiones.md#d-29)). `postgres_password` queda 600 y los otros cuatro 640 con el grupo 1000, el de `node` en la imagen: así los lee la API.

Un servidor preparado antes de #36 tiene los secretos en `db.env`, `migrate.env` y `api.env`, y la base ya creada con esas contraseñas. Una sola vez, **antes de publicar el primer release que incluye #36**, desde la raíz del repo parado en `main` y con las variables de [La primera vez](#la-primera-vez):

1. Volver a correr `setup.sh` desde `main`, con la misma clave de deploy (los mismos comandos del paso 2 de arriba). Migra los `.env` de cada entorno a los archivos, con los mismos valores; no genera nada ni toca los `.env`. Tiene que decir, para los dos entornos, `secretos migrados de db.env, migrate.env y api.env, con los mismos valores`; si frena (un `.env` sin una variable, con una repetida o vacía), no escribió nada: corregir ese `.env` a mano y volver a correrlo.

```bash
ssh -i "$LIGHTSAIL_KEY" "ubuntu@$HOST" rm -rf cocos-setup
scp -i "$LIGHTSAIL_KEY" -r deploy/lightsail "ubuntu@$HOST:cocos-setup"
ssh -i "$LIGHTSAIL_KEY" "ubuntu@$HOST" "sudo bash cocos-setup/setup.sh '$(cat ~/.ssh/cocos-deploy.pub)'"
ssh -i ~/.ssh/cocos-deploy -o IdentitiesOnly=yes "deploy@$HOST" 'ls -ln /opt/cocos/staging/secrets /opt/cocos/production/secrets'
```

El último tiene que listar los cinco archivos de cada entorno: `postgres_password` con `-rw-------` y los demás con `-rw-r-----` y el grupo `1000`.

2. Publicar el release. Su deploy recrea la base de cada entorno (cambió su configuración; el volumen sigue y la contraseña ya no se usa: la base existe), con la API anterior atendiendo, que mientras tanto puede responder `503` reintentables ([cuando la base se reinicia](#cuando-la-base-se-reinicia)), y después la API. Si se publica sin el paso 1, el deploy frena en `Release que atiende` (`falta /opt/cocos/<entorno>/secrets/…: el servidor no está preparado`) sin cambiar nada: correr el paso 1 y volver a correr el workflow.

3. Verificar que `docker inspect` no muestra ningún secreto (tiene que imprimir `0`):

```bash
ssh -i ~/.ssh/cocos-deploy "deploy@$HOST" "docker inspect cocos-production-api-1 cocos-production-db-1 cocos-staging-api-1 cocos-staging-db-1 | grep -cE '(POSTGRES_PASSWORD|DATABASE_URL|DATABASE_ADMIN_URL|API_DB_PASSWORD|INTERNAL_TOKEN)='"
```

4. Los `.env` quedan para la vuelta atrás a un release anterior a #36, cuyo `compose.yml` todavía los usa con `env_file`. Se borran cuando ningún `compose*.yml` del entorno los usa (después del segundo release con #36, cuando `compose.previous.yml` también es de esta versión): si `grep -l env_file /opt/cocos/<entorno>/compose*.yml` no imprime nada, `rm /opt/cocos/<entorno>/{db,migrate,api}.env`. `setup.sh` no los vuelve a leer.

### Operación

- **Un deploy en rojo.** `gh run list --workflow deploy` y `gh run view <id> --log`. Si frenó en el job `gate`, el release no se puede desplegar (tag que no es `vX.Y.Z`, commit fuera de `main` o con `ci` en rojo; el log dice cuál): no se construyó nada, y la corrección es otro release. Si frenó en `Acceso SSH al servidor` o `Release que atiende`, faltan los secretos, el servidor no está preparado (`setup.sh`) o su `release.env` no dice qué atiende (el log lo nombra): se corrige a mano, nunca borrándolo, que lo haría pasar por un primer deploy. Si frenó en `El commit desciende del release actual`, el commit es anterior al que atiende (un re-run del deploy de un release viejo, por ejemplo): no cambió nada. Si falló `Bootstrap de la base`, no quedó nada aplicado y sigue la versión anterior; el log tiene el error del bootstrap. Si falló `Usuario del smoke` (solo staging), no cambió nada: el log tiene el error de psql. Si falló `Cambiar de versión`, `/health atiende el commit`, `Smoke funcional` (staging) o `Smoke de solo lectura` (producción), el paso `Volver a la versión anterior` devolvió la API a la imagen y el release de antes, y su log dice si `/health` atiende otra vez ese release. Si ese paso también falló, el entorno quedó como lo dejó el cambio: entrar al servidor y mirar `/opt/cocos/<entorno>` (`release.env`, `release.previous.env`) y `docker compose -p cocos-<entorno> ps`.
- **Re-desplegar** es volver a correr el workflow de ese release (`gh run rerun <id>`). Re-corre el gate, la construcción de la imagen (mismas etiquetas) y las dos etapas. Solo pasa si el release es el que atiende cada entorno o uno posterior: volver a una versión anterior no es un re-run (el gate de ancestría lo frena).
- **Staging en rojo, producción no**: el job `production` no corre (`needs: staging`); lo que atiende producción no cambia. Un deploy de staging con una migración nueva corre su bootstrap contra la base de staging antes de que esa migración llegue a producción.
- **En el servidor**: `ssh -i ~/.ssh/cocos-deploy deploy@18.227.203.30`, y cada entorno es un proyecto de compose en `/opt/cocos/<entorno>`: `docker compose -p cocos-production --project-directory /opt/cocos/production --env-file /opt/cocos/production/release.env logs api`. Las imágenes viejas se acumulan (la vuelta atrás usa la anterior): `docker image prune -a` borra las que ningún contenedor usa.
- **Ensayos** (a mano; no corren en el CI). `deploy/drills.sh`, con `gh` autenticado: el último release pasó por el workflow de deploy y `/health` lo atiende (`release [tag]`), y un re-run del deploy de un release viejo se frena en el gate (`rerun`); `URL` elige el entorno (por defecto, producción). `deploy/lightsail/drill-docker.sh`, con Docker en la máquina local y sin el servidor: `remote.sh` con imágenes rotas a propósito (un bootstrap que falla, una API cuyo `/health` responde `503`) tiene que rechazarlas y volver a la buena; conviene correrlo después de cambiar `remote.sh` o `compose.yml`. El smoke contra una imagen local, como en el CI: `docker build -t cocos:ci . && deploy/lightsail/smoke-docker.sh cocos:ci` (su propio proyecto, `cocos-smoke-staging`, y su propia red, `cocos-smoke-edge`: no toca un `cocos-edge` local; borra al terminar solo lo que creó). Contra un entorno, a mano: `URL=https://staging.18-227-203-30.sslip.io SHA=<release> deploy/smoke.mjs read` (`write` solo en staging, con `SMOKE_USERID`).
- **Token interno** para `/internal/*`, solo el token (el archivo tiene el token y nada más, sin salto final): `ssh -i ~/.ssh/cocos-deploy deploy@18.227.203.30 cat /opt/cocos/<entorno>/secrets/internal_token`, con `<entorno>` `staging` o `production`.

**Cambio de hash de idempotencia.** Si cambia cómo se calcula el hash de `POST /orders`, las claves vigentes (24 h) guardan el hash viejo y su reintento respondería `422`. El cambio tiene que aceptar también el hash anterior, solo para reconocer claves existentes y dentro de la misma llamada a `app.place_order`, hasta que vence la ventana; después se borra esa compatibilidad. Como el vencimiento lo decide `place_order` con `created_at`, la ventana termina 24 h + 1 min después del despliegue aunque la limpieza no haya corrido. Así se hizo al canonizar `amount` y `price` ([D-19](../decisiones.md#d-19)).

## Vencimiento de las claves de idempotencia

```sql
UPDATE app.settings SET idempotency_ttl = '12 hours';  -- por defecto: 24 h (D-19)
UPDATE app.settings SET idempotency_ttl = DEFAULT;
```

Es la única fuente del plazo (`app.idempotency_ttl()`), el del replay garantizado. De él salen los otros dos umbrales, con márgenes fijos de un minuto que cubren el `statement_timeout` de 5 s ([D-20](../decisiones.md#d-20)): `app.place_order` reclama una clave desde el plazo + 1 min (`app.idempotency_reclaim_age()`) y la limpieza la borra desde el plazo + 2 min (`app.idempotency_purge_age()`). Cambiarlo rige para la próxima transacción, también sobre las claves ya grabadas.

## Antigüedad máxima de una cotización

```sql
UPDATE app.settings SET price_max_age_days = 7;    -- recomendado en producción
UPDATE app.settings SET price_max_age_days = NULL; -- por defecto: sin límite (datos de 2023)
```
