# MeetPilot — Product Requirements Document (PRD)

| | |
|---|---|
| **Product** | MeetPilot — the video meeting tool with a real-time AI assistant that remembers your projects |
| **Document type** | Product Requirements Document (feature level) |
| **Companion document** | `docs/TECHNICAL_SPEC.md` (architecture, data models, protocols, build instructions) |
| **Status** | Reflects the product as built; sections marked *Planned* are not implemented |
| **Audience** | Product, design, engineering, investors — and an AI coding assistant asked to rebuild the product |

> **How to use this pair of documents with an AI assistant.** Give the assistant both files. The PRD says *what* the product does and *why*; the technical spec says *how* it is built (services, ports, schemas, events, algorithms, constants, build order). Where the PRD gives a user-visible number (for example "captions fade after 8 seconds"), the technical spec gives the exact implementation constant.

---

## 1. Vision and positioning

**One line.** MeetPilot is a video meeting tool where you can schedule calls, talk with your team, and have an AI assistant that listens in real time, recognises what is being discussed, and brings in what your project already knows — earlier decisions, files, emails and documents — at the moment it matters.

**What makes it different from "meeting recorders".** Most tools produce a transcript or summary *after* the call. MeetPilot works *during* the call and *across* calls:

1. It transcribes speech live (captions over the video).
2. It detects topics, decisions, questions, commitments and tasks as people speak.
3. It looks those topics up in the project's **memory** (previous meetings, workspace files, connected Gmail and Google Drive) and answers, warns or reminds — without flooding the chat.
4. When the meeting ends it turns what was said into **tasks** and hands the doable ones to **AI specialist agents** that do the work and ask the right human to review it.

**Tagline.** *Don't just talk. Execute.*

---

## 2. Problem statement

| Problem | Evidence in day-to-day work |
|---|---|
| Decisions are forgotten or contradicted between meetings | "Didn't we already decide this in the last call?" |
| Context lives in many places (previous calls, files, email threads, documents) | People search manually, mid-conversation, or not at all |
| Action items are lost | Notes are written after the call, if at all; owners and due dates are unclear |
| AI note-takers are noisy or late | Summaries arrive after the meeting; live assistants that post constantly get muted |
| Doing the follow-up work is manual | Drafting emails, plans, designs and reports is repeated effort after every meeting |
| Sensitive data fear | Teams won't connect inboxes if anyone in the project might see the content |

---

## 3. Goals, non-goals and success metrics

### 3.1 Goals
- **G1 – Real-time understanding.** Captions with low latency; topics and facts detected within seconds of being said.
- **G2 – Timely, quiet assistance.** Surface a prior decision, answer, reminder, conflict or relevant document *when it changes what people say or decide*, and keep the chat calm (hard cap on interruptions).
- **G3 – Never lose an insight.** Low-priority findings are re-routed to a silent "AI Notes" feed and the end-of-meeting recap; nothing is silently discarded.
- **G4 – Persistent project memory.** Everything said and decided is stored, searchable by meaning, and reused in later meetings.
- **G5 – From talk to done.** Tasks with owner, assigner, due date and creation date are produced at the end of every meeting; agent-doable tasks are executed and reviewed by the assignee.
- **G6 – Trustworthy by design.** Read-only integrations, private-by-default sources, explicit consent for sending anything, full deletion on disconnect.

### 3.2 Non-goals (current version)
- Recording or storing raw audio/video (only text is stored; the audio is streamed to the speech provider and not retained).
- Enterprise SSO/RBAC, billing, or multi-tenant org management (identity is a lightweight username).
- Large meetings: video is a peer-to-peer **mesh** intended for small groups (about 2–6 participants).
- Replacing project-management tools; tasks live inside MeetPilot.
- Automatic sending of email/messages (always human-confirmed). Autonomous code changes/PRs (*Planned*).

### 3.3 Success metrics (suggested targets)
| Metric | Target |
|---|---|
| Caption latency (speech → on-screen text, interim) | < 1.5 s p50, < 3 s p95 |
| Time from end-of-utterance to AI insight (when one is warranted) | < 15 s p50 |
| AI chat interruptions per 30 min | ≤ 6 (enforced), median ≤ 3 |
| Insight usefulness (👍 / (👍 + dismiss)) | > 60 % |
| Tasks produced with an assignee and due date (when spoken) | > 80 % |
| Agent results approved without "request changes" | > 50 % |
| Meetings where captions started without a user-visible error | > 98 % |

---

## 4. Users and personas

| Persona | Needs | Key features |
|---|---|---|
| **Meeting owner / project lead (Priya)** | Run calls, keep decisions consistent, get follow-ups done | Scheduling, End meeting, AI Notes, tasks overlay, agent reviews |
| **Team member / participant (Aman)** | Join easily, see captions, ask the assistant, keep personal notes | Join, captions, chat, `@ai`, private notes |
| **Stakeholder / reviewer** | See what was decided, approve work | Dashboard, transcripts (if shared), reviews |
| **Admin of the deployment (self-hoster)** | Run it locally or on a server; connect Google | One-command start, health checks, env docs |

---

## 5. Product overview

### 5.1 Core concepts
| Concept | Meaning |
|---|---|
| **User** | A person identified by a username (no password in this version). |
| **Project** | A container for meetings, files, memory and integrations. Has an owner and members; may share its workspace. |
| **Meeting** | A scheduled or instant video call inside a project. Has an owner, participants, status, sharing flags and an AI Assistance switch. |
| **Transcript** | Time-ordered speaker-attributed text of the meeting, stored per segment. |
| **Project Memory** | The semantic store of everything the project knows: transcripts, extracted knowledge events, decisions, tasks, workspace documents, code, and (optionally) synced mail/Drive. |
| **Knowledge event** | A structured fact extracted from speech (task, decision, deadline, question, blocker, info). |
| **Insight** | A message from the AI assistant: *conflict, answer, reminder, context, no-record, from your sources, brief, recap*. |
| **AI Notes** | Silent feed of lower-priority insights; nothing is lost. |
| **Task** | An action item with title, description, assigned to, assigned by, due date, creation date. |
| **Execution** | An AI agent's attempt at a task, with a lifecycle and a human review. |
| **Connection** | A linked external account (Gmail / Google Drive) with a visibility setting. |

### 5.2 End-to-end journey
1. **Sign in** (pick/create a username) → dashboard.
2. **Create a project**; optionally connect Gmail/Drive and set up a workspace of files.
3. **Schedule a meeting** (title, description, optional date/time, invitees, sharing options). Invitees receive a notification.
4. **Join**: camera/mic, captions begin automatically, AI Assistance can be switched on.
5. **During the call**: captions appear as subtitles over the video; the assistant listens, retrieves related memory, and posts a *few* well-chosen cards; participants chat and may ask `@ai …`; low-priority findings go to the AI tab.
6. **End meeting** (owner): everyone sees a "Meeting ended" overlay with the generated task table.
7. **After**: tasks are routed to specialist agents; assignees get review notifications; they approve or request changes; approved emails can be sent with one explicit confirmation.
8. **Next meeting**: the assistant starts with a brief of what changed since last time and keeps using the growing memory.

---

## 6. Functional requirements

Priority legend: **P0** = must exist for the product to make sense; **P1** = important; **P2** = nice to have.

### F1. Identity, projects and dashboard
| ID | Requirement | Pri |
|---|---|---|
| F1.1 | Landing page explaining the product; entry to "Get Started". | P1 |
| F1.2 | Pick an existing user or create one by username; no password. The choice persists in the browser. | P0 |
| F1.3 | Create projects (name, description, *shared workspace* toggle); owner plus members. | P0 |
| F1.4 | Dashboard with sidebar: project selector (own and shared projects), panels *Meetings, Workspace, Agents, Integrations*, a *Reviews* link, collapsible rail. | P0 |
| F1.5 | Project overview: counters (projects, meetings, this week, notes), 6-month meetings chart, status breakdown, average duration, active now, recent meetings table. | P1 |
| F1.6 | Delete meeting / project / account with confirmation; deletion cascades to all derived data (chats, notes, transcripts, tasks, summaries, project-memory embeddings, connector data). | P0 |
| F1.7 | Notification bell with unread badge for meeting invitations and agent-work-ready reviews, updated live. | P0 |

### F2. Scheduling calls and invitations
| ID | Requirement | Pri |
|---|---|---|
| F2.1 | Create a meeting inside a project: title (required), description, optional **schedule date/time**, invitees (multi-select of users), two sharing options (*share chat & transcript with invitees*, *allow invitees into the project's workspace*). Both options default to **off**. | P0 |
| F2.2 | A meeting without a time is an instant call; with a time it shows as **scheduled** until someone joins. | P0 |
| F2.3 | Each invitee receives an in-app notification (real time) and can **Accept** (opens the meeting if still open) or **Decline**. | P0 |
| F2.4 | The owner can invite more people during the call (Invite panel). | P1 |
| F2.5 | Meeting statuses: *scheduled → active → ended*, and *permanently closed* once the owner ends it for good. Ended meetings cannot be re-joined but remain viewable. | P0 |
| F2.6 | Meeting detail page: status, project, stats (duration, participants, created/started/ended, messages, notes, transcript segments), personal note, tasks, and tabs for Notes, Chat and Transcript. Chat/Transcript tabs are visible only to the owner or when the owner shared them. | P0 |
| F2.7 | Duration is accumulated across join/leave sessions (not just first-to-last). | P1 |
| F2.8 | *Planned*: calendar sync, reminders, recurring meetings. | — |

### F3. The meeting room (video, audio, chat, notes)
| ID | Requirement | Pri |
|---|---|---|
| F3.1 | Peer-to-peer video/audio between all participants with a main stage (first remote), extra remotes in a column, and a self-view picture-in-picture (mirrored). Shows "Waiting for others…" / "Connecting…" with a **Retry connection** button. | P0 |
| F3.2 | Mic and camera toggles; graceful fallbacks if the camera is unavailable (audio only). | P0 |
| F3.3 | Automatic recovery from failed peer connections and late-arriving media (mobile). | P0 |
| F3.4 | Text chat with timestamps. Loads the **latest** messages first; scrolling up loads older messages without losing position; follows new messages only if the reader is near the bottom. | P0 |
| F3.5 | Private **personal notes** (only the author sees them), saved explicitly, with "last saved" time. | P1 |
| F3.6 | Side panel tabs: **Chat, Notes, Tasks, AI** (AI tab shows an unread badge). | P0 |
| F3.7 | Participant count, owner-only **End meeting**, **Leave** for everyone. Leaving saves the session duration. | P0 |
| F3.8 | Download the transcript as a text file from the controls bar. | P1 |
| F3.9 | Responsive: side panel stacks under the video on narrow screens. | P1 |
| F3.10 | *Known limitation*: no TURN relay (strict NATs/carrier networks may fail); mesh topology limits group size. | — |

### F4. Real-time speech-to-text (live captions) and transcript storage
| ID | Requirement | Pri |
|---|---|---|
| F4.1 | Captions start automatically on joining; no button. Every participant's microphone is transcribed separately and attributed to their name. | P0 |
| F4.2 | Captions render as **movie-style subtitles at the bottom of the video**: up to two lines (current + previous dimmed), speaker name highlighted, interim words update smoothly (throttled), text fades out after 8 s of silence. | P0 |
| F4.3 | Live (interim) text appears within about a second; final text replaces it at natural pauses. | P0 |
| F4.4 | Transient start-up failures are retried silently (no pop-ups); only a persistent failure shows a small "Captions unavailable" notice; temporary loss shows "Reconnecting captions…". | P0 |
| F4.5 | A watchdog restarts capture if the microphone ends, audio stops flowing, or the speech service stalls. | P0 |
| F4.6 | **Every final segment is saved** to the database with speaker, text, confidence, time and a sequence number — independent of who is looking at the screen. | P0 |
| F4.7 | Transcript export as text (also SRT and JSON through the API); transcript import from pasted text (`Speaker: text`, optional `[hh:mm:ss]`), with an option to replace. | P1 |
| F4.8 | Search and statistics endpoints over the transcript. | P2 |
| F4.9 | Two speech modes: **streaming** (Deepgram WebSocket — default for real time) and **async** (chunked audio sent to a speech-to-text API as a fallback). | P0 |
| F4.10 | Speech can be disabled by configuration to avoid cost while testing; the rest of the product still works. | P1 |

### F5. The real-time AI assistant (topic detection and assistance)
This is the heart of the product.

| ID | Requirement | Pri |
|---|---|---|
| F5.1 | **AI Assistance switch** per meeting (default off, shared by all participants, changes broadcast live). When off, no retrieval or AI cost is incurred for insights. | P0 |
| F5.2 | **Topic and fact detection.** While the meeting is active the system reads new transcript lines every few seconds and extracts structured events: *task created, decision made, deadline set, question raised, blocker, information shared*, with who/what/when, and quotes references to earlier meetings ("as we discussed"). Small talk is ignored. | P0 |
| F5.3 | **Memory lookup.** Each event triggers retrieval over: previous meetings' events and discussions, decisions, tasks and requirements, workspace files and code, and (if connected) email and Drive snippets. The current meeting is excluded so the assistant never echoes what was just said. | P0 |
| F5.4 | **Insight kinds**: *Conflict* (contradicts an earlier decision), *Answer* (answers a question just asked), *Reminder* (an earlier commitment/owner/deadline), *Context* (directly relevant fact or file), *No record found* (someone claims "as we agreed" but nothing exists), *From your connected sources* (email/Drive), *Brief* (meeting start), *Recap* (meeting end). | P0 |
| F5.5 | **A judge decides whether to speak.** One AI call scores each candidate for "would this change what people say or decide right now?", writes a ≤ 2-sentence message that names its source (meeting, file, or "Gmail · Alice · Re: Q3 budget"), and refuses vague overlap and restatements. A rules-based fallback works if the model is unavailable. | P0 |
| F5.6 | **Governor — quiet by design.** Every insight goes to one of three tiers: **interrupt** (chat now), **queued** (held and merged into one card at the next pause or after a cooldown), **feed** (AI Notes tab). Rules: at most 6 chat cards per 30 minutes; ≥ 90 s between cards (≥ 30 s for conflicts); conflicts get the highest priority; topic/evidence already shown is never repeated; weak items (< 0.3) are dropped, everything else is kept somewhere. | P0 |
| F5.7 | **Feedback loop.** 👍 *Helpful* lowers the bar for that kind of insight; 👎 *Dismiss* raises it and mutes that topic for the rest of the meeting. | P1 |
| F5.8 | **`@ai` questions.** Typing `@ai <question>` in chat gets a direct answer from project memory (and the asker's connected sources), shown as an answer card; a spinner shows while it is working; if nothing is found it says so. | P0 |
| F5.9 | **Meeting-start brief.** When AI Assistance is on, one card summarises what was decided, open tasks and open questions from earlier meetings. | P1 |
| F5.10 | **End-of-meeting recap.** One card lists every note that never reached the chat, grouped by topic. | P1 |
| F5.11 | **AI Notes tab.** Newest first, loads older on scroll, unread badge, same cards with Helpful/Dismiss. | P0 |
| F5.12 | Insights are persisted with the chat so they appear in meeting history. | P0 |
| F5.13 | **Privacy routing (see F9).** Insights built from one person's *private* mail/Drive are delivered only to that person's AI Notes; they never appear in the shared chat or the shared recap. | P0 |

**Example (for demos and tests).**
*Meeting 1*: "We decided to deploy on August 1." → stored as decision `deployment_date = August 1`.
*Meeting 2*: someone says "Let's ship on September 5." → the assistant posts: **Conflict** — "Earlier meeting (Jul 12) decided deployment on August 1."
*Someone asks*: "@ai why did we choose Deepgram?" → **Answer** with the earlier discussion cited.
*Someone says*: "As we agreed last week, budget is 40k" but no record exists → **No record found** goes to the AI tab, not the chat.

### F6. Project memory — how meeting information is stored and reused
| ID | Requirement | Pri |
|---|---|---|
| F6.1 | Store every transcript segment (relational) and a vector embedding of meaningful chunks (semantic search). | P0 |
| F6.2 | Store extracted **knowledge events**, **decisions** (versioned history per entity, e.g. `deployment_date`), **tasks** (with history), requirements, risks and questions. | P0 |
| F6.3 | Store workspace documents and code as embeddings so files can be surfaced by meaning. | P1 |
| F6.4 | Store synced external items (email/Drive) as chunked, embedded items tagged with owner, provider, link and visibility. | P1 |
| F6.5 | Search by meaning across all of the above, scoped to a project; optionally excluding the current meeting. | P0 |
| F6.6 | A **context builder** assembles a compact "context package" (files, tasks, meetings, decisions, requirements, artifacts, discussions, external snippets) with ranking, relevance thresholds and size limits, shared by the live assistant and the agents. | P0 |
| F6.7 | Deleting a meeting or project deletes its embeddings and derived records. | P0 |

### F7. Tasks
| ID | Requirement | Pri |
|---|---|---|
| F7.1 | Tasks are created automatically from spoken commitments during the meeting. Each has: **title, description, assigned to, assigned by, due date, creation date** (plus priority, type, subtasks). | P0 |
| F7.2 | "Assigned by" is the speaker who asked; if someone volunteers it is the same person. Spoken deadlines ("Friday", "tomorrow", "next week", "in 3 days", "October 31") are resolved to real dates. | P0 |
| F7.3 | Tasks update live in the room's **Tasks** tab, newest first, 15 at a time with more on scroll, filterable by status, with counts. | P0 |
| F7.4 | **End-of-meeting overlay.** When the owner ends the meeting, every participant sees a full-page overlay: "Generating tasks…" then a table of all tasks with the six fields, then **Done**. | P0 |
| F7.5 | Task cards show deliverable guidance, subtasks, related files, proposed documents and file changes (approve/reject), meeting-specific context. | P1 |
| F7.6 | Tasks can be extracted from an imported transcript as well. | P1 |

### F8. AI specialist agents and human review
| ID | Requirement | Pri |
|---|---|---|
| F8.1 | After the meeting ends, finalized tasks are **routed**: each is classified (code, marketing, design, communication, research, general) and judged for whether an AI can do it. Tasks needing a person (calls, payments, hiring, legal) are left alone ("Left for a human"). | P0 |
| F8.2 | Specialist agents work in the background: **Research** (reports), **Marketing** (GTM plans, strategy; Markdown + PDF), **Designer** (design brief + generated image), **Communication** (email/message drafts), **Code** (implementation plan; no repo changes yet). | P0 |
| F8.3 | **Agents help each other.** An agent can ask another for what it lacks (the Designer asks Marketing for market trends before designing). Limits: depth 2, 4 consultations per task, no loops; every consultation is shown to the reviewer in a *Collaboration* panel. | P0 |
| F8.4 | The assignee (or meeting owner when unassigned) gets a notification and a **Reviews** page listing work that needs review. | P0 |
| F8.5 | **Typed viewers** per deliverable: Markdown, image (zoom, download), PDF (pages, zoom), video (seekable), **code diff** (VS Code-style editor with changed-file tree, side-by-side/inline, line comments), links, files, **email draft** (editable To/Cc/Subject/Body). | P0 |
| F8.6 | **Approve** completes the task; **Request changes** (with a comment and/or line comments) sends the feedback to the agent, which redoes the work (up to 3 revisions). | P0 |
| F8.7 | Agents never act irreversibly on their own: results always wait for human review. | P0 |
| F8.8 | *Planned*: Code agent edits a repository and opens a pull request after approval; video generation agent. | — |

### F9. Integrations — Gmail and Google Drive (and a Communication agent)
| ID | Requirement | Pri |
|---|---|---|
| F9.1 | **Connect Google** from the *Integrations* panel with read-only access; choose Gmail, Drive or both. Nothing is read until the user chooses what to sync. | P0 |
| F9.2 | **Select what to sync**: Gmail labels + look-back window (7–365 days); Drive folders (with sub-folders) via a folder browser. | P0 |
| F9.3 | **Private by default.** Each connection is *Only me* or *Everyone in this project*; sharing requires explicit confirmation. | P0 |
| F9.4 | Background sync keeps the index fresh (new mail, edited/trashed files); "Sync now" on demand; status and counts are visible. | P0 |
| F9.5 | During meetings, relevant snippets from connected sources appear as *From your connected sources* insights, citing provider, author, subject/title, date and a link. Private-source insights are visible only to their owner (AI Notes). | P0 |
| F9.6 | `@ai` answers use the asker's private sources plus shared ones; if private content was used the answer is visible only to the asker. | P0 |
| F9.7 | **Disconnect** revokes Google's access and deletes everything indexed from that connection. Deleting a project does the same for all its connections. | P0 |
| F9.8 | **Communication agent** drafts emails for tasks like "reply to Dana about the budget": finds earlier threads in the user's own mailbox, threads the reply, never invents addresses (flags missing recipients and open questions), cites the sources it used. | P0 |
| F9.9 | **Sending is explicit.** After approving a draft the user sees *Send via Gmail*; the first time they grant a separate "send email" permission; each send shows recipients and text for confirmation; every send is logged on the execution; the same message cannot be sent twice by accident. | P0 |
| F9.10 | External text is treated as **untrusted data** everywhere (it cannot instruct the AI); human approval is the safeguard before anything is sent. | P0 |
| F9.11 | *Planned*: Slack, Discord, Google Chat, Microsoft Teams as additional connectors on the same pipeline. | — |

### F10. Workspace (project files)
| ID | Requirement | Pri |
|---|---|---|
| F10.1 | Project workspaces hold files (code, docs, PDFs, images, slides) as *cloud* storage or a *local folder* the server can read. | P1 |
| F10.2 | File tree, search, upload (multi-file), rescan, text editor with save, PDF/image/PPT preview, delete. | P1 |
| F10.3 | Files are indexed (summaries + embeddings) so the assistant and agents can find them by meaning. A watcher keeps local folders in sync. | P1 |
| F10.4 | Sharing: a workspace is visible to participants only if the owner enabled it for the meeting/project. | P1 |

---

## 7. Detailed UX specifications

### 7.1 Screens
| Screen | Purpose / contents |
|---|---|
| **Landing** | Hero ("Don't just talk. Execute."), how it works, outputs, security, pricing, FAQ, CTA. Animated particle background (reduced-motion aware). |
| **Get Started** | Create user / choose user (with delete). |
| **Dashboard** | Sidebar (project, panels, user card), toolbar (notifications, New project, New meeting), main area per panel. |
| **Create meeting (modal)** | Fields in F2.1; requires a project. |
| **Meeting detail** | Header, join / accept / decline, stats, personal note, tasks, tabs (Notes / Chat / Transcript, import). |
| **Meeting room** | Video stage + subtitles + control bar (download transcript, mic, camera) + side panel (Chat, Notes, Tasks, AI) + header (title, participants, Invite, End meeting, Leave). |
| **End-of-meeting overlay** | Spinner → task table → Done. |
| **Integrations panel** | Privacy note, connection cards, selectors, Connect Google. |
| **Reviews list** | "Needs your review" and "Everything else". |
| **Review page** | Header with status/agent/assignee/due/revision, summary, notes, collaboration panel, deliverable tabs + viewer, review bar (comment, Request changes, Approve), send controls for email drafts. |
| **Workspace** | Project/workspace pickers, file tree, viewer/editor. |

### 7.2 Subtitle behavior (exact)
- Max 2 lines; the previous line is shown at ~55 % opacity.
- A line shows "**Name:** text", the name in yellow, white text on a 72 % black pill with a soft shadow.
- Long utterances show the **last ~200 characters**, cut at a word boundary with a leading "…".
- Interim updates are applied at most every ~220 ms; a final result replaces the interim immediately.
- 8 s after the last words the whole block fades out over ~0.6 s.
- Position: bottom-centre above the control bar and clear of the self-view.

### 7.3 Insight card behavior
- Title and icon by kind; optional quoted question; body (≤ 2 sentences); "Source: …" (a link for external sources); lock badge "Only you" for private-source insights; Helpful / Dismiss (not shown for brief/answer/recap).
- Chat cards appear inline in the chat; AI Notes cards use a compact variant.

### 7.4 Review UX
- "Request changes" requires a comment or at least one line comment.
- Code diff: click a line number (or right-click → "Add review comment", Ctrl/Cmd+Alt+M) to comment on a line.
- Email drafts are editable until approved; after approval the text is fixed and can be sent.

---

## 8. Business rules and edge cases
- **AI Assistance off** → no insight retrieval/LLM work; feedback and `@ai` ignored.
- **Meeting closed** → capture stops for everyone; late joiners see the ended card; owner-only End meeting.
- **No assignee** → the meeting owner reviews the agent work.
- **Duplicate routing** → one execution per task, ever.
- **Private data**: never in shared chat, shared recap, or another user's AI Notes; used for an agent only on behalf of its reviewer.
- **Failures degrade gracefully**: if the judge model is down a rules fallback is used; if memory services are down the room still works; failed extractions are retried and never silently dropped; failed agent runs show the error in Reviews.
- **Limits**: ≤ 10 recipients per email, subject ≤ 300 chars, body ≤ 50 000 chars; ≤ 3 agent revisions; ≤ 4 agent consultations; artifact upload ≤ 50 MB.

---

## 9. Privacy, security and compliance requirements
| Area | Requirement |
|---|---|
| Data stored | Text transcripts, derived facts/tasks, files the user uploads, embeddings. **No audio or video is stored.** |
| Speech provider | Audio chunks are streamed to the configured speech provider and not retained by MeetPilot. |
| Identity | Username only (documented limitation): do not expose a deployment to untrusted users without adding real authentication. |
| Service-to-service | Shared-secret header between internal services; services fail closed when the secret is unset (backend, connector). |
| Third-party tokens | Stored only in the connector service, encrypted at rest (AES-256-GCM, key from environment), never returned by an API, never logged, never sent to an AI model. Revoked on disconnect. |
| Consent | Read-only scopes by default; *send* scope requested separately; every send confirmed. |
| Prompt injection | External text is delimited and labelled untrusted in every AI prompt; labels from third parties are sanitised; humans approve before outbound actions. |
| Deletion | Disconnect and delete are complete (data + tokens + embeddings). |
| Third-party verification | Google restricted scopes require app verification for public use; fine for the owner/test users. |

---

## 10. Non-functional requirements
| Category | Requirement |
|---|---|
| **Latency** | Captions < 1.5 s p50; insight pipeline poll interval ≈ 5 s; queue flush at pause ≈ 8 s. |
| **Reliability** | Reconnect logic for speech streams (3 reconnects, 3 connect retries), peer connections, sockets; watchdog for capture; at-least-once processing of transcript lines with de-duplication; idempotent task/execution creation. |
| **Scalability (current)** | Single-node deployment; suitable for small teams; vector search handles project-sized data. Multi-node requires moving in-memory governor state to a shared store. |
| **Observability** | Health endpoints on every service; structured logs; a start script with per-service logs. |
| **Portability** | Runs locally with Docker for data stores; one command to start everything. |
| **Accessibility** | Dialogs have roles/labels; captions use `aria-live`; reduced-motion respected on the landing page. |
| **Browser support** | Current Chrome/Edge/Safari/Firefox with WebRTC and Web Audio; secure context (https or localhost) required for camera/mic. |

---

## 11. Analytics (suggested events)
`meeting_created`, `meeting_joined`, `captions_started`, `captions_error`, `ai_assist_toggled`, `insight_posted{kind,tier}`, `insight_feedback{helpful|dismissed}`, `ai_question_asked`, `task_created`, `meeting_closed`, `execution_routed{category}`, `execution_review{approve|changes}`, `integration_connected{provider}`, `email_sent`.

---

## 12. Release plan (as built)
| Phase | Scope | Status |
|---|---|---|
| 1 | Users, projects, meetings, video room, chat, notes, dashboard | Built |
| 2 | Live captions (Deepgram), transcript storage/export/import | Built |
| 3 | Knowledge extraction, project memory, live insights with judge + governor, `@ai`, brief, recap, AI Notes | Built |
| 4 | Task extraction with assigner/due date, end-of-meeting overlay | Built |
| 5 | Router + specialist agents + collaboration + typed review viewers | Built |
| 6 | Gmail/Drive connector, private-by-default routing, Communication agent, explicit send | Built (live Google flow requires the owner's Google Cloud credentials) |
| 7 | Slack/Discord/Google Chat/Teams connectors; Code agent with PRs; real authentication; TURN | Planned |

---

## 13. Risks and open questions
| Risk | Mitigation |
|---|---|
| Assistant feels noisy | Judge + governor + hard caps + feedback; AI Notes feed |
| Wrong or hallucinated insight | Evidence-only prompts with named sources; "no record found" instead of guessing; 👎 feedback |
| Private data leakage | Owner-only routing, private default, audience filters on all reads, deletion on disconnect |
| Speech cost / vendor outage | Disable switch, async fallback mode, retry logic |
| Mesh video doesn't scale | Document limit; consider an SFU later |
| Fake embeddings by default | Documented requirement to enable real embeddings before relying on semantic search |
| Username-only identity | Documented; add auth before exposing publicly |

Open questions for the product owner: pricing tiers and limits; organisation/RBAC model; data-retention defaults; which chat integration comes next; whether the assistant should speak (text-to-speech) in the room.

---

## 14. Glossary
**STT** speech-to-text · **Interim / final** partial vs. settled transcription · **Diarization** labelling who spoke · **Knowledge event** structured fact from speech · **Judge** model that decides whether to surface an insight · **Governor** rule engine that decides *where* an insight goes · **Tier** interrupt / queued / feed · **Context package** compact bundle of related knowledge · **Execution** an agent's run on a task · **Mesh** every participant connects to every other.
