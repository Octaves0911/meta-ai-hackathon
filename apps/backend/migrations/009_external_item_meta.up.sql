-- Thread/Message-ID/sender address of synced mail, so the communication agent can thread replies and use real addresses.
alter table external_items add column meta jsonb not null default '{}';
