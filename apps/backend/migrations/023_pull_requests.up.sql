-- Pull requests opened from verified Code agent changes (docs/09 §2.5). The unique (execution, revision) is the duplicate guard.
create table pull_requests (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  revision int not null,
  repo_id uuid references project_repos(id) on delete set null,
  repo_full_name text not null,
  base_branch text not null,
  base_sha text not null,
  branch text not null,
  number int,
  url text,
  head_sha text,
  status text not null default 'pending' check (status in ('pending', 'open', 'unconfirmed')),
  draft boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (execution_id, revision)
);
