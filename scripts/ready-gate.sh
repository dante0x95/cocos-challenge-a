#!/usr/bin/env bash
# Gate de ready for review (CONTRIBUTING.md, paso 7): un PR que no es borrador tiene que tener
# codex/review en verde en su head. Si no se puede confirmar, lo devuelve a borrador y falla.
# Lo corre .github/workflows/ready-gate.yml, desde un checkout de main (nunca el código del PR).
#
# Uso (variables de entorno):
#   REPO         owner/nombre.
#   PR_NUMBER    número del PR.
#   PR_NODE_ID   node_id del PR, para convertPullRequestToDraft (no cambia en la vida del PR).
#   EVENT_SHA    head del PR cuando se disparó el evento. Solo se informa.
#
# Qué decide: lee el PR y el status *vigentes*, no los del evento. Una corrida atrasada (evento
# en A, head ya en B) decide sobre B: no revierte un B aprobado ni acepta B con la aprobación
# de A. El workflow corre de a una corrida por PR (concurrency), y acá se relee el PR después
# de leer el status: si el head se movió en el medio, se vuelve a leer.
#   - PR cerrado o ya en borrador: nada que decidir.
#   - codex/review en success en el head vigente: queda ready.
#   - Cualquier otra cosa (ausente, pending, failure, error, la API no responde, el head no
#     se estabiliza): vuelve a borrador.
# Cada llamada a la API se reintenta READY_GATE_ATTEMPTS veces, esperando
# READY_GATE_RETRY_DELAY segundos entre intentos.
# Salida: 0 queda ready o no hay nada que decidir · 1 volvió a borrador · 2 no pudo volver a
# borrador (el PR puede seguir ready) · 64 uso.
# Requiere: gh (autenticado con GH_TOKEN).
set -uo pipefail

CONTEXT="codex/review"
ATTEMPTS="${READY_GATE_ATTEMPTS:-3}"
RETRY_DELAY="${READY_GATE_RETRY_DELAY:-5}"
HEAD_READS=3

for var in REPO PR_NUMBER PR_NODE_ID EVENT_SHA; do
  if [ -z "${!var:-}" ]; then echo "ready-gate: falta $var" >&2; exit 64; fi
done

# Corre "$@" hasta ATTEMPTS veces; deja la salida del primer intento exitoso en stdout.
with_retries() {
  local i out
  for ((i = 1; i <= ATTEMPTS; i++)); do
    if out=$("$@"); then printf '%s' "$out"; return 0; fi
    echo "ready-gate: intento $i/$ATTEMPTS falló: $1 ${2:-} ${3:-}" >&2
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$RETRY_DELAY"
  done
  return 1
}

# Una línea "estado draft head" (por ejemplo "open false <sha>").
read_pr() {
  with_retries gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '"\(.state) \(.draft) \(.head.sha)"'
}

# El estado de codex/review en el sha, o "absent" si no tiene.
read_status() {
  with_retries gh api "repos/$REPO/commits/$1/status?per_page=100" \
    --jq "[.statuses[] | select(.context == \"$CONTEXT\") | .state] | first // \"absent\""
}

to_draft() {
  local reason="$1" is_draft
  is_draft=$(with_retries gh api graphql -f id="$PR_NODE_ID" \
    -f query='mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }' \
    --jq '.data.convertPullRequestToDraft.pullRequest.isDraft')
  if [ "$is_draft" != "true" ]; then
    echo "::error::$reason No se pudo devolver el PR a borrador (respuesta: ${is_draft:-sin respuesta}): puede seguir ready sin revisión. Pasarlo a borrador a mano."
    exit 2
  fi
  echo "::error::$reason El PR volvió a borrador: correr scripts/codex-review.sh y marcarlo ready cuando apruebe."
  exit 1
}

# El status leído vale solo si una lectura posterior del PR lo encuentra abierto, ready y con
# el mismo head.
pr=$(read_pr) || to_draft "No se pudo leer el PR #$PR_NUMBER."
read_head=""
for ((n = 0; ; n++)); do
  read -r state draft head <<<"$pr"
  if [ "$state" != "open" ]; then echo "PR #$PR_NUMBER $state: nada que decidir."; exit 0; fi
  if [ "$draft" = "true" ]; then echo "PR #$PR_NUMBER ya está en borrador: nada que decidir."; exit 0; fi
  [ "$head" = "$read_head" ] && break
  [ -z "$read_head" ] || echo "El head cambió de $read_head a $head mientras se leía el status."
  [ "$n" -lt "$HEAD_READS" ] || to_draft "El head del PR no se estabilizó en $HEAD_READS lecturas."
  [ "$head" = "$EVENT_SHA" ] || echo "El evento era para $EVENT_SHA; el head vigente es $head y se decide sobre ese."
  review=$(read_status "$head") || to_draft "No se pudo leer codex/review en $head."
  read_head="$head"
  pr=$(read_pr) || to_draft "No se pudo releer el PR #$PR_NUMBER."
done

if [ "$review" = "success" ]; then
  echo "codex/review en verde en $head: el PR queda ready."
  exit 0
fi
to_draft "codex/review no está en verde en $head (estado: $review)."
