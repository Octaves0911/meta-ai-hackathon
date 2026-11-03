-- Owner switch: agents must not send anything to the web for this project (docs/09 §2.1).
alter table projects add column no_external_lookups boolean not null default false;
