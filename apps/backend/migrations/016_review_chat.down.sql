drop table if exists execution_messages;
update executions set revision = 3 where revision > 3;
alter table executions drop constraint executions_revision_check;
alter table executions add constraint executions_revision_check check (revision <= 3);
