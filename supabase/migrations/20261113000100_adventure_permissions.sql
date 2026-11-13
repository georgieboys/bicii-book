-- Adventures (docs/ADVENTURES.md, ADR-026, PLAN D169): three permissions.
--
--   manage_adventures      catalogue, offers, departures, bookings,
--                          trackers and finisher packs
--   verify_adventures      private ride evidence, certification decisions
--   facilitate_adventures  an assigned departure's manifest and
--                          observations (Phase E)
--
-- private.role_implies is unchanged: an admin holds every permission, a
-- manager every one except manage_staff (so all three), a mechanic none
-- unless granted as an exception. Their own migration because a new enum
-- value cannot be used in the transaction that adds it.
alter type public.permission_key add value 'manage_adventures';
alter type public.permission_key add value 'verify_adventures';
alter type public.permission_key add value 'facilitate_adventures';
