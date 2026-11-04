#!/usr/bin/env bash
# Starts everything inside the one container: migrate, then connector + AI service (localhost only) + backend (public, serves the web app).
set -euo pipefail
cd /app

need() { [ -n "${!1:-}" ] || { echo "missing required setting: $1"; exit 1; }; }
need DATABASE_URL
need INTERNAL_SECRET
need LLM_API_KEY

# The token vault key must stay the same between restarts or saved Google tokens become unreadable; fall back to a throwaway key (and say so).
if [ -z "${TOKEN_ENC_KEY:-}" ]; then
  export TOKEN_ENC_KEY="$(head -c 32 /dev/urandom | base64)"
  echo "WARNING: TOKEN_ENC_KEY is not set; using a temporary key (Google connections will not survive a restart)"
fi

echo "migrating database…"
npx tsx apps/backend/src/db/migrate.ts up
if [ "${SEED_DEMO:-0}" = "1" ]; then
  echo "seeding demo data…"
  npx tsx apps/backend/src/db/seed-demo.ts "${SEED_DEMO_USER:-aman}" || echo "demo seed skipped"
fi

PIDS=()
(cd apps/connector && exec npx tsx src/index.ts) & PIDS+=($!)
(cd apps/ai && exec uvicorn main:app --host 127.0.0.1 --port 5001) & PIDS+=($!)

for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:5001/health >/dev/null 2>&1 && curl -fs http://127.0.0.1:6100/health >/dev/null 2>&1 && break
  sleep 1
done

npx tsx apps/backend/src/index.ts & PIDS+=($!)
trap 'kill "${PIDS[@]}" 2>/dev/null || true' TERM INT
# If any process dies, stop the container so the platform restarts it cleanly.
wait -n
kill "${PIDS[@]}" 2>/dev/null || true
exit 1
