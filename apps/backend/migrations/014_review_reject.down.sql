delete from execution_reviews where verdict = 'reject';
update executions set status = 'failed', error = 'rejected' where status = 'rejected';
alter table execution_reviews drop constraint execution_reviews_verdict_check;
alter table execution_reviews add constraint execution_reviews_verdict_check check (verdict in ('approve', 'changes'));
alter table executions drop constraint executions_status_check;
alter table executions add constraint executions_status_check
  check (status in ('routed', 'running', 'awaiting_review', 'changes_requested', 'approved', 'failed', 'skipped_human'));
