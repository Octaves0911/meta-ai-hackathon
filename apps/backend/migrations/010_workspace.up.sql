-- A project's workspace is its uploaded files (cloud) and optionally a folder on the server (local, under WORKSPACE_LOCAL_BASE).
alter table projects add column local_root text;
alter table workspace_files add column content_hash text;

-- Deleting a file record removes its embeddings (F6.7).
create function workspace_chunks_delete() returns trigger language plpgsql as $$
begin
  delete from memory_chunks where source_id = old.id and source_type in ('workspace_doc', 'code');
  return old;
end $$;
create trigger workspace_files_memory_cleanup after delete on workspace_files
  for each row execute function workspace_chunks_delete();
