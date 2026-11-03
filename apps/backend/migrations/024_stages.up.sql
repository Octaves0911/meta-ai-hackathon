-- Multi-stage tasks (docs/09 §1.9): a task can have one execution per stage (0 = first agent, 1 = the agent started after the reviewer approved it).
alter table executions drop constraint executions_task_id_key;
alter table executions add column stage int not null default 0 check (stage between 0 and 2);
alter table executions add column parent_execution_id uuid references executions(id) on delete set null;
create unique index executions_task_stage_uidx on executions (task_id, stage);
