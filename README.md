# Cocos challenge — API de portfolio, búsqueda de activos y órdenes

API en Node.js + Express + PostgreSQL que resuelve el [challenge de backend](https://github.com/cocoscap/cocos-challenge/blob/main/backend-challenge.md):

| Endpoint | |
|---|---|
| `GET /portfolio/:userid` | Valor total de la cuenta, pesos disponibles para operar y activos con cantidad, valor en $ y rendimiento en % — [contrato](docs/api/portfolio.md) |
| `GET /instruments?q=` | Búsqueda de activos por ticker y/o nombre — [contrato](docs/api/instruments.md) |
| `POST /orders` | Orden MARKET o LIMIT, por cantidad de acciones o por monto en pesos; también depósitos y retiros — [contrato](docs/api/orders.md) |
| `GET /orders/:id?userid=` · `POST /orders/:id/cancel` | Consulta de una orden propia y cancelación de una orden `NEW` — [contrato](docs/api/orders.md) |
| `GET /health` · `/internal/*` | Salud y operación (executor de LIMIT, limpieza de idempotencia) — [contrato](docs/api/operacion.md) |

## Correr

```bash
docker compose up --build
curl -s localhost:3000/portfolio/1
```

Levanta Postgres 18, corre el bootstrap (carga el `database.sql` del challenge, migra, instala funciones y verifica) y arranca la API en `:3000` cuando todo terminó bien.

Para operar a mano está [`rest-client/cocos.http`](rest-client/cocos.http) (extensión REST Client de VS Code), con un request por caso: depósito, replay, compra por cantidad y por monto, LIMIT, cancelación, venta rechazada y errores.

**Sin Docker para la API** (con un Postgres propio):

```bash
pnpm install
cp .env.example .env            # ajustar las URLs
export $(grep -v '^#' .env | xargs)
pnpm db:bootstrap
pnpm dev
```

## Pruebas

```bash
docker compose up -d db         # basta con la base
pnpm install
pnpm test
```

Crean su propia base `cocos_test` con el mismo bootstrap que producción. Las suites: unitarias, el test funcional de órdenes por HTTP, invariantes de la base, concurrencia con dos conexiones reales, propiedad contra un oráculo independiente y bootstrap. Qué demuestra cada una: [`docs/testing.md`](docs/testing.md).

El CI las corre en cada PR contra Postgres 18. Flujo de trabajo, formato de commits y revisión de Codex: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Cómo está hecho, en cinco ideas

1. **`orders` es la única fuente de verdad.** El balance se calcula a partir de las órdenes `FILLED` en cada request, como pide el enunciado; no hay tabla de saldos. Un índice parcial por usuario lo hace barato: 3 ms por lectura y p99 ≤ 26 ms a 400 req/s en un benchmark sobre 22 millones de órdenes. El mismo benchmark midió dónde deja de alcanzar (usuarios con más de 100.000 órdenes) y qué lo resolvería; ese perfil no está en el dataset. → [D-16](docs/decisiones.md#d-16), [`docs/decision-snapshot.md`](docs/decision-snapshot.md)
2. **La base impone el protocolo de escritura.** Cada orden pasa por una función de Postgres que toma un lock por usuario, lee, decide y escribe en una transacción. El rol de la API no puede escribir ninguna tabla. Así no hay doble gasto posible, y una prueba lo demuestra en las dos direcciones. → [D-17](docs/decisiones.md#d-17)
3. **Dinero en enteros.** Centavos y micro-pesos en la base, `BigInt` en Node, strings en JSON. Nunca `Number`. → [D-09](docs/decisiones.md#d-09), [D-13](docs/decisiones.md#d-13)
4. **Idempotencia obligatoria en `POST /orders`.** Un reintento con la misma clave devuelve la misma respuesta sin crear otra orden. → [D-19](docs/decisiones.md#d-19)
5. **Un comando levanta todo.** Migraciones versionadas, funciones repetibles y verificación de la historia antes de aceptar tráfico, con la API viva durante el despliegue. → [D-23](docs/decisiones.md#d-23), [D-24](docs/decisiones.md#d-24)

## Suposiciones y decisiones

Todas, con su porqué y lo que se descartó, en [`docs/decisiones.md`](docs/decisiones.md). Las que más cambian lo que se ve:

- **La historia recibida tiene una venta sin tenencia** (usuario 1, BMA: compra 20 y vende 30). Se muestra la posición real (−10), sin costo ni rendimiento, y marcada con `inconsistent`; el portfolio lleva `has_inconsistent_history`. Se consultó con los autores del challenge. → [D-01](docs/decisiones.md#d-01) a [D-03](docs/decisiones.md#d-03)
- **"Rendimiento total" = resultado no realizado sobre el costo promedio de compra.** Se agrega `resultado` en pesos y el retorno diario con `previousClose`. → [D-10](docs/decisiones.md#d-10)
- **Las órdenes LIMIT reservan** pesos o acciones mientras están `NEW`. → [D-08](docs/decisiones.md#d-08)
- **Cotizaciones sin límite de antigüedad por defecto**, porque las del challenge son de 2023. Configurable a 7 días. → [D-06](docs/decisiones.md#d-06)
- **El cash se guarda en centavos** (`size` = centavos, `price` = 0.01) para admitir montos con centavos. → [D-05](docs/decisiones.md#d-05)
- **No se simula el mercado:** las LIMIT se ejecutan solo si se llama al executor interno. → [D-28](docs/decisiones.md#d-28)

## Cambios al esquema del challenge

Todos en [`db/migrations`](db/migrations), justificados en cada archivo y en las decisiones:

| Cambio | Por qué |
|---|---|
| Tablas al esquema `app`, roles `app_owner` / `api` | Privilegios en un solo lugar; la API no puede escribir ([D-17](docs/decisiones.md#d-17)) |
| Cash en centavos | Montos con centavos con una sola fórmula de importe ([D-05](docs/decisiones.md#d-05)) |
| Columna `orders.balance_seq` | Orden de ejecución, distinto del de creación ([D-18](docs/decisiones.md#d-18)) |
| Columna `orders.cancel_reason` | Por qué se canceló una orden: el usuario o el tope de [D-14](docs/decisiones.md#d-14) |
| `NOT NULL`, `CHECK`s, trigger de inmutabilidad | La base rechaza estados imposibles, aunque alguien escriba sin pasar por la API |
| Índices parciales por usuario y estado | Leer la historia de un usuario sin recorrer la tabla (de 3–4 s a 3 ms por lectura en el benchmark) |
| `marketdata`: una cotización por instrumento y día | El "último precio" queda bien definido ([D-07](docs/decisiones.md#d-07)) |
| `idempotency_keys`, `settings` | Idempotencia y configuración ([D-19](docs/decisiones.md#d-19), [D-06](docs/decisiones.md#d-06)) |

## Estructura

```
db/
  migrations/     000 seed del challenge (sin modificar) · 001 esquema y roles · 002 auditoría
                  003 libro de órdenes · 005 motivo de cancelación — corren una vez
  functions/      010 base · 020 balance · 030 órdenes · 040 operación · 090 privilegios — repetibles
src/
  db/             pool (una sentencia por escritura) · bootstrap (migraciones, funciones, verificación)
  domain/         dinero en BigInt · armado del portfolio · validación de órdenes
  repositories/   una función por operación de base
  routes/         HTTP: validan, llaman al repositorio, responden
  http/           errores (SQLSTATE → HTTP) y log por request
  jobs/           limpieza periódica de claves de idempotencia
test/             unit · db · concurrency · property · bootstrap · oracle (fold independiente)
docs/             decisiones · benchmark del balance · pruebas · contratos de la API
rest-client/      colección de requests
```

## Fuera de alcance

Resultado realizado de ventas pasadas, liquidación T+1, ejecuciones parciales, comisiones, vencimiento de órdenes `NEW` y autenticación. El detalle y cómo se agregaría cada uno está en [Fuera de alcance](docs/decisiones.md#fuera-de-alcance).
