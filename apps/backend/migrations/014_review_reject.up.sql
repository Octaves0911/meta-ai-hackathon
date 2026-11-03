-- Reviewers can reject agent work: it stops, the task goes back to a human, and the reason is kept (docs/09 §1.11).
alter table executions drop constraint executions_status_check;
alter table executions add constraint executions_status_check
  check (status in ('routed', 'running', 'awaiting_review', 'changes_requested', 'approved', 'rejected', 'failed', 'skipped_human'));
alter table execution_reviews drop constraint execution_reviews_verdict_check;
alter table execution_reviews add constraint execution_reviews_verdict_check check (verdict in ('approve', 'changes', 'reject'));
