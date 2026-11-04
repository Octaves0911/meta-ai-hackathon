# 10 · Deploying MeetPilot on free hosting

One container runs everything (the backend also serves the built web app, so the browser sees a single origin), and the database lives on a free managed Postgres.

```
browser ──HTTPS──► Hugging Face Space (Docker, port 7860)
                    ├─ backend  (public: web app, /api, /socket.io, /stt)
                    ├─ AI service   127.0.0.1:5001
                    └─ connector    127.0.0.1:6100
                          │
                          ▼
       Neon Postgres (pgvector) · Meta Model API · Deepgram (captions) · Google · GitHub · Modal (optional)
```

Why these: both are free without a credit card, the Space has 16 GB of memory for the four processes, it sleeps only after about 48 hours without a visit (not 15 minutes), and it supports WebSockets, which the room and captions need. Neon supports the `vector` extension that the memory tables use.

## What needs which key

| Feature | Needs | Without it |
|---|---|---|
| Agents, review chat (streaming, screenshots), live assistant (tool calling), decks | `LLM_API_KEY` (Meta) | Nothing works: required |
| Live captions | `DEEPGRAM_API_KEY`, `STT_MODE=stream` | Use `STT_MODE=mock` (fake captions) or `off` |
| Gmail / Drive sources | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, redirect URI | The Integrations page cannot connect Google |
| Video across strict networks | `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | STUN only: some networks cannot connect |
| Code verified in a sandbox | `SANDBOX_MODE=modal`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | Code changes are labelled "Not tested" and cannot become pull requests |
| Pull requests | A GitHub token with write access, pasted per project in the app | PRs are not offered |

All names and sensible values are in `infra/deploy/env.production.example`.

## 1. Database (Neon)
1. Create a free project at neon.tech.
2. Copy the **connection string** (it ends in `?sslmode=require`). That is `DATABASE_URL`.
3. Nothing else: the first start runs the migrations, including `create extension vector`.

## 2. Secrets
```bash
infra/deploy/gen-secrets.sh
```
It prints `INTERNAL_SECRET` and `TOKEN_ENC_KEY`. Copy them into the host's secrets, do not commit them.

## 3. Space (Hugging Face)
1. Create an account, then **New Space** → SDK **Docker** → *Blank*.
2. **Settings → Variables and secrets.** Add everything from `infra/deploy/env.production.example` that you use. Put keys and passwords under **Secrets** (`DATABASE_URL`, `INTERNAL_SECRET`, `LLM_API_KEY`, `TOKEN_ENC_KEY`, `DEEPGRAM_API_KEY`, `GOOGLE_CLIENT_SECRET`, `TURN_CREDENTIAL`, `MODAL_TOKEN_SECRET`) and the rest under **Variables**. `WEB_URL` is your Space's direct URL: `https://<user>-<space>.hf.space`.
3. Set `SEED_DEMO=1` for the first start only.

## 4. Push the code
From the repository, with everything committed:

```bash
infra/deploy/push-to-hf.sh <hf-username>/<space-name>
```

Git asks for credentials: username = your Hugging Face username, password = a **write** access token (huggingface.co/settings/tokens). The script publishes the current commit with the Space's own README; your GitHub README is untouched. The first build takes several minutes.

## 5. Check it
- `https://<user>-<space>.hf.space/health` → `{"service":"backend","status":"ok"}`.
- Open the root URL, sign in with a username, open a project and a meeting.
- Use the **direct** `.hf.space` URL, not the huggingface.co page that embeds it: camera and microphone permissions work best at the top level.
- Set `SEED_DEMO` back to `0`.

## Optional integrations
- **Google (Gmail / Drive).** In Google Cloud Console create an OAuth client (Web), add `https://<user>-<space>.hf.space/api/connections/google/callback` as an authorised redirect URI, enable the Gmail and Drive APIs, and while the app is in *Testing* add each Google account you will use as a test user.
- **TURN relay.** metered.ca offers a free relay: create an app, copy its TURN URLs, username and credential into `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`. No rebuild is needed; the web app reads them from `/api/ice-servers`.
- **Modal sandbox.** Create a token at modal.com/settings/tokens, set `SANDBOX_MODE=modal`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`. Check the live path once from a machine with the repo: `cd apps/ai && .venv/bin/python scripts/sandbox_live_check.py`.

## Another free host
The image is plain Docker with one public port taken from `BACKEND_PORT` (default 7860 in the image), so any host that runs a Dockerfile works: set the same variables and point it at the repository. On a host that sleeps after 15 minutes of inactivity (Render's free web service) the first request after a pause takes about a minute, the 512 MB memory limit is tight for four processes, and calls drop when it sleeps, so prefer Hugging Face Spaces for a live demo.

## Known limits (read before a live demo)
- **Login is username-only** (a demo mechanism, no passwords). Anyone with the URL can sign in as anyone: use made-up data only, and consider keeping the Space private or sharing the link only with judges.
- **Spend:** anyone who can sign in can start agent runs. `AGENT_DAILY_CAP_USD` limits it per project; watch your Meta usage dashboard. With `LLM_MODEL=muse-spark-1.3-contributor` Meta may train on prompts, so use it for demo data only.
- **Video:** peer-to-peer WebRTC. Without a TURN relay calls can fail between strict networks. Chat, notes, tasks and agents are unaffected.
- **Sleep and disk:** after about 48 hours without a visit the Space sleeps and the first request wakes it (about a minute). The container disk is temporary; all data is in Neon, but files saved to the local workspace folder are lost on restart.
- **Neon free tier:** about 0.5 GB, and compute pauses after a few minutes idle (the first query after that is slower).
- **Designer PDF:** the container has no Chrome, so Designer PDFs use the built-in design-board fallback; HTML previews are unaffected.

## Run the same image locally
```bash
docker build -t meetpilot .
docker run --rm -p 7860:7860 -e DATABASE_URL=... -e INTERNAL_SECRET=... -e LLM_API_KEY=... meetpilot
# then open http://localhost:7860
```
