begin;

-- ---------------------------------------------------------------------------
-- Bounds the salon's own address line, so it is held to the same rule a client's
-- address already is.
--
-- `locations.address` has existed since 0001 as a bare `text` with no bound, and
-- until now no REQUEST could write it: the only insert into `locations` names
-- (business_id, name, timezone), and the only updates set name, timezone and
-- version. The single writer anywhere is `scripts/seed-qa.ts`, which plants one
-- well-formed line. So the column is null in every row an operator has ever
-- touched, and the bound was checked against a populated database before being
-- written here rather than assumed - a bound added over existing rows fails the
-- DEPLOY, not the request, which is far worse than the state it prevents.
--
-- Settings -> Business is about to make the column editable, which is what makes
-- the bound worth having now.
--
-- The shape is copied deliberately from `customer_addresses.address` in 0025,
-- character for character. That table is where Pawsh settled the question of how
-- an address is stored, and the answer was ONE FREE-TEXT LINE, capped at 500,
-- not a street/city/region/postcode decomposition. Nothing in this product
-- geocodes, routes, computes a distance, or validates a postcode, so structured
-- columns would buy nothing and cost a schema that every future address-shaped
-- thing has to be talked out of matching. A salon's address is not a different
-- kind of address from a client's.
--
-- `btrim` is the point of the lower bound rather than a plain length check: a
-- column that permits '' and '   ' has three ways to say "unknown", and the
-- handler would have to normalise all of them on every read. The schema layer
-- maps a blank string to null before it ever gets here; this makes that the only
-- possibility rather than a convention some future caller can forget.
--
-- Null still passes, and means what it has always meant - no address recorded.
-- A check constraint is not violated by null, so the nullable column needs no
-- special case.
-- ---------------------------------------------------------------------------

alter table locations
  add constraint location_address_bounded
  check (char_length(btrim(address)) between 1 and 500);

insert into schema_migrations(version) values ('0046_business_address_bound');
commit;
