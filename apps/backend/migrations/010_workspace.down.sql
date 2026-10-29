drop trigger if exists workspace_files_memory_cleanup on workspace_files;
drop function if exists workspace_chunks_delete();
alter table workspace_files drop column if exists content_hash;
alter table projects drop column if exists local_root;
