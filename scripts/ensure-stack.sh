#!/usr/bin/env bash
# Makes sure the local test stack is up, for a Claude cloud session (or anyone) about to run
# tests, and prints the env lines the tests read:
#   eval "$(scripts/ensure-stack.sh)" && npm run test:cloud
# The cloud sandbox is recycled while a session waits (for the user, or CI): the machine comes
# back without the Docker daemon, so the Supabase containers and their env are gone. This
# starts dockerd if it isn't running, checks the stack's Auth and REST answer, and (re)starts
# it with scripts/test-stack.sh only when they don't — retrying, since the first start after a
# reboot can race containers that are still coming up. Fast when all is well. CI doesn't use it
# (each run starts its own stack with test-stack.sh).
set -uo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${STACK_ENV_FILE:-/tmp/stack.env}"
URL="http://127.0.0.1:54321"
log() { echo "ensure-stack: $*" >&2; }

if ! docker info >/dev/null 2>&1; then
  log "starting the Docker daemon"
  (nohup dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { log "Docker didn't start (see /tmp/dockerd.log)"; exit 1; }
fi
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-docker.io}"
# After a Docker restart the stack's containers come back on their own: wait for the database to be healthy
# before deciding anything (test-stack.sh fails while it's still starting).
DB="supabase_db_$(sed -n 's/^project_id = "\(.*\)"/\1/p' supabase/config.toml)"
if docker inspect "$DB" >/dev/null 2>&1; then
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$DB" 2>/dev/null)" = healthy ] && break
    [ "$(docker inspect -f '{{.State.Status}}' "$DB" 2>/dev/null)" = exited ] && break
    sleep 1
  done
fi

healthy() {
  [ -s "$ENV_FILE" ] || return 1
  local key
  key=$(sed -n 's/.*SUPABASE_TEST_KEY=\([^ ]*\).*/\1/p' "$ENV_FILE")
  [ -n "$key" ] || return 1
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/auth/v1/health" -H "apikey: $key")" = 200 ] || return 1
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/rest/v1/" -H "apikey: $key")" != 000 ] || return 1
}

if ! healthy; then
  for attempt in 1 2 3; do
    log "starting the stack (attempt $attempt)"
    if scripts/test-stack.sh >"$ENV_FILE.new" 2>/tmp/stack.err && grep -q SUPABASE_TEST_KEY "$ENV_FILE.new"; then
      mv "$ENV_FILE.new" "$ENV_FILE"
      for _ in $(seq 1 30); do healthy && break; sleep 2; done
      healthy && break
    fi
    tail -3 /tmp/stack.err >&2
    sleep 5
  done
  healthy || { log "the stack isn't answering (see /tmp/stack.err)"; exit 1; }
fi
log "stack up at $URL"
cat "$ENV_FILE"
