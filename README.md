# MeetPilot

A video meeting app with a quiet, real-time AI assistant that remembers your projects. It shows live captions, spots decisions, tasks and conflicts with earlier meetings, answers `@ai` questions from project memory, and after the meeting hands doable tasks to specialist AI agents whose work you review.

- Product requirements: [PRD.md](PRD.md)
- Design: [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md) (architecture, data model, API, AI pipeline, UX, security, build plan, operations)

---

## 1. What you need

| Tool | Version | Why |
|---|---|---|
| Node.js | 20 or newer | backend, connector, web |
| npm | 9 or newer | workspaces |
| Python | 3.10 or newer | AI service (FastAPI) |
| Docker | any recent | runs Postgres with pgvector (macOS: Docker Desktop, or `brew install colima docker docker-compose && colima start`) |
| openssl, curl | – | used by the start script |

Optional, only for the real (non-demo) features: a Deepgram key (live captions), an LLM key (real AI), an embeddings key, Google Cloud OAuth credentials (Gmail/Drive). **None are needed to try the app**; see [§4](#4-demo-mode-no-api-keys).

Check your tools:

```bash
node -v && npm -v && python3 --version && docker --version && docker info > /dev/null && echo "docker is running"
```

---

## 2. Quick start (one command)

```bash
git clone https://github.com/Octaves0911/meta-ai-hackathon.git
cd meta-ai-hackathon
SEED=1 ./infra/start.sh
```

The script does everything, in order:

1. creates `.env` from `.env.example` (first run) and generates the token-vault key
2. starts Postgres (pgvector) in Docker and waits until it is ready
3. runs `npm install` (first run)
4. creates the Python virtualenv for the AI service and installs its requirements (first run)
5. applies the database migrations (`SEED=1` also loads demo data)
6. starts the **backend (4000)**, **connector (6100)**, **AI service (5001)** and **web app (5173)**, then checks each one's health

When you see `All services up`, open **http://localhost:5173**.

Stop everything with `Ctrl-C`. Logs are in `.logs/` (`backend.log`, `connector.log`, `ai.log`, `web.log`).

Script options:

| Variable | Effect |
|---|---|
| `SEED=1` | load demo data (users `priya` and `aman`, a project "Launch Q3", an earlier meeting that decided "deploy on August 1") |
| `SKIP_DB=1` | do not start Docker Postgres; use your own pgvector database and set `DATABASE_URL` in `.env` |

---

## 3. Manual setup (step by step)

Use this if you prefer to run things yourself or the script does not suit your machine.

**1. Install dependencies**

```bash
npm install
python3 -m venv apps/ai/.venv
apps/ai/.venv/bin/pip install -r apps/ai/requirements.txt
```

**2. Create `.env`**

```bash
cp .env.example .env
# generate the key that encrypts Google tokens, and put it in .env as TOKEN_ENC_KEY=
openssl rand -base64 32
```

**3. Start Postgres**

```bash
docker compose -f infra/docker-compose.yml up -d postgres
```

Any Postgres 16 with the `pgvector` extension works; then set `DATABASE_URL` in `.env`.

**4. Create the schema (and optional demo data)**

```bash
npm run db:migrate -w @meetpilot/backend
npm run db:seed -w @meetpilot/backend        # optional
```

**5. Start the four services** (one terminal each, from the repo root; they read `.env`)

```bash
set -a; . ./.env; set +a                     # load .env into this shell (all terminals)

npm run dev -w @meetpilot/backend            # http://localhost:4000
npm run dev -w @meetpilot/connector          # http://localhost:6100
(cd apps/ai && .venv/bin/uvicorn main:app --host 0.0.0.0 --port 5001)
npm run dev -w @meetpilot/web                # http://localhost:5173
```

**6. Check they are healthy**

```bash
curl localhost:4000/health && curl localhost:6100/health && curl localhost:5001/health
curl localhost:4000/health/ready             # also checks Postgres
```

Ports: web `5173`, backend `4000`, AI `5001`, connector `6100`, Postgres `5432`. (5000 and 6000 are avoided on purpose: macOS AirPlay uses 5000, and `fetch` blocks 6000.)

---

## 4. Demo mode (no API keys)

Out of the box (`.env.example`) the app runs fully offline:

| Feature | Offline behaviour |
|---|---|
| Embeddings / memory search | `EMBEDDING_PROVIDER=fake`: word-overlap vectors, good enough to demo |
| Live assistant (decisions, conflicts, tasks, `@ai`) | rules-based fallback when `LLM_API_KEY` is empty |
| AI agents | `AGENTS_MODE=mock`: deterministic sample deliverables (reports, sketch, email draft) |
| Captions | `STT_MODE=off` (set `STT_MODE=mock` for fake captions without a microphone) |

---

## 5. Try it (2-minute walkthrough)

Start with `SEED=1`, then:

1. Open http://localhost:5173 → **Get Started** → pick **priya**. The demo project "Launch Q3" already has an earlier meeting that decided *deploy on August 1*.
2. **New meeting** → give it a title, invite **aman** → **Start now**. On the meeting page click **Join**. Note the meeting id in the address bar (`/room/<meeting-id>`).
3. In a private window, pick **aman**, accept the invitation from the 🔔 menu and join. (Each browser tab remembers its own user, so two tabs can be two people.) Video needs camera/mic permission; without them you can still chat.
4. In the room header turn on **AI Assistance**: a brief of earlier decisions appears. Type `@ai when is the deployment date?` in the chat.
5. Without a microphone, feed the meeting some speech (as the owner, priya). Replace `<meeting-id>`:

   ```bash
   curl -X POST http://localhost:5173/api/meetings/<meeting-id>/transcript/import \
     -H 'x-user: priya' -H 'content-type: application/json' \
     -d '{"text":"Priya: Let'\''s ship on September 5.\nPriya: I will research competitor pricing by Friday.\nPriya: As we agreed last week, budget is 40k."}'
   ```

   Within a few seconds: a **conflict** card ("…decided deployment on August 1"), a task in the **Tasks** tab, and a quiet "No record found" note in the **AI** tab. (Run this once per project: after that, "September 5" is the remembered decision and the sentence is no longer a conflict.)
6. As the owner click **End meeting**: everyone sees the generated task table.
7. Open **Reviews** (sidebar; give the agent about 10 seconds): the research task was routed to a specialist agent. Open it, then **Request changes** or **Approve**.

---

## 6. Enabling the real services

Edit `.env`, then restart (`Ctrl-C` and `./infra/start.sh`).

**Live captions (Deepgram)**

```
STT_MODE=stream
DEEPGRAM_API_KEY=your-key
```

**Real LLM for the assistant and agents** (Anthropic Messages API)

```
LLM_API_KEY=your-key
LLM_MODEL=              # optional, default claude-sonnet-5-5
```

Also delete the `AGENTS_MODE=mock` line so agents use the real model.

**Real embeddings** (any OpenAI-compatible endpoint)

```
EMBEDDING_PROVIDER=real
EMBEDDING_API_KEY=your-key
# EMBEDDING_API_URL=https://api.openai.com/v1/embeddings
# EMBEDDING_MODEL=text-embedding-3-small
```

Existing memory was embedded with the previous provider; use a fresh database (or re-import) after switching.

**Gmail and Google Drive**

1. In Google Cloud Console create an OAuth client (type *Web application*), enable the Gmail and Drive APIs, and add the redirect URI `http://localhost:5173/api/connections/google/callback`.
2. Put the credentials in `.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

3. In the app: **Integrations → Connect Google**, then choose Gmail labels / Drive folders. Nothing is read until you choose. Sending email is a separate permission requested later from a review page.

Google restricts these scopes for public apps (app verification); for your own account and test users it works unverified.

**Local folder as workspace** (optional): set `WORKSPACE_LOCAL_BASE=/path/to/parent/folder`; the project owner can then pick any sub-folder of it under **Workspace → settings**.

All variables are listed in [`.env.example`](.env.example).

---

## 7. Everyday commands

```bash
./infra/start.sh                                  # start everything
npm run db:migrate -w @meetpilot/backend          # apply new migrations
npm run db:seed    -w @meetpilot/backend          # demo data (safe to repeat)
npm run db:reset   -w @meetpilot/backend          # roll back everything and re-apply
npm run typecheck                                 # TypeScript, all workspaces
npm run build -w @meetpilot/web                   # production build of the web app
docker compose -f infra/docker-compose.yml down   # stop Postgres (add -v to wipe its data)
```

---

## 8. Tests

Unit tests (Postgres must be running for the database-backed ones):

```bash
npm test -w @meetpilot/backend
npm test -w @meetpilot/connector
```

Smoke tests run against a live backend. Start it in a way that suits the test (rules fallback, fast pipeline, no rate limit), then run the scripts:

```bash
set -a; . ./.env; set +a
cd apps/backend
RATE_LIMIT_PER_MIN=0 INSIGHTS_LLM=off INSIGHT_TICK_MS=300 AGENTS_ENABLED=false npm start &   # backend on :4000

npm run smoke:room        # signaling, chat paging, notes
npm run smoke:insights    # assistant: brief, conflict, @ai, recap, privacy
npm run smoke:tasks       # tasks from speech, overlay data, import
```

Other smoke tests need extra setup, described in the header comment of each script:

| Script | Needs |
|---|---|
| `smoke:captions` | backend started with `STT_MODE=stream DEEPGRAM_API_KEY=x DEEPGRAM_URL=ws://localhost:9099/v1/listen` (the test provides a fake Deepgram) |
| `smoke:agents` | AI service with `AGENTS_MODE=mock`, backend with `JOBS_TICK_MS=300` and `AGENTS_ENABLED` not false |
| `smoke:workspace` | backend with `WORKSPACE_DIR`, `WORKSPACE_LOCAL_BASE`, `WORKSPACE_MAX_UPLOAD_MB=1`, `WORKSPACE_WATCH_DEBOUNCE_MS=200` |
| `smoke:hardening` | backend with `RATE_LIMIT_PER_MIN=20` |
| `smoke:connector`, `smoke:send` (in `apps/connector`) | connector with `GOOGLE_*_URL` pointed at the fake Google the script starts (see the script header) |

Smoke tests create and delete their own users. If you re-run one within a minute with rate limiting on, you may hit a 429; set `RATE_LIMIT_PER_MIN=0` or wait.

CI (`.github/workflows/ci.yml`) runs typecheck, the web build, migrations up/down/up, unit tests and the backend smoke tests.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker is required for Postgres` / `Cannot connect to the Docker daemon` | start Docker Desktop (or `colima start`), or use `SKIP_DB=1` with your own Postgres |
| `✗ ai did not become healthy` | see `.logs/ai.log`; usually the Python venv failed to install (needs Python 3.10+). Delete `apps/ai/.venv` and rerun |
| `INTERNAL_SECRET is not set; refusing to start` | `.env` is missing or not loaded; run through `./infra/start.sh` or `set -a; . ./.env; set +a` |
| Port already in use | stop the other process (`lsof -i :4000`) |
| Google says *redirect_uri_mismatch* | the redirect URI in Google Cloud must be exactly `http://localhost:5173/api/connections/google/callback` |
| Integrations: "not configured" | set `GOOGLE_CLIENT_ID/SECRET`; make sure `TOKEN_ENC_KEY` in `.env` is a 32-byte base64 value |
| "Reconnect Google" after changing `.env` | `TOKEN_ENC_KEY` changed, so stored tokens can't be read; reconnect |
| Camera/mic blocked | browsers allow them only on `localhost` or HTTPS; allow the permission for the site |
| Video doesn't connect across different networks | there is no TURN relay yet; try the same network |
| 429 Too Many Requests | rate limit (120 requests/min per user); `RATE_LIMIT_PER_MIN=0` disables it for local testing |
| Fresh start from scratch | `docker compose -f infra/docker-compose.yml down -v && rm .env && SEED=1 ./infra/start.sh` |

---

## 10. Project layout

```
apps/web         React + Vite app (landing, dashboard, meeting room, reviews, integrations, workspace)
apps/backend     Fastify API, Socket.IO, speech proxy, assistant pipeline, tasks, agents, workspace
apps/connector   Google OAuth, token vault, Gmail/Drive sync, email sending
apps/ai          FastAPI: LLM gateway, extractor/judge/answerer, specialist agents, embeddings
packages/shared  shared types, schemas and the embeddings gateway
infra            docker-compose (Postgres + pgvector) and the start script
docs             design documents (see docs/TECHNICAL_SPEC.md)
```

## 11. Workflow and operations

- Feature branches (`feat/*`, `docs/*`, `chore/*`) are merged into `master` with `--no-ff`, using Conventional Commits. See [docs/07-build-plan.md](docs/07-build-plan.md).
- Health, metrics, rate limits, logs and analytics events: [docs/08-operations.md](docs/08-operations.md).
- Known limitations: identity is username-only (no passwords; do not expose publicly without adding real authentication), video is a peer-to-peer mesh for small groups with no TURN relay, and nothing has been tested against real Deepgram, LLM or Google services.
