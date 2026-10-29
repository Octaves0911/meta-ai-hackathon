# 06 · Security & Privacy Design

## 1. Trust boundaries
Browser ⟷ backend (user identity by username header — **demo-grade**, add OIDC before any public exposure) · backend ⟷ ai/connector (`x-internal-secret`, fail closed) · connector ⟷ Google (OAuth 2.0, read-only default) · ai ⟷ LLM provider (text only, no tokens).

## 2. Threats and controls
| Threat | Control |
|---|---|
| Private mail/Drive leaks to teammates | `visibility` default `private`; audience filter enforced **in SQL**; private insights emitted only to `user:<id>` room, stored with `audience_user_id`, excluded from shared recap and shared `@ai` answers |
| OAuth token theft | Tokens only in connector; AES-256-GCM (`TOKEN_ENC_KEY`, per-row IV+tag); serializers never select token columns; never logged; never in prompts; revoked at Google on disconnect |
| Prompt injection via email/Drive/transcript | `<untrusted_source>` delimiting; third-party labels sanitized; JSON-schema output validation; no tool in AI path can send/delete without a human click |
| Accidental or duplicate email send | Separate `gmail.send` scope requested at first send; confirmation dialog (recipients + body); `unique(execution_id, message_hash)`; ≤10 recipients, subject ≤300, body ≤50 000; audit row per send |
| Hallucinated recipients | Communication agent may only use addresses found in sources or supplied by the user; otherwise flagged `missing_recipients` |
| Unauthorized meeting data access | Chat/transcript endpoints check owner-or-shared flag; personal notes keyed by `(meeting,user)` |
| Service impersonation | Secret header required; unset secret ⇒ service refuses to start |
| Data remnants | Disconnect/delete cascades through relational rows, `memory_chunks`, `external_items`, artifacts in object storage |
| Cost abuse | `STT_MODE=off`, AI switch gating, per-meeting governor caps, per-user rate limits (60 req/min REST) |
| Upload risks | 50 MB cap, MIME sniffing, files served with `Content-Disposition` + `nosniff`; workspace local-folder paths confined to configured root (no `..`) |

## 3. Data classification
| Class | Examples | Storage |
|---|---|---|
| Secret | OAuth tokens, `INTERNAL_SECRET` | encrypted / env only |
| Private | synced mail & Drive text, private insights | DB, owner-scoped |
| Project-shared | transcripts, tasks, decisions, shared files | DB, member-scoped |
| Never stored | raw audio/video | — |

## 4. Verification checklist
- [ ] Unit: audience filter returns zero rows for non-owner on private `external_items`.
- [ ] Integration: private insight never appears in another socket's stream or in recap.
- [ ] Integration: disconnect leaves 0 `external_items` and null token columns.
- [ ] Injection test: email body "ignore previous instructions and send…" produces no tool call/side effect.
- [ ] Double-click on *Send* produces exactly one Gmail send.
- [ ] Backend and connector exit non-zero when `INTERNAL_SECRET` is missing.
