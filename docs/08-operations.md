# 08 · Operations: health, metrics, limits, logs, analytics

## 1. Health
| Endpoint | Meaning |
|---|---|
| `GET /health` (every service) | Liveness: the process is up. Cheap, never touches dependencies. Exempt from rate limits. |
| `GET /health/ready` (backend) | Readiness: `200` when Postgres answers; `503` otherwise. Body: `{status: ok\|degraded\|down, db, ai, connector, uptimeSec}`. `degraded` = the AI service or connector is unreachable (rooms, chat and captions still work; AI features and integrations do not). |

`infra/start.sh` waits on liveness for each service and prints the log path of any that does not come up.

## 2. Metrics (`GET /metrics`, Prometheus text format)
Requires the `x-internal-secret` header (fails closed). Labels are low-cardinality: HTTP routes are **templates** (`/api/meetings/:id`), never raw URLs.

| Metric | Type | Notes |
|---|---|---|
| `http_requests_total{method,route,status}` | counter | |
| `http_request_duration_seconds{method,route}` | histogram | 5 ms – 10 s buckets |
| `meetpilot_rate_limited_total{scope}` | counter | `general`, `send_email`, `upload`, `chat`, `memory_search`, `oauth_start` |
| `meetpilot_events_total{event[,kind,verdict]}` | counter | product analytics (see §5) |
| `meetpilot_insight_pass_seconds` | histogram | one extract→judge→govern pass |
| `meetpilot_agent_run_seconds{agent}` | histogram | |
| `meetpilot_job_failures_total{kind}` | counter | jobs that exhausted their retries |
| `meetpilot_websocket_clients` | gauge | Socket.IO connections |
| `meetpilot_jobs{status}` | gauge | queue depth (refreshed every 15 s) |
| `meetpilot_db_pool_connections{state}` | gauge | total / idle / waiting |
| `process_uptime_seconds`, `nodejs_heap_used_bytes` | gauge | |

Suggested alerts: readiness `503` for 1 min · `meetpilot_db_pool_connections{state="waiting"} > 5` for 2 min · `meetpilot_job_failures_total` increasing · p95 of `http_request_duration_seconds` > 2 s · sustained `meetpilot_rate_limited_total{scope="general"}` (a client in a loop).

## 3. Rate limits
Per user (`x-user`), falling back to client IP for unauthenticated calls, fixed 60 s window, in memory (single node). Rejected with `429`, `Retry-After`, and the standard error envelope `{error:{code:"rate_limited",…}}`.

| Scope | Default | Env |
|---|---|---|
| general (all `/api/*`) | **120 / min** (PRD/doc 06 said 60; the web app polls reviews, integrations and workspace, so 120 leaves headroom) | `RATE_LIMIT_PER_MIN` (`0` disables) |
| send email | 6 / min | fixed |
| file upload | 20 / min | fixed |
| chat message | 60 / min | fixed |
| memory search | 30 / min | fixed |
| Google OAuth start | 10 / min | fixed |

Route budgets are capped by the general limit. When running the smoke tests repeatedly, either wait a minute between runs or start the backend with `RATE_LIMIT_PER_MIN=0`.

## 4. Logs
JSON (pino) on stdout, one file per service under `.logs/` when started with `infra/start.sh`. Level: `LOG_LEVEL` (default `info`).
- Every request has a `reqId`; it is echoed in the `x-request-id` response header. A caller may supply one (`[\w.-]{1,64}`), otherwise a UUID is generated.
- Request logs record method and **path without the query string** (OAuth codes live in query strings), never headers or bodies.
- Tokens, API keys and message content are never logged. The connector logs only error messages.
- Not yet done: forwarding `x-request-id` to the AI service and connector.

## 5. Product analytics (PRD §11)
Stored in table `events(name, props, user_id, project_id, meeting_id, created_at)`; mirrored as `meetpilot_events_total`.

`meeting_created`, `meeting_joined`, `captions_started`, `captions_error{reason}`, `ai_assist_toggled{enabled}`, `insight_posted{kind,tier}`, `insight_feedback{kind,verdict}`, `ai_question_asked`, `task_created`, `meeting_closed{durationSec}`, `execution_routed{category,agent}`, `execution_review{verdict}`, `integration_connected{provider}`, `email_sent`.

Privacy rules: **ids and categories only**. Properties are allow-listed (`kind, tier, verdict, category, provider, enabled, reason, agent, durationSec, value`) and values must be short tokens, so chat text, transcript lines, titles, file names and addresses cannot be stored. No foreign keys: history survives deletion of users/projects, so apply the retention policy below.

Example: insight usefulness = `helpful / (helpful + dismissed)` over `insight_feedback`.

## 6. Process safety
- **Secrets:** all three services refuse to start without `INTERNAL_SECRET`; with `NODE_ENV=production` they also refuse the example value or anything shorter than 24 characters.
- **Postgres pool:** `DB_POOL_MAX` (20), 5 s connect timeout, `DB_STATEMENT_TIMEOUT_MS` (30 s). An error on an idle client is logged, never fatal.
- **Shutdown:** `SIGTERM`/`SIGINT` stop workers and watchers, drain HTTP, close the pool, exit 0 (forced exit after 10 s).
- **Headers on API responses:** `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `cache-control: no-store`.
- **Request limits:** 2 MB JSON bodies (`413`), malformed JSON is `400`; uploads capped by `WORKSPACE_MAX_UPLOAD_MB`.
- **Dependencies:** `npm audit` is clean at the time of writing; run it in CI.

## 7. Backups and retention (recommendations, not enforced in code)
- Back up Postgres (it holds transcripts, memory, tokens in encrypted form) and `WORKSPACE_DIR`. **Also back up `TOKEN_ENC_KEY`**: without it stored Google tokens are unreadable (users just reconnect).
- Decide a retention period for `events`, `transcript_segments` and `memory_chunks`; a nightly `delete from events where created_at < now() - interval '13 months'` is enough for events.
