import type { Pool, PoolClient } from 'pg';

/** Close the open "someone is present" interval into total_duration_sec (F2.7). Caller holds a transaction. */
export async function flushSegment(c: PoolClient, meetingId: string) {
  await c.query(
    `update meetings set
       total_duration_sec = total_duration_sec + coalesce(extract(epoch from now() - segment_started_at), 0)::int,
       segment_started_at = null
     where id = $1 and segment_started_at is not null`,
    [meetingId],
  );
}

/** Mark a participant as out of the call; flushes duration when the room becomes empty. */
export async function leaveMeeting(db: Pool, meetingId: string, userId: string) {
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('update meeting_participants set last_session_started_at = null where meeting_id = $1 and user_id = $2', [meetingId, userId]);
    const { rows } = await c.query(
      'select 1 from meeting_participants where meeting_id = $1 and last_session_started_at is not null', [meetingId]);
    if (!rows[0]) await flushSegment(c, meetingId);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
