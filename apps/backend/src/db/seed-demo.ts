// Demo data for the intelligence dashboard: a 10-week project with real rows in every table the analytics read
// (meetings, events, decisions, conflict insights, tasks and their status/due-date history). Idempotent.
// Usage: npm run db:seed-demo -w @meetpilot/backend -- <your-username> [--reset]   (adds you to the project; --reset rebuilds it)
import { createPool } from './pool.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const me = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
const pool = createPool();
const c = await pool.connect();
const ago = (days: number, hour = 10) => `now() - interval '${days} days' + interval '${hour - 10} hours'`;

try {
  await c.query('begin');
  const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0].id as string;
  const user = async (name: string) => (await c.query('insert into users(username) values ($1) on conflict (username) do update set username = excluded.username returning id', [name])).rows[0].id as string;
  const people = { priya: await user('priya'), aman: await user('aman'), dana: await user('dana'), sam: await user('sam'), leo: await user('leo') } as Record<string, string>;
  const viewer = me ? await user(me) : null;

  if (reset) await c.query("delete from projects where name = 'Atlas Platform Launch'");
  const existing = await c.query("select id from projects where name = 'Atlas Platform Launch' limit 1");
  let project = existing.rows[0]?.id as string | undefined;
  let meetingIds: string[] = [];
  if (!project) {
    project = await one("insert into projects(name, description, owner_id) values ('Atlas Platform Launch', 'Demo project with ten weeks of history', $1) returning id", [people.priya]);
    for (const [n, id] of Object.entries(people)) await c.query("insert into project_members values ($1,$2,$3) on conflict do nothing", [project, id, n === 'priya' ? 'owner' : 'member']);

    const meeting = async (title: string, days: number) => {
      const id = await one(`insert into meetings(project_id, owner_id, title, status, started_at, ended_at, total_duration_sec, ai_assist, created_at)
        values ($1,$2,$3,'closed', ${ago(days)}, ${ago(days)} + interval '40 minutes', 2400, true, ${ago(days)}) returning id`, [project, people.priya, title]);
      for (const uid of Object.values(people)) await c.query("insert into meeting_participants(meeting_id, user_id, invite_status) values ($1,$2,'joined')", [id, uid]);
      return id;
    };
    const [m1, m2, m3, m4, m5, m6] = [await meeting('Kickoff', 68), await meeting('Architecture sync', 54), await meeting('Sprint review 1', 40), await meeting('Release planning', 26), await meeting('Sprint review 2', 12), await meeting('Launch readiness', 3)];
    meetingIds = [m1, m2, m3, m4, m5, m6];
    const lines: Record<string, [string, string][]> = {
      [m1]: [['Priya', 'Welcome everyone. The goal is a public launch with live captions and project memory.'], ['Priya', 'We decided to deploy on August 1.'], ['Aman', 'Agreed. I will set up the CI pipeline by next week.'], ['Aman', 'For storage, let us use PostgreSQL.'], ['Dana', 'I will design the brand and the landing page.'], ['Priya', 'Great. Ship the beta by the end of the month.'], ['Sam', 'Fine by me. I will prototype live captions.'], ['Leo', 'I will take a look at the staging setup.']],
      [m2]: [['Sam', 'I am waiting on legal approval for the vendor contract.'], ['Aman', 'Which region should we deploy to?'], ['Sam', 'Deepgram streaming gives us the lowest caption latency.'], ['Priya', 'Then let us go with Deepgram streaming.'], ['Sam', 'I will prototype live captions by next week.'], ['Priya', 'And I will research competitor pricing.'], ['Dana', 'Noted, I will keep the design in sync.']],
      [m3]: [['Leo', 'The staging environment keeps failing on migrations.'], ['Dana', 'I still need to write the onboarding documentation.'], ['Aman', 'Project memory search is implemented and working.'], ['Priya', 'The beta slips, the new date is in twenty days.'], ['Leo', 'I will fix the staging migrations.'], ['Sam', 'Security review is next sprint.']],
      [m4]: [['Dana', 'Let us push the deployment to September 5.'], ['Priya', 'That conflicts with August 1, but the beta slipped so it makes sense.'], ['Aman', 'I will prepare the release checklist.'], ['Aman', 'Which region do we deploy to?'], ['Sam', 'Still waiting for legal approval of the vendor contract.'], ['Dana', 'I will draft the launch announcement.'], ['Leo', 'I will load test the room service.']],
      [m5]: [['Leo', 'The staging environment is failing on migrations again.'], ['Priya', 'Deployment moves to September 19.'], ['Aman', 'Let us use PostgreSQL with pgvector.'], ['Dana', 'Writing onboarding documentation for new users is still on my list.'], ['Dana', 'The beta is now nine days out.'], ['Sam', 'I will start the security review of the integrations.'], ['Priya', 'I will synthesize the customer interviews.']],
      [m6]: [['Leo', 'Let us switch to batch transcription for captions.'], ['Dana', 'Legal approval for the vendor contract is still pending.'], ['Dana', 'I will finish the onboarding documentation.'], ['Aman', 'The final QA pass is mine.'], ['Priya', 'Please sign off the launch checklist.']],
    };
    const evN = { n: 0 };
    const event = async (meeting: string, type: string, summary: string, who: string, days: number, extra: { key?: string; due?: string; seq?: number } = {}) =>
      one(`insert into knowledge_events(meeting_id, project_id, type, entity_key, summary, who, due_at, summary_hash, segment_from_seq, segment_to_seq, quote, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10, ${ago(days)} + interval '1 minute' * coalesce($9::int, 0)) returning id`, [meeting, project, type, extra.key ?? null, summary, who, extra.due ?? null, `demo-${++evN.n}`, extra.seq ?? null, extra.seq ? lines[meeting]?.[extra.seq - 1]?.[1] ?? null : null]);
    const decision = async (meeting: string, key: string, value: string, who: string, days: number, seq?: number) => {
      const ev = await event(meeting, 'decision', `${key}: ${value}`, who, days, { key, seq });
      const id = await one(`insert into decisions(project_id, entity_key, value, meeting_id, event_id, created_at) values ($1,$2,$3,$4,$5, ${ago(days)}) returning id`, [project, key, value, meeting, ev]);
      await c.query('update decisions set superseded_by = $1 where project_id = $2 and entity_key = $3 and id <> $1 and superseded_by is null and lower(value) <> lower($4)', [id, project, key, value]);
      return ev;
    };
    const conflict = async (meeting: string, title: string, body: string, source: string, days: number) => {
      const id = await one(`insert into insights(meeting_id, project_id, kind, tier, title, body, source_label, delivered_to_chat, created_at) values ($1,$2,'conflict','interrupt',$3,$4,$5,true, ${ago(days)} + interval '3 minutes') returning id`, [meeting, project, title, body, source]);
      await c.query(`insert into chat_messages(meeting_id, user_id, kind, body, insight_id, created_at) values ($1,null,'ai_insight',$2,$3, ${ago(days)} + interval '3 minutes')`, [meeting, title, id]);
    };
    const task = async (meeting: string, title: string, who: string, cat: string, prio: string, createdDays: number, dueDays: number, status: string, doneDays: number | null, ev: string | null = null, due2?: number) => {
      const id = await one(`insert into tasks(meeting_id, project_id, title, assigned_to, assigned_by, due_date, priority, category, status, finalized, event_id, created_at)
        values ($1,$2,$3,$4,$5, (${ago(dueDays)})::date, $6,$7,$8,true,$9, ${ago(createdDays)}) returning id`, [meeting, project, title, people[who], people.priya, prio, cat, status, ev]);
      if (due2 !== undefined) await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'due_date',(${ago(dueDays)})::date::text,(${ago(due2)})::date::text, ${ago(createdDays - 3)})`, [id]);
      if (status !== 'open') await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'status','open','in_progress', ${ago(createdDays - 2)})`, [id]);
      if (doneDays !== null) await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'status','in_progress','done', ${ago(doneDays)})`, [id]);
      if (status === 'review') await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'status','in_progress','review', ${ago(6)})`, [id]);
      return id;
    };

    for (const [id, script] of Object.entries(lines)) {
      const days = { [m1]: 68, [m2]: 54, [m3]: 40, [m4]: 26, [m5]: 12, [m6]: 3 }[id]!;
      for (const [i, [who, text]] of script.entries())
        await c.query(`insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq, started_at_ms, created_at) values ($1,$2,$3,$4,$5,$6, ${ago(days)} + interval '1 minute' * ($5::int))`, [id, people[who.toLowerCase()], who, text, i + 1, (i + 1) * 75000]);
    }
    // Decisions that change over time, by different people
    await decision(m1, 'deployment_date', 'August 1', 'Priya', 68, 2);
    await decision(m1, 'database', 'PostgreSQL', 'Aman', 68, 4);
    await decision(m2, 'captions_provider', 'Deepgram streaming', 'Sam', 54, 4);
    await decision(m4, 'deployment_date', 'September 5', 'Dana', 26, 1);
    await decision(m5, 'database', 'PostgreSQL with pgvector', 'Aman', 12, 3);
    await decision(m5, 'deployment_date', 'September 19', 'Priya', 12, 2);
    await decision(m6, 'captions_provider', 'Batch transcription', 'Leo', 3, 1);
    await conflict(m4, 'Conflicts with an earlier decision', 'Release planning decided deployment on August 1.', 'Meeting “Kickoff”', 26);
    await conflict(m5, 'Conflicts with an earlier decision', 'Deployment was moved to September 5 at Release planning.', 'Meeting “Release planning”', 12);
    await conflict(m6, 'Conflicts with an earlier decision', 'Streaming captions were chosen for latency at Architecture sync.', 'Meeting “Architecture sync”', 3);
    await conflict(m3, 'Conflicts with an earlier decision', 'Kickoff chose a managed database.', 'Meeting “Kickoff”', 40);

    const chat = (meeting: string, who: string, body: string, days: number, min: number) =>
      c.query(`insert into chat_messages(meeting_id, user_id, kind, body, created_at) values ($1,$2,'user',$3, ${ago(days)} + interval '1 minute' * ($4::int))`, [meeting, people[who], body, min]);
    await chat(m1, 'aman', 'Posting the CI checklist in the workspace.', 68, 5);
    await chat(m2, 'sam', 'Link to the Deepgram latency benchmarks: bench.example.com/deepgram', 54, 4);
    await chat(m4, 'leo', 'Can someone confirm the new date works for the load test?', 26, 6);
    await chat(m4, 'dana', 'Yes, September 5 is fine for design and marketing.', 26, 7);
    await chat(m6, 'priya', '@ai what did we decide about captions?', 3, 4);
    const recap = (meeting: string, days: number, title: string, body: string) =>
      c.query(`insert into insights(meeting_id, project_id, kind, tier, title, body, delivered_to_chat, created_at) values ($1,$2,'recap','feed',$3,$4,false, ${ago(days)} + interval '45 minutes')`, [meeting, project, title, body]);
    await recap(m4, 26, 'Meeting recap', 'Deployment moved to September 5, replacing the August 1 decision. Aman owns the release checklist, Dana the launch announcement and Leo the load test. Two questions stayed open: the deployment region and legal approval of the vendor contract.');
    await recap(m5, 12, 'Meeting recap', 'Deployment moved again, to September 19. PostgreSQL gets pgvector. Staging migrations failed again and onboarding documentation is still unwritten.');
    await recap(m6, 3, 'Meeting recap', 'The team switched captions to batch transcription, reversing the streaming decision. Legal approval is still pending. Final QA and the launch checklist sign-off remain open.');
    for (const [meeting, who, body, days] of [[m4, 'priya', 'Check with legal about the vendor contract before the 5th.\nRegion question is still open.', 26], [m6, 'priya', 'Captions switch needs a note to Sam.\nChase legal approval today.', 3]] as const)
      await c.query(`insert into personal_notes(meeting_id, user_id, body, updated_at) values ($1,$2,$3, ${ago(days)} + interval '30 minutes')`, [meeting, people[who], body]);
    // Recurring blockers and repeated, unresolved items
    const legal1 = await event(m2, 'blocker', 'Waiting on legal approval for the vendor contract', 'Sam', 54, { seq: 1 });
    await event(m4, 'blocker', 'Still waiting for legal approval of the vendor contract', 'Sam', 26, { seq: 5 });
    await event(m6, 'blocker', 'Legal approval for the vendor contract is still pending', 'Dana', 3, { seq: 2 });
    await event(m3, 'blocker', 'Staging environment keeps failing on migrations', 'Leo', 40, { seq: 1 });
    const stg = await event(m5, 'blocker', 'Staging environment failing on migrations again', 'Leo', 12, { seq: 1 });
    await event(m3, 'task', 'Write the onboarding documentation', 'Dana', 40, { seq: 2 });
    await event(m5, 'task', 'Write onboarding documentation for new users', 'Dana', 12, { seq: 4 });
    await event(m6, 'task', 'Finish the onboarding documentation', 'Dana', 3, { seq: 3 });
    await event(m2, 'question', 'Which region should we deploy to', 'Aman', 54, { seq: 2 });
    await event(m4, 'question', 'Which region do we deploy to', 'Aman', 26, { seq: 4 });
    await event(m1, 'deadline', 'Ship beta', 'Priya', 68, { seq: 6, key: 'beta_date', due: new Date(Date.now() - 40 * 864e5).toISOString() });
    await event(m3, 'deadline', 'Ship beta', 'Priya', 40, { seq: 4, key: 'beta_date', due: new Date(Date.now() - 20 * 864e5).toISOString() });
    await event(m5, 'deadline', 'Ship beta', 'Dana', 12, { seq: 5, key: 'beta_date', due: new Date(Date.now() + 9 * 864e5).toISOString() });

    // Tasks (done, late, overdue, reviewing, in-flight), across owners and departments
    await task(m1, 'Set up CI pipeline', 'aman', 'code', 'high', 67, 60, 'done', 61);
    await task(m1, 'Draft product requirements', 'priya', 'research', 'high', 67, 61, 'done', 62);
    await task(m1, 'Design brand and landing page', 'dana', 'design', 'medium', 67, 55, 'done', 52, null, 50);
    await task(m2, 'Prototype live captions', 'sam', 'code', 'high', 53, 46, 'done', 47);
    await task(m2, 'Research competitor pricing', 'priya', 'research', 'medium', 53, 47, 'done', 41);
    await task(m2, 'Vendor contract with transcription provider', 'sam', 'communication', 'high', 53, 40, 'open', null, legal1, 30);
    await task(m3, 'Implement project memory search', 'aman', 'code', 'high', 39, 30, 'done', 31);
    await task(m3, 'Write onboarding documentation', 'dana', 'communication', 'medium', 39, 28, 'open', null);
    await task(m3, 'Fix staging migrations', 'leo', 'code', 'high', 39, 25, 'done', 17);
    await task(m4, 'Prepare release checklist', 'aman', 'general', 'high', 25, 18, 'done', 19);
    await task(m4, 'Launch announcement draft', 'dana', 'marketing', 'medium', 25, 14, 'done', 9);
    await task(m4, 'Load test the room service', 'leo', 'code', 'high', 25, 10, 'in_progress', null, null, 5);
    await task(m4, 'Decide deployment region', 'aman', 'research', 'low', 25, 15, 'open', null);
    await task(m5, 'Security review of integrations', 'sam', 'code', 'high', 11, 3, 'review', null);
    await task(m5, 'Pricing page copy', 'dana', 'marketing', 'low', 11, -2, 'in_progress', null);
    await task(m5, 'Fix staging migrations (again)', 'leo', 'code', 'high', 11, 2, 'open', null, stg);
    await task(m5, 'Customer interview synthesis', 'priya', 'research', 'medium', 11, -5, 'in_progress', null);
    await task(m6, 'Final QA pass', 'aman', 'code', 'high', 2, -3, 'open', null);
    await task(m6, 'Press kit', 'dana', 'design', 'medium', 2, -6, 'open', null);
    await task(m6, 'Launch checklist sign-off', 'priya', 'general', 'high', 2, -2, 'open', null);
  }
  if (viewer) {
    await c.query("insert into project_members values ($1,$2,'member') on conflict do nothing", [project, viewer]);
    const ms = (await c.query('select id from meetings where project_id = $1', [project])).rows;
    for (const m of ms) await c.query("insert into meeting_participants(meeting_id, user_id, invite_status) values ($1,$2,'joined') on conflict do nothing", [m.id, viewer]);
  }
  await c.query('commit');
  console.log(`demo project "Atlas Platform Launch" ready${viewer ? `; ${me} added as a member` : '. Pass your username to be added: npm run db:seed-demo -w @meetpilot/backend -- <username>'}`);
} catch (e) {
  await c.query('rollback');
  throw e;
} finally {
  c.release();
  await pool.end();
}
