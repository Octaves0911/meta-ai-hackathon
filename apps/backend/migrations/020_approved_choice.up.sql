-- Which design direction the reviewer approved (A or B), passed on to later stages such as the web-page build (docs/09 §1.9).
alter table executions add column approved_choice text check (approved_choice in ('A', 'B'));
