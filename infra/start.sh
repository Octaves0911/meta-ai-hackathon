#!/usr/bin/env bash
# Start every MeetPilot service with per-service logs in .logs/. Ctrl-C stops all.
#   SKIP_DB=1    skip starting Postgres in Docker (use your own, set DATABASE_URL in .env)
#   SEED=1       load the demo data (users priya and aman, a project, an earlier meeting)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p .logs

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }
# Token vault key: generate once so the Google connector can encrypt tokens at rest (empty value, with or without a comment).
if grep -Eq '^TOKEN_ENC_KEY=[[:space:]]*(#.*)?$' .env 2>/dev/null; then
  sed -i.bak -E "s|^TOKEN_ENC_KEY=[[:space:]]*(#.*)?$|TOKEN_ENC_KEY=$(openssl rand -base64 32)|" .env && rm -f .env.bak
  echo "generated TOKEN_ENC_KEY in .env"
fi
set -a; . ./.env; set +a

if [ "${SKIP_DB:-0}" != "1" ]; then
  command -v docker >/dev/null || { echo "Docker is required for Postgres (or set SKIP_DB=1 and point DATABASE_URL at your own pgvector database)"; exit 1; }
  docker compose -f infra/docker-compose.yml up -d postgres
  printf "waiting for Postgres"
  for _ in $(seq 1 60); do
    docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U meetpilot >/dev/null 2>&1 && break
    printf "."; sleep 1
  done
  echo
fi

[ -d node_modules ] || npm install

# Bring the database schema up to date (safe to run every time).
npm run db:migrate -w @meetpilot/backend
[ "${SEED:-0}" = "1" ] && npm run db:seed -w @meetpilot/backend

if [ ! -d apps/ai/.venv ]; then
  python3 -m venv apps/ai/.venv
  apps/ai/.venv/bin/pip install -q -r apps/ai/requirements.txt
fi

PIDS=()
cleanup() { trap - INT TERM EXIT; kill "${PIDS[@]}" 2>/dev/null || true; }
trap cleanup INT TERM EXIT

run() { local name=$1; shift; "$@" >".logs/$name.log" 2>&1 & PIDS+=($!); }

run backend   npm run dev -w @meetpilot/backend
run connector npm run dev -w @meetpilot/connector
(cd apps/ai && exec .venv/bin/uvicorn main:app --host 0.0.0.0 --port 5001) >.logs/ai.log 2>&1 & PIDS+=($!)
run web       npm run dev -w @meetpilot/web

wait_health() {
  for _ in $(seq 1 120); do curl -fs "$2" >/dev/null 2>&1 && { echo "✓ $1 $2"; return; }; sleep 0.5; done
  echo "✗ $1 did not become healthy; see .logs/$1.log"
}
wait_health backend   http://localhost:4000/health
wait_health connector http://localhost:6100/health
wait_health ai        http://localhost:5001/health
wait_health web       http://localhost:5173/

echo "All services up. Logs in .logs/. Ctrl-C to stop."
wait
