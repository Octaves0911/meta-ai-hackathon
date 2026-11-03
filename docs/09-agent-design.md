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

### 1.8 File generation (shared; today no agent produces a real file)
Today agents return Markdown, links, an email draft and one tiny SVG; the `pdf` type has no producer. Every agent that delivers a document must produce a **real, downloadable file**.

**Principle: the model writes a structured spec (JSON, schema-constrained), deterministic code builds the file.** This is more reliable and better looking than free-form output, and keeps file bytes out of prompts.

**Decided: first pass is PDF only.** DOCX, PPTX and XLSX are designed for (same spec-then-build mechanism, same `file` artifact) but deferred.

| Format | Library (pure Python, no system deps) | Spec the model fills | Used by | Status |
|---|---|---|---|---|
| PDF | `fpdf2` (or `reportlab`) | title, sections[heading, paragraphs, bullets, table], sources | Research, Marketing, Communication (letters), Designer (brief, mockups), Code (plan) | **first pass** |
| `.patch`, MD | stdlib | diff / text | Code, all (downloads, not email-attachable) | first pass |
| DOCX | `python-docx` | same section spec as PDF | Marketing, Research | later |
| PPTX | `python-pptx` | slides[title, bullets, table, notes] | Marketing, Research, Designer | later |
| XLSX | `openpyxl` | sheets[name, columns, rows] | Marketing, Research | later |
| HTML (+ PDF export) | sandboxed HTML | design spec | Designer | first pass (no PNG) |

Presentation/Word/spreadsheet tasks in the first pass produce a PDF version (for a deck: one slide per page, landscape) and say so in *Needs your input* ("editable PPTX not generated yet").

- One module `apps/ai/files/` with `build_pdf(spec) -> bytes` (docx/pptx/xlsx builders later), golden-file tests (opens with the reader library, page/slide counts, no empty sections).
- **Storage**: bytes go to the existing artifact storage; the artifact is `type: "file"` with `payload {storage_key, filename, mime, size, sha256, attachable, pages|slides}`. Served with `Content-Disposition` + `nosniff` (existing upload rules). Previews: PDF inline, PPTX/DOCX as thumbnail/outline text + download.
- **Limits**: ≤ 10 MB per file, ≤ 8 files per execution (email: ≤ 10 MB total, §2.2); filenames sanitised (`[A-Za-z0-9._ -]`, no path parts).
- **Honesty**: any figure in a file is sourced or labelled "assumption" (same rules as the text deliverable); the quality gate checks the spec before the file is built.
- **Attachable**: a file is `attachable` only after its execution is **approved** (never a draft).

### 1.9 Data model deltas
`executions`: `confidence real`, `open_questions jsonb`, `usage jsonb`, `route_confidence real`.
`execution_steps` (new). `execution_artifacts.type` gains `html` (sandboxed mockup) and `table`; `file` and `pdf` get real payloads (§1.8).
`artifact.payload.sources[]`: `{title, url|label, kind: web|project|mail|drive, quote?}`.
`email_send_attachments(execution_id, artifact_id, filename, mime, size, sha256)` (new; audit + dedupe).

## 2. The agents

Order: **Research → Communication → Marketing → Designer → Code** (Research first because Marketing, Designer, Communication and Code consult it).

### 2.1 Research agent
- **Handles**: research, compare, analyse, benchmark, investigate, "find out", summarise.
- **Tools**: `web_search` (≤5), `project_memory_search`, `read_context_item`.
- **Meeting context (always included)**: the Research call receives the live state of the meeting the task came from, so it is up to date and its searches are focused:
  - the quote and ±10 transcript lines around it, with speaker names (why the task exists, which competitors/regions/products were named);
  - meeting title, date, attendees, and the agenda or meeting goal if set;
  - current decisions with change history (e.g. launch date moved 15th → 22nd), key points and open questions from this meeting;
  - sibling tasks from the same meeting (what else was assigned, to whom), so the report does not duplicate them and can point to them.
  Budgeted: quote/lines and decisions first (short, high value); project-memory snippets fill the remainder. All wrapped in `<untrusted_source>`.
- **Pipeline**: (1) **focus**: from task + meeting context, state the exact question to answer, the entities/constraints already named in the meeting, and what the team already decided (so it is not re-researched) → (2) plan 2–4 sub-questions → (3) answer each from project memory first, then web, with **search queries built from the meeting's own terms** (names, regions, versions, dates) and stripped of private details (internal figures, customer names, private mail text) → (4) every claim carries a source → (5) verify: each cited URL must be in the raw search results (no invented links) → (6) write the answer **to the focused question**, flagging where findings conflict with a meeting decision.
- **Privacy**: anything taken from private Gmail/Drive is labelled in the report; approving a report that contains such items to the shared project warns the reviewer first. A project-level "No external lookups" switch forces project-only mode.
- **Deliverables**: `markdown` report (Summary · Key findings · Comparison table · Recommendation · Risks & unknowns · Sources) + one `link` artifact per cited source (top 8) + **file**: `report.pdf` (always; for a deck/briefing task, a landscape slide-per-page PDF).
- **Honesty rules**: separate *project facts* from *web facts*; list "could not verify"; date-stamp web facts; report length ≤ ~1,500 words.
- **Consults**: none (leaf).
- **Review UX**: sources panel with open-link buttons; claim → source hover.
- **Done when**: golden task "compare competitor pricing pages" returns ≥3 distinct cited URLs, all present in the search results; a task with no web access degrades to a project-only report that says so; when the meeting named specific competitors, the searches and report cover exactly those; a finding that contradicts a meeting decision is flagged in "Needs your input".

### 2.2 Communication agent
- **Handles**: email, reply, announcement, follow-up, newsletter, message.
- **Tools**: `find_thread` (reviewer's Gmail), `project_memory_search`; consult Research for missing facts.
- **Pipeline**: intent + audience → find existing thread (reply vs new) → gather facts from the brief (dates/decisions/owners) → draft → **fact check** (every date, number and name in the body must appear in the brief) → recipients (existing rule: only addresses from sources or the task; else `missing_recipients`).
- **Deliverables**: `email_draft` (to, cc, subject, body, open_questions, sources, thread ids, **attachments[]**). Send stays explicit (confirmation dialog, dedupe, ≤10 recipients; existing). Writes its own file only when the task is a letter/notice (`letter.pdf`).
- **Attachments** (new):
  - The agent scans the project for **approved** file artifacts relevant to the task (other tasks from the same meeting, prior approved work) and proposes them as chips on the draft; it never attaches anything on its own.
  - The reviewer ticks each file; the send dialog lists every attachment (name, size, type) next to recipients and body.
  - **Attachment progress in the email review box (decided).** If the task implies an attachment that another agent is still preparing ("send the deck" while the deck task is queued/running/awaiting approval), the email draft shows a live chip for it with its state and progress: `waiting to start → agent running (current step from the trace) → awaiting approval → ready`. States update over the existing `execution:update` / `execution:step` events. **Send stays disabled while a ticked attachment is not ready**; the reviewer can untick it to send without, or open the other task from the chip. Once the other execution is approved the chip turns ready and the file attaches. Failure or rejection shows on the chip with a retry link.
  - Connector: `buildRaw` gains multipart/mixed with attachments. **First pass: PDF only** (extensible allow-list), ≤ 5 files, **≤ 10 MB total (decided)**; type verified by content sniffing, filenames sanitised against header injection; dedupe hash includes attachment hashes; audit row per attachment.
  - Private Drive files are never auto-attached; the reviewer must pick one explicitly. Attachment bytes never enter model prompts.
- **Review UX**: editable draft (exists); show the facts used and where they came from.
- **Done when**: "announce the launch" drafts use the *latest* launch date from decisions; a reply lands in the existing thread; no invented address.

### 2.3 Marketing agent
- **Handles**: campaign, GTM, positioning, launch plan, press release, pricing strategy, social plan.
- **Tools**: consult Research (≤2 questions), `get_decisions`, `get_team_tasks`.
- **Pipeline**: research input → audience & positioning → messaging pillars → channels → **timeline anchored to the actual launch date and task owners from the meeting** → KPIs → budget assumptions (always flagged as assumptions) → write.
- **Deliverables**: `markdown` plan + `table` (timeline) + **file**: `plan.pdf` (always; for deck/pitch tasks a landscape slide-per-page PDF built from a structured slide spec: title, 3–5 bullets, optional table, one idea per slide). Editable PPTX/DOCX/XLSX later.
- **Brand note (decided)**: a short project-level "brand & voice" note (owner-editable in project settings; ≤ 1,500 chars) is always included in the brief for Marketing, Communication and Designer. No tone inference from documents.
- **Timeline-fit check (decided)**: before writing, compare the work needed with the time left before the launch date. If it does not fit, say so plainly in *Needs your input* and deliver a reduced-scope plan (what can be done by the date, what slips), never a squeezed unrealistic one.
- **Plan vs copy (decided)**: the task type is detected first: `plan` (campaign/GTM/positioning), `copy` (press release, launch posts, ad text, announcement) or `both`. For `copy` the **actual text is the main deliverable** (e.g. the press release, the posts), with a short rationale; a plan is not produced instead of the copy.
- **Hard rule**: KPIs and budget figures not found in the project or in Research's cited results are tagged "assumption".
- **Done when**: if the launch date changed in the meeting, the plan uses the new date and says so; every number is either sourced or labelled "assumption"; an unfit timeline is flagged with a reduced-scope version; a "write the press release" task yields the release text.

### 2.4 Designer agent
- **Handles**: design, logo, banner, mockup, wireframe, UI/UX, poster.
- **Image decision (needs your call)**: Muse Image is unavailable in India. Provider interface `DESIGN_RENDERER=html|fireworks|meta`:
  - `html` (default, works anywhere): the model writes a **self-contained HTML/CSS mockup** (two directions, A/B), rendered in a sandboxed iframe (`sandbox=""`, no scripts, no external URLs, size-capped).
  - `fireworks`: raster concept images from an open image model on Fireworks (you already have access).
  - `meta`: Muse Image, allowed only when deployed outside restricted jurisdictions.
- **Pipeline**: consult Marketing (audience, tone) and Research (reference patterns) → design brief (goal, audience, constraints, palette, type scale, layout, copy) → render → self-check against the brief.
- **Deliverables**: `markdown` brief + `html` mockups (A, B) or `image`; palette/typography as `table`; **files**: `design-brief.pdf` and `mockups.pdf` (A and B, rendered). Image-provider outputs, if enabled, are stored as `file` PNG/JPG. No PNG export of HTML mockups in the first pass.
- **Done when**: two distinct directions render safely in the sandbox on desktop and 375 px widths; HTML with `<script>` or remote URLs is rejected.

### 2.5 Code agent
- **Levels**: **L1** plan (always) · **L2** patch against the project's workspace folder, shown as a diff, **never applied automatically** · **L3** GitHub PR after approval (later; needs a token).
- **Tools (read-only, confined to the workspace root)**: `list_files`, `read_file` (≤12 files / 40 KB), `search_code` (existing code index), `git_apply_check` (applies the generated patch to a throw-away copy).
- **Pipeline**: locate files → read → plan (steps, files touched, risks, tests, rollout) → generate unified diff → validate with `git apply --check` (one repair attempt) → write tests *inside the patch*.
- **Deliverables**: `markdown` plan + `diff` (per-file) + **files**: `change.patch` (downloadable, `git apply`-able) and `technical-plan.pdf` (shareable with non-developers). No workspace connected → plan only, with a note.
- **Review UX**: upgrade the diff viewer (file tree, side-by-side/inline, line comments that feed the revision loop — PRD F8.5).
- **Done when**: on a seeded sample repo the patch applies cleanly and the proposed test fails before / passes after (checked in the test suite, not in production).

## 3. Collaboration matrix (unchanged limits)
`marketing → research` · `designer → marketing, research` · `communication → research` · `code → research`. Depth ≤ 2, ≤ 4 per task, no cycles; shown in the Collaboration panel (exists) and as `consult` steps in the trace.

## 4. Review experience (shared)
Header: agent · status · **Confidence** · cost · revision. Top card: **Needs your input** (open questions). Tabs per artifact (typed viewers) · **What the agent did** (trace) · Collaboration · Sources. Actions: Approve · Request changes (comment + line comments) · Retry · *Run with another agent* (router override).

## 5. Build order (each = branch, tests, live check, merge on your OK)
0. `feat/agent-core` — gateway v2, brief, router v2, trace, quality gate, limits, review header
0b. `feat/agent-files` — `apps/ai/files/` PDF builder (spec → bytes; DOCX/PPTX/XLSX later), `file` artifact + storage, download/preview, golden tests
1. `feat/agent-research` — web search path, citations, PDF deliverable
2. `feat/agent-communication` — brief-grounded drafting + fact check, multipart send with approved PDF attachments + live attachment progress chips
3. `feat/agent-marketing` — timeline anchored to decisions, PDF (slide-per-page for decks)
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
7. ✅ **File formats in the first pass**: PDF only (DOCX/PPTX/XLSX later).
8. ✅ **PNG export of HTML mockups**: skipped (HTML + PDF).
9. ✅ **Pending attachments**: progress shown live in the email review box; Send disabled until ticked attachments are ready.
10. ✅ **Max total attachment size**: 10 MB.
