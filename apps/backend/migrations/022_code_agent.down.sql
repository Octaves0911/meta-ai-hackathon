delete from execution_artifacts where type = 'verification';
alter table execution_artifacts drop constraint execution_artifacts_type_check;
alter table execution_artifacts add constraint execution_artifacts_type_check
  check (type in ('markdown', 'image', 'pdf', 'video', 'diff', 'link', 'file', 'email_draft', 'html', 'table'));
alter table executions drop column if exists repo_id;
