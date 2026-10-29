drop index if exists tasks_event_uidx;
alter table tasks drop column if exists event_id;
