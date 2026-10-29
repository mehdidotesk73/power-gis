#!/usr/bin/env bash
# A local Supabase stack for the integration tests (tests/cloud): starts it with
# the Supabase CLI (Docker; no account needed), applies our schema files in
# order — the same ones run once on the real project — and prints the env
# lines the tests read. Used by CI and locally:
#   eval "$(scripts/test-stack.sh)" && npm run test:cloud
# Each start is an empty database; `npx supabase stop --no-backup` throws it away.
set -euo pipefail
cd "$(dirname "$0")/.."

# Not needed by the tests: logging, image transforms, pooler, studio's backend.
npx supabase start -x vector,logflare,imgproxy,supavisor,postgres-meta >&2

db="supabase_db_$(sed -n 's/^project_id = "\(.*\)"/\1/p' supabase/config.toml)"
for f in supabase/schema.sql supabase/0*.sql; do
  # A stack that's already set up keeps its schema (schema.sql isn't re-runnable).
  if [ "$f" = supabase/schema.sql ] && docker exec "$db" psql -U postgres -tAc "select to_regclass('public.datasets')" | grep -q datasets; then
    echo "test-stack: schema already applied" >&2
    break
  fi
  echo "test-stack: applying $f" >&2
  docker exec -i "$db" psql -U postgres -q -v ON_ERROR_STOP=1 < "$f" >&2
done

eval "$(npx supabase status -o env | grep -E '^(API_URL|PUBLISHABLE_KEY)=')"
echo "export SUPABASE_TEST_URL=$API_URL SUPABASE_TEST_KEY=$PUBLISHABLE_KEY"
