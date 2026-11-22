set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- 2026-11-22 quick audit: the audit event of unlink_shopify_customer, in its
-- own migration so 20261122001700_quick_audit_fixes can use it (a value
-- added by ALTER TYPE cannot be used in the transaction that adds it).
alter type public.integration_audit_type add value if not exists 'customer_unlinked';
