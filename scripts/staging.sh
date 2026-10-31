#!/usr/bin/env bash
# Guarded staging runner. Usage: scripts/staging.sh psql [args...] | run <cmd...>
set -euo pipefail

ENV_FILE="${STAGING_ENV_FILE:-.env.staging.local}"
PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/libpq/bin/psql}"
command -v psql >/dev/null 2>&1 && PSQL_BIN="$(command -v psql)"

ref_of() { printf '%s' "$1" | grep -oE 'https://[a-z0-9]+\.supabase\.co' | head -1 | sed -E 's#https://([a-z0-9]+)\.supabase\.co#\1#' || true; }
get_var() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true; }

[ -f ".env.local" ] || { echo "Ditolak: .env.local tidak ditemukan." >&2; exit 1; }
PROD_URL="$(get_var .env.local NEXT_PUBLIC_SUPABASE_URL)"
PROD_REF="$(ref_of "$PROD_URL")"
[ -n "$PROD_REF" ] || { echo "Ditolak: ref production tidak ditemukan." >&2; exit 1; }

[ -f "$ENV_FILE" ] || { echo "Ditolak: file env tidak ditemukan." >&2; exit 1; }
S_URL="$(get_var "$ENV_FILE" NEXT_PUBLIC_SUPABASE_URL)"
S_DB="$(get_var "$ENV_FILE" STAGING_DATABASE_URL)"
S_REF="$(ref_of "$S_URL")"
[ -n "$S_REF" ] || { echo "Ditolak: ref staging kosong." >&2; exit 1; }

if [[ "$S_URL" == *"$PROD_REF"* || "$S_DB" == *"$PROD_REF"* ]]; then
  echo "Ditolak: target mengandung ref production." >&2
  exit 1
fi

cmd="${1:-}"; shift || true
case "$cmd" in
  psql)
    [ -n "$S_DB" ] || { echo "Ditolak: STAGING_DATABASE_URL kosong." >&2; exit 1; }
    exec "$PSQL_BIN" "$S_DB" -X -v ON_ERROR_STOP=1 "$@"
    ;;
  run)
    set -a; . "./$ENV_FILE" 2>/dev/null || . "$ENV_FILE"; set +a
    exec "$@"
    ;;
  *) echo "Usage: $0 psql [args...] | run <cmd...>" >&2; exit 2 ;;
esac
