/**
 * The API surface fixture (PLAN §5 "RLS matrix"; DATA-MODEL §15, §16):
 * exactly what each API role may reach in the exposed and reporting
 * schemas. tests/db/meta.test.ts compares the live catalogue with these
 * lists, so a migration that forgets its explicit revoke (hosted Supabase
 * grants ALL on new `public` objects to anon/authenticated/service_role,
 * and the devstack now does too) fails, and so does a new grant nobody
 * added here on purpose.
 *
 * Adding an RPC, table or view to the API = adding it here in the same PR,
 * which is the moment to check its RLS policies and guard.
 */

/**
 * Functions anonymous visitors may call: the public booking reads (Phase 2,
 * D37): bookable times, the online-bookable appointment types (no capacity
 * units) and the weekly hours. Phase 11's public site consumes them and
 * must not revoke anon.
 */
export const ANON_FUNCTIONS: readonly string[] = [
  "public.available_slots(date, uuid)",
  // Phase 11 (D123): the public site's range wrapper over the same rules
  "public.bookable_slots(date, date, uuid)",
  "public.public_appointment_types()",
  "public.public_shop_hours()",
  // Phase 13 (D142, D143): the quote page, for whoever holds a quote link;
  // the token is checked against its stored SHA-256, nothing else is read
  "public.answer_quote(text, jsonb, text)",
  "public.quote_by_token(text)",
  // Phase 14 step 3 (D156f): the payment link page, for whoever holds a
  // balance link; the token is checked against its stored SHA-256
  "public.balance_by_token(text)",
];

/**
 * Relations (tables, views, sequences) anonymous visitors may touch, with
 * privileges. reporting.public_items (Phase 4) is the only anonymous
 * inventory surface: published products and units, public columns and
 * public photos only (DATA-MODEL §11, §15); Phase 11's /q page reads it.
 */
export const ANON_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  "reporting.public_items": ["SELECT"],
};

/**
 * Functions in `private` that anon may execute. Only private.selling_price:
 * reporting.public_items calls it, and a view's functions run as the
 * caller. anon has no USAGE on `private`, so it cannot call it directly
 * (tests/db/meta.test.ts checks both).
 */
export const ANON_PRIVATE_FUNCTIONS: readonly string[] = ["private.selling_price(uuid,uuid)"];

/**
 * Functions signed-in users may call (each one checks the caller itself).
 * Staff and customers share the `authenticated` role: the my_* functions
 * are the customer side (own rows, customer-safe columns only); every
 * other one requires active staff (DATA-MODEL §15 "Customer access").
 */
export const AUTHENTICATED_FUNCTIONS: readonly string[] = [
  // Staff (Phase 0)
  "public.create_staff(uuid, text, text, staff_role)",
  "public.grant_permission(uuid, permission_key)",
  "public.my_staff_profile()",
  "public.revoke_permission(uuid, permission_key)",
  "public.set_staff_active(uuid, boolean, text)",
  "public.staff_directory()",
  "public.staff_history(uuid, integer)",
  "public.staff_roster()",
  "public.update_staff(uuid, text, staff_role, text, staff_role)",
  // Customers, bikes, attachments, search (Phase 1): active staff
  "public.attachment_stray_objects(attachment_entity, uuid)",
  "public.delete_attachment(uuid, text)",
  "public.record_attachment(uuid, attachment_entity, uuid, text, text, text, integer, integer, integer, text, attachment_visibility)",
  "public.set_attachment_visibility(uuid, attachment_visibility, text, text)",
  "public.staff_search(text, text[], integer, boolean)",
  "public.transfer_bike_ownership(uuid, uuid, text)",
  // Workshop (Phase 3): active staff; service writes need manage_inventory
  // (a cost also view_costs), Cult Commons rates are admin only
  "public.add_manual_line(uuid, uuid, text, money_amount, line_quantity, money_amount)",
  "public.add_service_line(uuid, uuid, uuid, line_quantity, money_amount, money_amount, text)",
  "public.add_work_order_note(uuid, uuid, work_order_note_kind, text)",
  "public.assign_staff(uuid, uuid, assignment_role)",
  "public.cancel_cult_commons_rate(uuid)",
  "public.create_service(uuid, text, money_amount, text, uuid, money_amount, boolean, boolean)",
  "public.create_work_order(uuid, uuid, uuid, text, text, uuid, uuid[], jsonb)",
  "public.schedule_cult_commons_rate(uuid, rate_fraction, timestamp with time zone)",
  "public.set_approval_flag(uuid, boolean, text)",
  "public.set_service_archived(uuid, boolean)",
  "public.set_work_order_status(uuid, work_order_status, text)",
  "public.unassign_staff(uuid, uuid)",
  "public.update_service(uuid, text, money_amount, text, uuid, boolean, boolean, money_amount)",
  "public.update_work_order(uuid, text, text, text, text)",
  "public.void_line(uuid, text)",
  "public.work_order_timeline(uuid, integer)",
  // Inventory (Phase 4): active staff add and void parts; adjust_stock and
  // write_off_unit need adjust_stock; transfers, units and publication
  // manage_inventory (a unit cost also view_costs); a split needs both
  // adjust_stock and manage_inventory
  "public.add_inventory_line(uuid, uuid, uuid, integer, uuid, uuid, money_amount)",
  "public.adjust_stock(uuid, uuid, uuid, integer, movement_type, text, money_amount)",
  "public.create_unique_unit(uuid, uuid, uuid, text, text, money_amount, money_amount, uuid, text)",
  "public.set_publication_status(uuid, publication_status, text)",
  "public.split_unit_from_stock(uuid, uuid, uuid, uuid, text, text, text, text, money_amount)",
  "public.transfer_stock(uuid, uuid, uuid, uuid, integer, text, uuid)",
  "public.write_off_unit(uuid, uuid, text)",
  // Reporting and Today (Phase 5): active staff; money gated by FIN-ACCESS
  // (D30): financial_lines needs view_financial_reports, work_order_yield
  // view_costs, and cost-derived figures come back NULL without view_costs
  "public.daily_summary(date, date)",
  "public.financial_lines(date, date)",
  "public.operational_exceptions(integer)",
  "public.stock_adjustments_on(date)",
  "public.today_dashboard(date)",
  "public.work_order_activity_on(date)",
  "public.work_order_yield(uuid)",
  // Appointments (Phase 2): active staff; schedule settings admin only.
  // The three public booking reads are callable by everyone (D37).
  "public.available_slots(date, uuid)",
  "public.book_appointment(uuid, uuid, uuid, timestamp with time zone, uuid, text, text)",
  "public.cancel_appointment(uuid, text)",
  "public.delete_closure_override(uuid, text)",
  "public.mark_appointment_status(uuid, appointment_status, text)",
  "public.public_appointment_types()",
  "public.public_shop_hours()",
  "public.save_appointment_type(uuid, boolean, text, text, integer, integer, boolean, boolean, integer)",
  "public.save_closure_override(uuid, boolean, closure_kind, date, date, text, time without time zone, time without time zone)",
  "public.set_shop_hours(smallint, jsonb, boolean)",
  "public.update_appointment(uuid, uuid, boolean, text, text)",
  "public.update_shop_settings(integer, integer, integer, integer, integer, integer, text)",
  // Check-in (D40) creates or links the appointment's one work order; the
  // appointment counts (D41) are operational, every active staff member (D30)
  "public.appointment_daily(date, date)",
  "public.check_in_appointment(uuid, uuid, uuid, boolean, text, text, uuid)",
  // Consignment (Phase 6): manage_consignments takes items in, changes
  // their terms and charges (D4, D45) and returns them (D50, D51); consigned
  // parts go through add_inventory_line above (D44)
  "public.add_consignment_charge(uuid, uuid, text, money_amount, charge_bearer, uuid)",
  "public.create_consignment_item(uuid, uuid, uuid, money_amount, money_amount, uuid, text, text, text, uuid, tracking_type, integer, text, text, timestamp with time zone, text, text, uuid, uuid, uuid, jsonb)",
  "public.return_consignment_item(uuid, uuid, text, integer, uuid)",
  "public.update_consignment_terms(uuid, money_amount, money_amount, text)",
  "public.void_consignment_charge(uuid, text)",
  // D162: an admin reclassifies shop stock entered by mistake as consigned
  // stock on the same product (admin only, checked inside)
  "public.reclassify_as_consignment(uuid, uuid, uuid, money_amount, text, money_amount, timestamp with time zone)",
  // Sales and settlements (Phase 6): any active staff member records an
  // in-store sale (D48); restocks need adjust_stock (a consigned unit also
  // manage_consignments, D46); refunds are admin only (D49); settlements
  // and their reversals manage_consignments (D47)
  "public.record_retail_sale(uuid, jsonb, uuid, timestamp with time zone, text)",
  "public.record_sale_refund(uuid, uuid, money_amount, text)",
  "public.record_settlement(uuid, uuid, money_amount, jsonb, timestamp with time zone, text, text)",
  "public.restock_unit(uuid, uuid, uuid, text)",
  "public.reverse_settlement(uuid, uuid, text)",
  // Phase 6 reads: active staff; sale costs NULL without view_costs,
  // consignment money NULL without manage_consignments or view_costs (D48);
  // payout details manage_consignments only
  "public.consignor_payout_details(uuid)",
  "public.consignor_statement(uuid, uuid)",
  "public.list_consignors(text, boolean, integer)",
  "public.list_sales(timestamp with time zone, timestamp with time zone, text, integer)",
  "public.sale_lines_detail(uuid)",
  "public.saleable_stock(text, integer)",
  // Labels (Phase 8): active staff; templates and profiles written by admins only
  "public.create_print_job(uuid, label_kind, uuid, integer, uuid, uuid, uuid)",
  "public.label_preview(label_kind, uuid)",
  "public.set_default_label_template(uuid)",
  "public.set_default_printer_profile(uuid)",
  "public.set_print_job_status(uuid, print_status, text)",
  // Shopify (Phase 10, D86): admins retry inbound jobs, dismiss, and link
  // variants and customers; manage_inventory retries product-sync jobs
  "public.dismiss_integration_job(uuid, text)",
  "public.link_shopify_customer(uuid, text, text)",
  "public.link_shopify_variant(uuid, text, text, text)",
  "public.retry_integration_job(uuid)",
  // Shopify outbound (Phase 10 step 2, D84, D86): manage_inventory
  // publishes online and asks for a sync; admins change the settings
  "public.request_product_sync(uuid)",
  "public.set_publish_online(uuid, boolean)",
  "public.set_shopify_settings(uuid, text, boolean, text)",
  // Customer self-service (Phase 1): the caller's own rows only
  "public.my_bike_attachments(uuid)",
  "public.my_bikes()",
  "public.my_customer_profile()",
  "public.update_my_profile(text, text, text, text)",
  // Customer job projection (Phase 3, shown in Phase 11): own jobs only,
  // customer-safe columns (D17)
  "public.my_work_order_attachments(uuid)",
  "public.my_work_order_lines(uuid)",
  "public.my_work_order_timeline(uuid)",
  "public.my_work_orders()",
  // Customer appointments (Phase 2, consumed by Phase 11): own rows only,
  // the D42 projection; booking and cancelling under D37
  "public.book_my_appointment(uuid, uuid, timestamp with time zone, uuid, text)",
  "public.cancel_my_appointment(uuid, text)",
  "public.my_appointments(boolean)",
  // Public site (Phase 11): link the login to its customer record or make
  // one at the first booking (D121, D122); the range of bookable starts
  // (D123), as for anon
  "public.bookable_slots(date, date, uuid)",
  "public.claim_my_customer(boolean, text, text, text)",
  // Purchasing (Phase 7): every write, the cost defaults and the receipt
  // lookup need manage_purchasing (D60 D-PO-COSTS)
  "public.cancel_purchase_order(uuid, text)",
  "public.create_purchase_order(uuid, uuid, date, text, text)",
  "public.purchase_cost_defaults(uuid, uuid[])",
  "public.purchase_receipt_by_key(uuid)",
  "public.receive_purchase(uuid, uuid, jsonb, text, timestamp with time zone, text)",
  "public.remove_purchase_order_line(uuid, text)",
  "public.remove_supplier_product(uuid, uuid)",
  "public.set_purchase_order_line(uuid, uuid, uuid, integer, money_amount, date, text, text)",
  "public.set_supplier_product(uuid, uuid, text, integer, boolean)",
  "public.submit_purchase_order(uuid)",
  "public.update_purchase_order(uuid, uuid, date, text, text)",
  // Purchasing (Phase 7) reorder (D66 D-REORDER): suggestions for active
  // staff (no costs); the one-tap draft needs manage_purchasing
  "public.create_purchase_order_from_low_stock(uuid, uuid, uuid[])",
  "public.reorder_suggestions(uuid)",
  // Period reporting (Phase 9): financial RPCs need view_financial_reports, cost-derived columns NULL without view_costs (D30); activity for active staff
  "public.report_activity(date, date)",
  "public.report_activity_by_mechanic(date, date)",
  "public.report_breakdown(date, date, report_date_basis, report_dimension, integer, text, numeric, text)",
  "public.report_line_items(date, date, report_date_basis, report_dimension, text, integer, timestamp with time zone, uuid)",
  "public.report_period_series(date, date, report_date_basis, report_grain)",
  "public.report_period_summary(date, date, report_date_basis)",
  "public.report_stock_value()",
  // Reconciliation and exceptions (Phase 9): any active staff; the threshold is admin only (D106–D108)
  "public.report_stock_reconciliation(boolean, uuid, integer)",
  "public.report_unit_reconciliation(boolean, uuid, integer)",
  "public.report_exception_counts()",
  "public.set_consignment_settlement_alert_days(integer)",
  // Indent parts and quotes (Phase 13, D140-D147): active staff propose,
  // quote, cancel and fit; ordering needs manage_purchasing; a cost or
  // supplier on a proposal needs view_costs or manage_purchasing; the quote
  // page's two functions are callable signed in too
  "public.answer_quote(text, jsonb, text)",
  "public.cancel_part_request(uuid, text)",
  // D160: voiding a fitted line (public.void_line, unchanged) puts its
  // request back to approved or ordered through an owner-only trigger;
  // nothing is added here (tests/db/meta.test.ts checks the private side)
  "public.fit_part_request(uuid, uuid, uuid)",
  // D149a: a part bought outside BICII, recorded and fitted in one step;
  // view_costs or manage_purchasing (the function checks)
  "public.fit_part_bought_outside(uuid, uuid, money_amount, uuid, text)",
  "public.indent_reservations(uuid)",
  "public.order_part_requests(uuid[], uuid, uuid, boolean, text)",
  "public.part_request_arrivals(uuid)",
  "public.propose_part(uuid, uuid, uuid, integer, money_amount, money_amount, uuid)",
  "public.propose_service(uuid, uuid, uuid, line_quantity, money_amount)",
  "public.quote_by_token(text)",
  "public.send_quote(uuid, uuid, uuid[], quote_channel, integer)",
  "public.withdraw_quote(uuid)",
  // Indent deposits (Phase 14 step 2, D151, D152, D157): the deposit
  // percent is admin only; ordering a part whose deposit is not paid needs
  // an active admin or manager and a reason (order_part_requests above)
  "public.set_indent_deposit_percent(integer)",
  // Phase 14 step 3 (D154, D156, D161): counter payments are recorded and
  // voided by an active admin only (the functions check); any active staff
  // member sends a balance link; the payment link page is callable signed
  // in too; the payment reports need view_financial_reports
  "public.record_counter_payment(uuid, uuid, uuid, money_amount, counter_payment_method, timestamp with time zone, text, text)",
  "public.void_counter_payment(uuid, counter_void_kind, text)",
  "public.balance_by_token(text)",
  "public.send_balance_link(uuid, uuid, quote_channel, integer)",
  "public.report_payment_items(date, date, integer, timestamp with time zone, uuid)",
  "public.report_payment_summary(date, date)",
  "public.report_payments_held()",
];

/**
 * Relations signed-in users may touch, with privileges. Every table here
 * also has RLS policies (meta test "RLS is enabled on every table"). The
 * Phase 1 tables' policies admit active staff only; INSERT and UPDATE are
 * column grants (no short_id, customer_id after insert, Auth or Shopify
 * links; attachments: caption only). Phase 3: the workshop tables are
 * read-only (every write is an RPC) and SELECT on services and
 * work_order_line_items is a column grant without the cost columns, which
 * only the *_staff views return (view_costs); cult_commons_rates rows are
 * visible to view_costs only; categories are written by manage_inventory.
 */
export const AUTHENTICATED_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  "public.attachment_events": ["SELECT"],
  "public.attachments": ["SELECT", "UPDATE"],
  "public.bike_ownership_events": ["SELECT"],
  "public.bikes": ["INSERT", "SELECT", "UPDATE"],
  "public.customers": ["INSERT", "SELECT", "UPDATE"],
  "public.staff": ["SELECT"],
  "public.staff_permissions": ["SELECT"],
  // Workshop (Phase 3)
  "public.categories": ["INSERT", "SELECT", "UPDATE"],
  "public.cult_commons_rates": ["SELECT"],
  "public.services": ["SELECT"],
  "public.services_staff": ["SELECT"],
  "public.work_order_assignments": ["SELECT"],
  "public.work_order_events": ["SELECT"],
  "public.work_order_line_items": ["SELECT"],
  "public.work_order_line_items_staff": ["SELECT"],
  "public.work_order_totals": ["SELECT"],
  "public.work_order_totals_staff": ["SELECT"],
  "public.work_orders": ["SELECT"],
  // Inventory (Phase 4): staff read; manage_inventory writes locations and
  // products (no cost without view_costs: the invoker cost-write guards);
  // units are created and moved only by RPCs (UPDATE is a column grant for
  // details, prices and archiving); the ledger and the histories are
  // read-only. SELECT on products, units and movements excludes the cost
  // columns, which only the cost views return (view_costs).
  "public.inventory_movement_costs": ["SELECT"],
  "public.inventory_movements": ["SELECT"],
  "public.inventory_unit_costs": ["SELECT"],
  "public.inventory_unit_events": ["SELECT"],
  "public.inventory_units": ["SELECT", "UPDATE"],
  "public.locations": ["INSERT", "SELECT", "UPDATE"],
  "public.product_costs": ["SELECT"],
  "public.product_events": ["SELECT"],
  "public.products": ["INSERT", "SELECT", "UPDATE"],
  "public.selling_prices": ["SELECT"],
  "reporting.low_stock": ["SELECT"],
  "reporting.product_stock": ["SELECT"],
  // The anonymous projection, readable by signed-in users (customers) too
  "reporting.public_items": ["SELECT"],
  "reporting.stock_levels": ["SELECT"],
  // Appointments (Phase 2): staff read (RLS is_staff); every write is an
  // RPC; customers read none of them (zero rows), only the my_* RPCs
  "public.appointment_events": ["SELECT"],
  "public.appointment_types": ["SELECT"],
  "public.appointments": ["SELECT"],
  "public.closure_overrides": ["SELECT"],
  "public.schedule_events": ["SELECT"],
  "public.shop_hours": ["SELECT"],
  "public.shop_settings": ["SELECT"],
  // Consignment (Phase 6, D48): staff read consignors and items (no payout
  // details, agreed amount or request fingerprint: column grants);
  // manage_consignments inserts and updates consignors and edits item
  // notes; charges and item history are row-gated by consignment money
  // access (manage_consignments or view_costs) and written only by RPCs
  // and triggers. reporting.consignment_item_position has no API grant.
  "public.consignment_item_charges": ["SELECT"],
  "public.consignment_item_events": ["SELECT"],
  "public.consignment_items": ["SELECT", "UPDATE"],
  "public.consignors": ["INSERT", "SELECT", "UPDATE"],
  // Sales (Phase 6, D48): staff read headers (no request fingerprint),
  // lines (no cost, yield, Cult Commons, rate or payout: column grants) and
  // refunds; every write is an RPC. Settlements, their lines and reversals
  // are row-gated by consignment money access and written only by RPCs.
  "public.consignment_settlement_reversals": ["SELECT"],
  "public.consignment_settlements": ["SELECT"],
  "public.sale_lines": ["SELECT"],
  "public.sale_refunds": ["SELECT"],
  "public.sales": ["SELECT"],
  "public.settlement_lines": ["SELECT"],
  // Labels (Phase 8, D56-D59): staff read; admins insert and update
  // templates and printer profiles through column grants (never
  // is_default, moved by set_default_*, or created_by); print jobs are
  // read-only (create_print_job and set_print_job_status write them);
  // nothing is deleted.
  "public.label_templates": ["INSERT", "SELECT", "UPDATE"],
  "public.print_jobs": ["SELECT"],
  "public.printer_profiles": ["INSERT", "SELECT", "UPDATE"],
  // Shopify (Phase 10, D86): read-only; every write is an RPC. Events, the
  // queue and the audit trail return rows to admins only (payloads hold
  // customer personal data); the settings and sync rows to active staff.
  "public.integration_audit_events": ["SELECT"],
  "public.integration_events": ["SELECT"],
  "public.integration_retry_queue": ["SELECT"],
  "public.shopify_product_sync": ["SELECT"],
  "public.shopify_settings": ["SELECT"],
  // Phase 10 step 2: every staff member reads a product's sync status
  // (security_invoker; the open-job columns follow the queue's admin RLS)
  "reporting.shopify_sync_status": ["SELECT"],
  // Purchasing (Phase 7): staff read suppliers, POs, lines, receipts and
  // progress; manage_purchasing writes suppliers (column grants) and
  // everything else through RPCs. SELECT on supplier_products,
  // purchase_order_lines and purchase_receipt_lines excludes the purchase
  // cost columns, which only the *_staff views return; PO history rows are
  // visible to view_costs or manage_purchasing (D60 D-PO-COSTS)
  "public.purchase_order_events": ["SELECT"],
  "public.purchase_order_lines": ["SELECT"],
  "public.purchase_order_lines_staff": ["SELECT"],
  "public.purchase_order_totals_staff": ["SELECT"],
  "public.purchase_orders": ["SELECT"],
  "public.purchase_receipt_lines": ["SELECT"],
  "public.purchase_receipt_lines_staff": ["SELECT"],
  "public.purchase_receipts": ["SELECT"],
  "public.supplier_products": ["SELECT"],
  "public.supplier_products_staff": ["SELECT"],
  "public.suppliers": ["INSERT", "SELECT", "UPDATE"],
  "reporting.product_on_order": ["SELECT"],
  "reporting.purchase_order_progress": ["SELECT"],
  // Indent parts and quotes (Phase 13): staff read requests (not the
  // expected cost or supplier columns), quotes (not the token hash) and
  // quote items; the purchase data only through job_part_requests_staff
  // (D60, D147); writes only through the RPCs
  "public.job_part_requests": ["SELECT"],
  "public.job_part_requests_staff": ["SELECT"],
  "public.quote_items": ["SELECT"],
  "public.quotes": ["SELECT"],
  // Stripe payments (Phase 14 step 1, D150-D159): read-only; every write
  // is a service-role RPC. Payments are readable by active staff, matched
  // refunds by active staff and unmatched ones by admins, the delivery
  // evidence by admins only (D86)
  "public.payment_refunds": ["SELECT"],
  "public.payments": ["SELECT"],
  "public.stripe_events": ["SELECT"],
  // Indent deposits (Phase 14 step 2, D151, D154, D158, D159b): security
  // invoker views over the tables above, read through their RLS
  "public.payment_issues": ["SELECT"],
  "public.quote_deposits": ["SELECT"],
  "public.work_order_payment_totals": ["SELECT"],
  // Indent parts on completed and closed jobs (R-082): the approved items
  // not on the bill yet, counted and totalled; security invoker over
  // job_part_requests' RLS and column grants, no cost
  "public.work_order_unfitted_requests": ["SELECT"],
  // Phase 14 step 3 (D156, D161): counter payments and their voids
  // (not the request fingerprint) and balance links (not the token hash),
  // readable by active staff; append-only, written only through the RPCs
  "public.balance_links": ["SELECT"],
  "public.counter_payment_voids": ["SELECT"],
  "public.counter_payments": ["SELECT"],
};

/**
 * Functions the service role may call. Staff email sign-in (PLAN D72)
 * added note_sign_in_attempt, which the sign-in action calls with the
 * service-role key before every code request and check (src/lib/admin/).
 * Phase 10 added exactly the Shopify webhook and queue RPCs, which the
 * webhook route and the cron call with the service-role key, and the
 * product sync's state and result RPCs the sync worker calls
 * (DATA-MODEL §16). Phase 14 (D150-D159, ADR-025) adds the Stripe RPCs,
 * called only from src/lib/integrations/stripe/: the webhook's
 * record_stripe_event and the server's own reads, record_stripe_read
 * (step 1), and the quote page's Checkout start, prepare_deposit_checkout
 * and record_deposit_checkout (step 2; anon gains nothing), and the
 * payment link page's Checkout start, prepare_balance_checkout and
 * record_balance_checkout (step 3, D156). Nothing in `private` (the
 * Stripe purge is owner-only).
 */
export const SERVICE_ROLE_FUNCTIONS: readonly string[] = [
  "public.note_sign_in_attempt(text[], integer)",
  "public.claim_integration_jobs(integer, uuid)",
  "public.process_shopify_event(uuid)",
  "public.process_shopify_order_paid(uuid)",
  "public.process_shopify_refund(uuid)",
  "public.product_sync_state(uuid)",
  "public.record_product_sync_result(uuid, uuid, text, text, text, text, text, integer, money_amount, text, text, text, text, boolean)",
  "public.record_shopify_webhook(text, text, text, text, text, timestamp with time zone, jsonb, jsonb, text, integer, boolean, integration_rejection_reason, text)",
  // Stripe payments (Phase 14, D150-D159)
  "public.record_stripe_event(jsonb, jsonb, text, integer, stripe_rejection_reason, text)",
  "public.record_stripe_read(uuid, jsonb, text)",
  "public.prepare_deposit_checkout(text)",
  "public.record_deposit_checkout(uuid, uuid, jsonb)",
  "public.prepare_balance_checkout(text)",
  "public.record_balance_checkout(uuid, uuid, bigint, jsonb)",
];

/**
 * Views that run with their owner's rights (security_invoker off) and are
 * still granted to an API role. Each must filter rows itself. The Phase 3
 * *_staff views read cost columns authenticated has no grant on, and return
 * rows only when private.has_permission('view_costs') (security_barrier);
 * so do Phase 4's three cost views, and public.selling_prices returns rows
 * to active staff only. reporting.public_items is the first public one: it
 * reads the staff-only tables as its owner and filters to published rows
 * and public columns itself (security_barrier).
 */
export const DEFINER_VIEWS: readonly string[] = [
  // Inventory (Phase 4): costs for view_costs only; selling prices for
  // active staff (private.selling_price, the single price source)
  "public.inventory_movement_costs",
  "public.inventory_unit_costs",
  "public.product_costs",
  "public.selling_prices",
  "public.services_staff",
  "public.work_order_line_items_staff",
  "public.work_order_totals_staff",
  // Inventory (Phase 4): the anonymous /q projection
  "reporting.public_items",
  // Purchasing (Phase 7): purchase costs for view_costs or
  // manage_purchasing only (private.can_view_purchase_costs(), D60)
  "public.purchase_order_lines_staff",
  "public.purchase_order_totals_staff",
  "public.purchase_receipt_lines_staff",
  "public.supplier_products_staff",
  // Indent parts (Phase 13): expected cost and supplier for view_costs or
  // manage_purchasing only (D60, D147)
  "public.job_part_requests_staff",
];
