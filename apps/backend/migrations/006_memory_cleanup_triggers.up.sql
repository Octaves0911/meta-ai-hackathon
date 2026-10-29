-- Deleting a source record removes its embeddings (F6.7). Meeting/project deletes already cascade via memory_chunks FKs.
create function memory_chunks_delete_source() returns trigger language plpgsql as $$
begin
  delete from memory_chunks where source_id = old.id and source_type = tg_argv[0];
  return old;
end $$;

create trigger tasks_memory_cleanup after delete on tasks
  for each row execute function memory_chunks_delete_source('task');
create trigger decisions_memory_cleanup after delete on decisions
  for each row execute function memory_chunks_delete_source('decision');
create trigger events_memory_cleanup after delete on knowledge_events
  for each row execute function memory_chunks_delete_source('event');
