/**
 * Turns database and PostgREST errors into messages that are safe to show a
 * user (ADR-001 A2; DATA-MODEL §16 error convention). Raw Postgres messages
 * can leak table, column and constraint names, so nothing from the error is
 * echoed: known cases map to fixed text, everything else is generic.
 *
 * Pure (no server imports) so it is unit-tested directly.
 */
import { formatMoney } from "./money";

/** The shape PostgREST (supabase-js PostgrestError) and node-postgres share. */
export type DbErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  /** node-postgres */
  detail?: string;
  hint?: string | null;
  /** node-postgres */
  constraint?: string;
};

export type MappedError = {
  /** Safe to show. */
  message: string;
  /** Stable category for logs and tests. */
  kind:
    | "forbidden"
    | "business"
    | "not_found"
    | "duplicate"
    | "invalid"
    | "conflict"
    | "unavailable"
    | "unknown";
  /** SQLSTATE or PostgREST code when there was one. */
  code?: string;
  /** P0001 message code or violated constraint, when known. */
  reason?: string;
};

export const GENERIC_ERROR =
  "Something went wrong. Try again, and tell an admin if it keeps happening.";
export const FORBIDDEN_ERROR = "You don't have permission to do that.";

/**
 * P0001 business-error codes raised by our RPCs (MESSAGE = code). Add the
 * code here when a migration introduces one.
 */
export const BUSINESS_ERRORS: Record<string, string> = {
  staff_email_mismatch: "That email does not match the login it belongs to.",
  reason_required: "Give a reason for this change.",
  reason_too_long: "Keep the reason under 500 characters.",
  staff_history_append_only: "Staff history cannot be changed.",
  staff_permission_immutable: "Remove the permission and grant the new one instead.",
  // Staff roles (D92): an exception the person's role already implies.
  permission_implied_by_role: "Their role already includes that.",
  // Staff roles: update_staff's expected_role no longer matches (stale page).
  staff_role_changed: "Someone changed their role in the meantime. Reload and try again.",
  // Customers and bikes (Phase 1)
  customer_archived: "That customer is archived. Unarchive them first.",
  bike_archived: "That bike is archived. Unarchive it before changing its owner or stocking it.",
  bike_short_id_immutable: "A bike keeps its ID for life.",
  bike_history_append_only: "Bike ownership history cannot be changed.",
  // Attachments (Phase 1)
  attachment_object_missing: "The photo did not finish uploading. Try again.",
  attachment_path_mismatch: "The photo was uploaded to the wrong place. Try again.",
  attachment_bucket_mismatch: "The photo was uploaded to the wrong place. Try again.",
  attachment_media_type_unsupported: "Photos must be JPEG, PNG, WebP or HEIC.",
  attachment_media_type_mismatch: "That file is not the type of photo it claims to be.",
  attachment_entity_unsupported: "Photos cannot be added to that kind of record yet.",
  attachment_conflict: "That photo clashes with another one. Upload it again.",
  attachment_deleted: "That photo was deleted. Upload it again.",
  attachment_immutable: "A photo stays on the record it was taken for.",
  attachment_customer_never_public: "Photos on a customer record cannot be made public.",
  attachment_original_never_public:
    "This photo was stored as its original file, which may carry where it was taken. Add it again as a JPEG to make it public.",
  attachment_history_append_only: "Photo history cannot be changed.",
  // Workshop (Phase 3)
  work_order_transition_invalid: "A job can't move to that status from where it is now.",
  work_order_locked: "This job is completed or closed. Reopen it to change its lines.",
  work_order_closed: "This job is collected or cancelled and can no longer change.",
  work_order_has_lines:
    "Void the job's lines before cancelling it. Voiding a part returns it to stock.",
  work_order_conflict: "That job clashes with another one. Start the check-in again.",
  work_order_immutable: "A job keeps its number, customer, bike and timestamps.",
  work_order_history_append_only: "A job's timeline cannot be changed.",
  work_order_customer_archived:
    "That customer is archived. Unarchive them before checking in a bike.",
  work_order_bike_archived: "That bike is archived. Unarchive it before checking it in.",
  requested_work_required: "Say what the customer wants done.",
  note_required: "Write the note first.",
  note_too_long: "Keep the note under 5,000 characters.",
  bike_owner_mismatch: "That bike belongs to someone else. Transfer it to this customer first.",
  staff_inactive: "Only active staff can be assigned to a job.",
  assignment_immutable: "Assignments are closed, never edited. Assign again instead.",
  line_conflict: "That line clashes with another one. Add it again.",
  line_immutable: "Lines can't be edited or deleted. Void the line and add a new one.",
  service_unavailable: "That service is inactive or archived.",
  service_conflict: "That service clashes with another one. Save it again.",
  category_kind_mismatch:
    "Choose a category of the right kind: service categories for services, product categories for products.",
  cult_commons_rate_missing: "No Cult Commons rate is set. Ask an admin to set one.",
  cult_commons_rates_append_only:
    "Cult Commons rates can't be changed. Schedule a new rate instead.",
  cult_commons_rate_in_effect: "That rate is already in effect and can't be cancelled.",
  rate_backdated: "A new rate can start now or later, never in the past.",
  rate_conflict: "That rate clashes with another one. Schedule it again.",
  note_conflict: "That note clashes with another one. Add it again.",
  attachment_work_order_never_public: "Photos on a job can't be made public.",
  // Inventory (Phase 4)
  product_inactive: "That product is inactive.",
  product_archived: "That product is archived. Unarchive it first.",
  product_not_unique: "Only a unique item has individual units.",
  product_not_quantity: "Only stock counted by quantity can be split into a unique item.",
  product_unit_tracked: "This item is counted unit by unit. Change its units instead.",
  product_tracking_type_immutable:
    "A product stays counted or unique. Create a new product instead.",
  product_short_id_immutable: "A product keeps its ID for life.",
  product_slug_immutable: "A published product keeps its public address.",
  product_published: "Unpublish the product before archiving it.",
  product_has_stock: "The product still has stock. Adjust it to zero or write off its units first.",
  unit_required: "Choose which unit to use.",
  unit_product_mismatch: "That unit belongs to another product.",
  unit_not_available: "That unit is not available.",
  unit_status_transition_invalid: "A unit can't move to that status from where it is now.",
  unit_in_stock: "Only a sold, written-off or returned unit can be archived.",
  unit_location_mismatch: "That unit is somewhere else. Refresh and try again.",
  unit_ledger_inconsistent:
    "That unit's stock record doesn't add up. Tell an admin before changing it.",
  unit_conflict: "That unit clashes with another one. Save it again.",
  unit_short_id_immutable: "A unit keeps its ID for life.",
  location_inactive: "That location is inactive. Choose another or reactivate it.",
  location_has_stock: "That location still holds stock. Move or adjust it to zero first.",
  location_required: "There is no active stock location. Add one in Settings → Locations.",
  transfer_same_location: "Choose two different locations.",
  insufficient_stock: "There isn't that much stock at that location.",
  quantity_invalid: "Enter a quantity that's allowed here.",
  movement_type_not_manual: "Only a stock adjustment or damaged stock can be recorded by hand.",
  movement_append_only: "The stock record can't be changed. Record a correction instead.",
  movement_invalid: "That stock change is not consistent. Refresh and try again.",
  request_conflict: "That stock change clashes with another one. Start again.",
  part_price_missing: "This part has no sale price. Enter a price or ask someone to set one.",
  part_cost_missing:
    "This part has no cost yet, so its yield cannot be worked out. Ask someone with cost access to set it.",
  ownership_not_saleable:
    "This item belongs to a customer, or is not shop stock that can be split, so it can't be used here.",
  currency_mismatch: "That item is priced in another currency than the job or sale.",
  publication_transition_invalid:
    "The item can't move to that publication status from where it is now.",
  publication_requires_photo: "Add a public photo before publishing.",
  publication_requires_price: "Set a selling price before publishing.",
  publication_requires_available_unit: "There is no available unit to publish.",
  publication_sold_by_sale:
    "A sold item changes status only through a sale or its reversal. By hand it can only be archived.",
  publication_initial_invalid: "A new product starts as a draft or internal only.",
  bike_has_owner: "That bike belongs to a customer. Only a shop bike can be stock.",
  bike_already_linked: "That bike is already in stock as another unit.",
  bike_in_stock: "This bike is in stock as a unit; sell or write off the unit first.",
  bike_with_customer:
    "That bike now belongs to a customer. Transfer it back to the shop before putting its unit back in stock.",
  product_events_append_only: "Product history can't be changed.",
  inventory_unit_events_append_only: "Unit history can't be changed.",
  attachment_stock_never_customer: "Stock photos have no customer; choose Internal or Public.",
  // Consignment (Phase 6: D4, D44-D52)
  consignment_item_conflict:
    "That consignment clashes with another intake. Start the intake again.",
  consignor_archived: "That consignor is archived. Unarchive them first.",
  consignor_has_open_items:
    "This consignor still has items with the shop. Sell or return them before archiving.",
  consignment_product_required: "Choose a consignment product or name a new one.",
  product_not_consignment: "Consigned stock goes on a consignment product, never on shop stock.",
  consignment_tracking_mismatch: "That product is tracked differently (unique or by quantity).",
  consignment_unique_quantity_one: "A unique item is taken in one at a time.",
  consignment_quantity_invalid: "Take in between 1 and 9,999.",
  consignment_received_in_future: "The intake date can't be in the future.",
  consignment_item_not_active: "That consigned item is no longer with the shop.",
  consignment_return_quantity_invalid: "Return at least one, and no more than the shop still has.",
  consignment_return_conflict: "That return clashes with another stock change. Start again.",
  consignment_quantity_unavailable:
    "No single consignor has that many of this item at that location. Use fewer, or one consignor's stock at a time.",
  consignor_conflict:
    "That consignor was already saved with other details. Close the form and start again.",
  consignment_quantity_negative: GENERIC_ERROR,
  consignment_unit_write_off_blocked:
    "A consigned unit isn't the shop's to write off. Return it to the consignor or sell it.",
  consignment_stock_adjust_blocked:
    "Consigned stock can't be adjusted, damaged, split or received by hand. Return it to the consignor or sell it.",
  consignment_bike_requires_unique: "Only a unique item can be a bike.",
  consignment_item_immutable:
    "A consignment keeps its consignor, product, unit, quantity and intake date.",
  consignment_item_short_id_immutable: "A consignment item keeps its ID for life.",
  consignment_history_append_only: "Consignment history can't be changed.",
  consignment_charges_immutable: "A charge can't be edited or deleted, only voided with a reason.",
  consignment_charge_conflict: "That charge clashes with another one. Add it again.",
  charge_bearer_required: "Choose who bears the charge: the consignor or the shop.",
  shop_charge_unique_only: "A shop-borne charge goes on a unique item only.",
  shop_charge_unit_not_available:
    "That unit's cost is already fixed on a job or a sale. Change shop charges only while it is available.",
  product_ownership_immutable:
    "A product with stock history keeps its owner. Consigned stock lives on its own products.",
  line_consignment_mismatch:
    "That consigned part doesn't match its consignment. Refresh and try again.",
  attachment_consignment_internal_only:
    "Photos on a consignment item stay internal. Put listing photos on the product or unit.",
  // Sales, restocks and refunds (Phase 6)
  sale_conflict: "That sale clashes with another one already recorded. Start the sale again.",
  sale_line_invalid: "One of the items on the sale isn't valid. Remove it and add it again.",
  sale_lines_required: "Add at least one item to the sale.",
  sale_too_many_lines: "A sale holds at most 50 lines. Record the rest as another sale.",
  sale_duplicate_unit: "The same item is on the sale twice.",
  sale_recognized_in_future: "A sale can't be dated in the future.",
  sale_before_stock:
    "A sale can't be dated before the item came into the shop. Check the date and time it was sold.",
  sale_price_required: "This item has no selling price. Enter one.",
  sale_cost_missing:
    "This item has no cost yet, so the sale's yield can't be worked out. Ask someone with cost access to enter it.",
  sale_quantity_invalid: "Sell between 1 and 999.",
  sale_product_is_unique: "That product is sold item by item. Choose the item.",
  unit_already_sold: "That item has already been sold.",
  unit_not_sold: "That item isn't sold, so it can't be restocked.",
  restock_line_mismatch: "That sale line is for another item, or the item was sold elsewhere.",
  sale_immutable: "A recorded sale can't be changed or deleted. Record a refund instead.",
  sale_number_immutable: "A sale keeps its number for life.",
  sale_lines_immutable: "A sale line can't be changed or deleted.",
  sale_refund_immutable: "A refund can't be changed or deleted.",
  sale_refund_conflict: "That refund clashes with another one already recorded. Start again.",
  sale_voided: "That sale was voided.",
  refund_exceeds_sale: "That's more than is left to refund on this sale.",
  // Settlements (Phase 6, D47)
  consignor_has_balance:
    "This consignor's balance isn't zero. Pay what is owed first. An overpayment clears with a later sale, by voiding a consignor-paid charge or by reversing a payment.",
  settlement_conflict: "That settlement clashes with another one already recorded. Start again.",
  settlement_paid_in_future: "A settlement can't be dated in the future.",
  settlement_allocations_required:
    "Allocate the payment to the consignor's items, each with an amount above zero.",
  settlement_duplicate_item: "Each item takes one allocation per settlement.",
  settlement_item_wrong_consignor: "Every allocated item must be this consignor's.",
  settlement_allocation_mismatch: "The allocations must add up to the amount paid.",
  settlement_exceeds_outstanding:
    "That's more than is outstanding on the item. Give an override reason to pay more.",
  settlement_immutable:
    "A settlement can't be changed or deleted. Reverse it with a reason instead.",
  settlement_reversal_conflict: "That reversal clashes with another one. Start again.",
  settlement_already_reversed: "That settlement has already been reversed.",
  // Labels (Phase 8: D9, D56-D59)
  label_entity_archived: "That record is archived. Unarchive it before printing labels.",
  label_unique_product_needs_unit:
    "Unique items get one label per unit. Open the unit and print its label.",
  label_quantity_out_of_range:
    "Print 1 to 500 labels per job for a product, or up to 10 for a unit or bike. Start another job for more.",
  label_template_missing:
    "There is no label template for this kind of record. Ask an admin to set one up.",
  label_template_inactive: "That label template is switched off. Choose another.",
  label_template_kind_mismatch: "That template is for a different kind of label.",
  label_template_kind_immutable: "A template keeps its label kind. Create a new template instead.",
  label_template_default_required:
    "Make another template the default before switching this one off.",
  label_layout_invalid: "That layout does not fit the label. Check the sizes and fields.",
  printer_profile_inactive: "That printer is switched off. Choose another.",
  printer_profile_adapter_immutable: "A printer keeps its type. Add a new printer instead.",
  printer_profile_default_required:
    "Make another printer the default before switching this one off.",
  printer_config_invalid: "Those printer settings are not valid.",
  print_job_conflict: "This print was already started with different settings.",
  print_job_reprint_mismatch: "A reprint must be for the same record.",
  print_job_transition_invalid:
    "That print job has already been marked. Refresh to see its status.",
  print_job_error_required: "Say what went wrong with the print.",
  print_job_immutable: "A print job's record cannot be changed.",
  public_site_url_invalid:
    "Labels are off until an admin sets a valid public website address in Labels and printers settings.",
  // Reporting (Phase 5; Phase 9 reuses it)
  report_range_invalid: "Pick a start day on or before the end day, within the allowed range.",
  // Public site (Phase 11, D121–D123). The public site shows its own
  // wording; these are for staff reading a log or the same refusal here.
  customer_email_unconfirmed: "Confirm the email address with a code first.",
  customer_link_ambiguous:
    "More than one customer has this email address. Archive the duplicate or correct an email.",
  customer_name_required: "Enter a first name.",
  customer_name_too_long: "Keep first and last names under 100 characters each.",
  customer_phone_too_long: "Keep the phone number under 40 characters.",
  slot_range_invalid: "Pick a start day on or before the end day.",
  slot_range_too_long: "Ask for at most 31 days of times at once.",
  // Period reports (Phase 9, D100)
  report_range_too_long: "Reports cover at most two years. Choose a shorter range.",
  report_key_invalid: "That report row no longer exists. Go back and pick it again.",
  // Reconciliation and exceptions (Phase 9, D107)
  alert_days_out_of_range: "Choose between 1 and 365 days.",
  // Appointments and schedule (Phase 2)
  appointment_slot_misaligned: "Pick one of the listed times.",
  appointment_outside_hours: "The shop is not open for the whole of that time.",
  appointment_closed: "The shop is closed then.",
  appointment_capacity_exceeded: "That time has just filled up. Pick another time.",
  appointment_in_past: "That appointment would already be over. Pick a later time.",
  appointment_too_soon: "That is too soon to book online. Pick a later time.",
  appointment_too_far_ahead: "That is too far ahead to book online.",
  appointment_customer_limit:
    "You already have the most upcoming online bookings allowed. Cancel one or contact the shop.",
  appointment_type_unavailable: "That appointment type is not available.",
  appointment_conflict: "That booking clashes with another one. Start again.",
  appointment_bike_not_owned:
    "That bike belongs to someone else. Transfer it first or pick another bike.",
  appointment_bike_archived: "That bike is archived. Unarchive it or pick another bike.",
  appointment_immutable: "That part of the appointment can no longer be changed.",
  appointment_transition_invalid: "That appointment cannot move to that status.",
  appointment_use_check_in: "Use Check in to check this appointment in.",
  appointment_use_cancel: "Use Cancel appointment, with a reason.",
  appointment_not_started: "Mark a no-show only after the appointment has started.",
  appointment_not_cancellable:
    "This appointment can no longer be cancelled online. Please contact the shop.",
  appointment_history_append_only: "Appointment history cannot be changed.",
  appointment_not_checked_in: "Check the appointment in before linking a job.",
  appointment_work_order_mismatch:
    "That job is not an open job for this customer and bike, or it already has an appointment.",
  schedule_history_append_only: "Schedule history cannot be changed.",
  shop_hours_overlap: "Those opening hours overlap.",
  closure_invalid_range: "Check the closure's days and times.",
  closure_custom_hours_overlap: "Another short day already covers those days.",
  closure_conflict: "Someone changed this closure in the meantime. Reload and try again.",
  appointment_type_conflict: "Someone changed this type in the meantime. Reload and try again.",
  shop_capacity_below_type:
    "An active appointment type needs more capacity than that. Change the type first.",
  appointment_type_capacity_too_large:
    "That is more than the shop takes in one slot. Raise the shop's capacity first, or use fewer units.",
  shop_timezone_invalid: "That is not a time zone the database knows.",
  shop_settings_required: "The shop settings cannot be deleted, only changed.",
  // Shopify (Phase 10, D84-D88). The codes stored on an integration event
  // (shopify_variant_unmapped, ...) carry their own human message and are
  // never returned as an error, so they are not listed here.
  shopify_ids_conflict: "This product is already linked to a different Shopify product.",
  shopify_customer_already_linked:
    "That customer is already linked to a different Shopify customer.",
  shopify_gid_invalid: "That is not a valid Shopify ID.",
  shopify_settings_missing:
    "Shopify settings are missing. Ask an admin to set the online location.",
  integration_job_closed: "That item was already resolved.",
  integration_job_running: "That item is being retried right now. Try again in a moment.",
  integration_event_immutable: "Received webhooks cannot be changed.",
  integration_history_append_only: "Integration history cannot be changed.",
  // Publishing online (Phase 10 step 2, D84, D86)
  shopify_requires_public: "Make the product public before publishing it online.",
  shopify_not_saleable: "Customer-owned items cannot be sold online.",
  shopify_product_archived: "Unarchive the product before publishing it online.",
  shopify_price_missing: "Set a sale price before publishing it online.",
  shopify_not_published: "Publish the product online first.",
  // Purchasing (Phase 7)
  supplier_archived: "That supplier is archived. Unarchive it first.",
  supplier_has_open_orders: "This supplier still has open orders. Receive or cancel them first.",
  purchase_order_conflict: "That order clashes with another one. Start the order again.",
  purchase_order_number_immutable: "An order keeps its number for life.",
  purchase_order_supplier_locked: "The supplier can only change while the order is a draft.",
  purchase_order_closed:
    "This order is closed: it has been fully received or cancelled. Extra units go on a new order.",
  purchase_order_not_submitted: "Submit the order before receiving against it.",
  purchase_order_needs_lines: "An order needs at least one line. Add one, or cancel the order.",
  purchase_line_conflict: "That line clashes with another one. Refresh the order and try again.",
  purchase_line_below_received:
    "More than that has already been received. The ordered quantity can't go below it.",
  purchase_line_unique_product:
    "Unique items are registered one by one in Stock, not ordered on a purchase order.",
  purchase_line_not_shop_owned: "Only shop-owned products can be ordered from a supplier.",
  purchase_line_product_inactive: "That product is inactive or archived. Reactivate it first.",
  purchase_line_duplicate_product:
    "That product is already on this order. Change its line instead.",
  purchase_line_has_receipts:
    "Part of this line has been received, so it can't be removed. Lower its quantity instead.",
  purchase_currency_mismatch: "That product is priced in another currency than this order.",
  purchase_receipt_key_reused:
    "This submission was already recorded. Check the order before receiving again.",
  purchase_receipt_empty: "Enter at least one received line.",
  purchase_receipt_quantity_invalid: "Enter a whole number of units received, at least 1.",
  purchase_receipt_cost_invalid: `Enter a unit cost between ${formatMoney("0")} and ${formatMoney("99999.99")}.`,
  purchase_receipt_line_foreign: "That line is not on this order. Refresh the order and try again.",
  purchase_receipt_line_duplicate:
    "The same order line appears twice for one location. Combine them into one.",
  purchase_over_receipt:
    "That is more than is still to come on this order. Check the counts, or raise the ordered quantity first.",
  purchase_receipt_in_future: "The delivery date can't be in the future.",
  purchase_receipt_too_old: "A delivery can be back-dated by at most 30 days.",
  purchase_receipt_before_submission: "The delivery date is before the order was submitted.",
  purchase_receipt_immutable:
    "A recorded delivery can't be changed. Correct the stock with an adjustment.",
  purchase_order_history_append_only: "Purchase order history can't be changed.",
  reorder_nothing_selected: "Choose at least one product to order.",
  // Indent parts and quotes (Phase 13, D140-D147)
  part_request_conflict: "That item was already added as something else. Reload and try again.",
  indent_product_invalid: "Only shop-owned products counted by quantity can be ordered for a job.",
  price_invalid: "A price cannot be negative.",
  cost_invalid: "A cost cannot be negative.",
  supplier_unavailable: "That supplier no longer exists or is archived. Choose another.",
  part_request_quoted: "It is on the quote the customer has. Withdraw the quote first.",
  part_request_fitted: "It is already on the job. Void the line instead.",
  quote_already_sent: "This quote was already sent. Send a new one to get a new link.",
  quote_validity_invalid: "A quote is valid for 1 to 30 days.",
  quote_items_invalid: "Choose 1 to 50 different items for the quote.",
  part_request_not_proposed:
    "Only items proposed on this job and not on another quote can be sent.",
  quote_answered: "The customer has already answered this quote.",
  quote_not_found: "This link is not valid. Ask the shop for a new one.",
  quote_not_open: "This quote has already been answered or replaced.",
  quote_expired: "This quote has expired. Ask the shop for a new one.",
  quote_name_required: "Type your name (up to 100 characters).",
  quote_answer_incomplete: "Answer every item before sending.",
  order_items_invalid: "Choose 1 to 50 different parts to order.",
  part_request_not_approved: "Only approved items can be ordered or put on the job.",
  // Stripe payments (Phase 14 step 1, D153, D155, D159): the guards. Only
  // Stripe's verified word moves a payment, a refund or an event.
  payment_immutable: "A customer payment changes only when Stripe confirms it.",
  payment_refund_immutable: "A refund changes only when Stripe reports it.",
  stripe_event_immutable: "A received Stripe event is kept as evidence and can't be changed.",
};

/** 23505 unique violations by constraint name. */
export const UNIQUE_ERRORS: Record<string, string> = {
  staff_email_key: "A staff member with that email already exists.",
  staff_auth_user_id_key: "That login is already linked to a staff member.",
  staff_permissions_pkey: "That permission is already granted.",
  customers_pkey: "That customer has already been saved.",
  customers_auth_user_id_key: "That login is already linked to a customer.",
  customers_shopify_customer_id_key: "That Shopify customer is already linked to someone else.",
  bikes_pkey: "That bike has already been saved.",
  attachments_pkey: "That photo has already been saved.",
  attachments_storage_path_key: "That photo has already been saved.",
  // Workshop (Phase 3)
  work_orders_pkey: "That job has already been saved.",
  work_orders_job_number_key: "That job number is already taken. Try again.",
  work_order_line_items_pkey: "That line has already been saved.",
  services_pkey: "That service has already been saved.",
  services_active_name_key: "A service with that name already exists.",
  categories_pkey: "That category has already been saved.",
  categories_active_name_key: "A category with that name already exists.",
  cult_commons_rates_effective_from_key: "Another rate already starts at that time.",
  work_order_assignments_active_staff_key:
    "Someone else changed the assignments at the same time. Try again.",
  work_order_assignments_one_lead_key:
    "Someone else changed the assignments at the same time. Try again.",
  work_order_events_note_id_key: "That note has already been added.",
  // Inventory (Phase 4)
  products_pkey: "That product has already been saved.",
  products_short_id_key: "That product ID is already taken. Try again.",
  products_sku_key_unique: "Another product already uses that SKU.",
  products_public_slug_key: "Another product already uses that public address.",
  products_shopify_variant_id_key:
    "That Shopify variant is already linked to another BICII product.",
  inventory_units_pkey: "That unit has already been saved.",
  inventory_units_short_id_key: "That unit ID is already taken. Try again.",
  inventory_units_bike_id_key: "That bike is already in stock as another unit.",
  inventory_units_sold_sale_line_id_key: "That sale is already recorded against another unit.",
  bikes_inventory_unit_id_key: "That unit is already linked to another bike.",
  locations_pkey: "That location has already been saved.",
  locations_name_key: "A location with that name already exists.",
  work_order_line_items_unit_once: "That unit is already on a job.",
  inventory_movements_request_once: "That stock change has already been recorded.",
  inventory_movements_job_consumption_once: "That part has already taken its stock.",
  inventory_movements_sale_line_once: "That sale has already taken its stock.",
  inventory_movements_receipt_line_once: "That delivery has already been received.",
  inventory_movements_reversal_of_id_key: "That stock change has already been reversed.",
  // Consignment (Phase 6)
  consignors_pkey: "That consignor has already been saved.",
  consignors_customer_id_key: "That customer is already a consignor.",
  consignment_items_pkey: "That consignment has already been taken in.",
  consignment_items_short_id_key: "That consignment ID is already taken. Try again.",
  consignment_items_inventory_unit_id_key: "That unit already belongs to another consignment.",
  consignment_item_charges_pkey: "That charge has already been added.",
  sales_pkey: "That sale has already been recorded.",
  sales_sale_number_key: "That sale number is already taken. Try again.",
  sales_shopify_order_id_key: "That Shopify order is already recorded.",
  sale_lines_pkey: "That sale line has already been recorded.",
  sale_lines_sale_line_number_key: "That sale line has already been recorded.",
  sale_lines_shopify_line_part_key: "That Shopify line is already recorded.",
  sale_lines_unit_sells_once: "That item has already been sold.",
  sale_refunds_pkey: "That refund has already been recorded.",
  sale_refunds_shopify_refund_id_key: "That Shopify refund is already recorded.",
  inventory_movements_restock_once: "That item has already been restocked.",
  consignment_settlements_pkey: "That settlement has already been recorded.",
  settlement_lines_pkey: "That allocation has already been recorded.",
  settlement_lines_settlement_item_key: "Each item takes one allocation per settlement.",
  consignment_settlement_reversals_pkey: "That reversal has already been recorded.",
  consignment_settlement_reversals_settlement_id_key: "That settlement has already been reversed.",
  // Labels (Phase 8)
  label_templates_pkey: "That label template has already been saved.",
  label_templates_name_key: "A label template with that name already exists.",
  label_templates_one_default_per_kind:
    "Someone else changed the default template at the same time. Try again.",
  printer_profiles_pkey: "That printer has already been saved.",
  printer_profiles_name_key: "A printer with that name already exists.",
  printer_profiles_one_default:
    "Someone else changed the default printer at the same time. Try again.",
  print_jobs_pkey: "That print job was already started.",
  // Appointments and schedule (Phase 2)
  appointments_pkey: "That appointment has already been booked.",
  work_orders_appointment_id_key: "That appointment already has a job.",
  appointment_types_name_key: "An appointment type with that name already exists.",
  appointment_types_pkey: "That appointment type has already been saved.",
  closure_overrides_pkey: "That closure has already been saved.",
  shop_hours_weekday_opens_at_key: "Two opening intervals of that day start at the same time.",
  // Shopify (Phase 10)
  shopify_settings_pkey: "There is only one Shopify settings row.",
  shopify_product_sync_pkey: "That product already has its Shopify sync record.",
  shopify_product_sync_shopify_inventory_item_id_key:
    "That Shopify inventory item is already linked to another product.",
  integration_events_pkey: "That webhook has already been recorded.",
  integration_events_external_id_key: "That webhook has already been recorded.",
  integration_events_rejected_body_key: "That rejected delivery has already been recorded.",
  integration_retry_queue_pkey: "That item is already in the queue.",
  integration_retry_queue_event_open_key: "That Shopify event is already in the queue.",
  integration_retry_queue_product_queued_key: "That product is already waiting to sync.",
  integration_retry_queue_product_running_key:
    "That product is syncing right now. Try again in a moment.",
  integration_audit_events_pkey: "That integration history entry has already been recorded.",
  // Purchasing (Phase 7)
  suppliers_pkey: "That supplier has already been saved.",
  suppliers_name_active_key: "A supplier with that name already exists.",
  supplier_products_pkey: "That supplier is already linked to this product.",
  supplier_products_one_preferred:
    "Someone else changed the preferred supplier at the same time. Try again.",
  purchase_orders_pkey: "That order has already been saved.",
  purchase_orders_po_number_key: "That order number is already taken. Try again.",
  purchase_order_lines_pkey: "That line has already been saved.",
  purchase_order_lines_product_once:
    "That product is already on this order. Change its line instead.",
  purchase_receipts_pkey: "That delivery has already been recorded.",
  purchase_receipts_idempotency_key_key:
    "This submission was already recorded. Check the order before receiving again.",
  purchase_receipt_lines_pkey: "That delivery line has already been recorded.",
  purchase_receipt_lines_purchase_receipt_id_line_number_key:
    "That delivery line has already been recorded.",
  // Indent parts and quotes (Phase 13)
  job_part_requests_line_key: "That item is already on the job.",
  quotes_one_open_per_job: "This job already has an open quote. Withdraw it or send again.",
  // Stripe payments (Phase 14)
  stripe_events_pkey: "That Stripe event has already been recorded.",
  stripe_events_event_id_key: "That Stripe event has already been recorded.",
  stripe_events_rejected_body_key: "That rejected delivery has already been recorded.",
  payments_pkey: "That payment has already been started.",
  payments_checkout_session_key: "That Checkout session is already recorded.",
  payments_one_open_deposit: "A payment for this deposit is already open.",
  payment_refunds_pkey: "That refund has already been recorded.",
  payment_refunds_refund_key: "That refund has already been recorded.",
};

/** 23514 check violations by constraint name. */
export const CHECK_ERRORS: Record<string, string> = {
  staff_display_name_check: "Enter a name.",
  staff_events_reason_check: "Keep the reason under 500 characters.",
  customers_identifies_someone: "Enter a name, an email or a phone number.",
  customers_email_check: "Enter a valid email address.",
  customers_first_name_check: "Keep the first name under 100 characters.",
  customers_last_name_check: "Keep the last name under 100 characters.",
  customers_display_name_check: "Keep the name under 200 characters.",
  customers_phone_check: "Keep the phone number under 40 characters.",
  customers_internal_notes_check: "Keep the notes under 10,000 characters.",
  bikes_brand_check: "Keep the brand under 100 characters.",
  bikes_model_check: "Keep the model under 100 characters.",
  bikes_variant_check: "Keep the variant under 100 characters.",
  bikes_frame_size_check: "Keep the frame size under 40 characters.",
  bikes_colour_check: "Keep the colour under 60 characters.",
  bikes_serial_number_check: "Keep the serial number under 100 characters.",
  bikes_description_check: "Keep the description under 2,000 characters.",
  bikes_internal_notes_check: "Keep the notes under 10,000 characters.",
  attachments_caption_check: "Keep the caption under 500 characters.",
  attachments_byte_size_check: "Photos must be under 20 MB.",
  attachments_customer_never_public: "Photos on a customer record cannot be made public.",
  attachments_work_order_never_public: "Photos on a job can't be made public.",
  // Shape checks the RPCs and triggers keep true; reaching one means a
  // writer outside them (an owner backfill, a new path) got something wrong.
  staff_events_permission_matches_type: "That staff history entry is not consistent.",
  bikes_short_id_format: "A bike ID looks like B-000123.",
  bike_ownership_events_registered_shape: "That ownership entry is not consistent.",
  bike_ownership_events_transfer_changes_owner: "A transfer must go to a different owner.",
  bike_ownership_events_transfer_has_reason: "Give a reason for the transfer.",
  bike_ownership_events_reason_check: "Keep the reason under 500 characters.",
  attachments_bucket_matches_visibility:
    "The photo was stored in the wrong place. Upload it again.",
  attachments_media_type_check: "Photos must be JPEG, PNG, WebP or HEIC.",
  attachments_path_shape: "The photo was uploaded to the wrong place. Try again.",
  attachments_extension_matches_media_type: "That file is not the type of photo it claims to be.",
  attachment_events_deleted_has_reason: "Give a reason for deleting the photo.",
  attachment_events_reason_check: "Keep the reason under 500 characters.",
  // Workshop (Phase 3)
  categories_name_check: "Enter a category name under 80 characters.",
  services_name_check: "Enter a service name under 120 characters.",
  services_description_check: "Keep the description under 2,000 characters.",
  services_default_sale_price_check: "Prices can't be negative.",
  services_default_direct_cost_check: "Costs can't be negative.",
  services_currency_check: "Use a three-letter currency code.",
  cult_commons_rates_rate_check: "The rate must be between 0% and 100%.",
  cult_commons_rates_cancelled_shape: "A cancelled rate needs the time it was cancelled.",
  work_orders_job_number_format: "A job number looks like J-000123.",
  work_orders_currency_check: "Use a three-letter currency code.",
  work_orders_collected_stamp: "The job's dates don't match its status. Refresh and try again.",
  work_orders_cancelled_stamp: "The job's dates don't match its status. Refresh and try again.",
  work_orders_completed_stamp: "The job's dates don't match its status. Refresh and try again.",
  work_orders_ready_stamp: "The job's dates don't match its status. Refresh and try again.",
  work_orders_ready_after_completed: "A job is ready for collection only after it is completed.",
  work_orders_completed_after_started: "A job is completed only after work has started.",
  work_orders_started_after_check_in: "Work can't start before the bike was checked in.",
  work_orders_completed_after_check_in: "A job can't be completed before the bike was checked in.",
  work_orders_collected_after_completed: "A job is collected only after it is completed.",
  work_orders_status_changed_after_check_in:
    "A job's status can't change before the bike was checked in.",
  work_order_assignments_unassigned_after_assigned:
    "Someone can't leave a job before they were assigned to it.",
  work_order_events_payload_object: "That timeline entry is not consistent.",
  work_orders_requested_work_check: "Say what the customer wants done, in under 2,000 characters.",
  work_orders_intake_notes_check: "Keep the condition notes under 5,000 characters.",
  work_orders_internal_notes_check: "Keep the internal notes under 10,000 characters.",
  work_orders_completion_notes_check: "Keep the completion notes under 5,000 characters.",
  work_orders_approval_note_check: "Keep the approval note under 500 characters.",
  work_orders_cancellation_reason_check: "Keep the reason under 500 characters.",
  work_order_line_items_description_check: "Enter a description under 300 characters.",
  work_order_line_items_quantity_check: "Quantity must be more than 0 and at most 9,999.",
  work_order_line_items_unit_sale_price_check: "Prices can't be negative.",
  work_order_line_items_unit_direct_cost_check: "Costs can't be negative.",
  work_order_line_items_void_reason_check: "Keep the reason under 500 characters.",
  work_order_line_items_inventory_source: "Parts are counted in whole units.",
  work_order_line_items_unit_quantity: "A unique item is added one at a time.",
  work_order_line_items_rate_check: "The rate must be between 0% and 100%.",
  work_order_line_items_currency_check: "Use a three-letter currency code.",
  work_order_line_items_void_shape: "A voided line needs a reason.",
  work_order_line_items_service_source: "A service line needs its service.",
  work_order_line_items_manual_source: "A manual line can't point at a service or a part.",
  work_order_line_items_cost_pending_shape:
    "Only a manual line without a cost can be cost pending.",
  money_amount_not_nan: "Enter an amount.",
  rate_fraction_not_nan: "Enter a rate.",
  line_quantity_not_nan: "Enter a quantity.",
  // Inventory (Phase 4)
  locations_name_check: "Enter a location name under 80 characters.",
  products_short_id_format: "A product ID looks like P-000123.",
  products_sku_check: "Keep the SKU under 64 characters.",
  products_name_check: "Enter a product name under 200 characters.",
  products_description_check: "Keep the description under 5,000 characters.",
  products_brand_check: "Keep the brand under 100 characters.",
  products_public_slug_format: "That public address is not valid.",
  products_default_sale_price_check: "Prices can't be negative.",
  products_default_direct_cost_check: "Costs can't be negative.",
  products_currency_check: "Use a three-letter currency code.",
  products_reorder_point_check: "The reorder point can't be negative.",
  inventory_units_short_id_format: "A unit ID looks like U-000123.",
  inventory_units_serial_number_check: "Keep the serial number under 100 characters.",
  inventory_units_condition_check: "Keep the condition under 500 characters.",
  inventory_units_internal_notes_check: "Keep the notes under 10,000 characters.",
  inventory_units_sale_price_check: "Prices can't be negative.",
  inventory_units_direct_cost_check: "Costs can't be negative.",
  inventory_units_consignment_shape: "A consigned unit needs its consignment record.",
  inventory_units_sold_shape:
    "The unit's sale date doesn't match its status. Refresh and try again.",
  inventory_movements_quantity_delta_check: "Enter a quantity other than zero, up to 100,000.",
  inventory_movements_unit_delta: "A unique item moves one at a time.",
  inventory_movements_reason_required: "Give a reason for this stock change.",
  inventory_movements_reason_check: "Keep the reason under 500 characters.",
  inventory_movements_reversal_shape: "That stock correction is not consistent.",
  inventory_movements_job_consumption_shape: "A part taken by a job needs its job and line.",
  inventory_movements_damaged_negative: "Damaged stock is removed: use a negative quantity.",
  inventory_movements_transfer_request: "A transfer needs its request.",
  inventory_movements_unit_cost_snapshot_check: "Costs can't be negative.",
  inventory_movements_currency_check: "Use a three-letter currency code.",
  product_events_payload_object: "That product history entry is not consistent.",
  inventory_unit_events_payload_object: "That unit history entry is not consistent.",
  attachments_stock_never_customer: "Stock photos have no customer; choose Internal or Public.",
  // Consignment (Phase 6)
  consignors_display_name_check: "Enter the consignor's name, under 200 characters.",
  consignors_email_check: "Enter a valid email address.",
  consignors_phone_check: "Keep the phone number under 40 characters.",
  consignors_payout_details_check: "Keep the payout details under 2,000 characters.",
  consignors_internal_notes_check: "Keep the notes under 10,000 characters.",
  consignment_items_short_id_format: "A consignment ID looks like C-000123.",
  consignment_items_quantity_check: "Take in between 1 and 9,999.",
  consignment_items_agreed_amount_owed_check: "The amount owed can't be negative.",
  consignment_items_asking_price_check: "Prices can't be negative.",
  consignment_items_currency_check: "Use a three-letter currency code.",
  consignment_items_return_reason_check: "Keep the reason under 500 characters.",
  consignment_items_agreement_notes_check: "Keep the agreement notes under 2,000 characters.",
  consignment_items_internal_notes_check: "Keep the notes under 10,000 characters.",
  consignment_items_unit_quantity_one: "A unique item is taken in one at a time.",
  consignment_items_returned_has_date: "A returned item needs its return date.",
  consignment_items_sold_has_date:
    "The consignment's sale date doesn't match its status. Refresh and try again.",
  consignment_item_charges_description_check: "Describe the charge in under 200 characters.",
  consignment_item_charges_amount_check: "A charge must be more than 0.",
  consignment_item_charges_currency_check: "Use a three-letter currency code.",
  consignment_item_charges_void_reason_check: "Keep the reason under 500 characters.",
  consignment_charges_void_has_reason: "A voided charge needs a reason.",
  consignment_item_events_payload_object: "That consignment history entry is not consistent.",
  consignment_item_events_reason_check: "Keep the reason under 500 characters.",
  sales_sale_number_format: "A sale number looks like S-000123.",
  sales_currency_check: "Use a three-letter currency code.",
  sales_notes_check: "Keep the notes under 2,000 characters.",
  sales_shopify_order_id_check: "That Shopify order reference is too long.",
  sales_shopify_order_name_check: "That Shopify order name is too long.",
  sale_lines_line_number_check: "That sale line is out of order. Start the sale again.",
  sale_lines_description_check: "Describe the line in under 300 characters.",
  sale_lines_quantity_check: "Sell a whole number of at least 1.",
  sale_lines_unit_sale_price_check: "Prices can't be negative.",
  sale_lines_unit_direct_cost_check: "Costs can't be negative.",
  sale_lines_consignor_payout_check: "The amount owed can't be negative.",
  sale_lines_rate_check: "The Cult Commons rate must be between 0% and 100%.",
  sale_lines_currency_check: "Use a three-letter currency code.",
  sale_lines_shopify_line_item_id_check: "That Shopify line reference is too long.",
  sale_lines_unit_quantity_one: "A unique item is sold one at a time.",
  sale_lines_consignment_payout: "A consigned line needs what the consignor is owed.",
  sale_lines_restock_unit_only: "Only a unique item is restocked.",
  sale_lines_restock_shape: "A restock needs its date.",
  sale_refunds_amount_check: "A refund must be more than 0.",
  sale_refunds_currency_check: "Use a three-letter currency code.",
  sale_refunds_reason_check: "Give a reason, under 500 characters.",
  sale_refunds_shopify_refund_id_check: "That Shopify refund reference is too long.",
  consignment_settlements_amount_check: "A settlement must be more than 0.",
  consignment_settlements_currency_check: "Use a three-letter currency code.",
  consignment_settlements_reference_check: "Keep the reference under 200 characters.",
  consignment_settlements_notes_check: "Keep the notes under 2,000 characters.",
  settlement_lines_amount_applied_check: "Each allocation must be more than 0.",
  settlement_lines_override_reason_check: "Keep the override reason under 500 characters.",
  consignment_settlement_reversals_reason_check: "Give a reason, under 500 characters.",
  inventory_units_consignment_item_ownership: "Only a consigned unit has a consignment record.",
  work_order_line_items_consignment_shape:
    "A consigned part needs both its consignment and what the consignor is owed.",
  work_order_line_items_consignment_inventory_only: "Only a part can come from a consignment.",
  work_order_line_items_consignor_payout_check: "The amount owed can't be negative.",
  attachments_consignment_item_internal_only:
    "Photos on a consignment item stay internal. Put listing photos on the product or unit.",
  // Labels (Phase 8)
  label_mm_not_nan: "Enter a size in millimetres.",
  label_templates_name_check: "Enter a template name under 80 characters.",
  label_templates_width_mm_check: "Labels are 20 to 150 mm wide.",
  label_templates_height_mm_check: "Labels are 15 to 150 mm high.",
  label_templates_default_is_active: "The default template must be switched on.",
  printer_profiles_name_check: "Enter a printer name under 80 characters.",
  printer_profiles_default_is_active: "The default printer must be switched on.",
  printer_profiles_adapter_available:
    "That printer type needs a hardware adapter that is not installed yet.",
  print_jobs_quantity_check: "Print 1 to 500 labels per job.",
  print_jobs_unique_quantity_check: "Print up to 10 labels per job for a unit or bike.",
  print_jobs_entity_matches_kind: "That print job is not consistent. Start a new one.",
  print_jobs_qr_payload_shape: "That print job is not consistent. Start a new one.",
  print_jobs_content_keys: "A label can only carry its public details and identifiers.",
  print_jobs_error_check: "Say what went wrong with the print, under 500 characters.",
  print_jobs_completed_check: "That print job is not consistent. Refresh and try again.",
  print_jobs_rendered_check: "That print job is not consistent. Refresh and try again.",
  // Appointments and schedule (Phase 2)
  shop_settings_singleton: "There is only one settings row.",
  shop_settings_currency_check: "Use a three-letter currency code.",
  shop_settings_slot_minutes_check:
    "The slot length must divide the day evenly (5 to 240 minutes).",
  shop_settings_capacity_check: "Capacity per slot must be between 1 and 50.",
  shop_settings_notice_check: "Minimum notice must be between 0 minutes and 7 days.",
  shop_settings_horizon_check: "Customers can book between 1 and 365 days ahead.",
  shop_settings_customer_limit_check: "Allow between 1 and 20 upcoming online bookings.",
  shop_settings_cancel_cutoff_check:
    "The online cancellation cutoff must be between 0 minutes and 7 days.",
  shop_settings_public_site_url_check: "Enter the public site's address, starting with https://.",
  shop_settings_consignment_settlement_alert_days_check: "Choose between 1 and 365 days.",
  shop_hours_interval_check: "Opening time must be before closing time.",
  shop_hours_weekday_check: "Pick a day of the week.",
  closure_overrides_range_check: "A closure ends after it starts and lasts at most 366 days.",
  closure_overrides_hours_shape: "Different opening hours need an opening and a closing time.",
  closure_overrides_reason_check: "Give a reason, under 200 characters.",
  appointment_types_name_check: "Enter a name under 80 characters.",
  appointment_types_description_check: "Keep the description under 500 characters.",
  appointment_types_duration_check: "Duration must be 5 to 480 minutes, in steps of 5.",
  appointment_types_capacity_check: "Capacity units must be between 1 and 50.",
  schedule_events_payload_object: "That schedule history entry is not consistent.",
  schedule_events_reason_check: "Keep the reason under 500 characters.",
  appointments_range_check: "An appointment ends after it starts.",
  appointments_capacity_units_check: "Capacity units must be between 1 and 50.",
  appointments_customer_note_check: "Keep the note under 1,000 characters.",
  appointments_internal_note_check: "Keep the internal note under 5,000 characters.",
  appointments_cancellation_reason_check: "Keep the reason under 500 characters.",
  appointments_status_stamps:
    "The appointment's times don't match its status. Refresh and try again.",
  appointments_cancelled_via_check:
    "The appointment's cancellation doesn't match its status. Refresh and try again.",
  appointment_events_payload_object: "That appointment history entry is not consistent.",
  appointment_events_reason_check: "Keep the reason under 500 characters.",
  // Shopify (Phase 10)
  shopify_settings_single_row: "There is only one Shopify settings row.",
  shopify_settings_shopify_location_id_format: "That is not a valid Shopify location ID.",
  shopify_settings_storefront_url_check:
    "Enter the online store's address, starting with https://, under 200 characters.",
  shopify_product_sync_origin_check: "That Shopify link is not consistent. Refresh and try again.",
  shopify_product_sync_inventory_item_format: "That is not a valid Shopify inventory item ID.",
  shopify_product_sync_handle_check: "That Shopify handle is not valid.",
  shopify_product_sync_external_no_handle:
    "A product made in Shopify keeps its own handle; BICII does not set one.",
  shopify_product_sync_last_pushed_quantity_check: "A pushed quantity can't be negative.",
  shopify_product_sync_last_pushed_price_check: "A pushed price can't be negative.",
  shopify_product_sync_desired_hash_check: "That sync record is not consistent. Sync again.",
  shopify_product_sync_api_version_check: "That Shopify API version is not valid.",
  shopify_product_sync_last_error_code_check: "That sync error is too long.",
  shopify_product_sync_last_error_check: "That sync error is too long.",
  shopify_product_sync_publish_changed_shape:
    "That sync record is not consistent. Refresh and try again.",
  integration_events_provider_check: "Only Shopify webhooks are recorded.",
  integration_events_topic_check: "That webhook has no topic.",
  integration_events_external_event_id_check: "That webhook has no id.",
  integration_events_shopify_event_id_check: "That webhook's event id is too long.",
  integration_events_shop_domain_check: "That shop domain is too long.",
  integration_events_api_version_check: "That API version is too long.",
  integration_events_subject_check: "That webhook's subject is too long.",
  integration_events_shopify_order_gid_check: "That is not a valid Shopify order ID.",
  integration_events_payload_object: "That webhook body is not a JSON object.",
  integration_events_headers_object: "That webhook's headers are not consistent.",
  integration_events_result_object: "That webhook's result is not consistent.",
  integration_events_body_sha256_check: "That webhook's checksum is not valid.",
  integration_events_body_bytes_check: "That webhook's size is not valid.",
  integration_events_delivery_count_check: "That webhook's delivery count is not valid.",
  integration_events_attempts_check: "That webhook's attempt count is not valid.",
  integration_events_outcome_check: "That webhook's outcome is not valid.",
  integration_events_last_error_code_check: "That webhook's error is too long.",
  integration_events_last_error_check: "That webhook's error is too long.",
  integration_events_last_error_detail_check: "That webhook's error is too long.",
  integration_events_correlation_id_check: "That correlation id is too long.",
  integration_events_rejected_shape: "A rejected webhook keeps no body.",
  integration_events_payload_present: "A received webhook keeps its body.",
  integration_events_processed_shape: "That webhook's processing state is not consistent.",
  integration_retry_queue_kind_shape: "That queue item is not consistent.",
  integration_retry_queue_resolved_shape:
    "That queue item is not consistent. Refresh and try again.",
  integration_retry_queue_dismiss_reason: "Give a reason to dismiss this.",
  integration_retry_queue_attempts_check: "That queue item's attempt count is not valid.",
  integration_retry_queue_max_attempts_check: "Allow between 1 and 50 attempts.",
  integration_retry_queue_last_error_code_check: "That queue item's error is too long.",
  integration_retry_queue_last_error_check: "That queue item's error is too long.",
  integration_retry_queue_resolution_reason_check: "Give a reason, under 500 characters.",
  integration_audit_events_reason_check: "Give a reason, under 500 characters.",
  integration_audit_events_payload_object: "That integration history entry is not consistent.",
  integration_audit_events_correlation_id_check: "That correlation id is too long.",
  products_shopify_product_id_format: "That is not a valid Shopify product ID.",
  products_shopify_variant_id_format: "That is not a valid Shopify variant ID.",
  customers_shopify_customer_id_format: "That is not a valid Shopify customer ID.",
  sales_shopify_order_id_format: "That is not a valid Shopify order ID.",
  sales_shopify_customer_id_format: "That is not a valid Shopify customer ID.",
  sales_shopify_shape: "Only an online sale carries Shopify references.",
  sale_lines_shopify_line_item_id_format: "That is not a valid Shopify line ID.",
  sale_lines_shopify_line_part_check: "Only a split Shopify line has a part.",
  sale_refunds_shopify_refund_id_format: "That is not a valid Shopify refund ID.",
  // Purchasing (Phase 7)
  suppliers_name_check: "Enter a supplier name under 200 characters.",
  suppliers_contact_name_check: "Keep the contact name under 200 characters.",
  suppliers_email_check: "Enter a valid email address.",
  suppliers_phone_check: "Keep the phone number under 40 characters.",
  suppliers_website_check:
    "Enter a website starting with http:// or https://, under 300 characters.",
  suppliers_account_reference_check: "Keep the account number under 100 characters.",
  suppliers_notes_check: "Keep the notes under 10,000 characters.",
  supplier_products_supplier_sku_check: "Keep the supplier's SKU under 100 characters.",
  supplier_products_lead_days_check: "Lead time must be between 0 and 365 days.",
  supplier_products_last_unit_cost_check: "Costs can't be negative.",
  supplier_products_currency_check: "Use a three-letter currency code.",
  purchase_orders_po_number_format: "An order number looks like PO-000123.",
  purchase_orders_supplier_reference_check: "Keep the supplier's reference under 100 characters.",
  purchase_orders_currency_check: "Use a three-letter currency code.",
  purchase_orders_notes_check: "Keep the notes under 2,000 characters.",
  purchase_orders_cancellation_reason_check: "Keep the reason under 500 characters.",
  purchase_orders_submitted_shape:
    "The order's dates don't match its status. Refresh and try again.",
  purchase_orders_received_shape:
    "The order's dates don't match its status. Refresh and try again.",
  purchase_orders_cancelled_shape: "A cancelled order needs the time and the reason.",
  purchase_order_lines_quantity_ordered_check: "Order between 1 and 100,000 units.",
  purchase_order_lines_unit_cost_check: `Unit cost must be between ${formatMoney("0")} and ${formatMoney("99999.99")}.`,
  purchase_order_lines_currency_check: "Use a three-letter currency code.",
  purchase_order_lines_notes_check: "Keep the line notes under 500 characters.",
  purchase_order_events_payload_object: "That order history entry is not consistent.",
  purchase_order_events_reason_check: "Keep the reason under 500 characters.",
  purchase_receipts_reference_check: "Keep the delivery note reference under 100 characters.",
  purchase_receipts_notes_check: "Keep the notes under 2,000 characters.",
  purchase_receipt_lines_quantity_received_check: "Receive between 1 and 100,000 units.",
  purchase_receipt_lines_unit_cost_actual_check: `Unit cost must be between ${formatMoney("0")} and ${formatMoney("99999.99")}.`,
  purchase_receipt_lines_currency_check: "Use a three-letter currency code.",
  inventory_movements_purchase_received_has_receipt_line:
    "Stock from a supplier is received through its purchase order.",
  // Indent parts and quotes (Phase 13): the RPCs check these first; the
  // constraints are the last line of defence.
  job_part_requests_kind_source: "A proposed item is either a part or a service.",
  job_part_requests_description_check: "Keep the name under 200 characters.",
  job_part_requests_quantity_check: "Add between 1 and 999 (whole numbers for parts).",
  job_part_requests_currency_check: "Use a three-letter currency code.",
  job_part_requests_service_no_purchase: "A service has no supplier, cost or purchase order.",
  job_part_requests_ordered_has_line: "An ordered part must be on a purchase order.",
  job_part_requests_fitted_has_line: "A fitted item must be on the job.",
  job_part_requests_cancelled_has_reason: "Say why it is cancelled.",
  job_part_requests_cancel_reason_check: "Keep the reason under 500 characters.",
  quotes_token_hash_length: "That quote link is not valid.",
  quotes_currency_check: "Use a three-letter currency code.",
  quotes_answered_fields: "An answered quote needs the name of who answered.",
  quotes_withdrawn_fields: "A withdrawn quote needs the time it was withdrawn.",
  quotes_answered_name_check: "Type your name (up to 100 characters).",
  quote_items_decision_check: "Approve or decline each item.",
  // Stripe payments (Phase 14 step 1): the RPCs write only Stripe's
  // projected data; the constraints are the last line of defence.
  stripe_events_rejected_shape: "A rejected Stripe delivery keeps no body.",
  stripe_events_event_id_shape: "Only a verified Stripe webhook carries an event id.",
  stripe_events_event_id_check: "That is not a valid Stripe event id.",
  stripe_events_payload_check: "A recorded Stripe event keeps its allow-listed copy.",
  stripe_events_headers_check: "That Stripe delivery's headers are not consistent.",
  stripe_events_evidence_check: "A Stripe webhook keeps its size and checksum.",
  stripe_events_body_sha256_check: "That Stripe delivery's checksum is not valid.",
  stripe_events_body_bytes_check: "That Stripe delivery's size is not valid.",
  stripe_events_event_type_check: "That Stripe event has no type.",
  stripe_events_api_version_check: "That Stripe API version is too long.",
  stripe_events_object_check: "That Stripe object's id is too long.",
  stripe_events_delivery_count_check: "That Stripe delivery's count is not valid.",
  stripe_events_decided_check: "That Stripe event's decision is not consistent.",
  stripe_events_outcome_check: "That Stripe event's outcome is not valid.",
  stripe_events_correlation_id_check: "That correlation id is too long.",
  payments_kind_quote: "A deposit belongs to a quote; a balance does not.",
  payments_amount_check: `A payment must be between ${formatMoney("0.50")} and ${formatMoney("999999.99")}.`,
  payments_currency_check: "Online payments are in Singapore dollars.",
  payments_amount_received_check: "The amount received can't be negative.",
  payments_refunded_amount_check: "The amount refunded can't be negative.",
  payments_paid_shape: "A paid payment needs the time Stripe confirmed it.",
  payments_closed_shape: "A failed or expired payment needs the time it closed.",
  payments_session_id_check: "That is not a valid Stripe Checkout session id.",
  payments_payment_intent_id_check: "That is not a valid Stripe payment id.",
  payment_refunds_refund_id_check: "That is not a valid Stripe refund id.",
  payment_refunds_payment_intent_id_check: "That is not a valid Stripe payment id.",
  payment_refunds_amount_check: "A refund must be more than zero.",
  payment_refunds_currency_check: "Use a three-letter currency code.",
  payment_refunds_text_check: "That refund's reason is too long.",
};

/** Other fixed SQLSTATEs our RPCs raise on purpose. */
const SQLSTATE_ERRORS: Record<string, Pick<MappedError, "message" | "kind">> = {
  "42501": { message: FORBIDDEN_ERROR, kind: "forbidden" },
  P0002: { message: "That record no longer exists. Refresh and try again.", kind: "not_found" },
  "55000": {
    // Raised by staff_keep_an_active_admin: the only 55000 we use so far.
    message: "The shop must keep at least one active admin.",
    kind: "conflict",
  },
  "40001": { message: "Someone else changed this at the same time. Try again.", kind: "conflict" },
  "40P01": { message: "Someone else changed this at the same time. Try again.", kind: "conflict" },
  "22004": { message: "Some required values are missing.", kind: "invalid" },
  "22023": { message: "Some values are not allowed.", kind: "invalid" },
  "22P02": { message: "Some values are not in the right format.", kind: "invalid" },
  "22003": { message: "That amount is too large.", kind: "invalid" },
  // Exclusion constraints (Phase 2: closure_overrides_custom_hours_no_overlap,
  // the backstop of closure_custom_hours_overlap).
  "23P01": { message: "That overlaps with another entry.", kind: "conflict" },
};

/** Constraint name from the error, or parsed from Postgres's message. */
export function constraintOf(error: DbErrorLike): string | undefined {
  if (error.constraint) return error.constraint;
  const match = /constraint "([^"]+)"/.exec(error.message ?? "");
  return match?.[1];
}

function isDbErrorLike(error: unknown): error is DbErrorLike {
  return typeof error === "object" && error !== null && ("code" in error || "message" in error);
}

export function mapDbError(error: unknown): MappedError {
  if (!isDbErrorLike(error) || typeof error.code !== "string" || error.code === "") {
    return { message: GENERIC_ERROR, kind: "unknown" };
  }
  const code = error.code;

  if (code === "P0001") {
    const reason = (error.message ?? "").trim();
    const known = BUSINESS_ERRORS[reason];
    return known
      ? { message: known, kind: "business", code, reason }
      : { message: GENERIC_ERROR, kind: "unknown", code, reason: reason || undefined };
  }

  if (code === "23505") {
    const constraint = constraintOf(error);
    return {
      message: (constraint && UNIQUE_ERRORS[constraint]) ?? "That already exists.",
      kind: "duplicate",
      code,
      reason: constraint,
    };
  }

  if (code === "23514") {
    const constraint = constraintOf(error);
    return {
      message: (constraint && CHECK_ERRORS[constraint]) ?? "Some values are not allowed.",
      kind: "invalid",
      code,
      reason: constraint,
    };
  }

  if (code === "23503") {
    return { message: "That refers to something that no longer exists.", kind: "invalid", code };
  }
  if (code === "23502") {
    return { message: "Some required values are missing.", kind: "invalid", code };
  }

  const fixed = SQLSTATE_ERRORS[code];
  if (fixed) return { ...fixed, code };

  // PostgREST's own errors: PGRST301 (JWT expired/invalid) and friends.
  if (code === "PGRST301" || code === "PGRST302") {
    return { message: "Your session has expired. Sign in again.", kind: "forbidden", code };
  }
  // Connection problems surface as fetch errors without a SQLSTATE; 08xxx
  // and 57P0x when the database itself is going away.
  if (code.startsWith("08") || code.startsWith("57P")) {
    return {
      message: "The database is unavailable. Try again shortly.",
      kind: "unavailable",
      code,
    };
  }

  return { message: GENERIC_ERROR, kind: "unknown", code };
}

/** A PostgREST error rethrown with its fields intact (`throw new DbError(error)`). */
export class DbError extends Error implements DbErrorLike {
  code?: string;
  details?: string | null;
  hint?: string | null;
  constructor(error: DbErrorLike) {
    super(error.message ?? "database error");
    this.name = "DbError";
    this.code = error.code;
    this.details = error.details ?? error.detail ?? null;
    this.hint = error.hint ?? null;
  }
}

/** `{ data, error }` -> data, or throw DbError. */
export function unwrap<T>(result: { data: T; error: DbErrorLike | null }): T {
  if (result.error) throw new DbError(result.error);
  return result.data;
}
