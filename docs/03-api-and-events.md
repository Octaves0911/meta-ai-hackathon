# 03 · REST API & Realtime Event Contracts

Base URL `http://localhost:4000/api`. Caller identity: header `x-user: <username>` (documented limitation). JSON everywhere. Errors: `{ "error": { "code": "string", "message": "string" } }` with 400/401/403/404/409.
Shared zod schemas live in `packages/shared` and are the single source of truth for both ends.

## 1. REST

### Identity & projects
| Method | Path | Notes |
|---|---|---|
| GET | `/users` | list for picker |
| POST | `/users` `{username}` | 409 if taken |
| DELETE | `/users/:id` | cascade (F1.6) |
| GET/POST | `/projects` | list own+shared / create `{name,description,shareWorkspace}` |
| DELETE | `/projects/:id` | owner only; cascades + revokes connections |
| GET | `/projects/:id/overview` | counters, 6-month chart, status breakdown, avg duration, recent |

### Meetings
| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/meetings` | filter `status` |
| POST | `/projects/:id/meetings` | `{title,description?,scheduledAt?,inviteeIds[],shareChatTranscript=false,shareWorkspace=false}`; creates notifications |
| GET | `/meetings/:id` | detail + stats; chat/transcript tabs gated by owner-or-shared |
| POST | `/meetings/:id/invite` `{userIds[]}` | owner |
| POST | `/meetings/:id/respond` `{accept:boolean}` | invitee |
| POST | `/meetings/:id/join` · `/leave` | leave accumulates `total_duration_sec` |
| POST | `/meetings/:id/end` | owner; triggers end-of-meeting flow (§architecture 4.3) |
| PUT | `/meetings/:id/ai-assist` `{enabled}` | broadcast `ai:assist` |
| DELETE | `/meetings/:id` | cascade |

### Chat, notes, transcript
| Method | Path | Notes |
|---|---|---|
| GET | `/meetings/:id/messages?before=<ts>&limit=30` | newest-first page; client reverses |
| POST | `/meetings/:id/messages` `{body}` | `@ai ` prefix triggers assistant answer |
| GET/PUT | `/meetings/:id/notes` | caller's own note only |
| GET | `/meetings/:id/transcript?format=json\|txt\|srt` | |
| POST | `/meetings/:id/transcript/import` `{text,replace?}` | `Speaker: text` / `[hh:mm:ss]` |
| GET | `/meetings/:id/transcript/search?q=` · `/stats` | P2 |

### Insights & tasks
| Method | Path | Notes |
|---|---|---|
| GET | `/meetings/:id/insights?tier=feed&before=` | audience-filtered for caller |
| POST | `/insights/:id/feedback` `{value:'helpful'\|'dismissed'}` | adjusts governor thresholds |
| GET | `/meetings/:id/tasks?status=&before=&limit=15` | |
| PATCH | `/tasks/:id` | edit fields; writes `task_history` |

### Agents & reviews
| Method | Path | Notes |
|---|---|---|
| GET | `/reviews?scope=needs_review\|all` | caller's executions |
| GET | `/executions/:id` | summary, artifacts, consultations, revisions |
| POST | `/executions/:id/review` `{verdict, comment?, lineComments?[]}` | `changes` requires comment or ≥1 line comment; 409 after 3 revisions |
| PUT | `/executions/:id/artifacts/:aid` | edit email draft before approval only |
| POST | `/executions/:id/send-email` `{artifactId, confirm:true}` | needs send scope; dedupes via `message_hash` |

### Integrations (proxied to connector)
| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/connections` | never returns tokens |
| POST | `/projects/:id/connections/google/start` `{services:['gmail','drive'], visibility}` | returns OAuth URL |
| GET | `/connections/google/callback` | OAuth redirect target |
| PUT | `/connections/:id` | `{visibility, labels, lookbackDays(7–365), folderIds}`; `visibility→project` requires `confirmShare:true` |
| POST | `/connections/:id/sync` | on-demand |
| GET | `/connections/:id/drive/folders?parent=` | folder browser |
| DELETE | `/connections/:id` | revoke + purge |

### Workspace
`GET /projects/:id/files` · `GET /files/:id` · `PUT /files/:id` · `POST /projects/:id/files` (multipart) · `POST /projects/:id/rescan` · `DELETE /files/:id`

### Notifications
`GET /notifications` · `POST /notifications/:id/read`

### Internal (service-to-service, `x-internal-secret`)
| Service | Endpoint | Purpose |
|---|---|---|
| ai | `POST /extract` | transcript lines → knowledge events |
| ai | `POST /judge` | event + candidates → decision |
| ai | `POST /answer` | `@ai` question + context |
| ai | `POST /embed` | texts → vectors |
| ai | `POST /agents/:name/run` · `/revise` | start / redo execution |
| connector | `POST /search` | `{projectId, viewerId, query}` → snippets |
| connector | `POST /gmail/send` | send after confirmation |

## 2. Realtime (Socket.IO)

Namespace `/`, auth `{username}`. Rooms: `meeting:<id>`, `user:<id>` (notifications).

### Signaling (client ↔ server)
| Event | Dir | Payload |
|---|---|---|
| `room:join` | c→s | `{meetingId}` → ack `{peers:[{userId,socketId,name}]}` |
| `peer:joined` / `peer:left` | s→c | `{userId,socketId,name}` |
| `rtc:offer` / `rtc:answer` / `rtc:ice` | c↔s↔c | `{to,from,sdp\|candidate}` |
| `rtc:retry` | c→s | `{to}` re-negotiate (F3.1 Retry) |

### Room state
| Event | Payload |
|---|---|
| `chat:message` | message row (incl. insight cards) |
| `ai:assist` | `{enabled}` |
| `ai:working` | `{askId}` spinner for `@ai` |
| `insight:new` | `{insight, tier}` — `interrupt` goes to chat, `feed` to AI tab; private ones emitted **only** to `user:<audienceUserId>` |
| `task:upserted` | task row |
| `meeting:ended` | `{meetingId}` capture stops, overlay opens |
| `meeting:tasks_ready` | `{tasks[]}` overlay table |

### Captions
| Event | Payload |
|---|---|
| `caption:interim` | `{userId,speaker,text,ts}` (not persisted) |
| `caption:final` | `{userId,speaker,text,seq,ts}` |
| `caption:status` | `{userId,state:'ok'\|'reconnecting'\|'unavailable'}` |

### User channel
`notification:new` `{type,payload}` · `execution:update` `{id,status}`

### STT socket (binary)
`ws://…/stt?meetingId=&userId=` — client sends 16 kHz mono PCM16 frames (~100 ms); server sends the JSON `caption:*` payloads back and mirrors them into the room. Close codes: `4001` meeting closed, `4002` STT off.

## 3. Idempotency & ordering
- `transcript_segments (meeting_id, seq)` unique; `seq` assigned server-side in a transaction.
- Insight worker keeps a per-meeting cursor `last_seq_processed`; re-processing the same range is safe (events keyed by `(meeting_id, from_seq, type, summary_hash)`).
- Execution creation uses `unique(task_id)`; send-email uses `unique(execution_id, message_hash)`.
