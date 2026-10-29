# 05 · UX & Frontend Design

## 1. Frontend architecture
```
apps/web/src/
├─ routes/            landing, get-started, dashboard, meeting/:id (detail), room/:id, reviews, reviews/:id
├─ features/
│  ├─ room/           VideoStage, SelfView, ControlBar, SidePanel(Chat|Notes|Tasks|AI), EndOverlay
│  ├─ captions/       useMicCapture, useCaptionStream, SubtitleOverlay
│  ├─ rtc/            usePeerMesh (offer/answer/ICE, retry, recovery)
│  ├─ insights/       InsightCard, AiNotesFeed, useInsights
│  ├─ meetings/ projects/ tasks/ reviews/ integrations/ workspace/
├─ stores/            session (user), room (peers, captions, ai state), notifications
└─ lib/               api client (zod-validated), socket, format
```
State: server data via TanStack Query; live state (peers, captions, insights) in Zustand fed by Socket.IO. Routes are code-split; the room bundle loads only on `/room/:id`.

## 2. Layouts

**Dashboard** — left rail (project selector, Meetings · Workspace · Agents · Integrations, Reviews link, user card; collapsible) · top bar (🔔 badge, New project, New meeting) · main panel per route.

**Meeting room**
```
┌──────────────────────────────────────────────┬────────────────┐
│ Title · 3 participants · Invite  End  Leave  │ Chat Notes     │
├──────────────────────────────────────────────┤ Tasks AI(2)    │
│                                  ┌────────┐  ├────────────────┤
│        main stage (remote 1)     │remote 2│  │ messages /     │
│                                  │remote 3│  │ insight cards  │
│   ┌──────────────────────────┐   └────────┘  │                │
│   │ Priya: we should ship on…│  subtitles    │                │
│   └──────────────────────────┘     ┌──────┐  │                │
│  [⤓ transcript] [🎤] [📷]         │ self │  ├────────────────┤
│                                    └──────┘  │ [msg … @ai]    │
└──────────────────────────────────────────────┴────────────────┘
 < 900px: side panel stacks beneath the video
```
The **AI Assistance** switch sits in the header; its state is shared and broadcast.

## 3. Component specs

### SubtitleOverlay (exact behaviour, PRD §7.2)
- Max 2 lines; previous at 55 % opacity; `**Name:**` in `#FFD84D`, text white on `rgba(0,0,0,.72)` pill, soft shadow.
- Show last ~200 chars cut at word boundary with leading "…".
- Interim updates throttled to 220 ms; final replaces immediately; 8 s idle → 0.6 s fade.
- Anchored bottom-centre, `bottom` offset above control bar, horizontal inset clear of self-view. Container has `aria-live="polite"`.
- Status chip: "Reconnecting captions…" (transient) / "Captions unavailable" (persistent after retries). No modal errors.

### InsightCard
| Kind | Icon · colour token | Feedback buttons |
|---|---|---|
| conflict | ⚠ `--warn` | Helpful / Dismiss |
| answer | 💬 `--info` | none |
| reminder | ⏰ `--accent` | yes |
| context | 📎 `--neutral` | yes |
| no_record | ∅ `--muted` (feed only) | yes |
| external | ✉/📁 `--info` + 🔒 "Only you" when private | yes |
| brief / recap | 📋 `--neutral` | none |
Anatomy: title · optional quoted question · body (≤2 sentences) · `Source: …` (link for external) · feedback row. AI-tab variant is compact (single-line title, expandable).

### Chat
Loads latest 30; scroll-up sentinel loads older and preserves scroll offset (`scrollTop += newHeight − oldHeight`); auto-follow only if within 80 px of bottom. `@ai` messages show an inline spinner row bound to `ai:working`.

### TasksTab / EndOverlay
Tasks tab: newest first, 15 per page, infinite scroll, status filter chips with counts. EndOverlay: full-screen, focus-trapped (`role="dialog"`), spinner "Generating tasks…" → table (Title · Description · Assigned to · Assigned by · Due · Created) → **Done** returns to meeting detail.

### Review page
Header (status · agent · assignee · due · revision n/3) → summary & notes → **Collaboration** panel (consultations) → deliverable tabs with typed viewers: `MarkdownViewer`, `ImageViewer` (zoom/download), `PdfViewer` (paging/zoom), `VideoPlayer`, `DiffViewer` (Monaco diff, file tree, side-by-side/inline, line comments via gutter click / right-click / Ctrl-Cmd-Alt-M), `LinkList`, `FileList`, `EmailEditor` (To/Cc/Subject/Body, editable until approved). Sticky review bar: comment box · **Request changes** (disabled without comment or line comment) · **Approve**. After approval an email draft shows **Send via Gmail** → confirm dialog listing recipients + body.

### Integrations panel
Privacy note → connection cards (provider, account, visibility chip *Only me / Everyone in project*, last sync, counts, Sync now, Disconnect) → config (Gmail labels + look-back slider 7–365, Drive folder browser with sub-folder toggle). Switching to *Everyone* opens a confirmation modal that states what becomes visible.

## 4. Design tokens
```css
:root{ --bg:#0E1116; --surface:#161B22; --border:#262C36; --text:#E6EAF0; --muted:#8B94A3;
       --accent:#6C8CFF; --info:#4DB6FF; --warn:#FFB84D; --danger:#FF6B6B; --ok:#4CD6A0;
       --subtitle:#FFD84D; --radius:12px; --font:Inter, system-ui, sans-serif; }
@media (prefers-color-scheme: light){ :root{ --bg:#F7F8FA; --surface:#FFF; --border:#E3E6EB; --text:#12161C; --muted:#5E6674; } }
```
Spacing scale 4/8/12/16/24/32. Min tap target 40 px. Focus ring 2 px `--accent`.

## 5. Interaction states & errors
| Situation | UX |
|---|---|
| Camera denied/unavailable | audio-only banner, video tile shows initials |
| Peer not connected after 10 s | "Connecting…" + **Retry connection** button |
| STT start failure | silent retries (3×); then chip "Captions unavailable"; never a toast |
| AI off | AI tab shows "Turn on AI Assistance to get live help"; `@ai` replies gently that AI is off |
| Meeting ended | late joiners see an "ended" card with link to detail page |
| Agent failed | red status in Reviews with error and **Retry** |
| Empty states | every list has a one-line explanation + primary action |

## 6. Accessibility & responsiveness
Dialogs: `role="dialog"`, `aria-modal`, labelled, focus trap, Esc closes (except EndOverlay). All controls keyboard reachable; icon buttons have `aria-label`. Landing particle background disabled under `prefers-reduced-motion`. Breakpoints: ≥1100 two-column room; 900–1100 narrower panel; <900 stacked.

## 7. Landing page
Sections: hero ("Don't just talk. Execute."), how it works (3 steps), outputs (captions, insights, tasks, agents), security, pricing (placeholder), FAQ, CTA → Get Started.
