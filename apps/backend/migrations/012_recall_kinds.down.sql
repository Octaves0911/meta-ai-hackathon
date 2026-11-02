alter table tasks drop column if exists spoken_assignee;
delete from insights where kind in ('update', 'repeat');
alter table insights drop constraint if exists insights_kind_check;
alter table insights add constraint insights_kind_check
  check (kind in ('conflict', 'answer', 'reminder', 'context', 'no_record', 'external', 'brief', 'recap'));
