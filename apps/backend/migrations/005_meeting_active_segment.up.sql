-- Start of the current "someone is present" interval; duration accumulates across join/leave sessions (F2.7).
alter table meetings add column segment_started_at timestamptz;
