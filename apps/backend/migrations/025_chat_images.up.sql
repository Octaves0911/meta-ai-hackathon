-- Screenshots attached to a review chat message (Muse vision input). Small images only (the API enforces 2.5 MB); kept with the message.
alter table execution_messages add column image bytea, add column image_mime text;
