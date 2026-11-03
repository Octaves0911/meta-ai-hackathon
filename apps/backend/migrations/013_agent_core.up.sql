-- Agent core (docs/09 §1): confidence + open questions + usage on a run, the routing confidence and plan, and a step trace.
alter table executions
  add column confidence real check (confidence between 0 and 1),
  add column open_questions jsonb not null default '[]',
  add column usage jsonb,
  add column route_confidence real check (route_confidence between 0 and 1),
  add column stage_plan jsonb;

create table execution_steps (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  revision int not null default 0,
  seq int not null,
  kind text not null check (kind in ('plan', 'search', 'read', 'consult', 'tool', 'draft', 'check')),
  label text not null,
  detail jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (execution_id, revision, seq)
);

alter table execution_artifacts drop constraint execution_artifacts_type_check;
alter table execution_artifacts add constraint execution_artifacts_type_check
  check (type in ('markdown', 'image', 'pdf', 'video', 'diff', 'link', 'file', 'email_draft', 'html', 'table'));
