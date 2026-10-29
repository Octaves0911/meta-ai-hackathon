// Dev seed: the PRD §F5 golden scenario (Meeting 1 decides Aug 1 deploy; Meeting 2 will contradict it).
// Idempotent: does nothing if the seed users already exist. Embeddings are added by feat/project-memory.
import { createPool } from './pool.js';

const pool = createPool();
const client = await pool.connect();

try {
  const existing = await client.query("select 1 from users where username = 'priya'");
  if (existing.rowCount) {
    console.log('seed already applied');
  } else {
    await client.query('begin');
    const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0].id as string;

    const priya = await one("insert into users(username) values ('priya') returning id");
    const aman = await one("insert into users(username) values ('aman') returning id");

    const project = await one(
      "insert into projects(name, description, owner_id) values ('Launch Q3', 'Seed project', $1) returning id",
      [priya],
    );
    await client.query("insert into project_members values ($1,$2,'owner'), ($1,$3,'member')", [project, priya, aman]);

    const m1 = await one(
      `insert into meetings(project_id, owner_id, title, status, started_at, ended_at, total_duration_sec)
       values ($1,$2,'Release planning','closed', now() - interval '7 days', now() - interval '7 days' + interval '30 minutes', 1800)
       returning id`,
      [project, priya],
    );
    await client.query("insert into meeting_participants(meeting_id, user_id, invite_status) values ($1,$2,'joined'), ($1,$3,'joined')", [m1, priya, aman]);
    await client.query(
      `insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values
       ($1,$2,'Priya','We decided to deploy on August 1.',1),
       ($1,$3,'Aman','Agreed. I will prepare the release checklist by Friday.',2)`,
      [m1, priya, aman],
    );
    const ev = await one(
      `insert into knowledge_events(meeting_id, project_id, segment_from_seq, segment_to_seq, type, entity_key, summary, who, summary_hash)
       values ($1,$2,1,1,'decision','deployment_date','Deploy on August 1','Priya','seed-deploy-aug1') returning id`,
      [m1, project],
    );
    await client.query("insert into decisions(project_id, entity_key, value, meeting_id, event_id) values ($1,'deployment_date','August 1',$2,$3)", [project, m1, ev]);
    await client.query(
      "insert into tasks(meeting_id, project_id, title, assigned_to, assigned_by, due_date, finalized) values ($1,$2,'Prepare release checklist',$3,$4,current_date + 3,true)",
      [m1, project, aman, priya],
    );

    const m2 = await one(
      `insert into meetings(project_id, owner_id, title, status, started_at, ai_assist)
       values ($1,$2,'Sprint sync','active', now(), true) returning id`,
      [project, priya],
    );
    await client.query("insert into meeting_participants(meeting_id, user_id, invite_status) values ($1,$2,'joined'), ($1,$3,'invited')", [m2, priya, aman]);

    await client.query('commit');
    console.log('seeded: users priya, aman; project "Launch Q3"; 2 meetings');
  }
} catch (e) {
  await client.query('rollback');
  throw e;
} finally {
  client.release();
  await pool.end();
}
