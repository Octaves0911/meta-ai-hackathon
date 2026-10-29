# 07 · Build Plan, Git Workflow & Testing

## 1. Git workflow
- `master` is always releasable; **no direct commits** except merges.
- One branch per feature, named `<type>/<scope>`: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`.
- Merge with `--no-ff` (keeps feature history visible); branches are kept after merge.
- **Conventional Commits**: `type(scope): imperative summary` + body explaining *why*. One logical step per commit.
- Each feature branch below maps to a PRD phase and is merged only when its acceptance checks pass.

## 2. Feature branches (build order)
| # | Branch | Scope | PRD | Acceptance |
|---|---|---|---|---|
| 1 | `chore/monorepo-scaffold` | workspaces, shared zod package, lint/format, docker-compose (pgvector), `.env.example`, `infra/start.sh` | — | `./infra/start.sh` boots all services, `/health` 200 |
| 2 | `feat/db-schema` | migrations from doc 02, seed data | F1,F6 | migrate up/down clean |
| 3 | `feat/users-projects` | users, projects, members, dashboard shell, landing, get-started | F1 | create/delete cascades |
| 4 | `feat/meetings-scheduling` | create/schedule, invites, notifications bell, status machine, detail page | F2 | invite→accept→join flow |
| 5 | `feat/meeting-room-rtc` | signaling, mesh, controls, retry/recovery, chat paging, personal notes, End/Leave | F3 | 3-tab local call works; reload keeps history |
| 6 | `feat/live-captions` | mic capture, STT proxy, subtitle overlay, watchdog, segment persistence, export/import | F4 | final segments saved w/ seq; fade at 8 s |
| 7 | `feat/project-memory` | embeddings gateway (+fake), chunking, search, context builder | F6 | golden retrieval tests |
| 8 | `feat/ai-insights` | extractor, retriever, judge+fallback, governor, AI tab, feedback, `@ai`, brief, recap | F5 | doc 04 §9 scenarios pass |
| 9 | `feat/tasks-end-overlay` | task extraction fields, date resolution, Tasks tab, end overlay | F7 | spoken "Friday" → real date |
| 10 | `feat/agents-reviews` | router, agent runtime, 4 agents + collaboration, Reviews + typed viewers, revisions | F8 | approve/changes loop ≤3 |
| 11 | `feat/google-connector` | OAuth, vault, Gmail/Drive sync, private routing, disconnect purge | F9.1–9.7 | doc 06 checklist |
| 12 | `feat/communication-agent-send` | email draft agent, editor, explicit send, audit | F9.8–9.10 | single send under double-click |
| 13 | `feat/workspace-files` | file tree, upload, editor, indexing, watcher | F10 | search finds uploaded doc |
| 14 | `chore/hardening-observability` | rate limits, structured logs, health, analytics events | §10,§11 | metrics emitted |

Branches 3→4→5→6 are sequential; 7 can start after 2; 11 can start after 2 in parallel with 5–10.

## 3. Testing strategy
| Layer | Tooling | Focus |
|---|---|---|
| Unit | Vitest / pytest | governor routing table, date resolution, audience filter, chunker, judge fallback |
| Contract | zod schemas shared | REST + socket payloads validated on both sides |
| Integration | Supertest + testcontainers (pgvector) | cascade deletes, status machine, idempotency keys |
| AI evals | fixture transcripts + recorded LLM responses | extractor precision on golden set; judge speak/silent accuracy; injection set |
| E2E | Playwright, fake media devices (`--use-fake-device-for-media-stream`) | two-browser call, captions overlay with STT mocked, end-overlay |
| Manual | checklist | real mic + Deepgram, Google OAuth flow |

CI (GitHub Actions): lint → typecheck → unit → integration → e2e smoke on PRs; AI evals nightly.

## 4. Definition of done
Acceptance checks pass · tests added · docs updated if contracts changed · conventional commits · merged `--no-ff`.

## 5. Open decisions (need product owner)
1. Weak insights (<0.3): store in feed (our reading) vs. truly discard — see doc 04 §4 note.
2. Default LLM/embedding vendor and budget.
3. Data-retention period for transcripts and embeddings.
4. Whether to add TURN before first external pilot.
