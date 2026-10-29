drop trigger if exists tasks_memory_cleanup on tasks;
drop trigger if exists decisions_memory_cleanup on decisions;
drop trigger if exists events_memory_cleanup on knowledge_events;
drop function if exists memory_chunks_delete_source();
