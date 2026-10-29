import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { chunkDocument, chunkTranscript } from '../src/memory/chunker.js';
import { EMBEDDING_DIM, fakeEmbed, createEmbedder } from '../src/memory/embedder.js';
import { indexMeetingTranscript, indexRecord, reindexSource } from '../src/memory/store.js';
import { searchMemory } from '../src/memory/search.js';
import { buildContext, SNIPPET_CHARS, TOTAL_CHARS, LIMITS } from '../src/memory/context.js';
import { toVector } from '../src/memory/embedder.js';

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

test('fake embedder is deterministic, normalised and lexically meaningful', () => {
  const a = fakeEmbed('We decided to deploy on August 1');
  assert.equal(a.length, EMBEDDING_DIM);
  assert.deepEqual(a, fakeEmbed('We decided to deploy on August 1'));
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-6);
  assert.ok(dot(a, fakeEmbed('deploying in August?')) > dot(a, fakeEmbed('what is for lunch today')));
});

test('stemmer unifies word forms', async () => {
  const { stem } = await import('../src/memory/embedder.js');
  assert.equal(stem('deployment'), stem('deploying'));
  assert.equal(stem('deploy'), stem('deployment'));
  assert.equal(stem('release'), stem('releases'));
  assert.equal(stem('date'), stem('dates'));
});

test('chunkTranscript: windows of ≤6 segments, ≤800 chars, one-segment overlap', () => {
  const segs = Array.from({ length: 14 }, (_, i) => ({ speaker: 'A', text: `line ${i}` }));
  const chunks = chunkTranscript(segs);
  assert.ok(chunks.every((c) => c.split('\n').length <= 6));
  assert.equal(chunks[0].split('\n').at(-1), chunks[1].split('\n')[0], 'last line of a chunk starts the next');
  assert.ok(chunks.join('\n').includes('line 13'));
  const long = chunkTranscript([{ speaker: 'A', text: 'x'.repeat(2000) }, { speaker: 'B', text: 'short' }]);
  assert.ok(long.every((c) => c.length <= 800));
  assert.deepEqual(chunkTranscript([]), []);
});

test('chunkDocument: paragraph-aware, ≤1000 chars', () => {
  const doc = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(60)}`).join('\n\n');
  const chunks = chunkDocument(doc);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 1000));
  const huge = chunkDocument('Sentence one. '.repeat(300));
  assert.ok(huge.length > 1 && huge.every((c) => c.length <= 1000));
});

// ---- database-backed golden retrieval tests ----
const DB = process.env.DATABASE_URL;
describe('project memory (database)', { skip: !DB }, () => {
  const db = new pg.Pool({ connectionString: DB });
  const emb = createEmbedder();
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

  before(async () => {
    const tag = `mem${Date.now()}`;
    ids.u1 = (await q('insert into users(username) values ($1) returning id', [`${tag}a`]))[0].id;
    ids.u2 = (await q('insert into users(username) values ($1) returning id', [`${tag}b`]))[0].id;
    for (const [k, name] of [['p1', 'P1'], ['p2', 'P2']] as const) {
      ids[k] = (await q('insert into projects(name, owner_id) values ($1,$2) returning id', [name, ids.u1]))[0].id;
    }
    for (const [k, p] of [['m1', 'p1'], ['m2', 'p1'], ['mo', 'p2']] as const) {
      ids[k] = (await q("insert into meetings(project_id, owner_id, title, status) values ($1,$2,$3,'ended') returning id", [ids[p], ids.u1, k]))[0].id;
    }
    const seg = (m: string, i: number, who: string, text: string) =>
      q('insert into transcript_segments(meeting_id, speaker_name, text, seq) values ($1,$2,$3,$4)', [ids[m], who, text, i]);
    await seg('m1', 1, 'Priya', 'We decided to deploy the release on August 1.');
    await seg('m1', 2, 'Aman', 'I will prepare the release checklist by Friday.');
    await seg('m2', 1, 'Priya', "Let's ship on September 5 instead of the deployment date we had.");
    await seg('mo', 1, 'Zed', 'Deploy the release on August 1 for the other project.');
    for (const m of ['m1', 'm2', 'mo']) await indexMeetingTranscript(db, emb, ids[m]);
    ids.dec = (await q("insert into decisions(project_id, entity_key, value, meeting_id) values ($1,'deployment_date','August 1',$2) returning id", [ids.p1, ids.m1]))[0].id;
    await indexRecord(db, emb, 'decision', ids.dec);
  });
  after(async () => {
    await q('delete from projects where id = any($1)', [[ids.p1, ids.p2]]);
    await q('delete from users where id = any($1)', [[ids.u1, ids.u2]]);
    await db.end();
  });

  test('golden: a new deployment date finds the earlier decision and meeting', async () => {
    const hits = await searchMemory(db, emb, { projectId: ids.p1, query: "Let's ship on September 5, deployment date", excludeMeetingId: ids.m2 });
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.sourceType === 'decision' && /August 1/.test(h.text)), 'decision surfaced');
    assert.ok(hits.some((h) => h.sourceType === 'transcript' && h.meetingId === ids.m1), 'earlier meeting surfaced');
  });

  test('the current meeting is excluded', async () => {
    const hits = await searchMemory(db, emb, { projectId: ids.p1, query: 'ship September 5 deployment', excludeMeetingId: ids.m2 });
    assert.ok(hits.every((h) => h.meetingId !== ids.m2));
    const incl = await searchMemory(db, emb, { projectId: ids.p1, query: 'ship September 5 deployment' });
    assert.ok(incl.some((h) => h.meetingId === ids.m2), 'sanity: without exclusion it is found');
  });

  test('results never cross projects', async () => {
    const hits = await searchMemory(db, emb, { projectId: ids.p1, query: 'deploy the release on August 1', k: 20, minScore: 0 });
    assert.ok(hits.length > 0 && hits.every((h) => h.meetingId !== ids.mo));
  });

  test('unrelated queries return nothing above the relevance floor', async () => {
    assert.deepEqual(await searchMemory(db, emb, { projectId: ids.p1, query: 'what is on the lunch menu today' }), []);
  });

  test('external items obey the audience filter in SQL', async () => {
    const conn = (await q("insert into connections(project_id, user_id, provider) values ($1,$2,'gmail') returning id", [ids.p1, ids.u1]))[0].id;
    const add = async (ext: string, vis: string, text: string) => q(
      `insert into external_items(connection_id, project_id, owner_id, provider, external_id, title, visibility, text, embedding)
       values ($1,$2,$3,'gmail',$4,$5,$6,$7,$8::vector)`,
      [conn, ids.p1, ids.u1, ext, `Re: ${ext}`, vis, text, toVector(fakeEmbed(text))]);
    await add('secret', 'private', 'Confidential budget approval of forty thousand dollars for marketing');
    await add('shared', 'project', 'Shared budget approval notes of forty thousand dollars for marketing');
    const owner = await buildContext(db, emb, { projectId: ids.p1, viewerId: ids.u1, query: 'budget approval forty thousand marketing' });
    const other = await buildContext(db, emb, { projectId: ids.p1, viewerId: ids.u2, query: 'budget approval forty thousand marketing' });
    assert.deepEqual(owner.external.map((h) => h.title).sort(), ['Re: secret', 'Re: shared']);
    assert.deepEqual(other.external.map((h) => h.title), ['Re: shared'], 'private item hidden from other users');
  });

  test('context package respects section, snippet and total limits', async () => {
    for (let i = 0; i < 12; i++) {
      const t = (await q("insert into tasks(meeting_id, project_id, title, description) values ($1,$2,$3,$4) returning id",
        [ids.m1, ids.p1, `Prepare release notes ${i}`, 'release notes '.repeat(80)]))[0].id;
      await indexRecord(db, emb, 'task', t);
    }
    const pkg = await buildContext(db, emb, { projectId: ids.p1, viewerId: ids.u1, query: 'prepare release notes', minScore: 0 });
    assert.ok(pkg.tasks.length > 0 && pkg.tasks.length <= LIMITS.tasks);
    const all = Object.values(pkg).flat();
    assert.ok(all.every((h) => h.text.length <= SNIPPET_CHARS));
    assert.ok(all.reduce((n, h) => n + h.text.length, 0) <= TOTAL_CHARS);
  });

  test('reindexing replaces chunks atomically (no duplicates)', async () => {
    await reindexSource(db, emb, { projectId: ids.p1, sourceType: 'workspace_doc', sourceId: ids.p1, texts: ['alpha document', 'beta document'] });
    await reindexSource(db, emb, { projectId: ids.p1, sourceType: 'workspace_doc', sourceId: ids.p1, texts: ['gamma document'] });
    assert.equal((await q("select count(*)::int n from memory_chunks where source_id = $1 and source_type='workspace_doc'", [ids.p1]))[0].n, 1);
  });

  test('deleting a source or meeting deletes its embeddings (F6.7)', async () => {
    const count = async (sql: string, p: unknown[]) => (await q(sql, p))[0].n as number;
    assert.equal(await count("select count(*)::int n from memory_chunks where source_id = $1", [ids.dec]), 1);
    await q('delete from decisions where id = $1', [ids.dec]);
    assert.equal(await count("select count(*)::int n from memory_chunks where source_id = $1", [ids.dec]), 0);
    assert.ok(await count("select count(*)::int n from memory_chunks where meeting_id = $1", [ids.m1]) > 0);
    await q('delete from meetings where id = $1', [ids.m1]);
    assert.equal(await count("select count(*)::int n from memory_chunks where meeting_id = $1", [ids.m1]), 0);
  });
});
