# 09 · Post-meeting agents: design (to finalise before coding)

Status: **proposal**. Companion to [04-ai-pipeline](04-ai-pipeline.md) §6–7 and PRD F8/F9. Nothing here is built yet.

## 0. What exists and what is wrong with it

| Piece | Today | Problem |
|---|---|---|
| Router | keyword regex (`agents/classify.ts`) | "Send the updated pricing deck to leadership" matches nothing → left unrouted; no confidence; no override |
| Agents | one model call each, no tools, Markdown out | Research cannot browse; Designer returns a toy SVG; no PDF (PRD says Marketing → PDF); Code has no repo context |
| Context | project memory only | agents never see **what was said** around the task (quote, neighbouring lines, decisions) |
| JSON | "extract `{…}` from text + retry" | brittle; Meta supports constrained JSON decoding (`response_format: json_schema`) |
| Review UI | Markdown/image/email viewers; diff is a `<pre>`; PDF needs a `uri` that nothing produces | cannot show what an agent did; no confidence, no open questions |

Platform facts that shape the design (Meta Model API docs):
- **Web search** (`web_search` tool, $2.50 / 1k queries) works on the **Responses API** only; citations come back as `url_citation` annotations and the raw hits with `include: ["web_search_call.results"]`. Our gateway uses Chat Completions, so it needs a second path.
- **Tool calling** works on both; Responses preserves reasoning across tool turns (better for multi-step agents).
- **Structured output**: `response_format` (Chat) / `text.format` (Responses), schema-constrained decoding, no recursive schemas.
- **Muse Image is not available in India** (Geographic Use Policy §2.2; circumvention is prohibited). Designer must not depend on it unless deployed elsewhere.
- Hidden reasoning tokens count against `max_completion_tokens` (already handled by `REASONING_HEADROOM`).

## 1. Shared foundation (step 0, built once)

### 1.1 Gateway v2 (`apps/ai/gateway.py`)
- `chat_json(system, user, schema)` → constrained JSON (replaces `complete_json`'s parse-and-retry for agents/router/extractor).
- `chat_text(...)` as today.
- `respond(input, tools, …)` → **Responses API** (web_search, function tools, multi-turn) returning `{text, citations[], search_results[], usage}`.
- One **agent loop** `run_agent(spec, brief)`: bounded steps, tool allow-list, trace recording, usage totals, wall-clock cap.
- Per-agent model: `AGENT_MODEL` (default `LLM_MODEL`), override `AGENT_MODEL_RESEARCH=…` etc. Dev: contributor tier; deploy: `muse-wonder-1.0` for Research/Code, Spark for the rest.

### 1.2 Task brief (what every agent receives)
```
task        title, description, owner, assigner, due, priority
source      the quote + ±10 transcript lines around it + speaker names
decisions   current value of each decision key, with "changed from X" history
neighbours  other tasks from this meeting (what else was assigned, to whom)
memory      project memory hits (existing context builder) — reviewer-scoped
external    Gmail/Drive snippets visible to the reviewer only
prior work  deliverables of earlier executions on similar tasks (approved ones first)
workspace   file list + matches (code agent)
```
Each section has a character budget; everything quoted is wrapped in `<untrusted_source>` (existing rule).

### 1.3 Router v2
Structured result: `{category, agent|null, can_ai_do, confidence 0..1, reason, missing_inputs[], human_reason}`.
- Model classification with the regex rules as fallback and as a veto for obvious human work (calls, payments, hiring, legal).
- `confidence < 0.6` → *left for a human* **with a "Run with <agent>" button** (reviewer can override).
- Records `route_reason` (exists) and `confidence` (new).

### 1.4 Run trace + progress
New table `execution_steps(execution_id, revision, seq, kind, label, detail jsonb, tokens, started_at, ended_at)`;
kinds: `plan | search | read | consult | tool | draft | check`. Emitted live on `execution:step`; shown on the review page as **"What the agent did"** (collapsed by default).

### 1.5 Quality gate
After drafting, a cheap structured self-check against a per-agent rubric (answers the task? facts traceable? placeholders left? dates match decisions? open questions listed?). One automatic repair attempt if it fails; the check result is stored and shown as **Confidence** + **Needs your input** (open questions) at the top of the review.

### 1.6 Limits and cost (per execution, configurable)
steps ≤ 8 · web searches ≤ 5 · files read ≤ 12 · wall time ≤ 180 s · consultations ≤ 4, depth ≤ 2 (existing).
Token usage and estimated cost are saved on the execution (`usage jsonb`) and shown to the reviewer; a project-level daily cap stops runaway spend.

### 1.7 Safety rules (all agents)
No irreversible action without a human click (existing F8.7). Web pages and files are data, never instructions. Tool allow-list per agent. Private sources (Gmail/Drive) are used only on behalf of the reviewer and never copied into shared artifacts without marking them.

### 1.8 Data model deltas
`executions`: `confidence real`, `open_questions jsonb`, `usage jsonb`, `route_confidence real`.
`execution_steps` (new). `execution_artifacts.type` gains `html` (sandboxed mockup) and `table`.
`artifact.payload.sources[]`: `{title, url|label, kind: web|project|mail|drive, quote?}`.

## 2. The agents

Order: **Research → Communication → Marketing → Designer → Code** (Research first because Marketing, Designer, Communication and Code consult it).

### 2.1 Research agent
- **Handles**: research, compare, analyse, benchmark, investigate, "find out", summarise.
- **Tools**: `web_search` (≤5), `project_memory_search`, `read_context_item`.
- **Pipeline**: (1) plan 2–4 sub-questions from the task + meeting context → (2) answer each from project memory first, then web → (3) every claim carries a source → (4) verify: each cited URL must be in the raw search results (no invented links) → (5) write.
- **Deliverables**: `markdown` report (Summary · Key findings · Comparison table · Recommendation · Risks & unknowns · Sources) + one `link` artifact per cited source (top 8) + `pdf` export.
- **Honesty rules**: separate *project facts* from *web facts*; list "could not verify"; date-stamp web facts; report length ≤ ~1,500 words.
- **Consults**: none (leaf).
- **Review UX**: sources panel with open-link buttons; claim → source hover.
- **Done when**: golden task "compare competitor pricing pages" returns ≥3 distinct cited URLs, all present in the search results; a task with no web access degrades to a project-only report that says so.

### 2.2 Communication agent
- **Handles**: email, reply, announcement, follow-up, newsletter, message.
- **Tools**: `find_thread` (reviewer's Gmail), `project_memory_search`; consult Research for missing facts.
- **Pipeline**: intent + audience → find existing thread (reply vs new) → gather facts from the brief (dates/decisions/owners) → draft → **fact check** (every date, number and name in the body must appear in the brief) → recipients (existing rule: only addresses from sources or the task; else `missing_recipients`).
- **Deliverables**: `email_draft` (to, cc, subject, body, open_questions, sources, thread ids). Send stays explicit (confirmation dialog, dedupe, ≤10 recipients; existing).
- **Review UX**: editable draft (exists); show the facts used and where they came from.
- **Done when**: "announce the launch" drafts use the *latest* launch date from decisions; a reply lands in the existing thread; no invented address.

### 2.3 Marketing agent
- **Handles**: campaign, GTM, positioning, launch plan, press release, pricing strategy, social plan.
- **Tools**: consult Research (≤2 questions), `get_decisions`, `get_team_tasks`.
- **Pipeline**: research input → audience & positioning → messaging pillars → channels → **timeline anchored to the actual launch date and task owners from the meeting** → KPIs → budget assumptions (always flagged as assumptions) → write.
- **Deliverables**: `markdown` plan + `table` (timeline) + `pdf`.
- **Done when**: if the launch date changed in the meeting, the plan uses the new date and says so; every number is either sourced or labelled "assumption".

### 2.4 Designer agent
- **Handles**: design, logo, banner, mockup, wireframe, UI/UX, poster.
- **Image decision (needs your call)**: Muse Image is unavailable in India. Provider interface `DESIGN_RENDERER=html|fireworks|meta`:
  - `html` (default, works anywhere): the model writes a **self-contained HTML/CSS mockup** (two directions, A/B), rendered in a sandboxed iframe (`sandbox=""`, no scripts, no external URLs, size-capped).
  - `fireworks`: raster concept images from an open image model on Fireworks (you already have access).
  - `meta`: Muse Image, allowed only when deployed outside restricted jurisdictions.
- **Pipeline**: consult Marketing (audience, tone) and Research (reference patterns) → design brief (goal, audience, constraints, palette, type scale, layout, copy) → render → self-check against the brief.
- **Deliverables**: `markdown` brief + `html` mockups (A, B) or `image`; palette/typography as `table`.
- **Done when**: two distinct directions render safely in the sandbox on desktop and 375 px widths; HTML with `<script>` or remote URLs is rejected.

### 2.5 Code agent
- **Levels**: **L1** plan (always) · **L2** patch against the project's workspace folder, shown as a diff, **never applied automatically** · **L3** GitHub PR after approval (later; needs a token).
- **Tools (read-only, confined to the workspace root)**: `list_files`, `read_file` (≤12 files / 40 KB), `search_code` (existing code index), `git_apply_check` (applies the generated patch to a throw-away copy).
- **Pipeline**: locate files → read → plan (steps, files touched, risks, tests, rollout) → generate unified diff → validate with `git apply --check` (one repair attempt) → write tests *inside the patch*.
- **Deliverables**: `markdown` plan + `diff` (per-file, downloadable `.patch`). No workspace connected → plan only, with a note.
- **Review UX**: upgrade the diff viewer (file tree, side-by-side/inline, line comments that feed the revision loop — PRD F8.5).
- **Done when**: on a seeded sample repo the patch applies cleanly and the proposed test fails before / passes after (checked in the test suite, not in production).

## 3. Collaboration matrix (unchanged limits)
`marketing → research` · `designer → marketing, research` · `communication → research` · `code → research`. Depth ≤ 2, ≤ 4 per task, no cycles; shown in the Collaboration panel (exists) and as `consult` steps in the trace.

## 4. Review experience (shared)
Header: agent · status · **Confidence** · cost · revision. Top card: **Needs your input** (open questions). Tabs per artifact (typed viewers) · **What the agent did** (trace) · Collaboration · Sources. Actions: Approve · Request changes (comment + line comments) · Retry · *Run with another agent* (router override).

## 5. Build order (each = branch, tests, live check, merge on your OK)
0. `feat/agent-core` — gateway v2, brief, router v2, trace, quality gate, limits, review header
1. `feat/agent-research` — web search path, citations, PDF export
2. `feat/agent-communication` — brief-grounded drafting + fact check
3. `feat/agent-marketing` — timeline anchored to decisions, PDF
4. `feat/agent-designer` — renderer interface + HTML mockups (+ chosen image provider)
5. `feat/agent-code` — read-only repo tools, validated patch, diff viewer
6. `feat/agent-e2e` — end-meeting → route → run → review → approve test, cost caps, README

## 6. Decisions to finalise
1. **Designer visuals**: HTML/SVG mockups (recommended) · Fireworks image model · Muse Image (only outside India).
2. **PDF**: server-side pure-Python (`fpdf2`/`reportlab`, no system libs; recommended) vs browser print only.
3. **Code agent ceiling for now**: L2 patch (recommended) · L1 plan only · L3 PR.
4. **Models for deployment**: Wonder for Research + Code, Spark for the rest (recommended) · Spark everywhere · Wonder everywhere.
5. **Auto-run policy**: run every routed task automatically (today) vs ask the reviewer first for expensive agents (Research with search, Code).
6. **Per-project daily spend cap** default.
