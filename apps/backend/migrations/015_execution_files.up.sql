-- Real files produced by agents (docs/09 §1.8). Bytes live next to the artifact so they follow its lifecycle and visibility.
create table execution_files (
  artifact_id uuid primary key references execution_artifacts(id) on delete cascade,
  filename text not null,
  mime text not null,
  size int not null check (size > 0 and size <= 10485760),
  sha256 text not null,
  data bytea not null
);
