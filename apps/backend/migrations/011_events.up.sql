-- Product analytics events (PRD §11): ids and categories only. No foreign keys, so history survives deletions of users/projects.
create table events (
  id bigserial primary key,
  name text not null,
  props jsonb not null default '{}',
  user_id uuid,
  project_id uuid,
  meeting_id uuid,
  created_at timestamptz not null default now()
);
create index events_name_idx on events (name, created_at desc);
