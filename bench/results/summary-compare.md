# Resumen del benchmark — A vs Z vs C-frio vs C-caliente

Generado 2026-10-28T20:17 desde 25 corrida(s) en `bench/results`. Latencias en ms. SLA de referencia: p99 < 500 ms, fallos < 0,1 %, 0 descartadas.

| perfil | escenario | RPS | var | GET p50 | GET p95 | GET p99 | POST p50 | POST p99 | fallos % | descartadas | iteraciones | códigos | órdenes | restore |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| medium | read-heavy | 1 | Z | 60000 | 60001 | 60003 | 60001 | 60002 | 100.000 | 0 | 270 |  |  | restore+vacuum: 61 s |
| medium | read-heavy | 2 | Z | 60000 | 60003 | 60004 | 60000 | 60017 | 100.000 | 21 | 520 |  |  | restore+vacuum: 46 s |
| medium | read-heavy | 5 | Z | 60002 | 60005 | 60005 | 60002 | 60005 | 100.000 | 101 | 125 |  |  |  |
| medium | read-heavy | 50 | A | 3 | 11 | **23** | 5 | 42 | 0.033 | 0 | 3001 |  |  |  |
| medium | read-heavy | 100 | A | 2 | 8 | **19** | 4 | 11 | 0.003 | 0 | 30001 |  |  | restore+vacuum: 102 s |
| medium | read-heavy | 100 | C-caliente | 2 | 4 | **5** | 5 | 11 | 0.007 | 0 | 30000 |  |  | restore+vacuum: 81 s, calentamiento: 300 s |
| medium | read-heavy | 100 | C-frio | 2 | 7 | **17** | 5 | 45 | 0.010 | 0 | 30001 |  |  | restore+vacuum: 91 s |
| medium | read-heavy | 200 | A | 2 | 7 | **17** | 3 | 10 | 0.010 | 0 | 60001 |  |  | restore+vacuum: 81 s |
| medium | read-heavy | 200 | C-caliente | 2 | 2 | **8** | 4 | 17 | 0.007 | 0 | 60000 |  |  | restore+vacuum: 78 s, calentamiento: 303 s |
| medium | read-heavy | 200 | C-frio | 2 | 8 | **25** | 4 | 66 | 0.005 | 0 | 60001 |  |  | restore+vacuum: 82 s |
| medium | read-heavy | 400 | A | 1 | 7 | **23** | 2 | 26 | 0.009 | 0 | 120001 |  |  | restore+vacuum: 82 s |
| medium | read-heavy | 400 | C-caliente | 1 | 2 | **3** | 2 | 7 | 0.005 | 0 | 120000 |  |  | restore+vacuum: 86 s, calentamiento: 290 s |
| medium | read-heavy | 400 | C-frio | 1 | 8 | 87 | 4 | 149 | 0.007 | 148 | 119852 |  |  | restore+vacuum: 89 s |
| medium | whale | 1 | Z | 60000 | 60003 | 60004 | 60000 | 60003 | 100.000 | 0 | 270 |  |  | restore+vacuum: 50 s |
| medium | whale | 2 | A | 557 | 780 | 795 | 52 | 91 | 0.000 | 0 | 600 |  |  | restore+vacuum: 79 s |
| medium | whale | 2 | C-caliente | 13 | 17 | **20** | 10 | 15 | 0.000 | 0 | 601 |  |  | restore+vacuum: 83 s, calentamiento: 288 s |
| medium | whale | 2 | C-frio | 12 | 20 | **62** | 11 | 30 | 0.000 | 0 | 600 |  |  | restore+vacuum: 83 s |
| medium | whale | 5 | A | 60000 | 60000 | 60001 | 59999 | 60002 | 96.813 | 194 | 1161 |  |  | restore+vacuum: 80 s |
| medium | whale | 5 | C-caliente | 13 | 18 | **22** | 10 | 17 | 0.000 | 0 | 1501 |  |  | restore+vacuum: 75 s, calentamiento: 284 s |
| medium | whale | 5 | C-frio | 60000 | 60007 | 60007 | 59999 | 60007 | 99.828 | 195 | 1160 |  |  | restore+vacuum: 90 s |
| medium | whale | 20 | A | 60000 | 60003 | 60004 | 60000 | 60004 | 98.507 | 3467 | 2345 |  |  | restore+vacuum: 85 s |
| medium | whale | 20 | C-caliente | 10 | 13 | **14** | 6 | 10 | 0.000 | 0 | 6001 |  |  | restore+vacuum: 73 s, calentamiento: 281 s |
| medium | whale | 20 | C-frio | 60000 | 60003 | 60005 | 60000 | 60004 | 100.000 | 3501 | 2330 |  |  | restore+vacuum: 80 s |
| medium | whale | 100 | C-caliente | 8 | 10 | **11** | 5 | 7 | 0.000 | 0 | 30001 |  |  | restore+vacuum: 76 s, calentamiento: 292 s |
| medium | whale | 100 | C-frio | 59999 | 60001 | 60003 | 59999 | 60008 | 100.000 | 27501 | 2500 |  |  | restore+vacuum: 83 s |

Negrita en GET p99 = la corrida cumple el SLA completo (p99, fallos y descartadas).
