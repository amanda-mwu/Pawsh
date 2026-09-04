begin;

-- ---------------------------------------------------------------------------
-- Retire `businesses.coupon_stacking`.
--
-- TWO COLUMNS CARRIED THE SAME THREE-VALUED RULE, and only one of them was
-- ever consulted about money.
--
--   discount_stacking_mode  (0048)  the authority. Twenty consumers, including
--                                   `applyDiscounts` in @pawsh/domain, which is
--                                   what decides whether a $100 bill with a $20
--                                   discount and a 10% discount comes to $72 or
--                                   to $70. Written through
--                                   `PUT /api/settings/discount-stacking`,
--                                   gated on `settings.discounts`.
--   coupon_stacking         (0047)  zero money consumers. `PUT /api/business/
--                                   settings` wrote it and read it back only to
--                                   name it in the audit entry. Nothing that
--                                   calculates a bill has ever read it.
--
-- `single` and `one_per_appointment` are the same rule spelled twice; the other
-- two values are spelled identically. They were never separate concepts, and
-- the Business Settings control that wrote this column told an operator their
-- choice would take effect when coupons shipped. Coupons shipped in 0048 and
-- read the other column.
--
-- NO VALUE IS COPIED ANYWHERE. That is the whole safety argument and it is
-- worth stating as a rule rather than as a consequence: a bill must not change
-- because of a cleanup. Copying `coupon_stacking` into the financial authority
-- would move real money for any workspace whose inert setting disagreed with
-- its effective one, and the disagreement is not hypothetical - it is exactly
-- what a control that changed nothing invites. Existing effective billing
-- behaviour wins over an obsolete inert setting, so `discount_stacking_mode` is
-- not touched by this migration at all and every workspace bills tomorrow
-- exactly as it billed today.
--
-- The column drop takes its check constraint with it; the constraint is dropped
-- by name first so the intent is legible in the file rather than implied, and
-- so a database that somehow holds one without the other converges. Both
-- statements are `if exists`, which makes the migration idempotent and lets it
-- apply to a fresh database and to an upgraded one by the same path.
--
-- WIRE EFFECT, STATED PLAINLY. `GET /api/me` selects `businesses.*`, so
-- `business.couponStacking` disappears from that payload and from the body
-- `PUT /api/business/settings` returns. The request field of the same name is
-- removed from `businessSettingsSchema` in the same change; because that schema
-- is not `.strict()`, a client still sending it is ignored rather than refused.
-- ---------------------------------------------------------------------------

alter table businesses
  drop constraint if exists business_coupon_stacking_supported;

alter table businesses
  drop column if exists coupon_stacking;

commit;
