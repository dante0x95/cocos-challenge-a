# Lab: Z, A y C detrás de `/v1`, `/v2` y `/v3`

Un extra para mostrar con la API real lo que midió el benchmark ([`docs/decision-snapshot.md`](../docs/decision-snapshot.md)): las tres variantes sobre los mismos datos, ballenas incluidas, en una instancia de Lightsail aparte ([#72](https://github.com/dante0x95/cocos-challenge-a/issues/72)). La misma URL con otro prefijo compara las variantes:

```
https://<ip con guiones>.sslip.io/v1/portfolio/1002    Z
https://<ip con guiones>.sslip.io/v2/portfolio/1002    A
https://<ip con guiones>.sslip.io/v3/portfolio/1002    C
```

Nada de esto toca el entregable: el servidor de staging y producción, su imagen, su CI y `deploy/lightsail/` siguen igual. Todo vive en `lab/`, que la imagen no copia y que ningún workflow usa.

## Qué atiende cada prefijo

| Prefijo | Variante | Qué es |
|---|---|---|
| `/v1` | **Z**, la línea base | [`lab/z/server.ts`](z/server.ts): el esquema de `database.sql` tal cual (solo claves primarias y foráneas) y `SUM … GROUP BY` sobre `orders` en cada request, más una consulta de la última cotización por posición. Es la de `src/naive/` del benchmark, con los mismos endpoints de lectura que A (`/portfolio/:userid`, `/orders/:id?userid=`, `/instruments?q=`), el mismo JSON y los mismos `400`. |
| `/v2` | **A**, el entregable | La imagen del release (`ghcr.io/dante0x95/cocos-challenge-a:v0.2.0`) tal cual, con su bootstrap y la configuración del entregable. |
| `/v3` | **C**, snapshot + delta | La misma imagen de A sobre una base con [`lab/c/snapshot.sql`](c/snapshot.sql): una caché del balance por usuario, publicada con el fold completo de A (`app.c_state_full`); la lectura parte del snapshot y aplica las órdenes ejecutadas después (`app.c_state`). Se republica cuando el delta llega a `K = 500`. Los snapshots se calientan después de la carga, antes de atender. |

El lab es de solo lectura: el proxy responde `403` a todo lo que no es `GET` o `HEAD`, en los tres prefijos (crear y cancelar órdenes, `/internal`), antes de llegar a una API. Las tres bases quedan con el mismo dataset para siempre, y la imagen de A no se toca.

**Qué coincide** ([decisión en #72](https://github.com/dante0x95/cocos-challenge-a/issues/72#issuecomment-6571338025)). Para cualquier usuario, `/v2` y `/v3` responden el mismo JSON, y los dos coinciden con el oráculo de los tests (`test/oracle/fold.ts`). `/v1` coincide con ellos en cash, cantidades, reservas, precio, valor y valor total, pero no en `costo_total`, `costo_unitario`, `resultado` ni `rendimiento_pct` cuando hubo ventas: Z calcula el costo como el promedio de todas las compras (Σ importes de compra / Σ acciones compradas × cantidad), que es el error que el fold de A corrige ([D-09](../docs/decisiones.md#d-09)). Tampoco podría hacer otra cosa: `database.sql` no guarda el orden de ejecución (`balance_seq`, [D-18](../docs/decisiones.md#d-18)), y el 12 % de las órdenes ejecutadas del dataset son LIMIT ejecutadas días después de crearse. Es la vara, no una alternativa.

**Z calcula con `numeric`.** El Z del benchmark usaba `Number`; el del lab hace las cuentas en Postgres y devuelve strings exactos, como A ([D-13](../docs/decisiones.md#d-13)), así que sus importes se comparan exactos y la única diferencia con A es la de método. La lentitud no cambia: viene del esquema sin índices. `round()` de Postgres redondea los empates hacia afuera (A, half-even): `retorno_diario_pct`, el único campo redondeado que se compara con A, daría distinto solo en un empate exacto, y en los usuarios que compara `check.ts` no hay ninguno.

## Datos

El generador del benchmark, con seed fija: el mismo resultado en cada corrida y en cada máquina ([`lab/data/generate.sh`](data/generate.sh)). 5.000 usuarios con las cohortes del benchmark (80 % alrededor de 50 órdenes ejecutadas, 15 % alrededor de 500, 4 % alrededor de 2.000, 1 % alrededor de 5.000) y 3 ballenas, las más cerca de 150.000 de las 10 que crea el generador: **1002** (161.882), **1003** (128.671) y **1005** (169.693). 1.000 instrumentos con 5 años de cotizaciones diarias. En total, 1.967.228 órdenes (1.794.778 ejecutadas) por base, más los datos de ejemplo de `database.sql`.

Las tres bases se cargan desde los mismos archivos ([`lab/load/load.sh`](load/load.sh)): `manifest.json` lleva el sha256 de cada uno, y cada base guarda el del dataset que cargó (`public.lab_dataset`). Una base ya cargada no se vuelve a cargar, y una con otro dataset no arranca: se borra con `LAB_RESET=1`. En A y C, `app.verify_ledger()` tiene que dar vacío para los usuarios del dataset; en C, después de calentar, snapshot + delta tiene que dar lo mismo que el fold completo para todos los usuarios.

Mientras el generador no esté en este repo (#70), se usa el del benchmark: `LAB_GENERATOR` es la ruta a su `bench/gen/generate.ts`.

## Memoria

Todo entra en una instancia de 2 GB ([`lab/compose.yml`](compose.yml)): tres Postgres 18 de 360 MB (`shared_buffers` 128 MB, 20 conexiones), tres APIs de 160 MB (pool de 5) y Caddy en 64 MB, unos 1,6 GB. `setup.sh` agrega 2 GB de swap como margen para la carga.

## Probarlo en local

Con Docker, sin la instancia ([`lab/e2e.sh`](e2e.sh)): construye la imagen de A con el Dockerfile del tag `v0.2.0` (la de GHCR es privada), genera el dataset si falta, levanta todo en el proyecto `cocos-lab-e2e` (puerto 8072), corre [`lab/check.ts`](check.ts) y lo baja con sus volúmenes. Tarda unos 6 minutos; `KEEP=1` lo deja levantado.

```bash
LAB_GENERATOR=~/Documents/cocos/bench/gen/generate.ts lab/e2e.sh
```

`check.ts` pide a las tres variantes el portfolio de las 3 ballenas y de 3 usuarios de cada cohorte, seis veces cada uno, y falla si algo de lo de arriba no coincide o si alguna de las seis no responde `200` con el mismo cuerpo que la primera. También: un usuario inexistente da `404` y un id inválido `400` en las tres; `GET /orders/:id` coincide; `/instruments` responde igual en `/v2` y `/v3`, y `/v1` encuentra exactamente lo que da su definición (q como texto en ticker o nombre, sin acentos ni trigramas, que son de A; `%` y `_` también como texto), calculado desde los instrumentos de `database.sql` y del dataset; las entradas inválidas (`q` vacía o de más de 50, un carácter de control, `limit` fuera de rango) dan `400` en las tres; y crear, cancelar, `/internal` y `PUT`/`PATCH`/`DELETE` dan `403` en las tres sin cambiar el portfolio. Después, `e2e.sh` vuelve a levantar el lab sin borrar las bases, como un redeploy: ninguna se recarga, C vuelve a tener su `c_state` sobre el que reinstaló el bootstrap, y `check.ts` vuelve a pasar. Lo que midió en una Mac con Apple Silicon (milisegundos, la mediana de 5 requests seguidas):

| `GET /portfolio/<id>` | Z (`/v1`) | A (`/v2`) | C (`/v3`) |
|---|---|---|---|
| ballena 1002 (161.882 ejecutadas) | 4.120 | 686 | 16 |
| ballena 1003 (128.671) | 4.192 | 530 | 11 |
| ballena 1005 (169.693) | 4.074 | 701 | 10 |
| usuario típico (1010, cohorte de 50) | 578 | 4,9 | 4,5 |
| cohorte de 5.000 (1538) | 554 | 15 | 5,5 |

Los de la instancia se anotan junto a la tabla del benchmark después del primer deploy.

## La instancia: lo que se hace en la consola de Lightsail

Una vez, antes del primer deploy:

1. **Create instance**: Linux/Unix, **Ubuntu 24.04 LTS**, el plan de **2 GB** de RAM (2 vCPU). En la misma región que se quiera; un nombre como `cocos-lab`.
2. **Networking → Create static IP**, asociada a esa instancia. Esa IP es `LIGHTSAIL_LAB_HOST`.
3. **Networking → IPv4 Firewall**: dejar SSH (22) y agregar **HTTP (80)** y **HTTPS (443)**. Caddy pide el certificado de `<ip con guiones>.sslip.io` por esos dos puertos.
4. **Account → SSH keys**: bajar la clave por defecto de la región y guardarla, por ejemplo, en `~/.ssh/cocos-lab.pem`, con `chmod 600`. Esa ruta es `LIGHTSAIL_LAB_KEY`.

La primera conexión SSH pide aceptar la huella de la instancia: compararla antes con la que muestra `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` en **Connect using SSH** (la terminal del navegador).

## Desplegar

Desde la raíz del repo, en la Mac, con `pnpm install` hecho. Los bloques no llevan comentarios: en zsh interactivo (la terminal de macOS) un `#` después de un comando no es un comentario. Reemplazar la IP y la ruta de la clave:

```bash
LIGHTSAIL_LAB_HOST=203.0.113.10
LIGHTSAIL_LAB_KEY=~/.ssh/cocos-lab.pem
LAB_GENERATOR=~/Documents/cocos/bench/gen/generate.ts
export LIGHTSAIL_LAB_HOST LIGHTSAIL_LAB_KEY LAB_GENERATOR
```

La imagen de A se baja en la Mac y se copia a la instancia, así la instancia no necesita credenciales de GHCR. Para bajarla, `docker login` con un token que pueda leer paquetes (una vez):

```bash
gh auth refresh -s read:packages
gh auth token | docker login ghcr.io -u dante0x95 --password-stdin
```

Preparar la instancia (una vez; es idempotente): Docker y compose de los paquetes de Ubuntu, 2 GB de swap y `/opt/cocos-lab` con las contraseñas de las bases, generadas ahí y nunca impresas ([`lab/remote/setup.sh`](remote/setup.sh)).

```bash
lab/deploy.sh setup
```

Desplegar el commit actual ([`lab/deploy.sh`](deploy.sh)): copia el código (solo lo versionado en `HEAD`, con `git archive`), el dataset si la instancia tiene otro y la imagen de A si no la tiene; levanta `lab/compose.yml` como el proyecto `cocos-lab`, espera a que las tres bases estén cargadas y C caliente, y corre `lab/check.ts` contra la URL pública. La primera vez tarda unos minutos: copia unos 120 MB de datos y la imagen, construye la de Z y carga las tres bases.

```bash
lab/deploy.sh
```

Otras variables: `LAB_A_VERSION` elige el release de A (por defecto `v0.2.0`), `LAB_SITE=:80` sirve HTTP solo por la IP en vez de HTTPS por sslip.io, y `LAB_RESET=1` borra las tres bases antes de levantar (hace falta si cambió el dataset).

## Operación

- **Verificar lo que atiende**, sin desplegar: `lab/deploy.sh check`.
- **Logs y estado**, en la instancia: `ssh -i "$LIGHTSAIL_LAB_KEY" "ubuntu@${LIGHTSAIL_LAB_HOST}"` y, en `/opt/cocos-lab`, `docker compose -p cocos-lab --project-directory src/lab -f src/lab/compose.yml --env-file secrets.env --env-file deploy.env ps` (o `logs load-c`, `logs api-z`). `deploy.env` dice qué commit, qué imagen de A y qué sitio atiende.
- **Si no levanta**, `deploy.sh` muestra el estado y los logs de la carga. La carga de cada base es una transacción (con la verificación y la marca del dataset adentro): si se corta o falla no queda nada, y el deploy siguiente la vuelve a intentar.
- **Apagarlo**: desde la consola, parando la instancia (la IP estática se conserva), o borrándola junto con la IP estática si ya no se usa.
