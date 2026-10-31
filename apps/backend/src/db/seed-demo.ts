// Demo data for the intelligence dashboard: a 10-week project with real rows in every table the analytics read
// (meetings, events, decisions, conflict insights, tasks and their status/due-date history). Idempotent.
// Usage: npm run db:seed-demo -w @meetpilot/backend -- <your-username>   (adds you to the project so you can see it)
import { createPool } from './pool.js';

const me = process.argv[2]?.trim().toLowerCase();
const pool = createPool();
const c = await pool.connect();
const ago = (days: number, hour = 10) => `now() - interval '${days} days' + interval '${hour - 10} hours'`;

try {
  await c.query('begin');
  const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0].id as string;
  const user = async (name: string) => (await c.query('insert into users(username) values ($1) on conflict (username) do update set username = excluded.username returning id', [name])).rows[0].id as string;
  const people = { priya: await user('priya'), aman: await user('aman'), dana: await user('dana'), sam: await user('sam'), leo: await user('leo') } as Record<string, string>;
  const viewer = me ? await user(me) : null;

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
    const evN = { n: 0 };
    const event = async (meeting: string, type: string, summary: string, who: string, days: number, extra: { key?: string; due?: string } = {}) =>
      one(`insert into knowledge_events(meeting_id, project_id, type, entity_key, summary, who, due_at, summary_hash, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8, ${ago(days)}) returning id`, [meeting, project, type, extra.key ?? null, summary, who, extra.due ?? null, `demo-${++evN.n}`]);
    const decision = async (meeting: string, key: string, value: string, who: string, days: number) => {
      const ev = await event(meeting, 'decision', `${key}: ${value}`, who, days, { key });
      const id = await one(`insert into decisions(project_id, entity_key, value, meeting_id, event_id, created_at) values ($1,$2,$3,$4,$5, ${ago(days)}) returning id`, [project, key, value, meeting, ev]);
      await c.query('update decisions set superseded_by = $1 where project_id = $2 and entity_key = $3 and id <> $1 and superseded_by is null and lower(value) <> lower($4)', [id, project, key, value]);
      return ev;
    };
    const conflict = (meeting: string, title: string, body: string, source: string, days: number) =>
      c.query(`insert into insights(meeting_id, project_id, kind, tier, title, body, source_label, created_at) values ($1,$2,'conflict','interrupt',$3,$4,$5, ${ago(days)})`, [meeting, project, title, body, source]);
    const task = async (meeting: string, title: string, who: string, cat: string, prio: string, createdDays: number, dueDays: number, status: string, doneDays: number | null, ev: string | null = null, due2?: number) => {
      const id = await one(`insert into tasks(meeting_id, project_id, title, assigned_to, assigned_by, due_date, priority, category, status, finalized, event_id, created_at)
        values ($1,$2,$3,$4,$5, (${ago(dueDays)})::date, $6,$7,$8,true,$9, ${ago(createdDays)}) returning id`, [meeting, project, title, people[who], people.priya, prio, cat, status, ev]);
      if (due2 !== undefined) await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'due_date',(${ago(dueDays)})::date::text,(${ago(due2)})::date::text, ${ago(createdDays - 3)})`, [id]);
      if (status !== 'open') await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'status','open','in_progress', ${ago(createdDays - 2)})`, [id]);
      if (doneDays !== null) await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'status','in_progress','done', ${ago(doneDays)})`, [id]);
      if (status === 'review') await c.query(`insert into task_history(task_id, field, old, new, changed_at) values ($1,'status','in_progress','review', ${ago(6)})`, [id]);
      return id;
    };

    // Decisions that change over time, by different people
    await decision(m1, 'deployment_date', 'August 1', 'Priya', 68);
    await decision(m1, 'database', 'PostgreSQL', 'Aman', 68);
    await decision(m2, 'captions_provider', 'Deepgram streaming', 'Sam', 54);
    await decision(m4, 'deployment_date', 'September 5', 'Dana', 26);
    await decision(m5, 'database', 'PostgreSQL with pgvector', 'Aman', 12);
    await decision(m5, 'deployment_date', 'September 19', 'Priya', 12);
    await decision(m6, 'captions_provider', 'Batch transcription', 'Leo', 3);
    await conflict(m4, 'Conflicts with an earlier decision', 'Release planning decided deployment on August 1.', 'Meeting “Kickoff”', 26);
    await conflict(m5, 'Conflicts with an earlier decision', 'Deployment was moved to September 5 at Release planning.', 'Meeting “Release planning”', 12);
    await conflict(m6, 'Conflicts with an earlier decision', 'Streaming captions were chosen for latency at Architecture sync.', 'Meeting “Architecture sync”', 3);
    await conflict(m3, 'Conflicts with an earlier decision', 'Kickoff chose a managed database.', 'Meeting “Kickoff”', 40);

    // Recurring blockers and repeated, unresolved items
    const legal1 = await event(m2, 'blocker', 'Waiting on legal approval for the vendor contract', 'Sam', 54);
    await event(m4, 'blocker', 'Still waiting for legal approval of the vendor contract', 'Sam', 26);
    await event(m6, 'blocker', 'Legal approval for the vendor contract is still pending', 'Dana', 3);
    await event(m3, 'blocker', 'Staging environment keeps failing on migrations', 'Leo', 40);
    const stg = await event(m5, 'blocker', 'Staging environment failing on migrations again', 'Leo', 12);
    await event(m3, 'task', 'Write the onboarding documentation', 'Dana', 40);
    await event(m5, 'task', 'Write onboarding documentation for new users', 'Dana', 12);
    await event(m6, 'task', 'Finish the onboarding documentation', 'Dana', 3);
    await event(m2, 'question', 'Which region should we deploy to', 'Aman', 54);
    await event(m4, 'question', 'Which region do we deploy to', 'Aman', 26);
    await event(m1, 'deadline', 'Ship beta', 'Priya', 68, { key: 'beta_date', due: new Date(Date.now() - 40 * 864e5).toISOString() });
    await event(m3, 'deadline', 'Ship beta', 'Priya', 40, { key: 'beta_date', due: new Date(Date.now() - 20 * 864e5).toISOString() });
    await event(m5, 'deadline', 'Ship beta', 'Dana', 12, { key: 'beta_date', due: new Date(Date.now() + 9 * 864e5).toISOString() });

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
