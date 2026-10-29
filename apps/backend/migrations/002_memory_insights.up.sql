create extension if not exists vector;

create table knowledge_events (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  segment_from_seq int,
  segment_to_seq int,
  type text not null check (type in ('task', 'decision', 'deadline', 'question', 'blocker', 'info')),
  entity_key text,
  summary text not null,
  who text,
  due_at timestamptz,
  references_earlier boolean not null default false,
  quote text,
  summary_hash text not null,
  created_at timestamptz not null default now(),
  unique (meeting_id, segment_from_seq, type, summary_hash)
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  entity_key text not null,
  value text not null,
  meeting_id uuid references meetings(id) on delete cascade,
  event_id uuid references knowledge_events(id) on delete set null,
  superseded_by uuid references decisions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index decisions_entity_idx on decisions (project_id, entity_key, created_at desc);

create table memory_chunks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_type text not null check (source_type in ('transcript', 'event', 'decision', 'task', 'workspace_doc', 'code')),
  source_id uuid,
  meeting_id uuid references meetings(id) on delete cascade,
  text text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);
create index memory_chunks_embedding_idx on memory_chunks using hnsw (embedding vector_cosine_ops);
create index memory_chunks_project_idx on memory_chunks (project_id, source_type);
create index memory_chunks_source_idx on memory_chunks (source_id);

create table insights (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('conflict', 'answer', 'reminder', 'context', 'no_record', 'external', 'brief', 'recap')),
  tier text not null check (tier in ('interrupt', 'queued', 'feed')),
  title text not null,
  body text not null,
  quote text,
  source_label text,
  source_url text,
  score real,
  topic_key text,
  audience_user_id uuid references users(id) on delete cascade, -- non-null => private to that user
  feedback text check (feedback in ('helpful', 'dismissed')),
  delivered_to_chat boolean not null default false,
  created_at timestamptz not null default now()
);
create index insights_meeting_idx on insights (meeting_id, created_at desc);
create index insights_audience_idx on insights (meeting_id, audience_user_id);

alter table chat_messages
  add constraint chat_messages_insight_fk foreign key (insight_id) references insights(id) on delete set null;
