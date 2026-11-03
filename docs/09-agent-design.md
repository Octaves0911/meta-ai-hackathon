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
Structured result: `{category, agent|null, stages[{agent, goal}], scope, can_ai_do, confidence 0..1, reason, missing_inputs[], human_reason}` (multi-stage plans: §1.9).
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

### 1.9 Multi-stage tasks (hand-offs with approval gates)
Some tasks need more than one agent in sequence. A **consultation** (existing) is an agent asking another for input *inside* its run. A **hand-off** is new: agent A finishes, the human approves, and the approved work **starts agent B automatically**.

**Router v2 returns a plan, not just an agent**: `stages: [{agent, goal}]` (1–3 stages) plus `scope` (`deliverable` or `build`) and the reason. Examples:

| Task says | Plan |
|---|---|
| "Design a landing page / website / web app screen / dashboard for the product" | **Designer → (approve) → Code** (a website is meant to be built) |
| "Design a card / banner / poster / social post / logo / template / mockup / wireframe" | **Designer only** (the deliverable *is* the design) |
| "Research competitors and draft our positioning" | Research → (approve) → Marketing |
| "Write the press release and send it to the press list" | Marketing → (approve) → Communication (draft; the *send* is still a separate human click) |
| "Design the landing page, just a mockup" / "only the design" | Designer only (explicit wording wins) |

**Designer → Code is allowed only for web-page work (hard rule).** The Code stage is planned only when the task or the meeting context is about a web page or site: landing page, website, web page, web app screen, dashboard UI, homepage, signup/pricing page, "implement/build the page". Cards, banners, posters, social graphics, logos, templates, brand/print designs, slides and generic mockups or wireframes **never** hand off to Code, and the output of the Designer is not passed to the Code agent for them.
- Detection: regex veto list for non-web artefacts + a model check with the meeting context ("is a web page being designed?"), recorded with its reason on the task.
- Web-related but the wording says "only the mockup / just the design", or the router is unsure: single-stage; the approved design then shows an **"Also build it with Code"** button, shown **only for web-page designs**, started by the human.
- A Designer result for a non-web task offers no Code hand-off or button at all.
Regex rules veto obvious cases; the model decides the rest; the plan and reason are shown on the task.

**Flow** (each stage is an ordinary execution with its own run, trace, review and revisions ≤ 3):
1. Stage 1 runs → *awaiting review*.
2. **Request changes** → only stage 1 re-runs (existing loop). Nothing downstream starts.
3. **Approve** → stage 1 is locked; **stage 2 starts automatically** with a brief that includes the *approved* output of stage 1 (never a draft). The reviewer is notified that it started and sees it on the stage stepper.
4. Stage 2 finishes → *awaiting review* → the reviewer approves (or requests changes) again. The **task is `done` only when the final stage is approved**.
5. Cancelling or rejecting any stage stops the pipeline; earlier approved stages keep their outputs.

Rules:
- **A human approval gates every hand-off.** No stage consumes unapproved work. Approval is the "go": it is *not* a second confirmation.
- When a stage has alternatives (Designer A/B), approval **picks one**: *Approve A* / *Approve B* (or "approve with notes"); only the chosen direction is passed on.
- A later stage that finds the approved input unworkable raises *Needs your input* with a **Send back to stage N** action (counts toward revisions) instead of guessing.
- Irreversible actions never run in a hand-off: Code never applies or deploys, Communication never sends. Those stay explicit clicks.
- Limits: ≤ 3 stages per task; cost caps and the daily project cap apply across the whole pipeline; each stage keeps its own timeout.
- **UI**: a stage stepper at the top of the review (`Design ✓ → Code ● running → Done`), each step opens that stage's review; a notification when a stage is waiting for you or has started.
- **Dependent tasks** (separate tasks, e.g. "send the design to the client") use the attachment-progress chips (§2.2) instead; a hand-off is for one task that needs several agents.

**Designer → Code, concretely**: the approved mockup (chosen direction, brief, palette/type, real copy) is the Code agent's spec. Code turns it into production structure, not a copy-paste of the mockup: semantic HTML, responsive CSS, accessible markup, components if the stack calls for it. With a connected workspace it targets that project's stack and returns a validated patch (§2.5). With **no workspace** (a new site) it returns a **file bundle** (`site.zip` + file tree viewer, ≤ 40 files / 1 MB, static HTML/CSS/JS by default unless the meeting or brand note names a framework). Never auto-applied, never deployed.

### 1.10 Project repositories (owner-managed)
- **Owner setting**: in project settings the **owner** (only) adds GitHub repo links (`https://github.com/<owner>/<name>`), each with an optional short description ("web app", "billing API") and default branch. Members can see them; only the owner adds/removes. Table `project_repos(project_id, owner, name, default_branch, description, languages, indexed_at, added_by)`.
- **Access**: a GitHub connection per project (GitHub App installation preferred; fine-grained token as fallback), stored **only in the connector** (AES-256-GCM like Google tokens), scoped to the listed repos. Adding a repo validates it with the GitHub API (exists, token can read, can open PRs) and shows the result.
- **Repo index**: on add (and on demand/daily) we store README summary, top-level tree, languages, package manifests and key entry points in project memory, so the agent can choose without cloning.
- **Repo picker (first step of every Code task)**: rank the project's repos against the task + meeting context + repo index, output `{repo, confidence, reason, alternatives}`.
  - confident (≥ 0.7 and clearly ahead) → proceeds, shows its choice and reason on the review page;
  - ambiguous → *Needs your input* with the candidate repos as buttons (the reviewer picks, never a guess);
  - none fit → plan only + "no matching repository".
  One repo per execution; a change spanning repos becomes separate stages/PRs.
- **Sandbox use**: the setup phase clones the chosen repo (shallow, token used only for the clone, GitHub and package registries on the network allow-list); the **run phase has no token and no network**. Commit/push/PR happen **outside the sandbox**, from the verified patch, by the backend/connector with the PR-scoped credential (§2.5). No workspace folder is needed once repos are configured (the workspace remains for uploaded files/memory).
- Removing a repo cancels nothing already merged; open executions on it are marked *repo removed*.

### 1.11 Review box and live feedback (all agents)
**Review inbox.** A **Reviews** page lists every execution awaiting the signed-in user's review (all projects, filter by project/agent/status, badge count in the nav and notifications). Opening one shows the review panel; the same panel is used from the task page.

**View in the site, decide in the site.** The deliverable opens in an in-app viewer, not a download: **PDF** (inline PDF viewer, page navigation, zoom), HTML mockups (sandboxed, desktop/mobile toggle, A/B), Markdown, email draft, diff + Verification tab, site preview. Actions live in the same panel: **Approve** (picks A/B where relevant) · **Request changes** (reruns with feedback) · **Reject** (new verdict: stops the task/pipeline, task returns to a human, reason recorded) · Retry · Run with another agent.

**Live interaction while reviewing.** A chat panel beside the deliverable talks to the agent that produced it, with the task brief, the current output and the whole review history as context:
- *Ask* ("why did you pick this palette?", "where does this number come from?") → the agent answers, no change, no revision used.
- *Change request* ("make B darker", "add a pricing section", "shorten the email") → the agent confirms what it will change; **Apply & rerun** starts a new revision with all pending feedback bundled (chat + line/region comments). Only reruns count toward the revision limit (default 5, configurable); chat messages are free but rate-limited and cost-capped.
- The agent may ask **clarifying questions** back in the chat; answers feed the next rerun.
- **Partial reruns**: the previous output and the feedback are given to the agent so it edits instead of starting over, and keeps what was approved ("keep A, revise B").
- Live progress while it reruns (`execution:step` trace) and the new revision opens in the same panel with a **diff against the previous revision** where applicable (text diff; visual A/B for designs).
- Data: `execution_messages(execution_id, revision, role user|agent, text, kind ask|change|clarify, created_at)`; events `execution:message`. The chat is private to reviewers/members of the project, and the same untrusted-input rules apply.

### 1.12 Data model deltas
`executions`: `confidence real`, `open_questions jsonb`, `usage jsonb`, `route_confidence real`, `pipeline_id uuid`, `stage int`, `stage_plan jsonb` (planned agents + reason), `input_execution_id` (the approved stage whose output this one consumes), `approved_choice text` (e.g. design direction A/B).
`execution_steps` (new). `execution_artifacts.type` gains `html` (sandboxed mockup) and `table`; `file` and `pdf` get real payloads (§1.8).
`artifact.payload.sources[]`: `{title, url|label, kind: web|project|mail|drive, quote?}`.
`project_repos` (§1.10), `execution_messages` (§1.11), `executions.repo_id`, review verdict `reject` + status `rejected`.
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
- **Approval and hand-off**: approving picks a direction (A or B). If the router planned Designer → Code (website/landing page/web app), approval starts the Code stage with the chosen direction; for cards, banners, posters, logos and templates the approved design is the final output and the task is done (§1.9).
- **Done when**: two distinct directions render safely in the sandbox on desktop and 375 px widths; HTML with `<script>` or remote URLs is rejected.

### 2.5 Code agent
**Rule: AI-written code is never run or tested anywhere except an isolated Modal Sandbox.** It never executes on the app server or a developer machine. A change is only called *verified* when it passed in the sandbox, and a PR is only ever offered for verified work.

- **Levels**: **L1** plan (always) · **L2** verified patch / site bundle, shown as a diff, never auto-applied · **L3** commit + GitHub PR from a *verified* result (after approval; needs a GitHub connection).
- **Tools**: read-only, confined to the workspace root: `list_files`, `read_file` (≤12 files / 40 KB), `search_code` (existing index), plus sandbox tools: `sandbox_run(cmd)` (allow-listed commands: install, test, lint, build) and `git_apply_check`. Secret files (`.env`, key files) are on a deny-list.
- **As a second stage** (web-page hand-off, §1.9): receives the approved design (chosen direction, brief, palette, copy) as its spec; no workspace → static `site.zip` bundle (≤ 40 files / 1 MB); workspace → patch targeting that stack.

#### Modal sandbox (new)
- **Where**: the Python AI service uses the Modal SDK (`modal.Sandbox`), configured by `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`; `SANDBOX_MODE=modal|mock|off`. Without credentials (or `off`) the agent still produces the plan/patch but labels it **"not tested"** and PR creation is disabled.
- **Image**: a pinned base image per ecosystem (Node, Python, static-site tooling + headless Chromium for page checks); dependencies are installed in a separate phase.
- **Two phases**:
  1. *Setup*: copy the workspace snapshot in, apply the patch, install dependencies. Network is allowed **only to package registries** (outbound allow-list).
  2. *Run*: tests, lint, build and page checks with **network blocked** (`block_network`), no secrets or tokens in the environment, no mounted host paths.
- **Limits per run**: CPU/memory caps, wall-clock timeout per command and per sandbox (Modal's sandbox lifetime default is 300 s; we set ours explicitly), stdout/stderr truncated, file count/size caps. The sandbox is terminated at the end; filesystem snapshots may cache the installed dependencies between repair attempts.
- **What is checked**:
  - *Engineering task*: (a) tests on the **base** code, (b) apply patch, (c) the project's tests plus the new tests, (d) lint/typecheck/build if the project defines them. The new test must fail before and pass after.
  - *Website bundle*: HTML validity, every referenced file exists, no remote scripts or assets, console errors, an accessibility scan, **screenshots at 375 px and desktop** (stored as image artifacts and embedded in the technical-plan PDF).
- **Repair loop**: on failure the logs (truncated) go back to the agent for a fix, **≤ 3 attempts**, each a new sandbox run; within the overall step/time/cost limits. After 3 failures the result is delivered as **"failed verification"** with the logs, no PR option.
- **Evidence** stored with the execution: commands run, exit codes, test counts, durations, truncated logs, screenshots, sandbox cost. Shown on the review page as a **Verification** tab and as the headline status: `Verified ✓ (42 passed, build ok)` / `Failed ✗` / `Not tested`.
- Sandbox output is data, never instructions (a test log saying "ignore previous instructions" does nothing).
- **Cost**: billed per second by Modal (CPU and memory); estimated cost is added to the execution `usage` and counted in the daily cap. Verify current rates on Modal's pricing page before sizing.

#### Pipeline
1. focus → 2. locate and read files → 3. plan (steps, files, risks, tests, rollout) → 4. generate patch / bundle → 5. `git apply --check` → 6. **sandbox verification + repair loop** → 7. quality gate → 8. deliver.

#### Commit and PR (L3), only after verification
- **Preconditions** (all required): status *Verified ✓* · reviewer approved this revision · the project has a GitHub connection for this repo (GitHub App or a fine-grained token with contents + pull-requests write on that repo only).
- **Gate**: *Create PR* is a deliberate click after approval, with a confirmation dialog (repo, base branch, branch name, files changed, verification summary). The "everything passed" condition is necessary but **not sufficient**: a human still decides. Not available when the result is *Failed* or *Not tested*.
- **What it does**: create branch `meetpilot/<task-slug>-<short id>` from the base branch → commit the verified patch (commit message from the plan; author = the reviewer, with an agent co-author trailer) → push the branch → open a PR whose body has the task, meeting link, plan, files touched, **test evidence** and the screenshots/log summary.
- **Never**: push to the default branch, force-push, merge, or delete branches. Idempotent (one PR per execution revision; double-click safe). Audit row per PR.
- **Re-verify**: if the base branch moved since verification, re-run the sandbox on the new base before opening the PR.

- **Deliverables**: `markdown` plan + `diff` (per-file) + **files**: `change.patch` / `site.zip`, `technical-plan.pdf` (includes the verification summary) + a `verification` artifact (logs, results, screenshots) + the PR link once created.
- **Review UX**: upgraded diff viewer (file tree, inline/side-by-side, line comments that feed revisions, PRD F8.5), a **Verification** tab, preview of generated sites in a sandboxed iframe with scripts off (the real execution is in Modal), and the *Create PR* action.
- **Done when**: on a seeded sample repo, the patch applies, the new test fails on base and passes with the patch **inside the sandbox** (a mock transport covers CI; one live Modal run covers the smoke test); a deliberately broken patch is repaired or reported as failed, never PR-able; a build that tries network access or reads host secrets is blocked; a traversal attempt (`../../etc/passwd`) is refused; with `SANDBOX_MODE=off` the result says "not tested" and no PR is possible; the PR is created exactly once and never from an unverified result.

## 3. Collaboration matrix (consultations; unchanged limits)
`marketing → research` · `designer → marketing, research` · `communication → research` · `code → research`. Depth ≤ 2, ≤ 4 per task, no cycles; shown in the Collaboration panel (exists) and as `consult` steps in the trace.

## 4. Review experience (shared)
Header: agent · status · **Confidence** · cost · revision. Top card: **Needs your input** (open questions). Tabs per artifact (typed viewers) · **What the agent did** (trace) · Collaboration · Sources. Actions: Approve · Request changes (comment + line comments) · Retry · *Run with another agent* (router override).

## 5. Build order (each = branch, tests, live check, merge on your OK)
0. `feat/agent-core` — gateway v2, brief, router v2, trace, quality gate, limits, review header
   *Built (branch `feat/agent-core`): schema-constrained JSON + usage/cost + per-agent models, task brief (transcript window, decisions with history, neighbours, prior work), model router with confidence + override + web-page-only design→code plan, quality gate (self-check, one repair, deterministic date/amount fact check), live step trace, confidence/open questions/cost on the review page, daily spend cap. Deferred to their own steps: Responses API + web search (research), multi-stage hand-off execution (designer/code).*
0a. `feat/review-inbox` — Reviews page, in-app PDF/HTML/diff viewers, Reject verdict, notifications
0b. `feat/agent-files` — `apps/ai/files/` PDF builder (spec → bytes; DOCX/PPTX/XLSX later), `file` artifact + storage, download/preview, golden tests
   *Built (branch `feat/agent-files`): `apps/ai/files/pdf.py` (fpdf2; spec → PDF, plus a Markdown→spec converter so every Markdown deliverable gets a matching PDF with no extra model call; landscape one-slide-per-page for deck tasks; Latin-1 text only, other characters shown as `?`), bytes stored in `execution_files` (≤10 MB, `%PDF-` checked on the bytes, safe file names), `GET /api/artifacts/:id/file` (reviewer / assignee / meeting owner only, nosniff + sandbox CSP), `attachable` set only on approval, authenticated in-site PDF viewer. LLM-written slide specs and DOCX/PPTX/XLSX remain later.*
0c. `feat/review-chat` — live agent chat in the review panel (ask / change / clarify), Apply & rerun, partial reruns, revision diff
   *Built (branch `feat/review-chat`): `POST /agents/:name/chat` (answer / planned change / clarifying question, schema-constrained, never claims to have changed anything), `execution_messages`, `GET|POST /executions/:id/messages` (reviewer only, ≤60 messages, spend-cap aware, chat cost added to the run), `POST /executions/:id/rerun` (compiles this revision's requests into one request for changes; the agent receives its previous output and edits it), up to 5 revisions, `?revision=n` to fetch an earlier revision, chat panel + line diff against the previous revision. Region/line comments on designs and live token streaming are later.*
1. `feat/agent-research` — web search path, citations, PDF deliverable
   *Built (branch `feat/agent-research`): Responses API gateway (`respond`, `max_tool_calls` ≤ 5, search cost in the run usage), focus step → search call that sees only a scrubbed question (no names, emails, amounts, links) → citation resolution (every cited link must resolve to a page the search actually returned, exact or same-site, else it is removed and reported) → report with [n] markers and a code-built Sources section → self-check that sees the web findings → one repair; project-only fallback when the web is off, unavailable or unnecessary; owner switch `No external lookups`; Sources artifact. Measured: search results carry titles and URLs only (no page text), so claims are checked against the retrieved list, not against page content; the report says so. Roughly 1.7 US cents and 50-65 s per web run.*
2. `feat/agent-communication` — brief-grounded drafting + fact check, multipart send with approved PDF attachments + live attachment progress chips
   *Built (branch `feat/agent-communication`): connector `multipart/mixed` with PDF-only attachments (≤5 files, ≤10 MB total, content-sniffed, safe names, no header injection); a draft attaches another execution's approved PDF (`attachments` = execution ids, same project only); `GET /executions/:id/attachments` returns live chips (ready / awaiting approval / working with the current step / failed / no file); sending is refused (409, nothing sent, no claim left) until every attachment is approved, enforces the 10 MB cap, hashes the file bytes into the duplicate guard and audits each file in `email_send_attachments`; the agent sees which files exist, suggests attachments only from that list (never invented ids), lists the facts it used, writes in the thread's/meeting's language and flags when the text says “attached” but no file is. Letter PDFs written by the agent itself, voice matching and multiple variants stay later.*
3. `feat/agent-marketing` — timeline anchored to decisions, PDF (slide-per-page for decks)
   *Built (branch `feat/agent-marketing`): task kind `plan` / `copy` / `both` (copy: the text is the deliverable); the model proposes the plan, code does the exact parts: dates counted back from the CURRENT launch decision, owners validated against the real team (else Unassigned), fit check against today's date (phases that do not fit are dropped and listed, re-plan when almost nothing fits), every KPI labelled brief / research / assumption (a sourced-looking target whose figures are not in the brief becomes an assumption), no invented budget, at most 2 Research consults, Timeline `table` artifact + PDF; owner-written brand and voice note (≤1,500 chars) shown to Marketing, Communication and Designer. Slide-per-page PDFs for deck tasks come from the shared PDF builder.*
4. `feat/agent-designer` — renderer interface + HTML mockups (+ chosen image provider)
   *Built (branch `feat/agent-designer`): consults Marketing/Research (≤1 question each), a structured design brief (goal, audience, constraints, real copy, two directions with six-colour palettes and system font stacks), palette hex validation and WCAG AA contrast fixes in code (every adjustment is reported), a check that the two directions really differ, both mockups written as self-contained HTML and REBUILT by an allowlist sanitizer (`safehtml.py`: no scripts, handlers, forms, frames, remote resources or navigation) then checked (real headline/CTA on the page, one h1, no fixed wide layout), repaired once, else replaced by a guaranteed-safe page; copy may not credit or name the team (checked in code and by the self-check, with a repair pass); `Palette and type` table; `Mockups (PDF)` rendered by headless Chrome/Chromium when present (`CHROME_BIN`, `DESIGN_PDF=board` to force) and otherwise drawn as a design board; **Approve A / Approve B** records `executions.approved_choice` for the later web-page build. Layouts measured with no horizontal overflow at 320/375/1280 px. Fireworks/image providers remain deferred.*
5a. `feat/agent-sandbox` — Modal sandbox wrapper (`SANDBOX_MODE`), images, two-phase run, limits, evidence capture, mock transport for tests
   *Built (branch `feat/agent-sandbox`, `apps/ai/sandbox/`): a `Backend`/`Session` interface; `ModalBackend` (Modal SDK 1.6: gVisor runtime, `outbound_domain_allowlist` = npm/PyPI (+ GitHub only for a clone) in the setup phase, `block_network` in the run phase, `snapshot_filesystem` carrying installed dependencies into the network-less run sandbox, files in via stdin, 900 s lifetime cap, per-command timeouts); `ScriptedBackend` (tests, records everything, executes nothing) and `MockBackend` (`SANDBOX_MODE=mock`); there is deliberately no local-process backend (a test asserts no module can spawn a process). `verify_change` clones or unpacks the repo, detects Node/Python (commands come from fixed templates, never from the model), installs, snapshots, then in the run phase runs the baseline tests, applies the new tests alone (must FAIL), applies the change (must PASS), then lint and build; a change is `verified` only if tests actually ran and passed (no test command → `not_tested`). The clone credential travels only in the setup phase's environment, never in an argument, the snapshot, the run phase or the stored evidence (redacted). Evidence: steps, exit codes, counts, truncated output, warnings, estimated cost. `GET /sandbox/status` explains 'Not tested'. **Not yet verified against live Modal** (no credentials here): run `apps/ai/scripts/sandbox_live_check.py` once with a Modal token; it checks verified / failed / does-not-apply and that the network policies really hold.*
5b. `feat/project-repos` — owner adds GitHub repos, validation, index, repo picker
   *Built (branch `feat/project-repos`): strict GitHub link parser (shared; refuses other hosts, http, credentials, ports, traversal), `project_repos` (≤10 per project, owner-only add/edit/refresh/remove, members read-only, duplicates refused in any spelling), repository inspection through the connector (languages, top-level tree, manifest highlights, cleaned README start → capped index text stored server-side, never sent to the browser), optional per-project GitHub token sealed with the same AES-256-GCM vault as Google tokens (validated against GitHub before storing, never returned or logged, deleted with the project; `GET /github/clone-token` is internal-secret only, for the sandbox's clone), GitHub error mapping without the token (404 / bad token / rate limit / forbidden), `POST /repos/pick` where the model scores every linked repo and CODE decides: pick (≥0.7 and 0.2 ahead), ambiguous (reviewer chooses), none (<0.4 or task needs no code); invented ids ignored. Owner UI card with description editing, refresh and push-permission warning. Verified live against real public repos (Express, Flask, Hello-World) and in the browser through the real connector; private repositories and push-permission checks need a token and are untested live.*
5c. `feat/agent-code` — read-only repo tools, patch/site generation, sandbox verification + repair loop, diff viewer, Verification tab
5d. `feat/agent-github-pr` — GitHub connection, branch/commit/PR from verified results, confirmation dialog, audit
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
11. ✅ **Multi-stage tasks**: hand-offs with an approval gate at every stage; website/landing page → Designer → Code; card/banner/template → Designer only (§1.9).
11b. ✅ Designer output goes to Code **only** for web-page design tasks (§1.9).
12. ✅ **Code agent**: all generated code runs and is tested only in a Modal sandbox; commit + PR only from verified results after approval (§2.5).
13. ✅ Features outside the agents: owner-managed project repos with an agent repo picker (§1.10); a Reviews inbox with in-site PDF/design viewing and approve/reject (§1.11); live chat with the agent during review with Apply & rerun (§1.11).
14. ✅ **Defaults adopted (2026-11-03)**: Designer = HTML mockups, PDF via optional headless browser (degrades to brief-only note), Fireworks deferred; models = Wonder for Research + Code, Spark for the rest (dev: contributor tier); auto-run all routed tasks, with the per-run limits of §1.6; daily spend cap default **US$5 per project** (configurable); PR creation is a deliberate click after approval.
15. **Still open**: Modal account/token for the live sandbox check, GitHub App vs fine-grained token, Research search provider (Meta `web_search` assumed), Communication voice/channels/variants/language.
