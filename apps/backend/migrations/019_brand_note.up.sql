-- Short owner-written "brand and voice" note that Marketing, Communication and Designer always see (docs/09 §2.3).
alter table projects add column brand_note text check (brand_note is null or length(brand_note) <= 1500);
