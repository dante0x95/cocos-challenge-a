# Decisiones y suposiciones

Registro de todo lo que no se desprende directamente del enunciado y que cambia lo que el sistema hace o devuelve. Cada entrada dice qué se decidió, por qué, qué se descartó y qué cuesta.

Índice:

- **Datos recibidos:** [D-01](#d-01) venta en corto heredada · [D-02](#d-02) dónde se señala · [D-03](#d-03) cubrir un corto · [D-04](#d-04) orden de la historia heredada · [D-05](#d-05) cash en centavos · [D-06](#d-06) antigüedad de una cotización · [D-07](#d-07) cotizaciones duplicadas
- **Dominio:** [D-08](#d-08) qué mueve saldo y qué reserva · [D-09](#d-09) costo de una posición · [D-10](#d-10) rendimiento · [D-11](#d-11) orden por monto · [D-12](#d-12) ejecución de MARKET y LIMIT · [D-13](#d-13) números en la entrada y la salida · [D-14](#d-14) límites · [D-15](#d-15) valor total de la cuenta
- **Arquitectura:** [D-16](#d-16) cómo se calcula el balance · [D-17](#d-17) protocolo de escritura · [D-18](#d-18) orden de ejecución · [D-19](#d-19) idempotencia · [D-20](#d-20) tiempos máximos · [D-21](#d-21) acceso a datos · [D-22](#d-22) lógica en la base · [D-23](#d-23) barrera de despliegue · [D-24](#d-24) migraciones
- **API:** [D-25](#d-25) búsqueda · [D-26](#d-26) consulta y cancelación de una orden · [D-27](#d-27) autenticación · [D-28](#d-28) executor de LIMIT
- **Despliegue:** [D-29](#d-29) Fly.io con deploy continuo desde `main`
- [Fuera de alcance y límites conocidos](#fuera-de-alcance)

---

## Datos recibidos

<a id="d-01"></a>
### D-01 — Venta en corto en la historia recibida: se tolera y se señala

**Hallazgo.** En `database.sql`, el usuario 1 compra 20 BMA (orden 9, `FILLED`) y después vende 30 (orden 11, `FILLED`). Queda con −10 acciones. El enunciado dice que una venta sin acciones suficientes debe quedar `REJECTED`, así que esa orden no debería existir. El cash no se ve afectado (753.000 / 125.500 / 627.500), porque suma importes sin mirar tenencias.

**Alternativas.**
1. **Tolerar y señalar.** La posición se muestra con su cantidad real (−10), costo 0, sin costo unitario ni rendimiento, y marcada. El resto del portfolio se calcula normalmente.
2. **Cuarentena.** `GET /portfolio/1` responde `422` hasta que alguien corrija la historia a mano.

**Decisión: 1.** El usuario 1 es el único con órdenes en los datos provistos. Con la opción 2, el endpoint principal no devolvería nada útil sobre esos datos. La opción 1 muestra todo, hace visible el problema y no oculta ni inventa nada. Se consultó con los autores del challenge: confirmaron que la interpretación y la opción 1 son correctas.

**Lo que no cambia.** Una venta nueva sin tenencia suficiente siempre queda `REJECTED`. El corto solo puede venir de la historia recibida, nunca de la API. Al migrar, el bootstrap lo informa (`historia: usuario 1 — short`) en vez de abortar.

**Una `LIMIT NEW` heredada sin respaldo es otra cosa.** Una base preexistente también puede traer `NEW` insertadas sin pasar por `place_order` ([D-24](#d-24)): una venta sin las acciones, una compra sin el cash. Eso no es un hecho pasado sino una decisión pendiente, y el sistema sí puede negarse a tomarla: ejecutarla dejaría la posición en corto o el cash negativo por decisión propia, no por historia. Por eso el bootstrap la cancela con `cancel_reason = 'UNBACKED'` y lo informa (`historia: usuario N — reserva`), y si llega al executor antes, el executor hace lo mismo ([D-12](#d-12)).

<a id="d-02"></a>
### D-02 — La historia inconsistente se señala en dos niveles

- **Por posición:** `inconsistent: true` significa que la posición **está en corto ahora** (`qty < 0`).
- **Por portfolio:** `has_inconsistent_history: true` significa que la historia del usuario tuvo alguna venta sin tenencia, aunque hoy ninguna posición esté en corto.

**Por qué dos.** El flag de posición señala la fila exacta y deja usable el resto. El global sirve a quien consume solo el total. Además conserva la marca cuando el corto ya se cubrió ([D-03](#d-03)).

**Descartado:** excluir la posición del portfolio o forzarla a 0. Ocultar el dato es peor que mostrarlo marcado.

<a id="d-03"></a>
### D-03 — Comprar sobre un corto heredado: las acciones que lo cubren no llevan costo

**Problema.** Si el usuario 1 compra 15 BMA a 100 partiendo de −10, la regla ingenua (sumar el costo de la compra) deja `qty 5` con costo 1.500: un costo unitario de 300 cuando pagó 100 por cada acción que tiene, y un rendimiento de −66,7 % cuando es 0 %. Comprar exactamente 10 dejaba `qty 0` con costo 1.000.

**Regla.** Al comprar `s` acciones con `qty < 0`, las primeras `−qty` cubren el corto **sin costo**. Solo el excedente `max(s + qty, 0)` abre posición, al precio de la compra. Si `qty` queda en 0 o menos, el costo es 0. La posición deja de estar marcada en cuanto `qty ≥ 0`; la marca histórica queda en `has_inconsistent_history`.

**Por qué.** Esas acciones no se compraron para tenerlas: devolvieron las que faltaban. El costo de la posición debe ser el de las acciones que el usuario efectivamente tiene.

**Cómo se verifica.** Hay casos fijos (compra 15, 10, 5; cubrir, cerrar y reabrir) en `test/db/ledger.test.ts`. Además, la prueba de propiedad siembra cortos heredados en el 20 % de los usuarios: si la base se aparta del oráculo en esta regla, falla.

<a id="d-04"></a>
### D-04 — Orden de la historia recibida: `(datetime, id)`

Las órdenes `FILLED` recibidas no traen orden de ejecución. Se numeran por usuario en orden `(datetime, id)` en la columna `balance_seq` ([D-18](#d-18)). Es una **aproximación declarada**: `datetime` es la creación, no la ejecución. Para los datos provistos no hay ambigüedad (las 7 `FILLED` del usuario 1 tienen horas distintas). Las órdenes nuevas no dependen de esta regla: su secuencia se asigna al ejecutarlas.

<a id="d-05"></a>
### D-05 — Movimientos de cash en centavos

**Antes:** `CASH_IN` de 100,50 ARS no se podía representar, porque `size` es entero y `price` era 1.
**Después:** `size` = centavos y `price` = 0.01. 100,50 ARS → `size 10050`. El importe `size × price` de las órdenes existentes no cambia: la migración multiplica `size` por 100 y lo verifica.

**Por qué así y no una columna `amount`.** Así se mantiene una sola fórmula para todas las órdenes: importe = `size × price`, exacto con enteros y dos decimales. Las sumas de cash quedan como una sola agregación sobre `orders`, como pide el enunciado.

**Costo.** Como `size` es `integer`, el máximo por movimiento de cash es 21.474.836,47 ARS. Se rechaza con `400` por encima. Es un límite por operación, no del saldo.

<a id="d-06"></a>
### D-06 — Cotización válida y su antigüedad máxima, configurable

Una cotización es válida si su fecha es ≤ hoy (zona `America/Argentina/Buenos_Aires`). Si `settings.price_max_age_days` no es `NULL`, además no puede ser más vieja que esa cantidad de días.

**Valor por defecto: `NULL` (sin límite).** Las cotizaciones de `database.sql` son de julio de 2023. Con un límite de 7 días, ninguna posición se valuaría y toda MARKET terminaría en `NO_PRICE`: el sistema "no funcionaría" sobre los datos provistos. En producción, la configuración recomendada es 7 días (`UPDATE app.settings SET price_max_age_days = 7`). Los tests prueban los dos modos. Las fechas futuras se ignoran siempre.

**Descartado:** mover las fechas de `marketdata` para que parezcan recientes. Altera datos provistos y esconde el problema.

<a id="d-07"></a>
### D-07 — Cotizaciones duplicadas por (instrumento, día): se conserva la de mayor id

La migración impone una cotización por instrumento y día (`UNIQUE (instrumentid, date)`). Si hay duplicados, conserva la de mayor `id`, que es la última cargada. Los datos provistos no tienen duplicados; la regla existe para no fallar con otros datos.

---

## Dominio

<a id="d-08"></a>
### D-08 — Qué mueve saldo, qué reserva, qué se rechaza

- Solo `FILLED` mueve cash y tenencias, como pide el enunciado.
- `NEW` **reserva**: una compra LIMIT reserva `size × límite` en pesos; una venta LIMIT reserva `size` acciones. Lo reservado no se puede volver a usar. Sin esto, dos LIMIT podrían comprometer el mismo dinero.
- `REJECTED` y `CANCELLED` no cuentan.
- **Pesos disponibles** = cash neto − cash reservado. **Acciones disponibles** = tenencia − acciones reservadas.
- Una orden que no alcanza **se persiste** como `REJECTED` y responde `201`: el enunciado pide grabarla. `CASH_OUT` por más del disponible también queda `REJECTED`.

<a id="d-09"></a>
### D-09 — Costo de una posición: promedio móvil en orden de ejecución, con enteros

- Por instrumento, en orden de `balance_seq`. Una compra suma su importe al costo. Una venta deja `costo × (qty − s) / qty`, redondeado **half-even**. Al cerrar la posición, el costo vuelve a 0.
- El costo se lleva en **micro-ARS** enteros (10⁻⁶ ARS) y el cash en centavos. Así nunca hay coma flotante, y el redondeo ocurre en un solo lugar, después de cada venta.
- Lo que se afirma es **determinismo**: el mismo resultado siempre, para cualquier historia.
- **Toda división que decide una cantidad o un importe es entera** (`div`, `mod`, `app.div_half_even`): la cantidad por monto ([D-11](#d-11)) y el costo tras una venta ([D-09](#d-09)). Las divisiones de presentación (porcentajes de la respuesta) redondean a su escala, en `BigInt`, con half-even. No se afirma exactitud de la fracción infinita (100 / 3 no tiene representación finita).
- Hay una sola implementación en el sistema (`app.c_state`) y un oráculo independiente en los tests ([D-22](#d-22)).

<a id="d-10"></a>
### D-10 — "Rendimiento total": no realizado, sobre el costo de la posición abierta

- `rendimiento_pct` = (valor − costo) / costo × 100, con 2 decimales. Ejemplo: costo 100, valor 110 → `"10.00"`.
- `resultado` = valor − costo, en pesos. Mismo dato en `$`: el enunciado pide la posición en `$` y el rendimiento en `%`, y los brokers suelen mostrar los dos.
- `retorno_diario_pct` = (`close` − `previousClose`) / `previousClose` × 100, como indica el enunciado.
- Son `null` cuando no hay precio, cuando la posición no es larga o cuando no tiene costo (por ejemplo, un corto heredado).

**Interpretación declarada.** "Rendimiento total" se toma como resultado **no realizado** de lo que el usuario tiene hoy, contra su precio promedio de compra. El resultado **realizado** de ventas pasadas no se calcula (ver [fuera de alcance](#fuera-de-alcance)).

<a id="d-11"></a>
### D-11 — Orden por monto en pesos

`POST /orders` acepta `size` **o** `amount`, nunca los dos. Con `amount`, la cantidad es la **división entera** de `amount` por el precio, los dos en centavos: el máximo entero, sin fracciones, como pide el enunciado. No es `floor(amount / precio)`: la división `numeric` de Postgres redondea el cociente a 16 dígitos significativos antes de que `floor` lo vea, y con `amount = 2 × precio − 0,01` daba 2 acciones, un centavo más que el presupuesto. `div(amount × 100, precio × 100)` es exacta. El tope de [D-14](#d-14) es sobre el importe que resulta (`size × precio`), no sobre el monto pedido. El precio es el `close` vigente para MARKET y el límite para LIMIT. Se calcula dentro de la función que decide, **bajo el lock** y con el mismo precio con que se ejecuta. Si da 0, responde `400` y no se graba orden. La orden se guarda con el `size` calculado. Para cash solo se acepta `amount`.

<a id="d-12"></a>
### D-12 — Ejecución de MARKET y LIMIT

- **MARKET:** se ejecuta enseguida al último `close` válido ([D-06](#d-06)). Sin cotización válida responde `422 NO_PRICE` y **no se graba orden**: no hay un precio que registrar.
- **LIMIT:** queda `NEW` y reserva ([D-08](#d-08)). El enunciado no pide simular el mercado. Hay un executor que ejecuta una LIMIT cuando el `close` vigente la cruza (compra: `close ≤ límite`; venta: `close ≥ límite`), **a su precio límite** ([D-28](#d-28)). Como el precio no cambia, lo reservado al crearla es exactamente lo que se ejecuta; aun así, el executor **revalida el respaldo** bajo el lock, con el estado del momento: la venta necesita esas acciones en la tenencia y la compra ese cash. Lo que la propia orden reserva no cuenta en contra (una venta por toda la tenencia tiene respaldo), y tampoco lo que reservan las otras `NEW` del usuario: el respaldo se evalúa al ejecutar, y la que cruza primero se lleva lo que hay. En régimen siempre lo tiene: `place_order` no deja una `NEW` sin respaldo y ninguna escritura posterior gasta lo reservado. Puede faltarle solo a una `NEW` heredada de una base preexistente ([D-24](#d-24)): venta sin las acciones, compra sin el cash, u orden sobre una moneda. Esa no se ejecuta: pasa a `CANCELLED` con `cancel_reason = 'UNBACKED'`, libera lo que reservaba y el reporte del executor la lista aparte (issue #6). También se revalidan los límites de [D-14](#d-14): si ejecutarla los violaría, se cancela con `LIMIT`.
- Sin ejecuciones parciales ni comisiones.

<a id="d-13"></a>
### D-13 — Números: se rechaza la escala de más; todo sale como string

- **Entrada:** precios y montos con a lo sumo 2 decimales, como string o como entero JSON. `1.005` responde `400`: **se rechaza, no se redondea**. Un número JSON con decimales también se rechaza, porque un float no garantiza la escala. Como número JSON solo se aceptan enteros dentro de ±2⁵³ (el rango que `JSON.parse` representa exacto): `9007199254740993` llegaría como `9007199254740992` y pasaría alterado en silencio, así que responde `400` y pide el valor como string; cualquier magnitud mayor va como string (`"9007199254740993"`). El string preserva la precisión pero no quita los límites: el importe de una orden sigue acotado a 10¹⁵ ARS por [D-14](#d-14) (`422 LIMIT`), que decide `place_order`. Lo aceptado se canoniza a 2 decimales (`100` → `"100.00"`) antes de seguir, también para el hash de idempotencia ([D-19](#d-19)): `100` y `"100.00"` siguen siendo el mismo request. Los ids del body (`userid`, `instrumentid`) y `size` son `integer` en Postgres y se acotan a 2³¹ − 1 en la API, como los de la ruta.
- **Salida:** importes, precios, costos, porcentajes, cantidades e ids viajan como **string** con escala fija. Un entero mayor que 2⁵³ no sobrevive a `JSON.parse` como número.
- **En la API:** `BigInt` para todo dinero. node-postgres entrega `numeric` e `int8` como string y no se registra ningún parser que los convierta a `Number`. Un test lo verifica.

<a id="d-14"></a>
### D-14 — Límites de dominio

Ningún movimiento se confirma si deja el cash fuera de ±10¹⁵ ARS (1.000.000.000.000.000,00), una posición por encima de 2⁶² acciones o el costo de una posición por encima de 10¹⁷ ARS. El cash tiene además el límite por movimiento de [D-05](#d-05). Y ninguna orden se graba, en ningún estado, si su importe (`size × price`) supera 10¹⁵ ARS: responde `422 LIMIT` sin orden.

**Por qué existe el tope.** El cash sale del fold como `bigint` en centavos (`cash_cents`): su máximo es 92.233.720.368.547.758,07 ARS. Un cash por encima no se puede leer ni autorizar. El tope de 10¹⁵ deja margen sobre lo representable y es una cifra que se explica. Para las posiciones, 2⁶² deja margen dentro de `bigint`.

**El costo de una posición viaja como `numeric`, con tope propio.** El costo se lleva en micro-ARS ([D-09](#d-09)): cuatro órdenes de magnitud más que el cash en centavos. En `bigint` desbordaría a 9,22 × 10¹² ARS, 100× por debajo del tope del cash, y como el fold corre en cada lectura y cada autorización, un usuario con una posición así quedaba congelado: `GET /portfolio`, un `CASH_IN`, una cancelación, todo `500`. Por eso `app.c_state` y `app.read_portfolio` lo devuelven como `numeric` sin decimales (la API lo convierte con `BigInt`). Y el costo **no lo acota el cash**: depositar 10¹⁵ y comprar, depositar 10¹⁵ y comprar, deja un costo de 2 × 10¹⁵ con un cash que nunca superó 10¹⁵. El tope propio es 10¹⁷ ARS por posición, con margen 10× sobre `numeric(24,0)`, validado en cada compra que se confirma, en `place_order` y al ejecutar una LIMIT.

**Por qué un tope por orden, y antes de todo.** Una orden cuyo importe supera el cash máximo representable nunca podría ejecutarse: una compra no tendría con qué pagarse y una venta dejaría el cash fuera del tope. Pero una LIMIT que queda `NEW` o `REJECTED` no pasa por la validación del estado, y el importe entra en tipos acotados (`numeric(20,0)` para el importe, `numeric(18,2)` para el precio y el `amount` de la respuesta): sin el tope, una orden con `size × price ≥ 10¹⁶` respondía `500` por overflow en vez de un código claro. Lo mismo una MARKET con `size` máximo sobre un instrumento de cotización muy alta. El tope se calcula apenas se conocen `size` y `price` (para una LIMIT, antes de asignar el precio; para MARKET o por `amount`, con el precio ya resuelto) y siempre antes de calcular el importe. La cantidad que sale de un `amount` se acota como `numeric` (a lo sumo 2³¹ − 1, `400`) antes de pasar a `bigint`: un `amount` no tiene máximo y el cociente podía no entrar.

**Una clave anterior al tope sigue dando su respuesta.** Una LIMIT por encima del tope que la versión anterior aceptó (por ejemplo `NEW` con importe 9,5 × 10¹⁵) dejó su clave con el `201` ([D-19](#d-19)). Por eso el `422` sale después del bloque de idempotencia, bajo el lock: una clave existente repite la respuesta original o rechaza otro body ([D-19](#d-19)), y solo una clave reclamada recién llega al `422`. Saber si la clave existe es leer estado, así que va bajo el lock ([D-17](#d-17)): la LIMIT fuera del tope espera el lock como cualquier escritura. Con el lock tomado por otra escritura del mismo usuario, puede terminar en `503 LOCK_TIMEOUT` en vez de `422`; reintentada con la misma clave, responde `422`.

**Dónde se valida.** Siempre bajo el lock, con el estado del momento en que el movimiento se confirma:

- **MARKET y cash** (`place_order`): responden `422 LIMIT` y no se graba orden.
- **LIMIT al ejecutarse** (`execute_limit`): una venta valida cash + importe ≤ 10¹⁵ ARS; una compra, posición + `size` ≤ 2⁶². Si se violaría, la orden pasa a `CANCELLED` con `cancel_reason = 'LIMIT'`: sale del executor, libera su reserva y el reporte del executor la lista aparte ([D-28](#d-28)). El usuario ve el motivo en `GET /orders/:id`. Ejemplo: cash 999.999.999.999.000,00 ARS y una venta LIMIT de 1.000 a 5.000 que la cotización cruza. Ejecutarla dejaría el cash en 1.000.000.004.999.000,00, así que se cancela y el cash no cambia. Si en cambio el cash fuera 999.999.995.000.000,00, quedaría exactamente en 10¹⁵ y se ejecuta.

**Por qué al ejecutar y no al crear la `NEW`.** El cash puede crecer entre la creación y la ejecución, así que validar al crear no alcanza; validar al ejecutar cubre los dos casos. Antes, una LIMIT así se confirmaba fuera del tope o, si superaba `numeric(18,2)`, fallaba en cada corrida del executor y ocupaba un lugar del lote para siempre.

**El motivo queda en la orden** (issue #21). `orders.cancel_reason` es `USER` (la canceló su dueño), `LIMIT` (la canceló el executor por este tope) o `UNBACKED` (no tenía respaldo, [D-12](#d-12); migración `007`), y `NULL` en cualquier otro estado. Lo escriben `cancel_order_outcome`, `execute_limit_outcome` y `cancel_unbacked` en el mismo `UPDATE` que la cancela, bajo el lock. Un `CHECK` exige que esté si y solo si la orden está `CANCELLED`, y el trigger `orders_guard` aplica la misma regla en cada transición: el motivo se escribe al cancelar y después no cambia. Una cancelación sin motivo es lo que hacían las funciones anteriores, así que el trigger la rechaza con `APP04` (`503`, reintentable) y no con un `500` ([D-24](#d-24)). Las órdenes canceladas antes de la columna quedaron `USER` (migración `005`): no se guarda cuándo se canceló una orden ni el reporte del executor, y recalcular el tope con el cash de hoy no dice nada del cash de ese momento. Solo pueden ser `LIMIT` las que canceló el executor entre el PR del issue #2 y esta migración.

<a id="d-15"></a>
### D-15 — Valor total de la cuenta

`valor_total` = cash neto + Σ (cantidad × último precio) de las posiciones con precio. **No resta el cash reservado**: reservar no cambia lo que el usuario tiene, solo lo que puede usar, y eso es `cash.disponible`. Si alguna posición no tiene precio, no suma al total y `valuation_complete` es `false`. Una posición en corto heredada suma con valor negativo: es lo que se debe.

---

## Arquitectura

<a id="d-16"></a>
### D-16 — El balance se calcula, no se guarda

`orders` es la única fuente de verdad. El balance de un usuario es el resultado de recorrer sus órdenes `FILLED` en orden de ejecución ([D-18](#d-18)), como pide el enunciado. Cada lectura y cada autorización lo recalculan desde `orders`; no hay ninguna tabla de saldos que mantener en sincronía.

- Lo que lo hace viable es un **índice parcial por usuario sobre las órdenes ejecutadas**: una lectura toca solo la historia de ese usuario, no la tabla. Medido en un benchmark de 22 millones de órdenes: 3 ms por lectura de un usuario típico, p99 ≤ 26 ms a 400 requests por segundo.
- El costo de cada request crece con la historia del usuario. El mismo benchmark midió dónde deja de alcanzar (usuarios con más de 100.000 órdenes ejecutadas, consultados más de 2 veces por segundo) y qué lo resuelve (una caché del balance regenerable). Ese perfil de usuario no existe en el dataset del challenge, así que la caché queda medida y diferida: [`decision-snapshot.md`](decision-snapshot.md).

**Descartado: una tabla de balances actualizada en cada orden.** Exige mantener en sincronía dos verdades en cada escritura, y un bug ahí se vuelve permanente.

<a id="d-17"></a>
### D-17 — La base impone el protocolo de escritura

Toda escritura de órdenes pasa por una función de Postgres (`place_order`, `execute_limit`, `cancel_order`) que, en una transacción:

1. toma un **lock por usuario** (advisory lock),
2. lee el estado (órdenes ejecutadas + reservas),
3. decide,
4. escribe.

Antes del lock solo se validan los argumentos: su forma y que existan el usuario y el instrumento, datos que ninguna escritura de órdenes cambia. Nada que dependa de las órdenes o de las claves de idempotencia se lee antes del lock. Por eso un rechazo que tiene que respetar el replay de una clave anterior, como el tope por orden de [D-14](#d-14), sale después del bloque de idempotencia.

El rol con que se conecta la API **no tiene INSERT, UPDATE ni DELETE** sobre ninguna tabla, solo `EXECUTE` sobre esas funciones. Por eso es imposible saltearse el orden lock → leer → decidir → escribir.

**Por qué importa el orden.** Dos compras simultáneas que leen el saldo antes de tomar el lock ven el mismo disponible y se aprueban las dos: doble gasto. El trigger y los CHECKs no lo detectan, porque las dos filas son válidas por separado. `test/concurrency` lo demuestra en las dos direcciones: con la función oficial, una de las dos compras sale `REJECTED`; con una función de prueba que lee antes del lock, las dos salen `FILLED` y el cash queda negativo.

**Por qué advisory lock y no `SELECT … FOR UPDATE` ni `SERIALIZABLE`.** No hay una fila de "cuenta" que bloquear, y `FOR UPDATE` sobre las órdenes escribe en cada una. `SERIALIZABLE` detecta el conflicto y aborta, lo que obliga a reintentar. El advisory lock previene en lugar de detectar, no toca el heap y se libera solo al terminar la transacción. Es cooperativo, por eso las funciones son la única vía de escritura.

**Costo.** Todas las escrituras de un mismo usuario se serializan, incluidos los créditos. Entre usuarios distintos no hay espera.

<a id="d-18"></a>
### D-18 — Orden de ejecución: `balance_seq`, asignada al ejecutar

El orden por `id` es el de creación, no el de ejecución. Ejemplo: comprar 10 a 100 (id 1); dejar una LIMIT de compra de 10 a 50 (id 2, `NEW`); vender 10 (id 3); ejecutar la id 2. Ordenando por `id`, el costo final sería 75; el real es 50.

`balance_seq` se asigna cuando una orden pasa a `FILLED`, bajo el lock, como máximo + 1 del usuario. Invariantes en la base: existe si y solo si la orden está `FILLED`, es positiva, es única por usuario y es consecutiva (lo controla el trigger). `test/db/ledger.test.ts` reproduce el ejemplo.

<a id="d-19"></a>
### D-19 — Idempotencia de `POST /orders`

- La cabecera `Idempotency-Key` es obligatoria, con alcance por usuario.
- Misma clave y mismo body (comparado por hash SHA-256 del body validado, con claves ordenadas y `amount`/`price` canonizados a 2 decimales: `100`, `"100"`, `"100.0"` y `"100.00"` son el mismo body): devuelve **exactamente** la respuesta original con `Idempotent-Replay: true`, sin crear otra orden y sin reevaluar saldo ni precio.
- Misma clave con otro body: `422 IDEMPOTENCY_MISMATCH`.
- La clave se reclama dentro de la misma transacción y bajo el mismo lock que la orden, así que no puede haber orden sin clave ni dos órdenes con la misma clave.
- Un `REJECTED` es una respuesta válida y se conserva. `NO_PRICE` no consume la clave, porque la transacción se revierte entera.
- **Ventana de 24 h, decidida al escribir.** Una clave vence exactamente 24 h después de su `created_at` (`settings.idempotency_ttl`, leído por `app.idempotency_ttl()`: la única fuente del plazo). Lo decide `app.place_order` al reclamar la clave, bajo el lock, con el `now()` del inicio de su transacción: `INSERT … ON CONFLICT DO UPDATE … WHERE created_at < now() − ttl`. Una clave vencida se reusa en el lugar, como si no existiera: con el mismo body o con otro, el request crea una orden nueva y la fila queda con el hash, la respuesta y el `created_at` nuevos; la orden anterior sigue existiendo. Si ese request falla (`NO_PRICE`), la transacción se revierte y la fila vencida queda como estaba. Dos requests simultáneos sobre una clave vencida se serializan por el lock: el primero la renueva y el segundo ve una clave viva (replay o `422`). El job de limpieza (`app.cleanup_idempotency`, cada hora con `JOBS_ENABLED`) borra las claves vencidas, pero **solo recupera espacio**: el vencimiento no depende de que corra ([#4](https://github.com/dante0x95/cocos-challenge-a/issues/4)). Corre por usuario con try-lock, así que nunca borra una clave en medio de un replay. Y borra una clave **un minuto después** de que vence (`app.idempotency_purge_age()`), no apenas vence: un request que empezó con la clave viva decide con el `now()` de su transacción, y antes del lock de usuario puede esperar la barrera de despliegue ([D-23](#d-23)); si la limpieza la borrara en ese rato, el request crearía otra orden. Una escritura dura a lo sumo 5 s ([D-20](#d-20)), así que el minuto la cubre con margen. Esto deduplica reintentos HTTP; no es una referencia única de depósito.

**Por qué obligatoria.** Una orden es dinero. Sin clave, un reintento por timeout puede ejecutar dos veces.

**Transición de la canonización (issue #4).** Antes, `amount` y `price` entraban al hash tal como llegaban (`100` → `"100"`). Una clave grabada así guarda ese hash. La API le pasa a `app.place_order` también el hash que calculaba la versión anterior para ese mismo request (`p_legacy_hash`), y la función lo acepta **solo para reconocer una clave que ya existe**, en la misma sentencia, bajo el mismo lock y con el mismo tiempo máximo: el reintento que antes daba replay lo sigue dando, y un monto distinto sigue siendo `422`. Una clave nueva guarda siempre el hash canonizado. Como las claves vencen a las 24 h de `created_at` sin esperar a la limpieza, `legacyRequestHash` y `p_legacy_hash` se pueden quitar 24 h después del despliegue: una clave legada vencida se reusa y su reemplazo guarda el hash canonizado. No se borra ni se reescribe ninguna clave vigente.

<a id="d-20"></a>
### D-20 — Tiempos máximos y resultado desconocido

- Cada escritura (`place_order`, `execute_limit_outcome`, `cancel_order_outcome`) es **una sola sentencia** de la API, `SELECT app.<función>(...)`, que es también su transacción. El presupuesto lo hace cumplir la base:
  - `statement_timeout` de 5 s, fijado en el rol `api`: es el tiempo total de la escritura. Al vencer, Postgres cancela la sentencia y revierte todo, también el reclamo de la clave de idempotencia: `503 TIMEOUT`.
  - `lock_timeout` de 2 s, como cláusula `SET` de cada función que espera el lock de usuario: rige con cualquier conexión y el llamador no lo puede ampliar. Al vencer: `503 LOCK_TIMEOUT`.
- La espera por una conexión libre del pool, que la base no ve, la acota `PG_CONNECT_TIMEOUT_MS` (2 s por defecto): al vencer, `503 TIMEOUT` sin haber ejecutado nada.
- **El presupuesto tiene dos capas.** La base (`statement_timeout`) vale cuando su respuesta llega. Si la red descarta paquetes sin cerrar el socket, Postgres cancela la sentencia pero su respuesta tampoco llega, y del lado de Node nada vencería: la consulta esperaría para siempre con su conexión ocupada en el pool, y diez así dejaban a la API sin conexiones. Por eso el driver tiene un plazo local, `PG_QUERY_TIMEOUT_MS` (7 s por defecto, por encima de los 5 s de la base: en condiciones normales manda la base). Al vencer, `503 TIMEOUT` con "resultado desconocido" y la conexión se descarta (no vuelve al pool). Los dos relojes arrancan en momentos distintos (el servidor al leer la sentencia, el cliente al enviarla): si el cliente vence antes, la escritura puede haberse confirmado; es exactamente el caso del reintento con la misma clave. `keepAlive` no reemplaza esto: con los defaults de Linux detecta un peer muerto en minutos. El pool del bootstrap no lleva este plazo: `verify_ledger` es una sola sentencia sobre todos los usuarios.
- Las lecturas tienen el mismo `statement_timeout` del rol `api`.
- Todo `503` lleva `Retry-After`. Si la conexión se corta después de enviar la escritura, el resultado es **desconocido**, no "sin orden". El cliente debe reintentar con la misma `Idempotency-Key` para saber qué pasó: si la orden existe, el replay la devuelve.
- **Un corte de conexión responde `503 CONNECTION_LOST`**, no `500`: los errores de socket de Node (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `ECONNREFUSED`), los mensajes del driver cuando una conexión muere ("Connection terminated unexpectedly") y los `SQLSTATE` de conexión (clase `08`, `57P01` admin_shutdown, `57P03` cannot_connect_now) se traducen todos a ese `503` con `Retry-After`. El `500` queda solo para un bug, y aun así lleva la misma guía en el mensaje. La regla está escrita en [`docs/api/orders.md`](api/orders.md#errores): cualquier `5xx` o falta de respuesta es resultado desconocido y se reintenta con la misma clave. En el log, un corte es `warn` con la fase (`connect` o `query`), sin stack: un reinicio de la base corta una conexión por request en vuelo y no es un bug.

**Descartado: un deadline en la API que cancela la sentencia desde otra conexión (`pg_cancel_backend`).** Fue la primera versión (issue #1) y tenía dos defectos. El cancel pedía una conexión al mismo pool: con el pool lleno quedaba en cola y el deadline dejaba de funcionar justo cuando hacía falta. Y como `pg_cancel_backend` cancela lo que esté corriendo en un proceso, un cancel que llegaba tarde alcanzaba al request siguiente que había tomado esa conexión (`test/concurrency/timeouts.test.ts` lo reproduce). Con una sola sentencia por escritura, el `statement_timeout` es el deadline y no hay nada que cancelar desde afuera. De paso, `POST /orders` bajó de hasta 7 viajes a la base a 1, y la cancelación de 2 sentencias a 1: `cancel_order_outcome` devuelve el motivo (`ok`, `not_found`, `not_new`) junto con la orden.

<a id="d-21"></a>
### D-21 — Acceso a datos: `pg` y SQL directo, sin ORM. Express

- **Por qué sin ORM.** La API hace dos tipos de llamada: `SELECT app.place_order(...)` y `SELECT * FROM app.read_portfolio(...)`. Un ORM no aporta nada ahí. Además suele mapear `numeric` a `number` (justo lo que [D-13](#d-13) evita) e intenta escribir tablas que el rol `api` tiene prohibidas a propósito.
- **Por qué Express.** Lo nombra el enunciado, alcanza para lo que hace falta (rutas y JSON) y no decide nada por la aplicación.
- **Validación con zod en el borde.** Forma del request en la API; reglas de estado en la base.

<a id="d-22"></a>
### D-22 — Lógica en la base: dónde se puso y por qué

Poner lógica de negocio en Postgres tiene costos reales: herramientas de debug y test más pobres, despliegue acoplado a la base, la CPU de la base es lo más caro de escalar, y aparece un segundo lenguaje.

**Qué hay en la base y por qué:**
- **Lock, lectura, decisión y escritura** ([D-17](#d-17)). Es la única forma de que el protocolo no se pueda saltear: si viviera en TypeScript, bastaría una consulta en la conexión equivocada para el doble gasto, sin ningún error.
- **El fold del balance** (`app.c_state`). Lo necesita la autorización, que corre bajo el lock dentro de la función. Llevar el fold a la aplicación obligaría a abrir la transacción, tomar el lock, traer las filas, decidir en Node y volver a escribir, con la API sosteniendo el lock durante todo el viaje de red.

**Cómo se acota el costo:**
- **Una sola implementación del fold** en todo el sistema. La lectura, la autorización y la verificación de la migración usan la misma función.
- **Un oráculo independiente en TypeScript** (`test/oracle/fold.ts`), sin imports de `src/` ni de `db/`, contra el que se compara la base en historias aleatorias. No es duplicación sino lo que hace creíble a la primera implementación. Un error compartido entre la API y la base no pasaría esta prueba.
- **Las funciones son idempotentes** (`CREATE OR REPLACE`) y se reaplican en cada bootstrap. Desplegar un cambio es correr el bootstrap.

<a id="d-23"></a>
### D-23 — Barrera de despliegue

- Toda escritura toma un **lock compartido de despliegue** antes del lock de usuario. El bootstrap toma ese lock en modo exclusivo mientras aplica migraciones y funciones ([D-24](#d-24)): espera a que terminen las escrituras en curso y bloquea las nuevas hasta confirmar.
- Un escritor que ya había entrado a una función anterior y quedó esperando sigue con ese cuerpo después del `COMMIT`. Si eso choca con el esquema nuevo, la migración lo hace fallar con `APP04` (`503 VERSION_MISMATCH`), reintentable: el reintento usa la función nueva.
- Así desplegar es correr el bootstrap con la API viva, sin ventana en la que un escritor vea el esquema nuevo con las funciones viejas.

<a id="d-24"></a>
### D-24 — Migraciones: runner propio, versionadas más repetibles

- `db/migrations/*.sql` corren **una vez**, en orden. `public.schema_migrations` guarda el nombre y el checksum de cada una. Si un archivo ya aplicado cambió, el bootstrap **aborta**: se corrige con una migración nueva, no editando la vieja.
- `db/functions/*.sql` corren **siempre** (`CREATE OR REPLACE`). `CREATE OR REPLACE` no cambia los argumentos ni el tipo de lo que devuelve una función: cuando cambian, el archivo borra antes la firma anterior (si la base la tiene) en la misma transacción, y `090_privileges.sql` vuelve a dar los permisos.
- **Migraciones pendientes, funciones, la contraseña del rol `api` y la verificación de la historia van en una sola transacción**, con la barrera de despliegue de [D-23](#d-23) en modo exclusivo: espera a las escrituras en curso y frena las nuevas hasta el `COMMIT`. Ningún escritor ve un esquema nuevo con funciones viejas, y un bootstrap que falla en cualquier paso, también en la verificación posterior a migrar, no deja nada aplicado. Un escritor que ya había entrado a una función anterior y quedó esperando sigue con ese cuerpo después del `COMMIT`: si eso choca con el esquema nuevo, la migración lo hace fallar con un error reintentable (en `005`, una cancelación sin motivo da `APP04` → `503`; issue #21).
- `000_seed.sql` es el `database.sql` del challenge **sin modificar**. Si la base ya tiene las tablas del challenge (datos propios), se registra como aplicado sin correrlo.
- La migración de datos ([D-04](#d-04), [D-05](#d-05)) se **audita antes** (`002_audit.sql` aborta con el detalle si algún dato viola una regla nueva) y se **verifica después**: el cash que da el fold tiene que coincidir con una suma directa de importes. Un corto heredado ([D-01](#d-01)) o una historia fuera de lo representable (un importe o un cash por encima de los tipos de [D-14](#d-14)) se informan en el log y no abortan: ese usuario no puede operar hasta que se corrija su historia; los demás, sí.
- **La historia heredada puede traer `LIMIT NEW` sin respaldo** (insertadas en `orders` sin pasar por `place_order`): venta sin las acciones, compra sin el cash, o una orden sobre una moneda (el `CHECK orders_cash_shape` no lo impide para una compra). La verificación las señala con `problem = 'reserva'` (por usuario, cash reservado ≤ cash del fold; por instrumento, acciones reservadas ≤ tenencia; ninguna `NEW` sobre `MONEDA`) y el bootstrap las cancela con `cancel_reason = 'UNBACKED'` y lo registra en el log, en vez de abortar: es una decisión pendiente, no un hecho ([D-01](#d-01), [D-12](#d-12)). La cancelación la hace `app.cancel_unbacked`, dentro de la misma transacción del bootstrap y bajo el lock de cada usuario: con la barrera de despliegue tomada no entra ninguna escritura entre la verificación y la cancelación, pero decide con el estado que lee bajo el lock, como toda escritura ([D-17](#d-17)). Recorre las `NEW` por id y conserva cada una que tenga respaldo descontando lo que reservan las conservadas antes: queda lo que el executor ejecutaría si todas cruzaran ahora, en orden de id, y lo reservado vuelve a caber en el cash y en la tenencia, que es el invariante que `place_order` mantiene en régimen. La migración `007` agrega el motivo al `CHECK` (issue #6).
- **Por qué no una herramienta de migraciones.** El runner tiene 150 líneas y hace exactamente esto. Una herramienta como `node-pg-migrate` serviría igual con el mismo SQL; no hace falta para este alcance.

---

## API

<a id="d-25"></a>
### D-25 — Búsqueda de activos

- `GET /instruments?q=` busca por ticker **y** por nombre, sin distinguir mayúsculas, por coincidencia parcial. Los comodines `%` y `_` se buscan literalmente.
- Orden: ticker exacto, ticker que empieza con `q`, nombre que empieza con `q`, el resto; después por ticker. Así, buscar `pamp` devuelve PAMP primero.
- La moneda (ARS, tipo `MONEDA`) se excluye por defecto, porque no es un activo que se pueda comprar. Se incluye con `include_cash=true`.
- **Sin índice, a propósito.** `instruments` tiene 66 filas: recorrerla entera es más rápido que cualquier índice, y Postgres no usaría uno. Si el catálogo creciera a decenas de miles, lo indicado sería un índice GIN `pg_trgm` sobre `ticker` y `name`, que sirve para `ILIKE '%q%'`.

<a id="d-26"></a>
### D-26 — Consulta y cancelación de una orden: siempre con el `userid` del dueño

- `GET /orders/:id?userid=…` y `POST /orders/:id/cancel` con `{ "userid": … }`: el `userid` es obligatorio en los dos. Sin él, o inválido, `400`.
- Una orden de otro usuario responde `404` con **el mismo cuerpo** que una inexistente (`orden <id> inexistente para el usuario <userid>`). Un `403` confirmaría que el id existe, y como los ids son incrementales se podrían enumerar todas las órdenes.
- El filtro va en la misma consulta (`WHERE id = $1 AND userid = $2`): una orden ajena no se lee para compararla después.
- La cancelación es una transición de estado (`NEW` → `CANCELLED`), no un borrado. Por eso es `POST` sobre una acción y no `DELETE`.
- Una orden que ya no está `NEW` responde `409 NOT_CANCELLABLE` con su estado actual.
- Una orden `CANCELLED` dice por qué: `cancel_reason` es `USER` si la canceló su dueño y `LIMIT` si la canceló el executor por [D-14](#d-14). En cualquier otro estado es `null`. Va en `GET /orders/:id`, en el `200` de la cancelación y en la orden del `409`. `POST /orders` también lo incluye (siempre `null`: una orden nueva no está cancelada), así la orden tiene la misma forma en los tres endpoints.
- La cancelación corre bajo el mismo lock que el executor, así que una cancelación y una ejecución simultáneas no pueden ganar las dos (`test/concurrency`).

<a id="d-27"></a>
### D-27 — Sin autenticación

No la pide el enunciado. El `userid` viaja en el path, la query o el body. Aun sin autenticación, la API no expone los datos de un usuario a quien pregunta por otro: cada recurso se pide junto con el `userid` de su dueño, y uno ajeno responde igual que uno inexistente ([D-26](#d-26)). En producción, el `userid` saldría del token y nunca del request; el contrato de cada endpoint no cambiaría, solo el origen del `userid`.

<a id="d-28"></a>
### D-28 — Executor de LIMIT: interno, manual y por lotes

`POST /internal/execute-limits` busca las LIMIT que el `close` vigente cruza y llama `execute_limit_outcome` para cada una, en su propia transacción. La decisión final la toma la función, bajo el lock y con la cotización releída: ejecutarla, no tocarla (ya no está `NEW` o no cruza) o cancelarla porque violaría [D-14](#d-14). `execute_limit` es la misma función con resultado booleano. El reporte lista las canceladas por el tope aparte de las ejecutadas, y la orden queda con `cancel_reason = 'LIMIT'` ([D-14](#d-14)), así no se confunde con una cancelación del usuario.

**No corre solo.** El enunciado dice que no hace falta simular el mercado, y ejecutar órdenes sin que nadie lo pida cambiaría los datos que el evaluador mira. Existe para que el ciclo completo se pueda demostrar.

Los endpoints `/internal/*` exigen la cabecera `X-Internal-Token`. Si `INTERNAL_TOKEN` no está configurado, no existen.

**Con muchas pendientes** (issue #9). La primera versión estaba dimensionada para el seed (dos `NEW`): recorría todas las pendientes evaluando la cotización por orden, tomaba "las 500 de menor id" sin reparto ni cursor y las ejecutaba en un bucle sin presupuesto. Ahora:

- **Candidatas por índice.** `app.limit_candidates(max, after_id, per_user)` resuelve la cotización una vez por instrumento (CTE materializado sobre `app.instruments` + `valid_close`) y busca las órdenes por rango en el índice parcial `orders_new_limit_by_price (instrumentid, side, price) WHERE status = 'NEW' AND type = 'LIMIT'` (migración `008`): compra con `price ≥ close`, venta con `price ≤ close`. Nada se evalúa por fila pendiente; el reparto y el orden final solo tocan las que cruzan. La subconsulta por instrumento lleva `OFFSET 0` para que el planificador no la aplane en un hash join con recorrido completo de las pendientes, que es lo que elige cuando estima que un tercio cruza. Medido en local con 50.000 `NEW` sembradas, como `api`: la versión anterior tardaba ~380 ms por llamada (50.000 llamadas a `valid_close`); la actual, ~3 ms con y sin cursor. `test/db/executor` fija la forma del plan.
- **Reparto por usuario.** A lo sumo `per_user` órdenes de un mismo usuario por corrida (`row_number() OVER (PARTITION BY userid ORDER BY id)`, antes del `LIMIT`): un usuario con miles de pendientes no llena el lote solo. Las suyas que quedan afuera entran en las corridas siguientes.
- **Cabeza de línea.** Al primer `55P03` de un usuario (lock tomado) el executor saltea sus demás órdenes del lote y lo informa en `skipped_users`; al primer `APP01` de un instrumento (se quedó sin cotización válida entre la selección y la ejecución), las demás de ese instrumento, en `skipped_instruments`. Ninguno de los dos es un error del lote: no van a `errors`, y las órdenes siguen `NEW` para la corrida siguiente.
- **Cursor.** El reporte devuelve `after_id` (el último id que la corrida procesó) mientras el lote siga; el endpoint lo acepta y continúa desde ahí. Cuando el lote se agota, `after_id` es `null` y la próxima corrida empieza de cero. Las salteadas quedan detrás del cursor hasta esa vuelta. **Latencia:** una orden que empieza a cruzar (o se crea) con un id menor que el cursor espera a la vuelta siguiente; con `n` pendientes que cruzan y lotes de `max`, eso es a lo sumo `⌈n / max⌉` corridas más.
- **Presupuesto.** `max_ms` por corrida (por defecto 10 s): al vencer, la corrida no empieza otra sentencia y devuelve `remaining` (candidatas del lote que no intentó) con el `after_id` de la última procesada. La sentencia en curso termina sola, con los tiempos de la base ([D-20](#d-20)): nunca se cancela desde la API, así que una orden queda `FILLED` o `NEW`, nunca a medias. `max`, `per_user`, `after_id` y `max_ms` se validan con Zod: un valor inválido o repetido responde `400`, nunca `500`.

**Sin paralelismo, por ahora.** Las órdenes de un mismo usuario no pueden ejecutarse a la vez (comparten el lock y la secuencia del balance), así que repartir el lote entre workers exigiría agrupar por usuario y limitar los workers a la mitad del pool. Con el cursor y el presupuesto, varias corridas en serie recorren cualquier cantidad de pendientes sin que ninguna se eternice; si la latencia de una vuelta completa se vuelve un problema, ese es el siguiente paso.

---

## Despliegue

<a id="d-29"></a>
### D-29 — Despliegue: Fly.io, staging y producción, deploy continuo desde `main`

**Qué se despliega.** Dos entornos, `staging` y `production`, cada uno con dos apps de Fly.io en `gru` (São Paulo, la región más cercana): la API (producción: `cocos-challenge-a-api`, `fly.toml`; staging: `cocos-challenge-a-staging`, `deploy/fly/staging.toml`), con la misma imagen que `docker compose`, y Postgres 18 (`cocos-challenge-a-db`, `deploy/fly/db.toml`; `cocos-challenge-a-staging-db`, `deploy/fly/staging-db.toml`) con la imagen oficial y un volumen, sin puertos públicos: la API la alcanza por la red privada. Cada commit de `main` con `ci` en verde se despliega solo (`.github/workflows/deploy.yml`): primero en staging y después, con aprobación, en producción, con los mismos pasos en cada entorno:

1. **El commit tiene que descender del release que atiende.** El workflow lee `release` de `GET /health` y verifica `git merge-base --is-ancestor <release> <commit>` (`deploy/fly/release-check.sh before`). `workflow_run` dispara con cualquier corrida de `ci` que termine en verde con evento `push` sobre `main`, incluida una reejecutada a mano sobre un commit anterior: sin este gate, ese re-run desplegaría un commit viejo encima del actual. Volver a desplegar el mismo commit pasa; un commit anterior, o de otra rama, frena el deploy con el motivo. Si `/health` no responde o no informa `release`, también frena: el primer deploy es `deploy/fly/setup.sh`, parado en `main`.
2. **La imagen se construye una sola vez**, en el job `image` del workflow: se publica en GHCR etiquetada con el SHA y se toma su digest (`deploy/fly/image-digest.sh`). Los dos entornos despliegan ese digest (`flyctl deploy --image <repo>@sha256:…`), no la etiqueta: otra corrida del mismo commit puede sobrescribir la etiqueta mientras producción espera la aprobación, y reconstruir no garantiza los mismos bytes.
3. `release_command` corre el bootstrap ([D-24](#d-24)) en una máquina aparte, con la versión anterior todavía atendiendo. Migraciones, funciones, la contraseña del rol `api` y la verificación de la historia van en una transacción bajo la barrera de despliegue ([D-23](#d-23)): si algo falla, también la verificación posterior a migrar, la CLI sale con 1, no queda nada aplicado, la versión anterior sigue escribiendo y el deploy se corta. Sin calentamiento ni versión del cálculo: el `release_command` es corto y acotado.
4. Estrategia `bluegreen`: las máquinas nuevas reciben tráfico solo si `/health` responde 2xx. Si no, el deploy falla y siguen las anteriores; no hace falta volver atrás.
5. **`/health` tiene que atender ese commit.** El workflow lo verifica desde afuera, por el dominio público: `ok: true` y `release` igual al SHA (`deploy/fly/release-check.sh after`). Si el deploy no hubiera cambiado nada, `release` sería el commit anterior; reintenta mientras lo sea, porque la conmutación tarda, con un límite (30 intentos cada 5 segundos). Es un bucle en bash y no `curl --retry`, que solo reintenta errores de transporte y no un `jq` que falla.
6. **Si algo falla desde que empieza el deploy, el entorno vuelve solo a la versión anterior.** bluegreen protege antes de conmutar, no después: las máquinas nuevas pueden pasar el check de Fly y después el dominio público no atender el commit, o `flyctl deploy` puede fallar después de habilitarlas, al retirar las anteriores. En los dos casos el paso `rollback.sh restore` mira las máquinas (no lo que dijo `flyctl`), vuelve a la imagen que corría antes del deploy (anotada con `rollback.sh record`), con su `RELEASE`, cada máquina de la API que no esté ya así, y exige que `/health` atienda otra vez ese release; el job queda en rojo. Si el deploy falló antes de conmutar, todas siguen en la imagen anterior y no toca ninguna. Cambia la imagen con `flyctl machine update` y no con `flyctl deploy`, para no correr el `release_command` de la versión anterior: sus funciones reemplazarían a las nuevas sobre un esquema ya migrado. La base queda con las migraciones y funciones nuevas, que es con lo que la versión anterior atiende en cualquier deploy hasta que se conmuta ([D-24](#d-24)). Cada máquina se reinicia al cambiar de imagen: un corte breve.

`/health` devuelve `release` (variable `RELEASE`, que el deploy pasa con `--env RELEASE=$SHA`) también en el `503` con la base caída: el gate necesita saber qué commit atiende aunque la base no responda. Sin la variable, como en `docker compose`, es `null`.

No hay deploy manual desde GitHub: un commit que no pasó por el CI no se despliega. Re-desplegar es volver a correr el workflow de ese commit. Corre un deploy a la vez por entorno, sin cortar el que está en curso, y los que llegan mientras tanto esperan todos en orden de llegada (`queue: max`; el grupo es de cada job de deploy y no del workflow, para que una aprobación de producción pendiente no frene el staging de los merges siguientes): con la cola por defecto de GitHub cada pendiente nuevo cancela al anterior, y un re-run del `ci` de un commit viejo cancelaría el deploy pendiente de un merge más nuevo, que quedaría sin desplegar. Si el `ci` de un merge más viejo termina después que el de uno más nuevo, su deploy se frena en el gate: una corrida en rojo que no cambia nada. Un operador con `flyctl` y el token puede desplegar a mano (`fly deploy --env RELEASE=<sha de main>`), fuera del workflow: es lo que haría falta si el release que atiende dejara de estar en la historia de `main`.

Los secretos (URLs de la base, contraseña del rol `api`, `INTERNAL_TOKEN`) se generan una vez en `deploy/fly/setup.sh` y viven en Fly; en GitHub solo está `FLY_API_TOKEN`, un token de deploy acotado a una app: uno por environment (`staging` y `production`), como secreto del environment, porque un token de deploy de Fly se acota a una sola app (`fly tokens create deploy -a <app>`). Cada job lee el de su environment, y el de staging no puede desplegar producción.

**Alternativas.**
1. **Fly.io.** Corre la imagen tal cual; `release_command`, health checks y bluegreen cubren migrar antes y no cortar el tráfico sin escribir infraestructura.
2. **Render.** Equivalente en lo simple (pre-deploy command, Postgres administrado), pero el Postgres administrado no garantiza la versión 18, que es la que corren el CI y `docker compose`.
3. **AWS ECS + RDS.** Lo más cercano a una producción real, pero exige VPC, task definitions e IaC: mucho más trabajo y costo que lo que prueba en un challenge.

**Decisión: 1**, primero con un solo entorno (issue #12) y después, como segunda etapa (issue #13), **una imagen, dos entornos**: el workflow construye la imagen una sola vez y la publica en GHCR etiquetada con el SHA (`ghcr.io/dante0x95/cocos-challenge-a:<sha>`), y los dos entornos despliegan su digest; `staging` (`cocos-challenge-a-staging`, `deploy/fly/staging.toml`, con su propia base) la despliega en cada merge, con el mismo gate y el mismo check de `/health`; `production` (`fly.toml`) despliega **la misma imagen** después, detrás del environment `production` de GitHub, que exige aprobación manual (Settings → Environments → `production` → required reviewers: es configuración del repo, no se puede fijar en el workflow; sin reviewers configurados, el job no espera). Lo que staging prueba antes que producción: el `release_command` (migraciones y funciones sobre una base con la misma forma) y el arranque de esa imagen exacta; lo que no prueba: la carga real. Un token de deploy por app, cada uno en el secreto `FLY_API_TOKEN` de su environment. La imagen que corre en producción es, byte a byte, la que pasó por staging.

**Cómo se prueba.** Lo que depende del código corre en el CI contra Postgres 18: `/health` con `release`, y en `503` con `db: "down"` y el mismo `release` si la consulta de salud falla en Postgres; el servidor real toma `RELEASE` del entorno; la CLI del bootstrap sale con 1 si una migración falla, y un bootstrap que falla en la verificación posterior a migrar no deja nada aplicado; con la API real atendiendo mientras el bootstrap migra, las requests en curso esperan y terminan bien, o, si el bootstrap tarda más que el `lock_timeout`, las escrituras responden `503 LOCK_TIMEOUT` reintentable (nunca `500`) y el reintento deja una orden por clave. Esa prueba encontró que `090_privileges.sql` tomaba `AccessExclusiveLock` sobre todas las tablas en cada bootstrap (`ALTER ... OWNER TO` sin cambios) y una lectura en curso terminaba en deadlock con el bootstrap; ahora solo cambia el dueño de lo que no es de `app_owner`. `test/unit/deploy-workflow` evalúa la condición del workflow contra cada conclusión y evento del CI, simula su cola de concurrencia (un re-run viejo no desplaza a un deploy pendiente), fija el orden de sus pasos y el checkout del commit en cada job, sigue el digest de la imagen hasta los dos deploys, corre `image-digest.sh` con un `docker` simulado, `rollback.sh` con `flyctl` y `curl` simulados (vuelve cada máquina a la imagen anterior y exige `/health` con el release anterior) y `setup.sh` en un repositorio temporal con `fly` simulado (apps, configuración y secretos de cada entorno, sin credenciales en argumentos ni salida), compara el montaje del volumen de Postgres con el de `docker compose` y corre `deploy/fly/release-check.sh` con un `curl` simulado y un repositorio temporal: frena un commit anterior al release actual y uno de otra rama, deja pasar el mismo commit y uno posterior, y reintenta hasta el límite mientras `release` sea el anterior. Lo que depende de Fly (`release_command`, bluegreen, el workflow contra la app real, el volumen) lo ejercita `deploy/fly/drills.sh` **a mano, con la cuenta; no corre en el CI**: verifica que el último merge pasó por `ci` y deploy y que `/health` lo atiende; despliega un release con el bootstrap roto y otro con `/health` en `503`, y reejecuta el `ci` de un commit viejo, y esos tres tienen que fallar y seguir atendiendo el release anterior; aparte, `persistence` escribe un dato, redespliega la base y exige que siga.

**Lo que cuesta y los límites conocidos.**
- **La credencial de administrador queda en las máquinas de la API.** Los secretos de Fly son por app: `DATABASE_ADMIN_URL`, que solo usa el `release_command`, está también en las máquinas que atienden. La API sigue conectándose con el rol `api`, que no puede escribir tablas ([D-17](#d-17)), pero un proceso comprometido en esa máquina tendría la credencial de owner, y en producción eso vacía esa garantía. La alternativa es una app aparte para el release: una máquina con la misma imagen y solo `DATABASE_ADMIN_URL`, que el workflow despliega antes que la API, y la app de la API con `DATABASE_URL` solamente. Queda como límite conocido: duplica apps y pasos del workflow para un solo entorno.
- **El executor de LIMIT no corre solo** ([D-28](#d-28)). En producción lo llamaría un cron externo cada N minutos: `POST /internal/execute-limits` con `INTERNAL_TOKEN`, desde una máquina programada de Fly (`fly machine run <imagen con curl> --schedule hourly`; el mínimo del scheduler de Fly es una hora) o desde un cron del operador si hace falta más seguido. No se implementa: con las cotizaciones del seed no ejecutaría nada, y ejecutar órdenes sin que nadie lo pida cambiaría los datos que el evaluador mira.
- Postgres corre en una sola máquina con un volumen: sin réplica ni backups administrados (Fly hace snapshots diarios del volumen). Para producción iría a un Postgres administrado con la misma versión.

---

<a id="fuera-de-alcance"></a>
## Fuera de alcance y límites conocidos

| Qué | Estado |
|---|---|
| Resultado **realizado** de ventas pasadas | No se calcula. La función que vende conoce el costo promedio vigente; registrar `(orden, costo, ingreso)` en cada venta lo habilitaría sin tocar el resto. |
| Liquidación (T+0 / T+1) | No se distingue: el disponible es inmediato. |
| Ejecuciones parciales, comisiones, impuestos | No existen en este modelo. |
| Vencimiento de órdenes `NEW` | Una LIMIT queda `NEW` hasta que se ejecuta o se cancela. |
| Historia larga | El costo de cada lectura y autorización crece con las órdenes `FILLED` del usuario. Medido: alcanza hasta cientos de miles de órdenes por usuario a baja frecuencia; por encima, la caché medida en [`decision-snapshot.md`](decision-snapshot.md). Las `NEW` tampoco están acotadas: 5 usuarios con 2.000 cada uno no movieron la latencia. |
| Serie temporal del portfolio | No se guarda ningún balance. Una fila por día daría la evolución del valor de la cuenta. |
| Autenticación | Ver [D-27](#d-27). |
| Calendario hábil | La antigüedad de una cotización se mide en días corridos. |
| Credencial de administrador en las máquinas de la API | Los secretos de Fly son por app: `DATABASE_ADMIN_URL`, que solo usa el `release_command`, queda también en las máquinas que atienden. La alternativa es una app aparte para el release, con la misma imagen y solo esa credencial, desplegada antes que la API ([D-29](#d-29)). |
| Executor de LIMIT programado | No corre solo ([D-28](#d-28)). En producción lo llamaría un cron externo cada N minutos (`fly machine run --schedule`, o un cron del operador) contra `POST /internal/execute-limits` ([D-29](#d-29)). |
