# El enunciado, punto por punto

Cada requisito del [enunciado del challenge](https://github.com/cocoscap/cocos-challenge/blob/main/backend-challenge.md), en su orden, con dónde se cumple: el contrato de la API, la decisión que lo interpreta (si hizo falta), el código y la prueba. Lo que el enunciado no pide y se agregó está al final.

## Endpoints

| Pide | Cómo se cumple | Dónde |
|---|---|---|
| **Portfolio:** valor total de la cuenta, pesos disponibles y listado de activos con cantidad, valor de la posición ($) y rendimiento total (%) | `GET /portfolio/:userid`. Cada dato pedido tiene su campo: `valor_total`, `cash.disponible`, `positions[]` con `qty`, `valor` y `rendimiento_pct`. "Rendimiento total" se interpreta como resultado no realizado sobre el costo de la posición abierta ([D-10](decisiones.md#d-10)). | [Contrato, campo por campo](api/portfolio.md#lo-que-pide-el-enunciado-campo-por-campo) · [ruta](../src/routes/portfolio.routes.ts#L15) · `test/db/orders.api` (`GET /portfolio/:userid`), `test/unit/portfolio` |
| **Buscar activos** por ticker y/o nombre | `GET /instruments?q=`: lo que contiene `q` en el ticker o en el nombre, sin mayúsculas ni acentos, y lo que se le parece (un error de tipeo) ([D-25](decisiones.md#d-25)). | [Contrato](api/instruments.md) · [ruta](../src/routes/instruments.routes.ts#L17) · `test/db/orders.api` (`GET /instruments`) |
| **Enviar una orden** de compra o venta, MARKET o LIMIT | `POST /orders` con `side` y `type`. | [Contrato](api/orders.md#post-orders) · [ruta](../src/routes/orders.routes.ts#L14) · [`app.place_order`](../db/functions/030_orders.sql#L28) |
| MARKET no lleva precio; LIMIT lo requiere | `price` es obligatorio en LIMIT y prohibido en MARKET: `400` sin llegar a la base. | [Validación](../src/domain/orders.ts#L54-L55) · `test/unit/orders` |
| La orden queda grabada en `orders` con su estado y valores | Se graba también una orden `REJECTED` (responde `201`). La respuesta trae la orden grabada: `size`, `price`, `status`, `datetime`. | [Contrato, response `201`](api/orders.md#response-201) · `test/db/orders.api` |

## Opcionales

| Pide | Cómo se cumple | Dónde |
|---|---|---|
| Colección de Postman, Insomnia o REST Client, con ejemplos | Las dos: Postman, con environments para local, staging y producción, y REST Client. | [`postman/`](../postman) · [`rest-client/cocos.http`](../rest-client/cocos.http) · [cómo usarla](api/operacion.md#colección-de-postman) · `test/unit/postman` |

## Consideraciones funcionales

| Pide | Cómo se cumple | Dónde |
|---|---|---|
| Precios en pesos | Todo monto entra y sale en pesos, como string con 2 decimales; el cash se guarda en centavos para admitir montos con centavos. | [D-05](decisiones.md#d-05) · [D-13](decisiones.md#d-13) |
| No hace falta simular el mercado | No se simula. Una LIMIT queda `NEW`; hay un executor interno, que se llama a mano, para ejecutarla cuando el `close` la cruza. | [D-12](decisiones.md#d-12) · [D-28](decisiones.md#d-28) |
| Enviar la cantidad exacta de acciones o un monto en pesos; con monto, el máximo de acciones enteras | `size` **o** `amount`, nunca los dos. Con `amount`, la cantidad es la división entera del monto por el precio, en centavos. | [D-11](decisiones.md#d-11) · [contrato, body](api/orders.md#body) · `test/db/amount` |
| `side`: `BUY` o `SELL` | `BUY`, `SELL`, y `CASH_IN`/`CASH_OUT` para las transferencias. | [Contrato, body](api/orders.md#body) |
| Estados `NEW`, `FILLED`, `REJECTED`, `CANCELLED` | Los cuatro, decididos en la base bajo el lock del usuario. | [Decisión del estado](../db/functions/030_orders.sql#L198-L210) · [D-08](decisiones.md#d-08) · [D-17](decisiones.md#d-17) |
| MARKET se ejecuta enseguida: `FILLED` | Al último `close` válido. Sin cotización válida responde `422 NO_PRICE` y no graba orden: no hay precio que registrar. | [D-12](decisiones.md#d-12) · `test/db/orders.api` (`BUY y SELL MARKET por HTTP`) |
| LIMIT queda `NEW` | Y reserva pesos (compra) o acciones (venta) mientras está `NEW`, para que dos LIMIT no comprometan el mismo saldo. | [D-08](decisiones.md#d-08) · [D-12](decisiones.md#d-12) |
| Solo se cancelan órdenes `NEW` | `POST /orders/:id/cancel`. Una orden que ya no está `NEW` responde `409 NOT_CANCELLABLE` con su estado actual. | [Contrato](api/orders.md#post-ordersidcancel) · [ruta](../src/routes/orders.routes.ts#L60) · [`cancel_order_outcome`](../db/functions/030_orders.sql#L389) · `test/db/orders.api` (`cancelación y consulta de órdenes`, `cancelaciones simultáneas`) |
| Una orden por más de lo disponible queda `REJECTED`: pesos en la compra, acciones en la venta | Se graba `REJECTED`. Lo disponible descuenta lo reservado por las LIMIT `NEW`. `CASH_OUT` por más del disponible también queda `REJECTED`. | [D-08](decisiones.md#d-08) · [decisión del estado](../db/functions/030_orders.sql#L198-L210) · `test/db/orders.api` |
| Transferencias como órdenes `CASH_IN` y `CASH_OUT` | Sobre el instrumento ARS, MARKET, por `amount`. | [Contrato, body](api/orders.md#body) · [D-05](decisiones.md#d-05) |
| Al ejecutarse una orden se actualizan las posiciones | No hay tabla de posiciones que actualizar: el portfolio se calcula desde las órdenes `FILLED` en cada lectura, así que una orden ejecutada aparece en la siguiente. | [D-16](decisiones.md#d-16) |
| Tenencia y pesos con todos los movimientos de `orders`, usando `size` | Una sola función recorre las órdenes `FILLED` del usuario; un índice parcial lo hace barato (3 ms por lectura en el benchmark). | [`app.c_state`](../db/functions/020_balance.sql#L46) · [D-16](decisiones.md#d-16) · [benchmark](decision-snapshot.md) · `test/property/parity` |
| El cash es un instrumento de tipo `MONEDA` | Se usa el ARS del seed. `BUY`/`SELL` sobre una moneda se rechaza con `400`. | [Seed](../db/migrations/000_seed.sql#L120) · [`place_order`](../db/functions/030_orders.sql#L96) |
| Retorno diario con `close` y `previousClose` | `positions[].retorno_diario_pct`. | [Cálculo](../src/domain/money.ts#L70-L75) · `test/unit/money` |
| MARKET usa el último precio (`close`) | El último `close` válido: fecha hasta hoy, una cotización por instrumento y día. | [`valid_close` en `place_order`](../db/functions/030_orders.sql#L151) · [D-06](decisiones.md#d-06) · [D-07](decisiones.md#d-07) |
| Valor de mercado, rendimiento y cantidad de cada posición desde las órdenes `FILLED` | Solo `FILLED` mueve cash y tenencias. El costo es un promedio móvil en orden de ejecución. | [D-08](decisiones.md#d-08) · [D-09](decisiones.md#d-09) · [D-10](decisiones.md#d-10) |

**Lo que el enunciado no resuelve y se decidió:** la historia del seed tiene una venta sin tenencia (usuario 1, BMA). Se muestra la posición real, −10, marcada como inconsistente ([D-01](decisiones.md#d-01) a [D-03](decisiones.md#d-03)).

## Consideraciones técnicas

| Pide | Cómo se cumple | Dónde |
|---|---|---|
| Node.js con un framework como Express o NestJS | Node ≥ 22, Express 4, TypeScript. | [`package.json`](../package.json) · [D-21](decisiones.md#d-21) |
| Una estrategia de acceso a datos: ORM o consultas directas | `pg` con SQL directo, sin ORM. Las escrituras son funciones de Postgres. | [D-21](decisiones.md#d-21) · [D-22](decisiones.md#d-22) |
| Un test funcional de la función para enviar una orden | `test/db/orders.api`: `POST /orders` por HTTP contra Postgres real. | [Pruebas](testing.md#qué-prueba-cada-suite) · [`test/db/orders.api.test.ts`](../test/db/orders.api.test.ts) |
| No hace falta autenticación | No hay. Igual, una orden se pide con el `userid` de su dueño, y una ajena responde como inexistente. | [D-27](decisiones.md#d-27) · [D-26](decisiones.md#d-26) |
| Documentar suposiciones y decisiones | Cada una con su porqué, lo descartado y su costo. | [`decisiones.md`](decisiones.md) |

## Base de datos

| Pide | Cómo se cumple | Dónde |
|---|---|---|
| Se pueden modificar tablas, justificándolo | El seed del challenge se aplica sin modificar; cada cambio es una migración versionada, justificada en el archivo y en las decisiones. | [Cambios al esquema](../README.md#cambios-al-esquema-del-challenge) · [`db/migrations`](../db/migrations) · [D-24](decisiones.md#d-24) |

## Más allá del enunciado

No los pide el enunciado; cambian lo que se ve o cómo se opera:

- **Idempotencia obligatoria en `POST /orders`:** un reintento con la misma `Idempotency-Key` no crea otra orden ([D-19](decisiones.md#d-19)).
- **`GET /orders/:id`** para consultar una orden propia ([D-26](decisiones.md#d-26)).
- **Executor de LIMIT** y limpieza de claves, por `/internal/*` ([D-28](decisiones.md#d-28), [operación](api/operacion.md#internal)).
- **La base impone las reglas:** el rol de la API no puede escribir ninguna tabla ([D-17](decisiones.md#d-17)).
- **Despliegue** en staging y producción al publicar un release ([D-29](decisiones.md#d-29)).
