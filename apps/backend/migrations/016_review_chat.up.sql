-- Live chat with the agent while reviewing (docs/09 §1.11) and up to 5 revisions.
alter table executions drop constraint executions_revision_check;
alter table executions add constraint executions_revision_check check (revision between 0 and 5);

create table execution_messages (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  revision int not null default 0,
  role text not null check (role in ('user', 'agent')),
  kind text not null default 'ask' check (kind in ('ask', 'change', 'clarify')),
  text text not null check (length(text) between 1 and 6000),
  proposed_change text,
  author_id uuid references users(id) on delete set null,
  usage jsonb,
  created_at timestamptz not null default now()
);
create index execution_messages_idx on execution_messages (execution_id, created_at);
