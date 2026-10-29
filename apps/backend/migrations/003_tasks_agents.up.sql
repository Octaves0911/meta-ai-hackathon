create table tasks (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  assigned_to uuid references users(id) on delete set null,
  assigned_by uuid references users(id) on delete set null,
  due_date date,
  priority text,
  category text check (category in ('code', 'marketing', 'design', 'communication', 'research', 'general')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'review', 'done')),
  parent_task_id uuid references tasks(id) on delete cascade,
  finalized boolean not null default false,
  created_at timestamptz not null default now()
);
create index tasks_meeting_idx on tasks (meeting_id, created_at desc);

create table task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  field text not null,
  old text,
  new text,
  changed_at timestamptz not null default now()
);

create table executions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references tasks(id) on delete cascade, -- one execution per task, ever
  agent text,
  status text not null default 'routed' check (status in
    ('routed', 'running', 'awaiting_review', 'changes_requested', 'approved', 'failed', 'skipped_human')),
  revision int not null default 0 check (revision <= 3),
  summary text,
  error text,
  reviewer_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index executions_reviewer_idx on executions (reviewer_id, status);

create table execution_artifacts (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  revision int not null default 0,
  type text not null check (type in ('markdown', 'image', 'pdf', 'video', 'diff', 'link', 'file', 'email_draft')),
  title text,
  uri text,
  payload jsonb
);

create table execution_reviews (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  revision int not null,
  reviewer_id uuid references users(id) on delete set null,
  verdict text not null check (verdict in ('approve', 'changes')),
  comment text,
  line_comments jsonb,
  created_at timestamptz not null default now()
);

create table agent_consultations (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  from_agent text not null,
  to_agent text not null,
  question text not null,
  answer text,
  depth int not null check (depth between 1 and 2),
  created_at timestamptz not null default now()
);

create table email_sends (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references executions(id) on delete cascade,
  artifact_id uuid references execution_artifacts(id) on delete set null,
  message_hash text not null,
  recipients jsonb not null,
  sent_at timestamptz not null default now(),
  unique (execution_id, message_hash) -- duplicate-send guard
);
