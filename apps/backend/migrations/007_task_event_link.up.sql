-- One task per extracted event: makes task creation idempotent when a transcript is re-processed (F7.1).
alter table tasks add column event_id uuid references knowledge_events(id) on delete set null;
create unique index tasks_event_uidx on tasks (event_id) where event_id is not null;
