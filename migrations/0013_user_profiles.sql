begin;

alter table users add column display_name text;

update users
set display_name = left(split_part(email, '@', 1), 120)
where display_name is null;

alter table users
  alter column display_name set default 'Pawsh user',
  alter column display_name set not null,
  add constraint users_display_name_length
    check (char_length(btrim(display_name)) between 1 and 120);

commit;
