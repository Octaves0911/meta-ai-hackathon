-- "Raised before" cards: update (reassigned / deadline moved) and repeat (already discussed or assigned).
alter table insights drop constraint if exists insights_kind_check;
alter table insights add constraint insights_kind_check
  check (kind in ('conflict', 'update', 'repeat', 'answer', 'reminder', 'context', 'no_record', 'external', 'brief', 'recap'));

-- A task owner who was named aloud but is not a project member keeps the spoken name instead of silently becoming "Unassigned".
alter table tasks add column if not exists spoken_assignee text;
