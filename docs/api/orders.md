# Órdenes

- [`POST /orders`](#post-orders): enviar una orden (compra, venta, depósito o retiro)
- [`GET /orders/:id?userid=`](#get-ordersiduserid): consultar una orden propia
- [`POST /orders/:id/cancel`](#post-ordersidcancel): cancelar una orden `NEW`

Toda la decisión (saldo, tenencia, precio, estado) la toma `app.place_order` en Postgres, bajo el lock del usuario ([D-17](../decisiones.md#d-17)). La API valida la forma del request y traduce el resultado.

---

## `POST /orders`

### Headers

| | |
|---|---|
| `Content-Type` | `application/json` |
| `Idempotency-Key` | **obligatoria**, hasta 200 caracteres. Una por intención de orden; para reintentar, reusar la misma con el mismo body ([D-19](../decisiones.md#d-19)). El mismo monto o precio en otra escala (`100`, `"100"`, `"100.00"`) cuenta como el mismo body. |

### Body

| Campo | Reglas |
|---|---|
| `userid` | entero > 0 |
| `side` | `BUY` · `SELL` · `CASH_IN` · `CASH_OUT` |
| `type` | `MARKET` (por defecto) · `LIMIT` |
| `instrumentid` | obligatorio en `BUY`/`SELL`; prohibido en cash (se usa ARS) |
| `size` **o** `amount` | exactamente uno. `size`: acciones, entero > 0. `amount`: pesos, string > 0 con hasta 2 decimales; para `BUY`/`SELL` se compra o vende el máximo entero de acciones que alcanza: `size = floor(amount / precio)`, con el `close` en MARKET y el límite en LIMIT ([D-11](../decisiones.md#d-11)). La orden se graba con ese `size` y su `amount` es `size × precio`, no el monto pedido; si no alcanza para una acción, `400`. Para cash, solo `amount` (máximo 21474836.47). |
| `price` | obligatorio en `LIMIT`, prohibido en `MARKET`. String > 0 con hasta 2 decimales: se rechaza, no se redondea. |

No se aceptan campos de más.

```json
{ "userid": 2, "side": "BUY", "type": "MARKET", "instrumentid": 47, "amount": "10000.00" }
```

### Response `201`

Una orden `REJECTED` también es `201`: la orden se grabó y su estado lo dice.

```json
{
  "id": "13", "userid": "2", "instrumentid": "47",
  "side": "BUY", "type": "MARKET", "size": "10", "price": "925.85", "amount": "9258.50",
  "status": "FILLED", "balance_seq": "2", "datetime": "2026-10-28T21:28:07Z", "cancel_reason": null
}
```

| Header | |
|---|---|
| `Location` | `/orders/{id}?userid={userid}` |
| `Idempotent-Replay` | `false` la primera vez; `true` si devolvió la respuesta de un request anterior con la misma clave |

| `status` | Cuándo |
|---|---|
| `FILLED` | MARKET con saldo o tenencia suficiente; `CASH_IN`; `CASH_OUT` dentro del disponible |
| `NEW` | LIMIT con saldo o tenencia suficiente. Reserva pesos (compra) o acciones (venta). |
| `REJECTED` | No alcanza el disponible (pesos o acciones, descontando reservas) |

`price` es el precio de ejecución: el último `close` para MARKET, el límite para LIMIT, `0.01` para cash. `size` de un movimiento de cash está en centavos ([D-05](../decisiones.md#d-05)). `amount` siempre es `size × price` en pesos. `cancel_reason` es el motivo de una orden `CANCELLED` (ver [la cancelación](#post-ordersidcancel)); una orden recién creada nunca lo tiene, así que acá siempre es `null`.

Un replay devuelve la respuesta del request original, no el estado actual de la orden: si la orden se canceló después, el replay sigue diciendo `NEW` y `cancel_reason: null`. El estado actual está en `GET /orders/:id`. Una clave grabada antes de que existiera `cancel_reason` devuelve su respuesta original, sin ese campo, hasta que vence (24 h).

### Errores

| Código | `error` | Cuándo | ¿Se grabó? |
|---|---|---|---|
| `400` | `BAD_REQUEST` | falta la clave, JSON inválido, campos o combinaciones inválidas, usuario o instrumento inexistente, moneda como activo, monto que no alcanza para una acción o que da más de 2³¹ − 1 acciones | no |
| `422` | `NO_PRICE` | MARKET sin cotización válida | no; la clave queda libre |
| `422` | `IDEMPOTENCY_MISMATCH` | misma clave con otro body | no |
| `422` | `LIMIT` | el resultado saldría de ±10¹⁵ ARS o 2⁶² acciones, o el importe de la orden (`size × price`) supera 10¹⁵ ARS ([D-14](../decisiones.md#d-14)) | no |
| `503` | `LOCK_TIMEOUT` · `TIMEOUT` · `VERSION_MISMATCH` | el usuario tenía otra operación en curso, se venció el tiempo (de la escritura o de la espera por una conexión con la base), o hay un despliegue en curso | no, o resultado desconocido: **reintentar con la misma clave** ([D-20](../decisiones.md#d-20)) |

Todos los errores responden `{ "error": "...", "message": "..." }`.

---

## `GET /orders/:id?userid=`

Devuelve la orden con la misma forma que `POST /orders`, con su estado actual, solo si es de `userid`. El `userid` es obligatorio, como en la cancelación ([D-26](../decisiones.md#d-26)).

| Código | Cuándo |
|---|---|
| `200` | la orden existe y es de `userid` |
| `400 BAD_REQUEST` | falta `userid`, viene repetido o no es un entero > 0 (`abc`, `0`); o el id no es un entero > 0 |
| `404 NOT_FOUND` | no existe **o es de otro usuario**: el mismo status y el mismo cuerpo en los dos casos, para no revelar órdenes ajenas |

```json
{ "error": "NOT_FOUND", "message": "orden 15 inexistente para el usuario 7" }
```

---

## `POST /orders/:id/cancel`

```json
{ "userid": 2 }
```

| Código | Cuándo |
|---|---|
| `200` | estaba `NEW` y quedó `CANCELLED` con `cancel_reason: "USER"`; devuelve la orden. Libera lo reservado. |
| `404 NOT_FOUND` | no existe o es de otro usuario |
| `409 NOT_CANCELLABLE` | ya no estaba `NEW`; el body incluye la orden con su estado actual |

```json
{
  "id": "15", "userid": "2", "instrumentid": "47",
  "side": "BUY", "type": "LIMIT", "size": "5", "price": "900.00", "amount": "4500.00",
  "status": "CANCELLED", "balance_seq": null, "datetime": "2026-10-28T21:30:12Z", "cancel_reason": "USER"
}
```

Una LIMIT también queda `CANCELLED` si el executor la cancela porque ejecutarla violaría los límites de [D-14](../decisiones.md#d-14). `cancel_reason` distingue los dos casos:

| `cancel_reason` | Quién la canceló |
|---|---|
| `USER` | su dueño, con este endpoint |
| `LIMIT` | el executor, porque ejecutarla habría dejado el cash por encima de 10¹⁵ ARS o la posición por encima de 2⁶² acciones |
| `null` | nadie: la orden no está `CANCELLED` |

Las órdenes canceladas antes de que existiera el campo figuran como `USER` ([D-14](../decisiones.md#d-14)).

Por qué `POST` y no `DELETE`, y por qué el `userid` en el body: [D-26](../decisiones.md#d-26).

---

## Ejemplos

```bash
# depósito
curl -s localhost:3000/orders -H 'content-type: application/json' -H 'Idempotency-Key: dep-1' \
  -d '{"userid":2,"side":"CASH_IN","amount":"100000.00"}'

# compra por monto
curl -s localhost:3000/orders -H 'content-type: application/json' -H 'Idempotency-Key: buy-1' \
  -d '{"userid":2,"side":"BUY","type":"MARKET","instrumentid":47,"amount":"10000"}'

# LIMIT y cancelación
curl -s localhost:3000/orders -H 'content-type: application/json' -H 'Idempotency-Key: lim-1' \
  -d '{"userid":2,"side":"BUY","type":"LIMIT","instrumentid":47,"size":5,"price":"900.00"}'
curl -s 'localhost:3000/orders/15?userid=2'
curl -s localhost:3000/orders/15/cancel -H 'content-type: application/json' -d '{"userid":2}'
```

La colección completa está en [`rest-client/cocos.http`](../../rest-client/cocos.http).
