alter table pets
  add column version integer not null default 1,
  add constraint pet_version_positive check (version > 0);
