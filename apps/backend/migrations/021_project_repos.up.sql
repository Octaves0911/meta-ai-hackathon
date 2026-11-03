-- GitHub repositories the project owner links to a project (docs/09 §1.10), and the optional per-project GitHub token (kept sealed by the connector).
create table project_repos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  owner text not null check (owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  name text not null check (name ~ '^[A-Za-z0-9._-]{1,100}$'),
  default_branch text not null default 'main',
  description text,                       -- owner-written; helps the agent choose
  github_description text,
  is_private boolean not null default false,
  can_push boolean not null default false,
  language text,
  languages jsonb not null default '{}',
  index_text text not null default '',    -- README summary, top-level tree, manifests: what the repo picker reads
  indexed_at timestamptz,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index project_repos_unique on project_repos (project_id, lower(owner), lower(name));

create table github_connections (
  project_id uuid primary key references projects(id) on delete cascade,
  token_ciphertext bytea not null,
  token_iv bytea not null,
  token_tag bytea not null,
  account text not null,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
