begin;

-- ---------------------------------------------------------------------------
-- Phase J: retire business_breeds.
--
-- Every runtime consumer has moved:
--   * pricing resolves through pets.breed_id -> business_breed_settings -> breeds (0028/0029)
--   * the breed Settings API serves the canonical taxonomy with sparse tenant overrides
--   * new businesses no longer receive a copied 247-row catalog
--
-- The equivalence run over all 182,460 pets in the pilot database reported 0 pricing-class
-- changes before this drop, which is the gate that allowed it.
--
-- What is deliberately NOT carried across: salon-invented breed names that have no canonical
-- equivalent. Pets referencing one keep their legacy breed text and resolve to the default
-- class, exactly as they did before, and the name survives on the pet rather than in a
-- catalog nothing reads. Genuine tenant disagreements about pricing class or availability
-- were migrated to business_breed_settings by 0029.
--
-- Dropping the table drops its tenant_isolation policy and indexes with it.
-- ---------------------------------------------------------------------------
drop table business_breeds;

insert into schema_migrations(version) values ('0030_retire_business_breeds');
commit;
