create table connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'drive')),
  visibility text not null default 'private' check (visibility in ('private', 'project')),
  config jsonb not null default '{}',
  scopes text[] not null default '{}',
  status text not null default 'pending',
  last_sync_at timestamptz,
  token_ciphertext bytea,
  token_iv bytea,
  token_tag bytea,
  created_at timestamptz not null default now()
);

create table external_items (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connections(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  provider text not null,
  external_id text not null,
  title text,
  author text,
  url text,
  visibility text not null check (visibility in ('private', 'project')),
  occurred_at timestamptz,
  text text not null,
  embedding vector(1536),
  unique (connection_id, external_id)
);
create index external_items_embedding_idx on external_items using hnsw (embedding vector_cosine_ops);
create index external_items_audience_idx on external_items (project_id, visibility, owner_id);

create table workspace_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  kind text not null check (kind in ('cloud', 'local')),
  size bigint,
  mime text,
  summary text,
  updated_at timestamptz not null default now(),
  unique (project_id, path)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null check (type in ('invite', 'review_ready')),
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  last_error text
);
create index jobs_due_idx on jobs (status, run_at);
