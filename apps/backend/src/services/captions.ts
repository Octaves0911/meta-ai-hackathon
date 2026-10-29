import type { Pool } from 'pg';

/** Persist a final caption. `seq` is allocated per meeting under an advisory lock so it is gap-free and unique. */
export async function saveSegment(db: Pool, a: {
  meetingId: string; userId: string; speaker: string; text: string; confidence: number;
}): Promise<{ seq: number; offsetMs: number; id: string }> {
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [a.meetingId]);
    const { rows } = await c.query(
      `insert into transcript_segments(meeting_id, user_id, speaker_name, text, confidence, seq, started_at_ms)
       select $1, $2, $3, $4, $5,
              coalesce((select max(seq) from transcript_segments where meeting_id = $1), 0) + 1,
              (extract(epoch from now() - coalesce(m.started_at, now())) * 1000)::int
       from meetings m where m.id = $1
       returning id, seq, started_at_ms`,
      [a.meetingId, a.userId, a.speaker, a.text, a.confidence],
    );
    await c.query('commit');
    return { id: rows[0].id, seq: rows[0].seq, offsetMs: rows[0].started_at_ms };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
