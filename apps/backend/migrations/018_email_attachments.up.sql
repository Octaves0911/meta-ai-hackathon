-- Audit of every file that went out with an email (docs/09 §2.2). The draft itself stores which executions' PDFs are attached.
create table email_send_attachments (
  id uuid primary key default gen_random_uuid(),
  send_id uuid not null references email_sends(id) on delete cascade,
  artifact_id uuid references execution_artifacts(id) on delete set null,
  filename text not null,
  mime text not null,
  size int not null,
  sha256 text not null
);
create index email_send_attachments_send_idx on email_send_attachments (send_id);
