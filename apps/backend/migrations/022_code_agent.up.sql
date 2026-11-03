-- Code agent (docs/09 §2.5): which linked repository an execution targets, and the verification evidence artifact.
alter table executions add column repo_id uuid references project_repos(id) on delete set null;
alter table execution_artifacts drop constraint execution_artifacts_type_check;
alter table execution_artifacts add constraint execution_artifacts_type_check
  check (type in ('markdown', 'image', 'pdf', 'video', 'diff', 'link', 'file', 'email_draft', 'html', 'table', 'verification'));
