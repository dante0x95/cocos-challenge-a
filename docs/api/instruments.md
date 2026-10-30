# `GET /instruments?q=`

Busca activos por ticker y/o nombre ([D-25](../decisiones.md#d-25)).

## Query

| Parámetro | Reglas |
|---|---|
| `q` | obligatorio, 1 a 50 caracteres después de recortar los espacios de los extremos (solo espacios cuenta como vacío). Encuentra lo que contiene `q` en `ticker` o en `name`, y también lo que se le parece (un error de tipeo en una palabra casi completa: `galisia` → Galicia). Sin distinguir mayúsculas ni acentos: `petroleo`, `Petróleo` y `PETROLEO` buscan lo mismo. `%` y `_` se buscan literalmente. |
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

El orden es: ticker exacto, ticker que empieza con `q`, nombre que empieza con `q`, el resto; dentro de cada nivel, lo más parecido a `q` primero y después por ticker. Como el desempate es por ticker, el exacto ya quedaría antes que los tickers que empiezan con `q` (todos lo extienden); su nivel propio solo lo hace explícito. Sin resultados, `results: []`.

## Qué encuentra `q`

- **Lo que lo contiene**, en el ticker o en el nombre, sin mayúsculas ni acentos: `rio` y `río` encuentran "Molinos Río de la Plata".
- **Lo que se le parece** por trigramas (`pg_trgm`): la similitud entre `q` y la palabra (o secuencia de palabras) del ticker o del nombre que más se le parece, con un umbral de 0,45. En la práctica tolera un error de tipeo en una palabra casi completa de 7 letras o más (`galisia` → Galicia, `superviele` → Supervielle; con 6, solo si el error está al final: `cresut` → Cresud) y variantes de una palabra (`argentino` → Argentina, Argentinos). Un ticker de 2 a 4 letras no tiene similitud suficiente con casi nada: a esos los encuentra la coincidencia literal, que sigue vigente.
- Con `q` de 1 a 3 caracteres, la similitud no agrega nada a la coincidencia literal: `q=a` devuelve exactamente lo que contiene una `a`.
- La similitud solo mira letras y números: `%`, `_`, puntos y guiones separan palabras y no cuentan. Así, `100%` encuentra literalmente "al 100%" y, por parecido, "al 1000" (detrás del literal). Una letra suelta en `q` (`PA_P` son las palabras "pa" y "p") se parece a cualquier nombre con esa letra como palabra ("Y.P.F.").
- Dentro de un nivel ordena la similitud, no si el texto contiene `q`: con `q=banco`, "Fondo banca" (se le parece: 0,5) va antes que "Fondo xbancox" (lo contiene dentro de una palabra más larga: 0,27). Lo que contiene `q` como palabra entera tiene similitud 1 y va primero en su nivel. Los niveles (ticker exacto, ticker que empieza con `q`, nombre que empieza con `q`) sí van siempre por encima de la similitud.
- `%`, `_` y `\` se buscan literalmente, también en ancho completo (`％`, `＿`, `＼`), que la normalización convierte en esos mismos caracteres.

## Errores

`400 BAD_REQUEST` si falta `q`, viene vacío o solo con espacios, supera los 50 caracteres, `limit` no es un entero de 1 a 50 o `include_cash` no es `true` ni `false`.
