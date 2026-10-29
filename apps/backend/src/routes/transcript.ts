import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { canReadConversation, participation } from '../services/access.js';
import { indexMeetingTranscript } from '../memory/store.js';
import { parseTranscript, toSrt, toText, type ExportSegment } from '../services/transcript.js';

const ImportBody = z.object({ text: z.string().min(1).max(500_000), replace: z.boolean().default(false) });

export async function transcriptRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/meetings/:id/transcript', async (req, reply) => {
    const me = await requireUser(app, req);
    const m = await participation(app, req.params.id, me);
    if (!canReadConversation(m, me)) throw new HttpError(403, 'forbidden', 'transcript is not shared for this meeting');
    const format = z.enum(['json', 'txt', 'srt']).catch('json').parse(req.query.format);
    const { rows } = await app.db.query(
      `select seq, speaker_name, text, confidence, user_id, coalesce(started_at_ms, 0) as offset_ms, created_at
       from transcript_segments where meeting_id = $1 order by seq`, [m.id]);
    const segs: ExportSegment[] = rows.map((r) => ({ seq: r.seq, speaker: r.speaker_name, text: r.text, offsetMs: r.offset_ms }));
    if (format === 'txt') return reply.type('text/plain; charset=utf-8').header('content-disposition', 'attachment; filename="transcript.txt"').send(toText(segs));
    if (format === 'srt') return reply.type('application/x-subrip; charset=utf-8').header('content-disposition', 'attachment; filename="transcript.srt"').send(toSrt(segs));
    return rows.map((r) => ({ seq: r.seq, speaker: r.speaker_name, text: r.text, confidence: r.confidence, userId: r.user_id, offsetMs: r.offset_ms, createdAt: r.created_at }));
  });

  // Import pasted text (F4.7). Owner only; optionally replaces the existing transcript.
  app.post<{ Params: { id: string } }>('/meetings/:id/transcript/import', async (req, reply) => {
    const me = await requireUser(app, req);
    const { text, replace } = ImportBody.parse(req.body);
    const m = await participation(app, req.params.id, me);
    if (m.owner_id !== me.id) throw new HttpError(403, 'forbidden', 'only the owner can import a transcript');
    const lines = parseTranscript(text);
    if (!lines.length) throw new HttpError(400, 'invalid_request', 'no "Speaker: text" lines found');
    const c = await app.db.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [m.id]);
      if (replace) await c.query('delete from transcript_segments where meeting_id = $1', [m.id]);
      const { rows } = await c.query('select coalesce(max(seq), 0) as max from transcript_segments where meeting_id = $1', [m.id]);
      let seq = rows[0].max as number;
      let last = 0;
      for (const l of lines) {
        last = l.offsetMs ?? last;
        await c.query(
          'insert into transcript_segments(meeting_id, speaker_name, text, seq, started_at_ms) values ($1,$2,$3,$4,$5)',
          [m.id, l.speaker, l.text, ++seq, last]);
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    indexMeetingTranscript(app.db, app.embedder, m.id).catch((e) => app.log.error(e, 'transcript indexing failed'));
    return reply.status(201).send({ imported: lines.length });
  });
}
