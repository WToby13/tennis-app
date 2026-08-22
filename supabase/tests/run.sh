#!/bin/zsh
# Run the SQL assertions against a throwaway local Postgres.
#
# Three suites: invites (set_participants, claim_invite, the signup trigger),
# moderation (blocking, reports, and what an account deletion leaves behind),
# and notifications (who a comment's fan-out reaches, and who it must not).
# Both sets of rules live in SQL, so this is where they can actually be tested —
# no Supabase project and no network needed. Start a scratch cluster first:
#
#   export LC_ALL=C          # Postgres 18 refuses to start without it here
#   initdb -D /tmp/ojopg --locale=C -U postgres
#   pg_ctl -D /tmp/ojopg -o "-p 55999 -k '' -c listen_addresses=127.0.0.1" -l /tmp/ojopg.log start
#   supabase/tests/run.sh
#
# bootstrap.sql stubs the parts of Supabase the migrations lean on (the anon /
# authenticated / service_role roles, auth.users, and auth.uid() backed by a
# session GUC so `set request.uid` plays the signed-in user).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS="$HERE/../migrations"
PORT="${PGPORT:-55999}"

P() { psql -h 127.0.0.1 -p "$PORT" -U postgres -q -v ON_ERROR_STOP=1 "$@"; }

# 0012 needs pg_cron, which a plain local Postgres doesn't have. Everything else
# runs, including 0014_moderation — it redefines get_feed, so a chain that
# skipped it would not be testing the function the app actually calls.
fail=0
for t in invites moderation notifications; do
  echo "--- $t ---"
  # Each suite gets a clean database: they both seed auth.users and would
  # otherwise trip over each other's fixtures.
  P -d postgres -c "drop database if exists ojo_$t;" -c "create database ojo_$t;" >/dev/null
  P -d "ojo_$t" -f "$HERE/bootstrap.sql" >/dev/null
  for f in "$MIGRATIONS"/0*.sql; do
    case "$f" in *0012_*) continue;; esac
    P -d "ojo_$t" -f "$f" >/dev/null 2>&1 || { echo "MIGRATION FAILED: $f"; exit 1; }
  done
  out=$(psql -h 127.0.0.1 -p "$PORT" -U postgres -d "ojo_$t" -f "$HERE/${t}_test.sql" 2>&1 \
    | grep -E "NOTICE:  (ok|FAIL)|ERROR|ALL ASSERTIONS" | sed 's/.*NOTICE:  //')
  echo "$out"
  echo "$out" | grep -q "ALL ASSERTIONS PASSED" || fail=1
done
exit $fail
