# `GET /portfolio/:userid`

Estado de la cuenta de un usuario: valor total, pesos disponibles para operar y el listado de activos con cantidad, valor en pesos y rendimiento. Es una lectura: no toma locks y se resuelve en una sola sentencia, que ve una foto consistente de las órdenes.

## Request

| | |
|---|---|
| Path | `/portfolio/:userid`, entero > 0 |
| Headers | ninguno |

## Response `200`

Usuario 1 de los datos del challenge:

```json
{
  "userid": 1,
  "valor_total": "889756.00",
  "cash": { "neto": "753000.00", "reservado": "125500.00", "disponible": "627500.00" },
  "valuation_complete": true,
  "has_inconsistent_history": true,
  "positions": [
    {
      "instrumentid": 31, "ticker": "BMA", "name": "Banco Macro S.A.",
      "qty": "-10", "acciones_reservadas": "0", "acciones_disponibles": "-10",
      "costo_total": "0.000000", "costo_unitario": null,
      "price": "1502.80", "price_date": "2023-07-14",
      "valor": "-15028.00", "resultado": null, "rendimiento_pct": null, "retorno_diario_pct": "-1.15",
      "inconsistent": true
    },
    {
      "instrumentid": 47, "ticker": "PAMP", "name": "Pampa Holding S.A.",
      "qty": "40", "acciones_reservadas": "0", "acciones_disponibles": "40",
      "costo_total": "37200.000000", "costo_unitario": "930.0000",
      "price": "925.85", "price_date": "2023-07-14",
      "valor": "37034.00", "resultado": "-166.00", "rendimiento_pct": "-0.45", "retorno_diario_pct": "0.44",
      "inconsistent": false
    },
    {
      "instrumentid": 54, "ticker": "METR", "name": "MetroGAS S.A.",
      "qty": "500", "acciones_reservadas": "0", "acciones_disponibles": "500",
      "costo_total": "125000.000000", "costo_unitario": "250.0000",
      "price": "229.50", "price_date": "2023-07-14",
      "valor": "114750.00", "resultado": "-10250.00", "rendimiento_pct": "-8.20", "retorno_diario_pct": "-1.08",
      "inconsistent": false
    }
  ]
}
```

**Todo número viaja como string** con escala fija ([D-13](../decisiones.md#d-13)). Hay que parsearlo con una librería decimal, no con `Number()`.

### Lo que pide el enunciado, campo por campo

| Pedido | Campo |
|---|---|
| Valor total de la cuenta | `valor_total` |
| Pesos disponibles para operar | `cash.disponible` |
| Listado de activos | `positions[]` (el cash no es un activo y nunca aparece acá) |
| Cantidad de acciones | `positions[].qty` |
| Valor total monetario de la posición ($) | `positions[].valor` |
| Rendimiento total (%) | `positions[].rendimiento_pct` |

### Todos los campos

| Campo | Unidad | Significado |
|---|---|---|
| `valor_total` | ARS, 2 dec. | `cash.neto` + Σ `valor` de las posiciones con precio. No resta lo reservado ([D-15](../decisiones.md#d-15)). |
| `cash.neto` | ARS, 2 dec. | Depósitos + ventas − retiros − compras; solo órdenes `FILLED`. |
| `cash.reservado` | ARS, 2 dec. | Σ `size × límite` de las compras LIMIT pendientes (`NEW`). |
| `cash.disponible` | ARS, 2 dec. | `neto − reservado`. Lo que el usuario puede usar. |
| `valuation_complete` | bool | `false` si alguna posición no tiene cotización válida: su `valor` es `null` y no suma al total. |
| `has_inconsistent_history` | bool | La historia tuvo alguna venta sin tenencia ([D-01](../decisiones.md#d-01), [D-02](../decisiones.md#d-02)). |
| `positions[]` | | Una por instrumento con tenencia distinta de 0, ordenadas por `instrumentid`. |
| `qty` | acciones | Compras − ventas `FILLED`. Negativa solo en un corto heredado. |
| `acciones_reservadas` | acciones | Σ `size` de las ventas LIMIT pendientes. |
| `acciones_disponibles` | acciones | `qty − acciones_reservadas`. |
| `costo_total` | ARS, 6 dec. | Costo promedio móvil, en orden de ejecución ([D-09](../decisiones.md#d-09)). |
| `costo_unitario` | ARS, 4 dec. | `costo_total / qty`; `null` si no hay posición larga con costo. |
| `price`, `price_date` | ARS, fecha | Última cotización válida ([D-06](../decisiones.md#d-06)); `null` si no hay. |
| `valor` | ARS, 2 dec. | `qty × price`. |
| `resultado` | ARS, 2 dec. | `valor − costo_total`: ganancia o pérdida no realizada en pesos. |
| `rendimiento_pct` | %, 2 dec. | `(valor − costo_total) / costo_total × 100` ([D-10](../decisiones.md#d-10)). |
| `retorno_diario_pct` | %, 2 dec. | `(close − previousClose) / previousClose × 100`. |
| `inconsistent` | bool | La posición está en corto ahora (solo posible por historia heredada). |

Los redondeos son half-even sobre la fracción exacta, siempre al final.

## Errores

| Código | Cuándo |
|---|---|
| `400 BAD_REQUEST` | `userid` no es un entero > 0, o viene mal codificado (`%FF`) |
| `404 NOT_FOUND` | el usuario no existe |
| `409 HISTORY_OVERFLOW` | la historia del usuario no entra en los tipos del cálculo (solo una base heredada, [D-24](../decisiones.md#d-24)): hasta que se corrija, sin `Retry-After` y sin reintentar |
| `503 TIMEOUT` | la lectura superó 5 s; incluye `Retry-After` |
| `500 INTERNAL` | un error no previsto: `error interno; reintentar` (es una lectura, sin `Idempotency-Key`) |

```json
{ "error": "NOT_FOUND", "message": "usuario 7 inexistente" }
```

Un usuario sin órdenes responde `200` con el cash en `"0.00"` y `positions: []`.

El `404` no cuesta otra consulta: `app.read_portfolio` verifica que el usuario exista en la misma sentencia y, si no existe, falla con el código propio `APP06`, que la API traduce a `404 NOT_FOUND`. Cada request es un solo round-trip a la base.

## Consistencia

- Órdenes y reservas salen de una sola sentencia: el disponible mostrado existió en algún instante. Puede ser un instante anterior a una escritura en curso, pero nunca es inventado.
- Las cotizaciones se leen en la misma sentencia, por instrumento. `price_date` dice de qué día es cada una.
- El cálculo recorre todas las órdenes ejecutadas del usuario ([D-16](../decisiones.md#d-16)); lo comparan con un oráculo independiente `test/property` y `test/db`.
