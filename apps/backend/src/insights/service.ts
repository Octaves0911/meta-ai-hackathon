import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Events, type Insight } from '@meetpilot/shared';
import { buildContext, type ContextPackage } from '../memory/context.js';
import { indexRecord } from '../memory/store.js';
import { searchMemory } from '../memory/search.js';
import { Governor, PRIORITY } from './governor.js';
import { toInsight } from './format.js';
import { TASK_SELECT, toTask } from './tasksFormat.js';
import { resolveDue, taskTitle, todayInTz } from '../services/due.js';
import { createLlmClient, type LlmClient } from './llm.js';
import { answerRules, extractRules, judgeRules } from './rules.js';
import type { Candidate, EventDraft, InsightKind, TranscriptLine, Verdict } from './types.js';

type Queued = Verdict & { insightId?: string };
interface MeetingRow { id: string; project_id: string; owner_id: string; ai_assist: boolean }

const NO_ANSWER = "I couldn't find anything about that in this project's memory.";
const isReal = () => (process.env.EMBEDDING_PROVIDER ?? 'fake') === 'real';
const thresholds = () => (isReal() ? { answer: 0.75, reminder: 0.6 } : { answer: 0.25, reminder: 0.25 });
const hash = (s: string) => createHash('md5').update(s).digest('hex').slice(0, 16);

/** Live assistant: extract -> retrieve -> judge -> govern -> deliver, plus brief, recap and `@ai` answers (docs/04). */
export class InsightService {
  private governors = new Map<string, Governor<Queued>>();
  private cursors = new Map<string, number>();
  private busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private labels = new Map<string, string>();

  constructor(private app: FastifyInstance, private llm: LlmClient = createLlmClient()) {}

  private get db() { return this.app.db; }
  private gov(meetingId: string) {
    let g = this.governors.get(meetingId);
    if (!g) this.governors.set(meetingId, (g = new Governor<Queued>()));
    return g;
  }

  start(tickMs = Number(process.env.INSIGHT_TICK_MS ?? 5000)) {
    this.timer = setInterval(() => void this.tick(), tickMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  feedback(meetingId: string, kind: InsightKind, topicKey: string | null, value: 'helpful' | 'dismissed') {
    this.gov(meetingId).feedback(kind, topicKey ?? '', value);
  }

  // ---- worker -------------------------------------------------------------------------------------------------
  async tick() {
    // Task extraction runs for every active meeting; insights only where AI Assistance is on (F5.1, F7.1).
    const { rows } = await this.db.query<MeetingRow>("select id, project_id, owner_id, ai_assist from meetings where status = 'active'");
    await Promise.all(rows.map((m) => this.process(m).catch((e) => this.app.log.error(e, 'insight tick failed'))));
  }

  /** One pass over a meeting. Safe to call concurrently (skipped if already running) and re-processing is idempotent. */
  async process(m: MeetingRow) {
    if (this.busy.has(m.id)) return;
    this.busy.add(m.id);
    try {
      const cursor = this.cursors.get(m.id) ?? 0;
      const { rows } = await this.db.query(
        'select seq, speaker_name, text, user_id, created_at from transcript_segments where meeting_id = $1 and seq > $2 order by seq limit 40', [m.id, cursor]);
      if (rows.length) {
        const lines: TranscriptLine[] = rows.map((r) => ({ seq: r.seq, speaker: r.speaker_name, text: r.text, userId: r.user_id }));
        const { rows: earlierRows } = await this.db.query(
          'select seq, speaker_name, text from transcript_segments where meeting_id = $1 and seq <= $2 order by seq desc limit 10', [m.id, cursor]);
        const earlier = earlierRows.reverse().map((r) => ({ seq: r.seq, speaker: r.speaker_name, text: r.text }));
        await this.handleLines(m, lines, earlier);
        this.cursors.set(m.id, lines[lines.length - 1].seq);
      }
      await this.flushQueue(m.id);
    } finally {
      this.busy.delete(m.id);
    }
  }

  /** Extract events from lines (LLM, else rules), attach the speaker, and handle each event. */
  private async handleLines(m: MeetingRow, lines: TranscriptLine[], earlier: TranscriptLine[]) {
    const events = (await this.llm.extract(lines, earlier)) ?? extractRules(lines);
    for (const ev of events) {
      const line = lines.find((l) => l.seq === ev.fromSeq) ?? lines[0];
      ev.speaker = line?.speaker ?? null;
      ev.speakerId = line?.userId ?? null;
      await this.handleEvent(m, ev);
    }
  }

  /** Match a spoken name to a meeting participant or project member (case-insensitive username). */
  private async resolveUser(m: MeetingRow, name: string | null | undefined): Promise<string | null> {
    if (!name) return null;
    const { rows } = await this.db.query(
      `select u.id from users u where lower(u.username) = lower($3) and (
         exists (select 1 from project_members pm where pm.project_id = $1 and pm.user_id = u.id)
         or exists (select 1 from meeting_participants p where p.meeting_id = $2 and p.user_id = u.id))`,
      [m.project_id, m.id, name.trim()]);
    return rows[0]?.id ?? null;
  }

  /**
   * One task per spoken commitment (F7.1/F7.2). "Assigned by" is whoever asked; a volunteer assigns themselves.
   * Deadlines are resolved against today's date.
   */
  private async createTask(m: MeetingRow, ev: EventDraft, eventId: string) {
    const today = todayInTz();
    const due = resolveDue(ev.dueText, today) ?? resolveDue(ev.quote, today);
    const assignee = await this.resolveUser(m, ev.who);
    const assigner = ev.speakerId ?? (await this.resolveUser(m, ev.speaker));
    const { rows } = await this.db.query(
      `insert into tasks(meeting_id, project_id, title, description, assigned_to, assigned_by, due_date, event_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (event_id) where event_id is not null do nothing returning id`,
      [m.id, m.project_id, taskTitle(ev.summary), ev.quote || ev.summary, assignee, assigner, due, eventId]);
    if (!rows[0]) return;
    await this.emitTask(m.id, rows[0].id);
    await indexRecord(this.db, this.app.embedder, 'task', rows[0].id).catch((e) => this.app.log.error(e));
  }

  private async emitTask(meetingId: string, taskId: string) {
    const { rows } = await this.db.query(`${TASK_SELECT} where t.id = $1`, [taskId]);
    if (rows[0]) this.app.io.to(`meeting:${meetingId}`).emit(Events.taskUpserted, toTask(rows[0]));
  }

  private async flushQueue(meetingId: string) {
    const g = this.gov(meetingId);
    if (!g.queued.length) return;
    const { rows } = await this.db.query('select max(created_at) as last from transcript_segments where meeting_id = $1', [meetingId]);
    const silence = rows[0]?.last ? Date.now() - new Date(rows[0].last).getTime() : Infinity;
    const out = g.flush(silence);
    if (!out) return;
    if (out.feed.length) {
      await this.db.query("update insights set tier = 'feed' where id = any($1::uuid[])", [out.feed.map((f) => f.insightId)]);
      for (const f of out.feed) await this.emitInsight(meetingId, f.insightId!);
    }
    if (!out.merged.length) return;
    const top = [...out.merged].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))[0];
    const single = out.merged.length === 1;
    const body = single ? out.merged[0].message : out.merged.map((v) => `• ${v.message} (${v.sourceLabel})`).join('\n');
    await this.db.query("update insights set delivered_to_chat = true where id = any($1::uuid[])", [out.merged.map((v) => v.insightId)]);
    await this.postToChat(meetingId, {
      kind: top.kind, tier: 'interrupt', title: single ? top.title : 'A few things worth knowing', body,
      sourceLabel: single ? top.sourceLabel : 'Several sources', sourceUrl: single ? top.sourceUrl ?? null : null,
      score: top.score, topicKey: `merged:${hash(out.merged.map((v) => v.topicKey).join('|'))}`,
    });
  }

  // ---- per-event pipeline -------------------------------------------------------------------------------------
  private async meetingLabel(id: string | null): Promise<string> {
    if (!id) return 'Project memory';
    const cached = this.labels.get(id);
    if (cached) return cached;
    const { rows } = await this.db.query('select title, coalesce(started_at, created_at) as d from meetings where id = $1', [id]);
    const label = rows[0] ? `Meeting “${rows[0].title}” · ${new Date(rows[0].d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Project memory';
    this.labels.set(id, label);
    return label;
  }

  private async candidatesFor(m: MeetingRow, ev: EventDraft): Promise<Candidate[]> {
    const out = new Map<string, Candidate>();
    if (ev.entityKey) {
      const { rows } = await this.db.query(
        `select id, entity_key, value, meeting_id from decisions
         where project_id = $1 and entity_key = $2 and meeting_id is distinct from $3 and superseded_by is null`,
        [m.project_id, ev.entityKey, m.id]);
      for (const r of rows) {
        out.set(r.id, { id: r.id, sourceType: 'decision', text: `Decision: ${r.entity_key} = ${r.value}`, score: 0.9,
          label: await this.meetingLabel(r.meeting_id), entityKey: r.entity_key, value: r.value });
      }
    }
    const hits = await searchMemory(this.db, this.app.embedder, { projectId: m.project_id, query: `${ev.summary} ${ev.quote}`, excludeMeetingId: m.id, k: 6 });
    for (const h of hits) {
      const id = h.sourceId ?? h.id;
      if (!out.has(id)) out.set(id, { id, sourceType: h.sourceType, text: h.text, score: h.score, label: await this.meetingLabel(h.meetingId) });
    }
    return [...out.values()];
  }

  private async handleEvent(m: MeetingRow, ev: EventDraft) {
    if (!m.ai_assist && ev.type !== 'task') return; // with AI off only commitments are tracked
    const { rows } = await this.db.query(
      `insert into knowledge_events(meeting_id, project_id, segment_from_seq, segment_to_seq, type, entity_key, summary, who, references_earlier, quote, summary_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (meeting_id, segment_from_seq, type, summary_hash) do nothing returning id`,
      [m.id, m.project_id, ev.fromSeq, ev.toSeq, ev.type, ev.entityKey, ev.summary, ev.who, ev.referencesEarlier, ev.quote, hash(ev.summary)]);
    if (!rows[0]) return; // already processed (idempotent re-run)
    const eventId = rows[0].id as string;
    if (ev.type === 'task') await this.createTask(m, ev, eventId);
    if (!m.ai_assist) return;

    const cands = await this.candidatesFor(m, ev);
    // undefined = LLM unavailable -> rules; null = the model decided to stay quiet (must not fall through to rules)
    const llmVerdict = await this.llm.judge(ev, cands);
    const verdict = llmVerdict === undefined ? judgeRules(ev, cands, thresholds()) : llmVerdict;
    if (verdict?.speak) await this.deliver(m, verdict);

    // Record the decision after judging so it is compared against *earlier* meetings only.
    if (ev.type === 'decision' && ev.entityKey && ev.value) {
      const { rows: d } = await this.db.query(
        'insert into decisions(project_id, entity_key, value, meeting_id, event_id) values ($1,$2,$3,$4,$5) returning id',
        [m.project_id, ev.entityKey, ev.value, m.id, eventId]);
      await this.db.query(
        'update decisions set superseded_by = $1 where project_id = $2 and entity_key = $3 and id <> $1 and superseded_by is null and lower(value) <> lower($4)',
        [d[0].id, m.project_id, ev.entityKey, ev.value]);
      await indexRecord(this.db, this.app.embedder, 'decision', d[0].id).catch((e) => this.app.log.error(e));
    }
    await indexRecord(this.db, this.app.embedder, 'event', eventId).catch((e) => this.app.log.error(e));
  }

  private async deliver(m: MeetingRow, v: Verdict) {
    const g = this.gov(m.id);
    const q: Queued = { ...v };
    const tier = g.route(q);
    const insight = await this.insertInsight(m, v, tier, v.private ? await this.privateAudience(m) : null);
    q.insightId = insight.id;
    if (tier === 'interrupt') {
      await this.db.query('update insights set delivered_to_chat = true where id = $1', [insight.id]);
      await this.chatMessage(m.id, insight.id);
    } else if (tier === 'feed') {
      await this.emitInsight(m.id, insight.id);
    } // queued: stays silent until merged
  }

  // Until connectors exist there are no private sources; private insights go to the meeting owner's AI Notes only.
  private async privateAudience(m: MeetingRow) { return m.owner_id; }

  // ---- persistence + delivery ---------------------------------------------------------------------------------
  private async insertInsight(m: { id: string; project_id: string }, v: Pick<Verdict, 'kind' | 'score' | 'title' | 'sourceLabel' | 'sourceUrl' | 'topicKey'> & { message?: string; body?: string; quote?: string | null },
    tier: string, audience: string | null): Promise<Insight> {
    const { rows } = await this.db.query(
      `insert into insights(meeting_id, project_id, kind, tier, title, body, quote, source_label, source_url, score, topic_key, audience_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [m.id, m.project_id, v.kind, tier, v.title, v.body ?? v.message ?? '', v.quote ?? null, v.sourceLabel, v.sourceUrl ?? null, v.score, v.topicKey, audience]);
    return toInsight(rows[0]);
  }

  /** Emit insight:new to the room, or only to the audience user for private insights. */
  private async emitInsight(meetingId: string, insightId: string) {
    const { rows } = await this.db.query('select * from insights where id = $1', [insightId]);
    if (!rows[0]) return;
    const insight = toInsight(rows[0]);
    const payload = { insight, tier: insight.tier };
    if (rows[0].audience_user_id) this.app.emitToUser(rows[0].audience_user_id, Events.insightNew, payload);
    else this.app.io.to(`meeting:${meetingId}`).emit(Events.insightNew, payload);
  }

  /** Persist a chat message that carries an insight card and broadcast it (never used for private insights). */
  private async chatMessage(meetingId: string, insightId: string) {
    const { rows } = await this.db.query(
      "insert into chat_messages(meeting_id, user_id, kind, body, insight_id) select $1, null, 'ai_insight', i.title, i.id from insights i where i.id = $2 returning id, created_at",
      [meetingId, insightId]);
    const { rows: ins } = await this.db.query('select * from insights where id = $1', [insightId]);
    const insight = toInsight(ins[0]);
    this.app.io.to(`meeting:${meetingId}`).emit(Events.chatMessage, {
      id: rows[0].id, meetingId, userId: null, username: null, kind: 'ai_insight', body: insight.title, createdAt: rows[0].created_at, insight,
    });
    this.app.io.to(`meeting:${meetingId}`).emit(Events.insightNew, { insight, tier: 'interrupt' });
  }

  private async postToChat(meetingId: string, v: { kind: InsightKind; tier: string; title: string; body: string; sourceLabel: string; sourceUrl?: string | null; score: number; topicKey: string; quote?: string | null }) {
    const { rows: m } = await this.db.query('select id, project_id from meetings where id = $1', [meetingId]);
    const insight = await this.insertInsight(m[0], v, 'interrupt', null);
    await this.db.query('update insights set delivered_to_chat = true where id = $1', [insight.id]);
    await this.chatMessage(meetingId, insight.id);
    return insight;
  }

  // ---- brief, recap, @ai --------------------------------------------------------------------------------------
  /** One card summarising earlier meetings, posted when AI Assistance is switched on (F5.9). Idempotent per meeting. */
  async brief(meetingId: string) {
    const { rows: m } = await this.db.query('select id, project_id from meetings where id = $1', [meetingId]);
    if (!m[0]) return;
    const done = await this.db.query("select 1 from insights where meeting_id = $1 and kind = 'brief'", [meetingId]);
    if (done.rowCount) return;
    const q = (sql: string) => this.db.query(sql, [m[0].project_id, meetingId]).then((r) => r.rows);
    const [decisions, tasks, questions] = await Promise.all([
      q("select entity_key, value from decisions where project_id = $1 and meeting_id <> $2 and superseded_by is null order by created_at desc limit 3"),
      q("select title from tasks where project_id = $1 and meeting_id <> $2 and status <> 'done' order by created_at desc limit 3"),
      q("select summary from knowledge_events where project_id = $1 and meeting_id <> $2 and type = 'question' order by created_at desc limit 3"),
    ]);
    const parts = [
      decisions.length && `Decided: ${decisions.map((d) => `${d.entity_key.replace(/_/g, ' ')} ${d.value}`).join('; ')}.`,
      tasks.length && `Open tasks: ${tasks.map((t) => t.title).join('; ')}.`,
      questions.length && `Open questions: ${questions.map((x) => x.summary).join('; ')}.`,
    ].filter(Boolean);
    if (!parts.length) return;
    // Briefs and @ai answers are not proactive interruptions: they neither start the cooldown nor use the chat-card cap.
    await this.postToChat(meetingId, { kind: 'brief', tier: 'interrupt', title: 'Since your last meeting', body: parts.join('\n'), sourceLabel: 'Earlier meetings', score: 1, topicKey: `brief:${meetingId}` });
  }

  /** End-of-meeting card listing every shared note that never reached the chat, grouped by topic (F5.10). */
  async recap(meetingId: string) {
    const done = await this.db.query("select 1 from insights where meeting_id = $1 and kind = 'recap'", [meetingId]);
    if (done.rowCount) return;
    const { rows } = await this.db.query(
      `select * from insights where meeting_id = $1 and audience_user_id is null and delivered_to_chat = false
         and kind not in ('brief','recap','answer') and tier in ('feed','queued') order by created_at`, [meetingId]);
    if (!rows.length) return;
    const groups = new Map<string, any[]>();
    for (const r of rows) groups.set(r.topic_key ?? r.id, [...(groups.get(r.topic_key ?? r.id) ?? []), r]);
    const body = [...groups.values()].map((g) => `• ${g[0].title}: ${g[0].body} (${g[0].source_label ?? 'memory'})`).join('\n');
    const { rows: m } = await this.db.query('select id, project_id from meetings where id = $1', [meetingId]);
    const insight = await this.insertInsight(m[0], { kind: 'recap', score: 1, title: 'Meeting recap: notes that stayed quiet', sourceLabel: 'AI Notes', topicKey: `recap:${meetingId}`, body }, 'interrupt', null);
    await this.db.query('update insights set delivered_to_chat = true where id = $1', [insight.id]);
    await this.chatMessage(meetingId, insight.id);
  }

  /**
   * Called when the owner ends the meeting: finish extraction, finalize the task list and tell the room (drives the
   * end-of-meeting overlay, F7.4), then post the recap if AI Assistance was on.
   */
  async finalize(meetingId: string) {
    const { rows } = await this.db.query('select id, project_id, owner_id, ai_assist from meetings where id = $1', [meetingId]);
    const m = rows[0] as MeetingRow | undefined;
    if (!m) return;
    for (let i = 0; i < 50 && this.busy.has(m.id); i++) await new Promise((r) => setTimeout(r, 100)); // let an in-flight pass finish
    try {
      await this.process(m);
    } catch (e) {
      this.app.log.error(e, 'final extraction failed');
    }
    await this.db.query('update tasks set finalized = true where meeting_id = $1', [m.id]);
    const { rows: tasks } = await this.db.query(`${TASK_SELECT} where t.meeting_id = $1 order by t.created_at, t.id`, [m.id]);
    this.app.io.to(`meeting:${m.id}`).emit(Events.meetingTasksReady, { meetingId: m.id, tasks: tasks.map(toTask) });
    // Hand doable tasks to specialist agents; they run in the background and wait for human review (F8.1).
    await this.app.agents.routeMeeting(m.id).catch((e) => this.app.log.error(e, 'task routing failed'));
    if (m.ai_assist) {
      const g = this.gov(m.id);
      // anything still queued never reached the chat: demote to the feed so the recap includes it
      for (const item of g.queued) if (item.insightId) await this.db.query("update insights set tier = 'feed' where id = $1", [item.insightId]);
      await this.recap(m.id).catch((e) => this.app.log.error(e, 'recap failed'));
    }
    this.governors.delete(m.id);
    this.cursors.delete(m.id);
  }

  /** Extract tasks from an imported transcript (F7.6). Insights are not generated for imports. */
  async importTasks(meetingId: string) {
    const { rows } = await this.db.query('select id, project_id, owner_id, status from meetings where id = $1', [meetingId]);
    if (!rows[0]) return;
    const m: MeetingRow = { ...rows[0], ai_assist: false };
    for (let from = 0; ; ) {
      const { rows: segs } = await this.db.query(
        'select seq, speaker_name, text, user_id from transcript_segments where meeting_id = $1 and seq > $2 order by seq limit 40', [m.id, from]);
      if (!segs.length) break;
      const lines = segs.map((r) => ({ seq: r.seq, speaker: r.speaker_name, text: r.text, userId: r.user_id }));
      await this.handleLines(m, lines, []);
      from = lines[lines.length - 1].seq;
    }
    if (rows[0].status === 'ended' || rows[0].status === 'closed') {
      await this.db.query('update tasks set finalized = true where meeting_id = $1', [m.id]);
      await this.app.agents.routeMeeting(m.id).catch((e) => this.app.log.error(e, 'task routing failed'));
    }
  }

  /** `@ai <question>`: answer from project memory plus the asker's own private sources (F5.8, F9.6). */
  async ask(meeting: { id: string; project_id: string; ai_assist: boolean }, asker: { id: string; username: string }, question: string) {
    const askId = createHash('md5').update(`${meeting.id}${asker.id}${Date.now()}`).digest('hex').slice(0, 12);
    const working = (done: boolean) => this.app.io.to(`meeting:${meeting.id}`).emit('ai:working', { askId, userId: asker.id, done });
    if (!meeting.ai_assist) {
      this.app.emitToUser(asker.id, Events.insightNew, { tier: 'interrupt', ephemeral: true, insight: {
        id: `off-${askId}`, meetingId: meeting.id, kind: 'answer', tier: 'interrupt', title: 'AI Assistance is off',
        body: 'Turn on AI Assistance in the meeting header to ask the assistant questions.', quote: question, sourceLabel: null, sourceUrl: null,
        score: null, topicKey: null, private: true, feedback: null, deliveredToChat: false, createdAt: new Date().toISOString() } });
      return;
    }
    working(false);
    try {
      const query = question.replace(/^@ai\s*/i, '').trim();
      const pkg = await buildContext(this.db, this.app.embedder, { projectId: meeting.project_id, viewerId: asker.id, query, minScore: undefined });
      const cands = await this.packageToCandidates(pkg);
      const llm = cands.length ? await this.llm.answer(query, cands) : undefined;
      const res = llm ?? answerRules(cands);
      const used = res?.used ?? [];
      const privateUsed = used.some((c) => c.private);
      const body = res && res.answer.trim() ? res.answer : NO_ANSWER;
      const insight = await this.insertInsight(meeting, {
        kind: 'answer', score: 1, title: 'Answer', sourceLabel: used.length ? [...new Set(used.map((c) => c.label))].join(' · ') : 'Project memory',
        sourceUrl: used.find((c) => c.url)?.url ?? null, topicKey: `ask:${hash(query)}`, body, quote: query,
      }, 'interrupt', privateUsed ? asker.id : null);
      if (privateUsed) await this.emitInsight(meeting.id, insight.id); // visible only to the asker
      else {
        await this.db.query('update insights set delivered_to_chat = true where id = $1', [insight.id]);
        await this.chatMessage(meeting.id, insight.id);
      }
    } catch (e) {
      this.app.log.error(e, '@ai failed');
    } finally {
      working(true);
    }
  }

  private async packageToCandidates(pkg: ContextPackage): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const h of Object.values(pkg).flat()) {
      out.push({ id: h.sourceId ?? h.id, sourceType: h.sourceType, text: h.text, score: h.score,
        label: h.sourceType === 'external' ? `${h.provider ?? 'Source'} · ${h.author ?? ''} · ${h.title ?? ''}` : await this.meetingLabel(h.meetingId),
        url: h.url ?? null, private: h.visibility === 'private' });
    }
    return out;
  }
}
