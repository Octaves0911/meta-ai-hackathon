import type { Pool } from 'pg';
import type { Embedder } from './embedder.js';
import { searchExternal, searchMemory, type MemoryHit } from './search.js';
import type { SourceType } from './store.js';

/** Compact bundle shared by the live assistant and the agents (docs/02 §3). */
export interface ContextPackage {
  files: MemoryHit[]; tasks: MemoryHit[]; meetings: MemoryHit[]; decisions: MemoryHit[];
  requirements: MemoryHit[]; artifacts: MemoryHit[]; discussions: MemoryHit[]; external: MemoryHit[];
}

export const LIMITS = { files: 4, tasks: 5, meetings: 4, decisions: 5, requirements: 3, artifacts: 3, discussions: 4, external: 3 } as const;
export const SNIPPET_CHARS = 400;
export const TOTAL_CHARS = 6000;

const SECTION_OF: Record<SourceType, keyof ContextPackage> = {
  workspace_doc: 'files', code: 'files', task: 'tasks', event: 'meetings', decision: 'decisions', transcript: 'discussions',
};

export async function buildContext(db: Pool, embedder: Embedder, a: {
  projectId: string; viewerId: string; query: string; excludeMeetingId?: string | null; minScore?: number;
}): Promise<ContextPackage> {
  const [internal, external] = await Promise.all([
    searchMemory(db, embedder, { projectId: a.projectId, query: a.query, excludeMeetingId: a.excludeMeetingId, k: 30, minScore: a.minScore }),
    searchExternal(db, embedder, { projectId: a.projectId, viewerId: a.viewerId, query: a.query, minScore: a.minScore }),
  ]);
  const pkg: ContextPackage = { files: [], tasks: [], meetings: [], decisions: [], requirements: [], artifacts: [], discussions: [], external: [] };
  // Best matches first, so the total-size cap drops the weakest snippets.
  const ranked = [...internal, ...external].sort((x, y) => y.score - x.score);
  let used = 0;
  for (const hit of ranked) {
    const section = hit.sourceType === 'external' ? 'external' : SECTION_OF[hit.sourceType];
    if (pkg[section].length >= LIMITS[section]) continue;
    const text = hit.text.length > SNIPPET_CHARS ? `${hit.text.slice(0, SNIPPET_CHARS - 1)}…` : hit.text;
    if (used + text.length > TOTAL_CHARS) continue;
    used += text.length;
    pkg[section].push({ ...hit, text });
  }
  return pkg;
}
