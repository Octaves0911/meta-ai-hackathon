create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  owner_id uuid not null references users(id) on delete cascade,
  share_workspace boolean not null default false,
  created_at timestamptz not null default now()
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  primary key (project_id, user_id)
);

create table meetings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'active' check (status in ('scheduled', 'active', 'ended', 'closed')),
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  closed_at timestamptz,
  total_duration_sec int not null default 0,
  share_chat_transcript boolean not null default false,
  share_workspace boolean not null default false,
  ai_assist boolean not null default false,
  created_at timestamptz not null default now()
);
create index meetings_project_idx on meetings (project_id, created_at desc);

create table meeting_participants (
  meeting_id uuid not null references meetings(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  invite_status text not null default 'invited' check (invite_status in ('invited', 'accepted', 'declined', 'joined')),
  joined_at timestamptz,
  last_session_started_at timestamptz,
  primary key (meeting_id, user_id)
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null default 'user' check (kind in ('user', 'ai_insight')),
  body text not null,
  insight_id uuid, -- FK added in 002 once insights exists
  created_at timestamptz not null default now()
);
create index chat_messages_meeting_idx on chat_messages (meeting_id, created_at desc);

create table personal_notes (
  meeting_id uuid not null references meetings(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  body text not null default '',
  updated_at timestamptz not null default now(),
  primary key (meeting_id, user_id)
);

create table transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  speaker_name text not null,
  text text not null,
  confidence real,
  seq int not null,
  started_at_ms int,
  created_at timestamptz not null default now(),
  unique (meeting_id, seq)
);
