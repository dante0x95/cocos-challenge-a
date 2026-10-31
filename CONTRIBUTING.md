# Cómo se trabaja en este repositorio

## Idioma

- **Código e identificadores en inglés:** variables, funciones, tablas, columnas, archivos.
- **Todo lo que lee una persona en español:** comentarios, nombres de tests, mensajes de error de la API, docs, commits y PRs.

## Flujo de un cambio

1. Cada cambio nace de un issue, con el problema, la decisión tomada y su plan de pruebas.
2. Rama por issue (`<tipo>/<issue>-<slug>`, por ejemplo `fix/4-decimal2-canonico`) y un PR por issue, abierto **en borrador**.
3. Un PR que arregla un defecto incluye un test que falla sin el arreglo.
4. El CI tiene que quedar en verde:
   - `ci`: tipos, tests unitarios y tests contra Postgres 18 real.
   - `commit-messages`: formato de cada commit y del título + descripción del PR.
5. Con el CI en verde, Dante corre la [revisión de Codex](#revisión-de-codex).
6. Cada hallazgo se responde en su hilo con `FIXED <sha>` (y el commit que lo arregla) o `JUSTIFIED <motivo>`. Después se vuelve a correr la revisión.
7. Con `codex/review` en verde, el PR se marca **ready for review** y Dante lo integra con **squash merge**. Antes no se puede: `ready-gate` devuelve a borrador un PR que se marca ready sin `codex/review` en verde.

`main` está protegida por un ruleset sin bypass (también para administradores): no se integra nada sin `ci`, `commit-messages` y `codex/review` en verde. `ready-gate` (`.github/workflows/ready-gate.yml`, que corre `scripts/ready-gate.sh`) usa `pull_request_target`: corre el workflow y el script de `main`, sin checkout del PR, así que un PR no puede cambiar su propia gate. Decide sobre el head y el status vigentes, no los del evento, y de a una corrida por PR: una corrida atrasada no revierte un PR aprobado ni aprueba un commit nuevo con el status de uno anterior. Si no puede confirmar `codex/review` en verde (la API no responde, el head se mueve), devuelve el PR a borrador; si tampoco puede convertirlo, falla diciéndolo. `test/unit/ready-gate.test.ts` lo prueba con `gh` simulado.

En los checks de un PR cada workflow aparece con el nombre de su job: `ci` (workflow `ci`), `commit-messages` (workflow `pr-format`) y `codex-review-before-ready` (workflow `ready-gate`). `codex/review` no es un workflow: es el commit status que fija la [revisión de Codex](#revisión-de-codex).

## Formato de commits y PRs

Obligatorio. Con squash merge, el título y la descripción del PR son el commit que queda en `main`, así que la misma regla vale para los dos.

```
<tipo>(<alcance>): <resumen en imperativo, ≤ 72 caracteres>

Problema:
<qué pasaba, con un ejemplo concreto>

Valor para el negocio:
<qué cambia para un usuario u operador, en lenguaje simple>

Solución:
- <qué cambió en el código>

Cómo se probó:
- automático: <comando y tests; cuál falló antes del cambio>
- manual: <pasos, o "n/a">

Refs: #<issue>
```

- Tipos: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`. El alcance es opcional, en minúsculas (`orders`, `portfolio`, `db`).
- El título no termina en punto.
- Después de `Refs:` solo van trailers de git (`Co-Authored-By: …`) y lo que agregan las herramientas: la línea `🤖 Generated with …`, URLs sueltas y un pie libre que empieza con una línea `---` (lo que sigue al `---` no se valida). Cualquier otro texto después de `Refs:` se rechaza.
- En un PR, el título se valida tal cual: no puede empezar con `#` ni estar vacío, aunque la descripción tenga un mensaje completo.
- Los docs versionados (`README.md`, `docs/`, este archivo) no dicen cuántas pruebas hay: ese número cambia con cada PR que agrega una y hace chocar a dos PRs en paralelo. La cuenta va en "Cómo se probó" del PR. `test/unit/docs` falla si un `.md` versionado tiene un número seguido de "pruebas" o "tests".
- Cada archivo `test/**/*.test.ts` nuevo lleva su fila en la tabla de [`docs/testing.md`](docs/testing.md#qué-prueba-cada-suite), y los docs no enlazan al repositorio `dante0x95/cocos-challenge` (sin `-a`), que es privado. `test/unit/docs-sync` falla si no.

Lo valida `scripts/commit-msg/check.ts`: en el CI (job `commit-messages`) y, si se activa, como hook local:

```bash
pnpm hooks:install   # git config core.hooksPath scripts/githooks
```

## Revisión de Codex

Una sola revisión por PR, que combina lo funcional (¿resuelve el issue?, ¿los tests fallarían si el arreglo se rompiera?) con la calidad del código. Corre en la máquina de Dante; ninguna API key sube a GitHub.

```bash
scripts/codex-review.sh <número de PR>             # publica en el PR y fija codex/review
scripts/codex-review.sh <número de PR> --dry-run   # muestra lo que publicaría, sin publicar
scripts/codex-review.sh <número de PR> --after-rebase   # PR aprobado que después se rebaseó
```

- Exige que `ci` y `commit-messages` existan y pasen en el último commit del PR (omitido o pendiente no cuenta); ningún otro check puede fallar ni estar pendiente.
- Toma el prompt (`docs/process/review-prompt.md`), las reglas (`docs/process/review-rules.md`) y el schema de la salida de la rama base: un PR no puede ablandar a su propio revisor.
- Le da a Codex el issue que cita `Refs:`, el diff y, desde la segunda corrida, los hallazgos anteriores con sus respuestas. Codex tiene que dar una disposición a cada hallazgo anterior, también si su hilo se cerró a mano: el estado del hilo no reemplaza su verificación.
- Publica un review con el veredicto, la tabla de cobertura de las pruebas y un hilo por hallazgo. Fija el commit status `codex/review`: verde solo con `APPROVED`.
- Máximo 4 iteraciones; después decide Dante.

Requiere `git`, `gh` (autenticado), `jq` y `codex`. `CODEX_MODEL` elige el modelo. `test/unit/codex-review.test.ts` lo prueba con `gh` y `codex` simulados.

### Después de un rebase

`codex/review` es un status del commit: un PR aprobado que se rebasea (o se reescribe de otra forma: merge de la base, reword) lo pierde. `--after-rebase` lo recupera sin gastar una iteración:

- Exige que la última corrida haya sido `APPROVED` y que ninguna corrida haya revisado ya el commit actual. Si no, se rechaza sin correr Codex.
- Una corrida es un review que publicó la gate: firmado por la cuenta que corre el script, con la marca como primera línea y el sha de la marca igual al `commit_id` del review. Un review ajeno o una marca citada no cuentan como corrida ni como aprobación.
- Compara, archivo por archivo, el diff del PR contra su merge-base con la base, el del commit aprobado y el del commit nuevo, con el archivo entero como contexto: un archivo del PR quedó igual solo si tiene el mismo modo y contenido en los dos commits y en sus dos merge-bases. Comparar hunks sueltos exigiría saber dónde empieza cada función, y esa heurística de git depende del lenguaje (en PL/pgSQL, el mismo cambio en dos funciones con el mismo cuerpo da el mismo hunk). El costo: si la base también cambió un archivo de código que el PR toca, corre Codex aunque el diff del PR sea el mismo, en una corrida que no cuenta.
- **Documentación** son los `.md` de la raíz, de `docs/` y de `.github/`, salvo `docs/process/`. Ni la aplicación, ni el build, ni la propia gate los usan como entrada, así que cambiarlos no cambia lo que Codex aprobó; el test que los revisa (`test/unit/docs.test.ts`) corre en el CI sobre el commit nuevo. Todo lo demás es **código**: la configuración del revisor (`docs/process/`, `scripts/codex-review.sh`) y también un `.md` en `src/`, `test/`, `db/` o `scripts/`, donde puede ser un fixture o una entrada.
- Si solo cambió documentación, o nada: fija `codex/review` en verde citando el review aprobado y comenta la comparación en el PR (tabla por archivo y lo que cambió). No corre Codex ni cuenta una iteración. Repetirlo sobre el mismo commit no duplica el comentario.
- Si cambió código: corre Codex sobre el commit nuevo, con la comparación en el contexto. Esa corrida no cuenta para el límite y hay una sola por commit; si pide cambios, la corrida siguiente es una iteración normal.
- `ci` y `commit-messages` se exigen igual que siempre. La comparación solo mira el diff del PR: cómo interactúa con lo que trajo la base lo prueban los tests, que corren sobre el commit rebaseado.
