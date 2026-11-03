delete from execution_artifacts where type in ('html', 'table');
alter table execution_artifacts drop constraint execution_artifacts_type_check;
alter table execution_artifacts add constraint execution_artifacts_type_check
  check (type in ('markdown', 'image', 'pdf', 'video', 'diff', 'link', 'file', 'email_draft'));
drop table if exists execution_steps;
alter table executions drop column if exists stage_plan, drop column if exists route_confidence, drop column if exists usage,
  drop column if exists open_questions, drop column if exists confidence;
