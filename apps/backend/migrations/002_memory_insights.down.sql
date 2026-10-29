alter table chat_messages drop constraint if exists chat_messages_insight_fk;
drop table if exists insights, memory_chunks, decisions, knowledge_events cascade;
drop extension if exists vector;
