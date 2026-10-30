# `GET /instruments?q=`

Busca activos por ticker y/o nombre ([D-25](../decisiones.md#d-25)).

## Query

| Parámetro | Reglas |
|---|---|
| `q` | obligatorio, 1 a 50 caracteres después de recortar los espacios de los extremos (solo espacios cuenta como vacío). Coincidencia parcial, sin distinguir mayúsculas, en `ticker` o en `name`. `%` y `_` se buscan literalmente. |
| `include_cash` | `true` para incluir la moneda (ARS) o `false`; ningún otro valor. Por defecto `false`. |
| `limit` | entero de 1 a 50; por defecto 20 |

## Response `200`

```json
{
  "query": "pa",
  "results": [
    { "id": 47, "ticker": "PAMP", "name": "Pampa Holding S.A.", "type": "ACCIONES" },
    { "id": 6,  "ticker": "PATA", "name": "Importadora y Exportadora de la Patagonia", "type": "ACCIONES" },
    { "id": 19, "ticker": "BPAT", "name": "Banco Patagonia", "type": "ACCIONES" },
    …
  ]
}
```

`query` es el `q` recortado. Cada resultado trae exactamente `id`, `ticker`, `name` y `type`.

El orden es: ticker exacto, ticker que empieza con `q`, nombre que empieza con `q`, el resto; después por ticker. Como el desempate es por ticker, el exacto ya quedaría antes que los tickers que empiezan con `q` (todos lo extienden); su nivel propio solo lo hace explícito. Sin resultados, `results: []`.

## Errores

`400 BAD_REQUEST` si falta `q`, viene vacío o solo con espacios, supera los 50 caracteres, `limit` no es un entero de 1 a 50 o `include_cash` no es `true` ni `false`.
