import type { Pool } from 'pg';
import { chunkDocument, chunkTranscript } from './chunker.js';
import { toVector, type Embedder } from './embedder.js';

export type SourceType = 'transcript' | 'event' | 'decision' | 'task' | 'workspace_doc' | 'code';

export interface IndexArgs {
  projectId: string; sourceType: SourceType; sourceId: string; meetingId?: string | null; texts: string[];
}

/** Replace all chunks of one source with freshly embedded ones (atomic). */
export async function reindexSource(db: Pool, embedder: Embedder, a: IndexArgs): Promise<number> {
  const texts = a.texts.map((t) => t.trim()).filter(Boolean);
  const vectors = texts.length ? await embedder.embed(texts) : []; // embed first: no DB transaction held during a network call
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('delete from memory_chunks where source_type = $1 and source_id = $2', [a.sourceType, a.sourceId]);
    for (let i = 0; i < texts.length; i++) {
      await c.query(
        `insert into memory_chunks(project_id, source_type, source_id, meeting_id, text, embedding)
         values ($1,$2,$3,$4,$5,$6::vector)`,
        [a.projectId, a.sourceType, a.sourceId, a.meetingId ?? null, texts[i], toVector(vectors[i])]);
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  return texts.length;
}

export async function deleteBySource(db: Pool, sourceType: SourceType, sourceId: string) {
  await db.query('delete from memory_chunks where source_type = $1 and source_id = $2', [sourceType, sourceId]);
}

/** (Re)build the transcript chunks of one meeting from its stored segments (F6.1). */
export async function indexMeetingTranscript(db: Pool, embedder: Embedder, meetingId: string): Promise<number> {
  const { rows: m } = await db.query('select project_id from meetings where id = $1', [meetingId]);
  if (!m[0]) return 0;
  const { rows } = await db.query('select speaker_name, text from transcript_segments where meeting_id = $1 order by seq', [meetingId]);
  return reindexSource(db, embedder, {
    projectId: m[0].project_id, sourceType: 'transcript', sourceId: meetingId, meetingId,
    texts: chunkTranscript(rows.map((r) => ({ speaker: r.speaker_name, text: r.text }))),
  });
}

/** Index one extracted knowledge record so later meetings can find it (F6.2). */
export async function indexRecord(db: Pool, embedder: Embedder, type: 'decision' | 'task' | 'event', id: string): Promise<number> {
  const q = {
    decision: `select project_id, meeting_id, 'Decision: ' || entity_key || ' = ' || value as text from decisions where id = $1`,
    task: `select project_id, meeting_id, 'Task: ' || title || coalesce('. ' || description, '') || coalesce(' Due ' || due_date::text, '') as text from tasks where id = $1`,
    event: `select project_id, meeting_id, initcap(type) || ': ' || summary || coalesce(' (' || who || ')', '') as text from knowledge_events where id = $1`,
  }[type];
  const { rows } = await db.query(q, [id]);
  if (!rows[0]) return 0;
  return reindexSource(db, embedder, { projectId: rows[0].project_id, sourceType: type, sourceId: id, meetingId: rows[0].meeting_id, texts: [rows[0].text] });
}

/** Index a workspace file or code file (F6.3). */
export const indexDocument = (db: Pool, embedder: Embedder, a: { projectId: string; fileId: string; text: string; code?: boolean }) =>
  reindexSource(db, embedder, { projectId: a.projectId, sourceType: a.code ? 'code' : 'workspace_doc', sourceId: a.fileId, texts: chunkDocument(a.text) });
