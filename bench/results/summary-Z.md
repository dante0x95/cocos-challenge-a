# Resumen del benchmark — Z

Generado 2026-10-28T02:03 desde 4 corrida(s) en `bench/results`. Latencias en ms. SLA de referencia: p99 < 500 ms, fallos < 0,1 %, 0 descartadas.

| perfil | escenario | RPS | var | GET p50 | GET p95 | GET p99 | POST p50 | POST p99 | fallos % | descartadas | iteraciones | códigos | órdenes | restore |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| medium | read-heavy | 1 | Z | 60000 | 60001 | 60003 | 60001 | 60002 | 100.000 | 0 | 270 |  |  | restore+vacuum: 61 s |
| medium | read-heavy | 2 | Z | 60000 | 60003 | 60004 | 60000 | 60017 | 100.000 | 21 | 520 |  |  | restore+vacuum: 46 s |
| medium | read-heavy | 5 | Z | 60002 | 60005 | 60005 | 60002 | 60005 | 100.000 | 101 | 125 |  |  |  |
| medium | whale | 1 | Z | 60000 | 60003 | 60004 | 60000 | 60003 | 100.000 | 0 | 270 |  |  | restore+vacuum: 50 s |

Negrita en GET p99 = la corrida cumple el SLA completo (p99, fallos y descartadas).
