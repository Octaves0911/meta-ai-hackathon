# MeetPilot

An AI-assisted meeting application: live captions, a quiet real-time assistant backed by persistent project memory, and post-meeting tasks executed by specialist AI agents with human review.

- Product: [PRD.md](PRD.md)
- Design: [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md) (architecture, data model, API, AI pipeline, UX, security, build plan)

## Workflow
Feature branches (`feat/*`, `docs/*`, `chore/*`) merged into `master` with `--no-ff`; Conventional Commits. See [docs/07-build-plan.md](docs/07-build-plan.md).

## Database
Postgres (pgvector) runs via `docker compose -f infra/docker-compose.yml up -d postgres`. Then, from the repo root:

```bash
npm run db:migrate -w @meetpilot/backend   # apply migrations
npm run db:seed -w @meetpilot/backend      # dev seed (priya, aman, golden scenario)
npm run db:reset -w @meetpilot/backend     # roll back all and re-apply
```

## Operations
Health, metrics, rate limits, logs and analytics events are documented in [docs/08-operations.md](docs/08-operations.md). CI runs typecheck, build, migrations (up/down/up), unit tests and the backend smoke tests (`.github/workflows/ci.yml`).
