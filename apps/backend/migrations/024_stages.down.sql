delete from executions where stage > 0;
drop index if exists executions_task_stage_uidx;
alter table executions drop column if exists parent_execution_id;
alter table executions drop column if exists stage;
alter table executions add constraint executions_task_id_key unique (task_id);
