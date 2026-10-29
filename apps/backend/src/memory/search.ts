import type { Pool } from 'pg';
import { defaultMinScore, toVector, type Embedder } from './embedder.js';
import type { SourceType } from './store.js';

export interface MemoryHit {
  id: string; sourceType: SourceType | 'external'; sourceId: string | null; meetingId: string | null;
  text: string; score: number; createdAt: string;
  title?: string | null; url?: string | null; author?: string | null; provider?: string | null; ownerId?: string | null; visibility?: string;
}

export interface SearchArgs {
  projectId: string; query: string; types?: SourceType[]; excludeMeetingId?: string | null; k?: number; minScore?: number;
}

/** Cosine search over project memory. `excludeMeetingId` keeps the live assistant from echoing the current meeting (F5.3). */
export async function searchMemory(db: Pool, embedder: Embedder, a: SearchArgs): Promise<MemoryHit[]> {
  const [vec] = await embedder.embed([a.query]);
  const q = toVector(vec);
  const { rows } = await db.query(
    `select id, source_type, source_id, meeting_id, text, created_at, 1 - (embedding <=> $2::vector) as score
     from memory_chunks
     where project_id = $1
       and ($3::text[] is null or source_type = any($3))
       and ($4::uuid is null or meeting_id is distinct from $4)
     order by embedding <=> $2::vector limit $5`,
    [a.projectId, q, a.types ?? null, a.excludeMeetingId ?? null, a.k ?? 8]);
  const min = a.minScore ?? defaultMinScore();
  return rows.filter((r) => r.score >= min).map((r) => ({
    id: r.id, sourceType: r.source_type, sourceId: r.source_id, meetingId: r.meeting_id,
    text: r.text, score: Number(r.score), createdAt: r.created_at,
  }));
}

/**
 * Synced mail/Drive snippets. The audience filter lives in the SQL itself: a row is readable only if it is shared with the
 * project or owned by the viewer — never post-filtered in application code (docs/02 §3, F9).
 */
export async function searchExternal(db: Pool, embedder: Embedder, a: { projectId: string; viewerId: string; query: string; k?: number; minScore?: number }): Promise<MemoryHit[]> {
  const [vec] = await embedder.embed([a.query]);
  const { rows } = await db.query(
    `select id, owner_id, provider, title, author, url, text, occurred_at, visibility, 1 - (embedding <=> $3::vector) as score
     from external_items
     where project_id = $1 and embedding is not null and (visibility = 'project' or owner_id = $2)
     order by embedding <=> $3::vector limit $4`,
    [a.projectId, a.viewerId, toVector(vec), a.k ?? 6]);
  const min = a.minScore ?? defaultMinScore();
  return rows.filter((r) => r.score >= min).map((r) => ({
    id: r.id, sourceType: 'external' as const, sourceId: null, meetingId: null, text: r.text, score: Number(r.score),
    createdAt: r.occurred_at, title: r.title, url: r.url, author: r.author, provider: r.provider, ownerId: r.owner_id, visibility: r.visibility,
  }));
}
