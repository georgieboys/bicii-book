# User guide

Audience: BICII staff and mechanics using the Admin on a phone in the
workshop or an iPad at the counter. Admins: shop settings, staff and
permissions are in [OPERATIONS.md](OPERATIONS.md#product-administration).

Applies to: `main` (production since 2026-10-12, through Phase 13's
indent parts and quotes and, since 2026-10-14, Phase 14 steps 1 and 2:
customer deposits through Stripe, deployed with the deposit percent at 0;
the owner set it to 100% in production on 2026-10-15 SGT, so every quote
sent since asks the full price of its approved parts; the build default is
50%) and the recheck (PR #25: Exceptions sentences in full, each Stripe
problem listed once, and why *Check with Stripe* could not read
everything), plus what happens to approved indent items a job is
completed without
([R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job);
D149 and D149a–c, PRs #26 and #27, since 2026-10-15 SGT), voiding a
fitted indent item's line (D160, PR #30, since 2026-10-16 SGT) and Phase
14 step 3 (payment links D156, counter payments D161 and the Customer
payments report D154; PR #36, since 2026-10-18 SGT): its tasks below
("Send a payment link", "Take payment at collection", "Record a counter
payment (admins)", "Void a counter payment or record it as given back
(admins)", "Read Customer payments in Reports") apply in production. On
a developer machine:
http://localhost:3000. Staff sign in with an emailed code.

Last walkthrough: not walked through by a person. These flows are exercised
by the E2E specs in `tests/e2e/` (among them `auth`, `workshop`,
`workshop-board`, `inventory`, `inventory-publish`, `scan`,
`appointments`, `appointment-settings`, `today`, `customers-bikes`,
`staff`, `roles`, `consignment`, `consignment-journey`, `sales`,
`purchasing`, `print-view`, `labels`, `shopify`, `indent`, `payments` and `reports`), on an iPhone 13 and
an iPad viewport (counts and dates in [NOW.md](../NOW.md)); the most
recent green full E2E run recorded in [NOW.md](../NOW.md) is PR #36's
label-triggered
[`e2e (Playwright)` run](https://github.com/georgieboys/bicii-book/actions/runs/39060496580/job/117477299307)
on edd4603 (2026-10-18 SGT).
Where a step below is not covered by a spec, it says so.

## Your first useful result

1. Open the Admin (on a developer machine: http://localhost:3000). You see
   **Staff sign in**.
2. Enter your **Email** and press **Email me a code**. The screen says
   **Check your email**.
3. Open the email "Your BICII sign-in code" and type the 6-digit **Code**,
   then press **Sign in**. The code works once, for 10 minutes; only the
   newest code works. No password is needed, and there is none. On a
   developer machine only, the seeded logins work and their codes are read
   from the devstack's mail catcher
   ([ENGINEERING.md](ENGINEERING.md#clean-checkout-to-running-application));
   a real shop has its own logins, created by an admin's invite.
4. **Today** opens with a greeting and today's date. On a phone the tabs at
   the bottom are Today, Jobs, Scan, Inventory and More (Customers, Bikes,
   Appointments, Settings and the rest); on an iPad every section is in the
   rail on the left.

If it fails:

- No email: check the address and your spam folder, wait a minute, then
  press **Send a new code** (it unlocks 60 seconds after the last one) or
  **Use a different email**. The screen says "Check your email" for every
  address, also one without a login, so a typo shows no error.
- "That code is wrong or has expired. Check your latest email or send a new
  code." (an older code stops working when a new one is sent).
- "This email doesn't have access to BICII Admin. Ask an admin to invite or
  reactivate you." (the code was right, but you are not active staff).
- "Too many attempts. Wait a minute and try again."
- "Sign-in is unavailable right now. Try again in a minute." (the service
  is down; tell whoever runs the system).

A link you opened before signing in takes you back there afterwards.

Your own details, your role (Admin, Manager or Mechanic), what it lets you
do and **Sign out** are under Settings → Your profile: the card **Your role
and access** lists every permission you have, marks any given to you on top
of your role as **Extra access**, and lists **Record refunds** for admins and
managers.

## Routine tasks

### Check a bike in as a new job

- Before you start: the customer's name (or find them by name, phone,
  email, B- number or serial).
- Steps:
  1. **Jobs** → **New job**. The intake has five steps and a review.
  2. Customer: search, or **New customer** (First name, Last name) →
     **Create customer**.
  3. Bike: choose one of theirs, or **Add bike** (Brand, Model) → **Add
     bike**. **Next**.
  4. Work: **Requested work** (required) and **Condition on arrival**.
     **Next**.
  5. People: pick the **Lead mechanic** and any **Additional staff**.
     **Next**.
  6. Services: tap the services to include. **Next**, check the review,
     then **Create job**.
  7. The job opens on **Intake photos**: **Choose photos**, then **Done**.
- Success looks like: the job page with its J- number, the photos, the
  people and the totals; its timeline starts "Checked in as J-…".
- If it fails: an interrupted intake offers "Continue the intake you
  started at …" (**Continue** or **Discard**). "Say what the customer
  wants done." means Requested work is empty. "That bike belongs to someone
  else. Transfer it to this customer first." "That customer is archived.
  Unarchive them before checking in a bike."

### Move a job through its statuses

- Before you start: open the job (Jobs, search, or scan its label).
- Steps: use the large buttons for the usual next step: **Start work**,
  **Diagnose**, **Waiting on parts**, **Pause**, **Resume**, **Complete**,
  **Ready for collection**, then **Collected…** and **Mark collected**
  (Collected is final, so it asks again). When the customer paid online
  or an admin recorded money taken at the counter, the confirmation says
  so first ("$60.00 was paid online. Take only $85.00.", "$45.00 was paid
  at the counter. Take only $100.00." or "$345.00 was paid ($300.00
  online, $45.00 at the counter). Take only $35.00."), or "Nothing is
  left to pay; take nothing." when the bill is paid. While Stripe is
  still confirming a payment (PayNow can take a while) it names no amount
  to take: "Stripe is still confirming $Z paid online, so $Y still to pay
  may already be covered. Press Check with Stripe before taking
  anything." Press **Check with Stripe** on the Customer payments card
  first and take nothing until the payment shows **Paid**. The same
  figures are under
  the job's total in **Lines** ("Paid $60.00 · Still to pay $85.00"):
  take only what is left at the counter (see "Take payment at
  collection"). Any other allowed move is under
  **Change status**, with an optional **Note**; picking **Collected**
  there shows the same sentences.
  - Approved indent items come first (D149b): if the job has approved or
    ordered indent items, the button reads **Complete…** and opens
    **Before completing J-…** ("Fit or cancel each approved or ordered
    item first."), listing each with its status ("Approved", or "Ordered
    · PO-000012 · Arrived" / "Not arrived yet") and any deposit. Press
    **Fit** (or **Add to job** for a service; for a part bought elsewhere,
    see "Quote and order a part the shop doesn't stock", step 6) or
    **Cancel item…** on each; when none is left the sheet says "All
    settled." and **Complete job** completes it. An open quote is
    withdrawn as the job completes; the sheet says so ("Completing the
    job withdraws the quote sent …: the customer's link will say it was
    withdrawn, and its item goes back to Proposed."). The same happens on
    **Ready for collection…**, **Collected…** (then **Mark collected**)
    and with **Change status**, whose **Note** is kept and saved with the
    move once the checklist is done (**Back** drops it). A job completed
    before this rule may still have such items: its checklist says to
    reopen the job to fit them, or cancel them.
  - Reopen a completed job (or one ready for collection): **Change
    status** → **Reopen job…**, answer "Why are you reopening this job?",
    then **Reopen job**. A unique item sold on the job goes back on hold
    for it. (Reopen is not covered by an E2E spec.)
  - Cancel an open job: **Change status** → **Cancel job…**, answer "Why
    is this job being cancelled?", then **Cancel job**. With approved or
    ordered indent items, **Cancel job…** opens **Before cancelling J-…**
    ("Cancel each approved or ordered item first. A cancelled job can't
    keep items waiting."): press **Cancel item…** on each (no Fit: a line
    would stop the cancel), then **Cancel job…** in that sheet.
- Success looks like: a toast "J-…: <new status>" and the status in the
  timeline. A completed job says "Completed jobs are locked. Reopen to
  change lines."
- If it fails: "A job can't move to that status from where it is now."
  "Give a reason for this change." "Void the job's lines before cancelling
  it. Voiding a part returns it to stock." "Fit or cancel the job's
  approved and ordered items first." (someone approved an item since the
  page loaded: the page refreshes and the checklist opens); when
  cancelling, "Cancel the job's approved and ordered items before
  cancelling it." (the same, but fitting would add a line, which also
  stops a cancel). A collected or cancelled job cannot change: "This job
  is collected or cancelled and can no longer change." (The one
  exception: an admin or manager can still cancel an indent item that
  was never fitted, D149.) Once collected or cancelled,
  a job with money paid above its bill shows it under the total: "Paid
  $120.00 · $120.00 more than the bill".

### Add services, parts and other lines to a job

- Before you start: the job is open (not completed).
- Steps:
  - **Add service**: pick the service, adjust **Unit price** or
    **Quantity** if needed, press **Add service**.
  - **Add part**: search by name, SKU, P- or U- number. Each choice shows
    what is in stock where ("40 at Shop floor · 60 total"). Choose
    **Quantity** and where to **Take from**; **Price each** is optional
    (empty charges the selling price). Press **Add part**.
  - **Add manual line**: **Description**, **Quantity**, **Unit price** and,
    with cost access, **Unit cost** ("Enter 0 when there is no direct cost.
    Left empty, the line is marked cost pending.").
  - To remove a line: **Void…** on its row, give the reason, **Void line**.
    Nothing is deleted; **Show voided** lists them. Voiding a part returns
    it to stock. Voiding the line a fitted indent item became puts the
    item back to approved or ordered, to fit again or cancel (D160, see
    [indent parts](#quote-and-order-a-part-the-shop-doesnt-stock-indent-part)).
- Success looks like: a toast such as "Added 1 × <part>. 39 left at Shop
  floor." (a unique item: "It is on hold for this job."), and the totals
  update.
- If it fails:
  - Taking more than a location holds is allowed but warned: "Only 2 at
    Shop floor. Adding 3 takes the count below zero; ask whoever does stock
    counts to recount." (D23).
  - "This part has no sale price. Enter a price or ask someone to set one."
  - "This part has no cost yet, so its yield cannot be worked out. Ask
    someone with cost access to set it." (staff with cost access see "This
    part has no cost yet, so it can't be added. Set its cost on the product
    first.") A price or cost of 0 is a real value; only a missing one is
    refused.
  - A line marked **Cost pending** counts its cost as 0: "Provisional: 1
    line has no cost entered, so cost, yield and Cult Commons count it at 0.
    Void it and add it again with its cost." The figures stay overstated
    until then ([RISKS R-005](RISKS.md#r-005--cost-pending-lines-overstate-yield-and-cult-commons)).
  - "No part in stock matches. Archived, inactive and customer-owned items
    are not offered." Consigned items are offered, marked "Consigned ·
    <consignor>" (see [Use a consigned item on a job](#use-a-consigned-item-on-a-job)).
  - "This job is completed or closed. Reopen it to change its lines."

### Quote and order a part the shop doesn't stock (indent part)

For a part ordered in for one bike: the customer approves it, per item,
before it is ordered, and it goes on the job only when it is fitted
([ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md)). Until
then it is not on the bill: not in the job's total, its yield or Cult
Commons. A job can't be completed (or made ready, collected or cancelled)
while an approved or ordered item is neither fitted nor cancelled:
**Complete…** lists them first (D149b).

- Before you start: the job is open; the part is a product counted by
  quantity (an existing one, or a new one if you manage inventory). The
  customer needs a mobile number for WhatsApp, or an email address for
  email (once an admin has set up quote emails,
  [RUNBOOK](RUNBOOK.md#quote-emails)); otherwise copy the link and send it
  yourself.
- Steps, on the job's **Indent parts and quote** card:
  1. **Propose part**: search the **Part** (only shop-owned products
     counted by quantity are offered), or, with Manage inventory, choose
     **New product** and give its **Name** and **Selling price**. Set
     **Quantity**; **Price each for this job** is optional (empty quotes the
     selling price). Staff with cost access can add the **Expected cost
     each** and the **Supplier**. Press **Propose part**. Nothing comes out
     of stock and nothing is on the job yet.
  2. **Propose service** for the fitting labour, the same way.
  3. **Send quote (N items)**: tick the items, check the **Quote total**,
     choose **Send by** **WhatsApp**, **Email** or **Copy link** (the sheet
     says why WhatsApp or Email is missing), and how many days the **Link
     works for** (1 to 30, default 7). Press **Create link**. The sheet
     **Quote ready to send** shows the link and a **Message**: by email it
     says "Emailed to <address>"; by WhatsApp press **Open WhatsApp** (the
     message is filled in); otherwise copy them. Then **Done**. The link is
     shown only this once; if it is lost, press **Send again**, which
     replaces it (the old link stops working).
  4. The customer opens the link (no sign-in) and sees the job number, the
     bike, each item with its price, and the total. They choose
     **Approve** or **Decline** for every item, type **Your name** and
     press **Send my answer**; the page then thanks them and shows what
     they approved. They can answer once. The card then says "Quote
     answered by <name>" and each item shows **Approved** or **Declined**;
     the job's approval is ticked with a note of what was approved, and the
     timeline records it. Anyone with the link can answer, so if in doubt
     confirm by phone. Under the job's total in **Lines** a memo says what
     is approved but not on the bill yet: "Approved, not on the bill yet: 2
     items, $275.00. Fit them to bill them." (it is never added to the
     total).
     When an admin has set a deposit (Settings → **Customer payments**,
     below; the shop's current setting is 100% since 2026-10-15), the open
     quote also says the shop asks for a deposit of N% of the parts they
     approve (not labour) after they answer. Once they
     answer, a **Deposit** card shows the amount (N% of the approved
     parts, worked out by the database when they answered; quotes sent
     before the deposit was set ask none) and **Pay $… deposit**, which
     opens Stripe's own payment page (card or PayNow) and brings them back
     to the quote. Their approval stands whether or not they pay. Back on
     the page they see "We're confirming your payment with Stripe…" and
     then "Deposit of $… paid. Thank you." (a PayNow payment Stripe is
     still confirming says "Reload this page later to see it
     confirmed."); if they left Stripe without
     paying, "Payment not finished. Nothing was charged." and the button
     again. Pressing Pay again reuses the same Stripe payment, so they are
     never charged twice. Only Stripe's own confirmation marks a deposit
     paid, never the return to the page. While Stripe is off the card says
     "The shop will tell you how to pay the deposit." No deposit is asked
     under S$0.50 (Stripe's minimum) or on a quote in another currency.
  5. **Order approved parts** (Manage purchasing): choose the **Supplier**
     (the one proposed is preset) and press **Add to order**. The parts go
     on that supplier's draft purchase order (a new draft if there is none),
     with the job number in the line's note; submit the order from
     Purchasing as usual. **Move the job to Waiting on parts** is on by
     default. A part whose quote asked a deposit that isn't paid yet shows
     **Deposit due** (or **Being confirmed** while Stripe confirms a
     PayNow payment, or **Deposit refunded**) on its row, and in the sheet
     it starts unticked as "2 × <part> (deposit not paid)", so **Add to
     order** never orders it by accident. Only an admin or manager can
     tick it (D152; **Manage purchasing as extra access does not include
     it**, and anyone else sees "Parts whose deposit isn't paid can be
     ordered once the customer pays, or by an admin or manager."). Ticking
     it shows "The customer hasn't paid the deposit for N of these parts."
     and **Why order before the deposit is paid?**; type the reason and
     press **Order without deposit**. The reason is recorded on the job's
     timeline ("Ordered before the deposit was paid: …"). Ordering does
     not pay the deposit: it stays **Deposit due**, and the customer's page
     keeps **Pay $… deposit**, now saying "The shop has ordered your
     parts. Ask the shop if you still need to pay the deposit." and "If you
     paid the deposit another way, ask the shop before paying here." When
     the customer pays the deposit in the shop, an admin records it (see
     "Record a counter payment (admins)"): it then reads **Deposit paid**,
     the part is no longer held back and the customer's page stops asking
     for it. Until it is recorded the customer could still pay online; if
     both happen, the card says "The deposit of $… was paid online and at
     the counter. …": refund the online payment in Stripe, or an admin
     records the counter money as given back. With the deposit at 0, the
     default, nothing is held up. Fitting is never held up by a deposit.
  6. When the order is received the item shows **Arrived**, and the
     product's page says "2 reserved for jobs" with the job numbers. They
     are not held: don't sell or use them elsewhere. Press **Fit**,
     check the price, then **Fit part**: the part becomes an ordinary line
     on the job at the quoted price and comes out of stock. For an approved
     service press **Add to job**. **A part you bought outside BICII**
     (approved, never ordered here), with View costs or Manage purchasing:
     press **Fit**, choose **Bought outside BICII** under **Where it comes
     from**, enter **Cost each** (what the shop paid for one, from the
     receipt; prefilled with the expected cost given when it was proposed,
     "Expected when proposed: $28.00."; it becomes the product's cost) and
     optionally **Bought from** (shop and receipt number, for example "Bike
     Hub receipt 4471"; not the price), check "Cost 1 × $30.00 = $30.00",
     then **Record and fit**. BICII records the purchase and fits the part
     in one step at the default location: the stock count there doesn't
     change, the job's yield uses that cost, the product's movements show
     "Bought outside BICII +1" and "Used on job −1", and the timeline says
     "Bought outside BICII · Bike Hub receipt 4471". Toast: "<part> is on
     the job (bought outside BICII)." A part on a BICII purchase order is
     received in Purchasing first, then fitted. Fitting from stock stays:
     **From stock** takes it out of stock at the default location, which
     may go below zero (D23); for a part never ordered here the sheet says
     "Never ordered in BICII. If you bought it outside BICII, choose
     Bought outside BICII so the stock count stays right and the job uses
     what you paid." (staff without cost access: "…ask someone with View
     costs or Manage purchasing to fit it as bought outside, so the stock
     count stays right."). Staff with View costs see "This part has no
     cost yet, so it can't be fitted from stock. If you bought it outside
     BICII, choose Bought outside BICII and enter what you paid; otherwise
     set its cost on the product's page first." with **Open the product**
     (anyone else gets "This part has no cost yet…" when they press **Fit
     part**; with the Bought outside option, the sheet switches to it and
     asks what you paid). Once every approved item is fitted, the memo
     under the total goes, and the job can be completed.
     **Voiding a fitted item's line** (a wrong part, D160): **Void…** on
     its row in **Lines** says "Voiding puts <part> back to approved: fit
     it again or cancel it before completing the job." (or "back to
     ordered" for a part on a purchase order), then what goes back to
     stock. Give the reason and press **Void line**; the toast reads
     "<part> is back to approved". The item is **Approved** (or
     **Ordered**) again in **Indent parts and quote**, with **Fit** and
     **Cancel** and "Its line was voided, so it is not on the bill: fit it
     again or cancel it.", the memo under the total counts it again, and
     the timeline reads "<part> back to approved: its line was voided".
     The part itself went back to stock with the void. An ordered part
     keeps its purchase order: if the order had been received it is
     **Arrived** and reserved for the job again; if it was fitted before
     its order came in, it reads "not arrived yet" until the order is
     received. A part bought outside
     BICII stays bought: the void put it into stock, so the card says
     "The part bought outside BICII went back into stock: fit it from
     stock, or cancel it.", and the Fit sheet says "It went back into
     stock when its line was voided: fit it from stock. Bought outside
     BICII would record a second purchase." Complete (and Ready,
     Collected and Cancel job) wait for it like any approved item. Anyone
     who can void a line can do this.
  7. Once a deposit is asked, the job shows a **Customer payments** card
     (every staff member sees it): first anything that needs attention, in
     a sentence (for example "$120.00 is held but this job is cancelled.
     Refund it in Stripe if it is due back."); then each deposit ("Deposit
     on the quote answered …", the amount and percent, and **Deposit
     due**, **Being confirmed**, **Deposit paid**, **Deposit refunded** or
     **No longer due**); then each online payment (**Checkout open**,
     **Paid**, **Partly refunded** "of which $… refunded", **Refunded**,
     "Refund pending in Stripe"; earlier checkouts that were never
     finished are counted in one line); then, with step 3 (D156, D161),
     the live payment link ("Payment link sent 17 Oct 2026 by WhatsApp
     ($135.00 when sent), valid until 24 Oct 2026.") and the money an
     admin recorded **At the counter**; then **Paid online**, **Paid at
     the counter** (when there is any), the job total so far (or **Job
     total** once the job is completed) with **Still to pay**, or **Paid
     ahead** when more is paid than the job's lines so far (indent parts
     join the job total when they're fitted), or **Paid above the bill**
     on a completed job. A deposit still due on a job that is no longer
     open reads **Part of the balance**: it is no longer asked on its
     own. This is money held against the job, not a sale: it never
     changes the job's totals or sales figures. **Check with Stripe** (on a payment Stripe hasn't confirmed,
     a pending refund or a problem) asks Stripe for its own record and
     shows what changed ("Stripe confirmed: Paid", "Stripe confirmed:
     Payment failed" for a PayNow payment that failed after Checkout, or
     "Nothing new from Stripe."); use it when a customer says they paid
     but the card still says due, or when a payment stays **Being
     confirmed**. Admins and managers also get **Open in Stripe**. Refunds
     are made in Stripe's Dashboard (D155) and appear on the card and the
     timeline by themselves. While Stripe is off the card says the
     customer can't pay online and that an admin or manager can order
     without the deposit.
  8. If the job was completed before an approved item was fitted (only
     possible before the D149b rule;
     [R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job)):
     the memo under the total reads "Approved but never fitted: $275.00
     (not billed).", and the item shows **Not fitted** (and **Deposit
     paid** when it was paid for). On a completed job, or one ready for
     collection, it says "Not on the bill: the job was completed before
     this was fitted. Reopen the job with Change status to fit it, or
     cancel it.": **Change status** → **Reopen job…**, fit it, then
     complete again; or **Cancel** it with a reason and refund any deposit
     in Stripe. A paid deposit for it shows on the Customer payments card
     and in Exceptions: "$120.00 is held for parts that are not on this
     job. Reopen the job to fit them, or cancel them and refund in
     Stripe." When other parts of the same quote were fitted, it names only
     their share, for example "$120.00 is held; $60.00 of it is for parts
     that are not on this job. … refund that share in Stripe." Once the
     job is collected (or cancelled) the item "can no longer be fitted";
     the problem then reads "$120.00 is held for parts that never went on
     this job. Cancel them and refund in Stripe, or agree with the customer
     how it counts.", and the card adds "$120.00 was paid online above
     this job's bill of $0.00. Refund it in Stripe if it is due back, or
     agree with the customer how it counts." Only an admin or manager sees
     **Cancel** there (D149): the sheet says "The job is closed and stays
     closed; refund any deposit for it in Stripe."; type why in
     **Reason**, press **Cancel item**, then refund in Stripe; the problem
     changes to "…every part it was for is cancelled…" and clears when the
     refund arrives. The job itself stays collected. The customer's quote
     page stops saying the shop will order the parts and says "Ask the
     shop about your deposit."
     An item still on a quote the customer never answered shows **Not
     answered** once the job is no longer open. On a completed job, or one
     ready for collection, reopen the job to withdraw the quote or send it
     again. On a collected or cancelled job an admin or manager presses
     **Cancel** on it: the sheet says cancelling it withdraws that quote
     (its link stops working) and its other items go back to **Proposed**;
     the toast reads "<part> cancelled. The quote was withdrawn." Cancel
     the other items the same way.
- Success looks like: toasts "Part proposed. Send a quote when you're
  ready.", "Added to the supplier's draft order." (or "Added to the
  supplier's draft order without the deposit.") and "<part> is on the
  job."; the item badges go Proposed → Waiting for the customer → Approved →
  Ordered → Fitted.
- Other actions: **Withdraw quote** stops the link working and returns its
  items to Proposed. It is shown only while the job is open: on a
  completed job, or one ready for collection, reopen it with **Change
  status** first; once the job is collected or cancelled the quote can't
  be withdrawn, and an admin or manager cancels its items instead (step
  8). **Cancel** on an item asks for a **Reason** (an item on the open
  quote cannot be cancelled while the job is open: withdraw the quote
  first; an ordered part stays on its purchase order). On a completed
  job, or one ready for collection, anyone can still cancel an item that
  is not on an open quote; on a collected or cancelled job only an admin
  or manager can (D149). Completing or cancelling the job withdraws its
  open quote (its link then says it was withdrawn; D149c); a quote left
  open on a job completed before that rule can no longer be answered: the
  card says so and what to do.
- If it fails:
  - "Only shop-owned products counted by quantity can be ordered for a
    job."
  - "It is on the quote the customer has. Withdraw the quote first."
  - "Only approved items can be ordered or put on the job."
  - "That line was voided. Reload the job and fit the item again." (a Fit
    sent again for a line that was voided meanwhile, D160).
  - Bought outside BICII: "It is on a purchase order. Receive it in
    Purchasing, then fit it." "Only a part can be bought outside BICII.
    Add a service with Add to job." Under **Cost each**: "Enter the cost
    each.", "Enter the cost each as an amount of 0 or more, like 12.50."
    or "The cost each is too large." (above $99,999.99). Under **Bought
    from**: "Keep where you bought it under 100 characters." "You don't
    have permission to do that." (without View costs or Manage
    purchasing).
  - Ordering, proposing or fitting on a completed or collected job: "This
    job is completed or closed. Reopen it to change its lines."
  - Withdrawing a quote, or (anyone but an admin or manager) cancelling an
    item, on a collected or cancelled job: "This job is collected or
    cancelled and can no longer change."
  - "The customer has already answered this quote."
  - "That supplier no longer exists or is archived. Choose another."
  - Ordering a part whose deposit isn't paid without a reason: "Say why
    the parts are ordered before the deposit is paid." (or, if the
    deposit became unpaid while the sheet was open, "The customer hasn't
    paid the deposit for these parts yet. An admin or manager can order
    them anyway with a reason.").
  - Check with Stripe: "Checked a moment ago. Wait a few minutes.",
    "Stripe can't be reached right now, or it isn't set up. Try again in a
    few minutes.", "This payment was made in Stripe's other mode (test
    or live) and can't be checked here.", "Stripe has no record of this
    Checkout under the key BICII uses now (another Stripe account?). An
    admin can follow RUNBOOK “Stripe: resolving problems”." or, under a
    success toast, "Stripe's payment or its refunds couldn't be read:
    Stripe refused the key. An admin should check the Stripe key's
    permissions (RUNBOOK “Stripe: restricted key”)." when Stripe refused
    the key, "Stripe's payment or its refunds couldn't be read: BICII
    could not use Stripe's answer. An admin should follow RUNBOOK
    “Stripe: resolving problems”." when Stripe answered with an error or
    something BICII could not read, or "Stripe's payment or its refunds
    couldn't be read: Stripe could not be reached; try again in a few
    minutes." when Stripe timed out or was busy.
  - Fitting before the order is received warns: "Its order (PO-…) has not
    been received yet. Fitting it now may take the stock count below
    zero."
  - Sending by email: "Email isn't set up yet. Send by WhatsApp or copy
    the link." or "The customer has no email address. Add one, or send by
    WhatsApp or copy the link." If the email itself fails, the quote is
    still sent: "The email didn't go out. Copy the link and send it another
    way."
- What the customer may see when paying a deposit: "Online payment isn't
  available right now. Try again in a few minutes, or contact the shop."
  (Stripe can't be reached, or isn't set up), "This job is closed. Ask the
  shop about the deposit.", "The parts this deposit was for were
  cancelled. Ask the shop.", or "Too many attempts. Wait a few minutes and
  try again."
- What the customer may see instead of the quote: "This link is not valid"
  (a cut-off link), "Quote for job J-… replaced" (you sent again or
  withdrew it), "Quote for job J-… expired", "Too many requests" (wait a
  few minutes), or, after answering, "This quote has already been answered
  or replaced."
  (Email delivery is not covered by an E2E spec; the quote page is.)

### Receive a consigned item

- Before you start: you need **Manage consignments**. Have the agreed
  amount owed to the consignor and the asking price ready.
- Steps:
  - **Consignment** → **Receive item** (or **Receive item** on a
    consignor's page, which fixes the consignor).
  - **Consignor**: search by name, phone or email. Someone new: type the
    name and choose **New consignor "…"**; fill in phone or email and,
    optionally, link their **Customer record** (it fills in the name,
    phone and email). They are created with the item.
  - **One item (bike, frame, wheelset)** or **Several identical**. A bike
    may link a **Shop bike record**; only bikes with no owner that are not
    in stock are offered. If the bike is registered to the consignor,
    first open the bike and **Transfer** it to the shop with a reason such
    as "Consigned by Daniel Ong" (D51).
  - **Name**, **Brand**, **Description**, **Category**; for one item the
    **Serial number** and **Condition** (public once published); for
    several, the **Quantity**; **Kept at**.
  - **Amount owed to the consignor when it sells** (per item; 0 is
    allowed) and the **Asking price** (the public, label and sale price).
    With View costs you see "If it sells at the asking price: yield … ·
    Cult Commons … · BICII keeps …".
  - **Received** (today unless you change it), **Agreement notes**,
    **Internal notes**. Press **Receive item**.
- Success looks like: "C-000123 received" and the item's page, where you
  add **Listing photos** (on the product; public once published) and
  **Agreement photos** (the signed agreement; always internal: "Agreement
  photos show the consignor's terms, so they stay internal.").
- If it fails: "That consignor is archived. Unarchive them first."; "The
  intake date can't be in the future."; "That bike belongs to a customer
  …" (transfer it to the shop first). Change terms later with **Edit
  terms** (a new amount owed needs a reason). Add work on the item with
  **Add charge**: choose **Consignor pays** (deducted from what we owe
  them) or **Shop pays** (added to the cost of the sale, so it lowers
  yield; one item only, before it is on a job or sold). There is no
  default (D4); void a charge with **Void…** and a reason.

### Use a consigned item on a job

- Before you start: the job is open; the consigned item is for sale.
- Steps: **Add part** on the job, search the item's name or U-/P-/C-
  number. Consigned choices show "Consigned · <consignor>" (several
  identical also show the C- number of the consignment they come from:
  the oldest one with stock left; at the location you take it from, the
  part comes from the oldest consignment that has that many there). The
  price is the asking price;
  **Price each** may change it. Press **Add part**.
- Success looks like: "Added … It is on hold for this job." The line shows
  "Consigned · <consignor>", linked to the item. When the job is
  **Completed** the item reads "Sold, awaiting payment" and the consignor
  is owed the agreed amount (D44).
- If it fails: consigned stock never goes below zero: "Only 2 of this
  consigned item at Shop floor. Consigned stock can't go below zero.", and
  "No single consignor has that many of this item at that location. Use
  fewer, or one consignor's stock at a time." To take it back, reopen the job and void
  the line; reopening alone removes what is owed until the job is
  completed again.

### Record a payment to a consignor

- Before you start: you need **Manage consignments**.
- Steps: open the consignor (Consignment → Consignors) → **Record
  payment**. Enter **Amount paid**, **Paid on** (today by default) and the
  **Reference**. Each item with something owed has a row, oldest sale
  first: type an amount per item, or press **Auto-fill**. **Add another
  item** pays an item that is not owed yet. Press **Record payment of
  $x**.
- Success looks like: "Payment of $200.00 recorded for <name>"; **Balance**
  shows Owed, Paid and Outstanding, and the payment appears under
  **Payments** with its allocations. "Settled" means everything owed has
  been paid; "Nothing owed yet" means nothing has sold.
- If it fails: the button stays disabled while the rows show "Unallocated
  $x" or "Over by $x", and while a row pays more than that item is owed
  without an answer to "Why pay more than is owed?". A wrong payment is
  corrected with **Reverse…** and a reason (the whole payment; it stays in
  the list, struck through). A negative balance reads "Overpaid $x
  (consignor owes the shop)": it clears with a later sale, by voiding a
  consignor-paid charge or by reversing a payment, never automatically
  (D46).

### Return an item to its consignor

- Before you start: you need **Manage consignments**; the item is for sale.
- Steps: open the item → **Return to consignor…** → answer "Why is it going
  back?"; for several identical, choose where from (only places holding
  this consignor's stock) and **How many** (all of their stock there by
  default). Press **Return to consignor** (or **Return N to consignor**).
  Another consignor's stock of the same item is never handed over (D54).
- Success looks like: the stock leaves the shop; a single item reads
  **Returned**; a quantity reads "2 of 3 left"; the history shows "1
  returned to consignor" with the reason. Nothing is owed for returned
  stock.
- If it fails: "Return at least one, and no more than the shop still has."
  "There isn't that much stock at that location." means this consignor
  has less there: choose the other location. An item on an open job must come off the job first. A returned bike
  keeps its link to its bike record; transfer the bike back to the
  consignor's customer record on the bike page ([R-020](RISKS.md#r-020--a-bike-record-consigned-once-cannot-be-consigned-again)).

### Record an in-store sale

- Before you start: anyone signed in can sell (D48). The item is in stock
  (a unique item is Available; it is not on a job).
- Steps: **More → Sales → New sale**, or **Sell** on a consignment item, a
  unit or a counted product (it starts with that item). Search the name,
  SKU or U-/P-/C- number under **Add item** and choose a result (each
  shows where it is, how many and the price; consigned ones show
  "Consigned · <consignor>"). The **Price** is the selling price; change
  it if you agreed another. For several, set **Quantity** (up to what is
  there). **Add item** adds more. Choose the **Customer** if they are on
  file (empty is a walk-in). **Sold earlier?** lets you enter when it was
  sold (not in the future, and not before the item came into the shop:
  a consigned item's intake, or the restock of a returned unit; D55).
  Press **Record sale · $x**.
- Success looks like: "S-000123 recorded" and the sale's page: the items,
  the total and who recorded it; the stock is lower, a unique item reads
  Sold ("Sold on S-…" on its page) and a consigned item is owed to its
  consignor. With View costs the sheet previews cost, yield and Cult
  Commons, and the sale page shows them.
- If it fails: "Below the asking price" and "Below cost: this sale loses
  money" are warnings, not blocks (D53). "That item has already been
  sold." outlines the line that went meanwhile: remove it and record the
  rest. "There isn't that much stock at that location." means the count
  changed: lower the quantity. "This item has no selling price. Enter
  one." needs a price. A date in the future is marked on **Sold at**;
  "A sale can't be dated before the item came into the shop." needs a
  later date. "No single consignor has that many of this item at that
  location." means the consigned stock there belongs to several
  consignors: sell fewer, or pick each consignor's line. A sold bike is not
  transferred to the buyer: use **Transfer** on the bike page (D51).

### Refund a sale

- Before you start: an admin or a manager records a refund (D94, amending
  D49). A mechanic does not see **Record refund**, whatever extra access
  they have.
- Steps: open the sale (Sales, or search its S- number) → **Record
  refund**. The **Amount** starts at what is left to refund; change it for
  a partial refund. Press **Record refund of $x…**, answer "Why is it
  being refunded?" and press **Refund $x**.
- Success looks like: "Refund of $x recorded"; the sale reads Partly
  refunded or Refunded and lists the refund with its reason. Nothing goes
  back into stock: if the item came back, restock it (below) (D7).
- If it fails: "That's more than is left to refund on this sale." The
  financial reports still count the sale in full: the period reports
  (Phase 9, screens to come) show refunds as "refunds recorded" beside
  gross sales on the day the refund is recorded, never taken off (D102, a
  build default; [R-021](RISKS.md#r-021--reports-overstate-net-sales-after-a-refund-or-restock)).

### Restock an item that came back

- Before you start: you need **Adjust stock**; for a consigned item also
  **Manage consignments** (D46). Only a single item (U- number) sold on a
  sale is restocked; an item sold through a job goes back by reopening the
  job and voiding the line.
- Steps: open the sale (or the unit's page, "Sold on S-…") → **Restock…**
  on the item → choose where it goes back if asked (default: where it was
  sold) → answer why → **Restock**.
- Success looks like: "U-000123 is back in stock"; the line reads
  Restocked and the unit Available again. A consigned item goes back on
  sale for its consignor and is no longer owed to them; money already paid
  for it stays paid (the balance may read Overpaid).
- If it fails: a unit whose bike now belongs to a customer cannot go back
  into stock (D29); a consigned item whose consignor is archived cannot
  either: "That consignor is archived. Unarchive them first." (the same
  applies to reopening a job that used it, D47); a restock never refunds
  money: record a refund too if the customer was paid back.

### Add a product you already stock

- Before you start: Manage inventory (the Cost fields also need View
  costs). Add the product categories you want first (below); a product can
  be added without one and filed later with **Edit details**.
- Steps: **Inventory** → **New product**. Choose **How it is counted**
  (fixed once the product exists):
  - **Quantity** for identical items counted together (tubes, pads,
    chains): **Name**, and if you like **SKU**, **Brand**, **Category**,
    **Description**, **Sale price**, **Cost** and **Reorder point**
    ("Listed under Low stock at or below this count"). Press **Add
    product**, then record what is on the shelf: **Stock** → **Adjust
    stock**, **Add**, the **Quantity**, the quick reason **Opening stock
    count**, **Save adjustment** (the next task).
  - **Unique** for one-of-a-kind items (a complete bike, a used frame):
    the same fields, then **First unit**: **Location**, **Serial
    number**, **Condition (shown publicly when published)**, **Unit sale
    price** and **Unit cost** (both optional: the product's when empty)
    and **This is a complete bike**. Press **Add product**. More of the
    same model: **Add unit** on the product.
- Success looks like: toast "Product added" and the product's page with
  its P- number (a unique item's unit gets its own U- number).
- Consigned items (owned by someone else) are not added here: use
  [Receive a consigned item](#receive-a-consigned-item).
- If it fails: the sheet names the field to fix beside it. If the unit is
  refused, the product still exists and its page offers **Add unit**.

### Add product categories

- Before you start: Manage inventory.
- Steps: **Settings** → **Product categories**. Type the name in **New
  category** and press **Add category**. **Rename** changes a name in
  place; **Archive** hides a category from **New product** and **Edit
  details**, **Unarchive** brings it back.
- Success looks like: toast "<name> added"; **New product** offers it
  under **Category**, and a product shows its category beside its SKU.
  Products filed under an archived category keep it (shown as
  "(archived)" when you edit them). Nothing is ever deleted.
- These are separate from the service categories under Settings →
  Services: the same name can exist in both.
- If it fails: "Name the category." or a name already used by another
  active product category.

### Adjust stock or move it between locations

- Before you start: Adjust stock needs the Adjust stock permission;
  Transfer needs Manage inventory. Open the product (Inventory, search, or
  scan).
- Steps (adjust): **Stock** → **Adjust stock**. Choose the **Location**,
  **Add or remove**, the **Quantity**, the **Type** (Adjustment, or
  Damaged for stock removed) and a **Reason** (or a quick reason such as
  "Opening stock count" or "Stock count correction"). Check "After saving"
  ("Shop floor: 0 → 10") and press **Save adjustment**.
- Steps (transfer): **Stock** → **Transfer**. Choose **From**, **To** and
  **Quantity**, optionally a **Reason**, then **Move stock**.
- Success looks like: "Stock saved. Shop floor: 10", or "Moved 2 to
  <location>"; the movement appears under Recent movements and **All
  movements**, with the reason. (Transfer is not covered by an E2E spec.)
- Consigned stock moves one consignor's stock at a time: the oldest
  consignment with that many at **From** (D54). "No single consignor has
  that many of this item at that location." means move fewer, in two
  transfers.
- If it fails: a manual count can never go below zero: "<location> has 3. A
  count can't go below zero by hand; check the number." (Save stays
  disabled). "Give a reason for this stock change." "Choose two different
  locations." "That location is inactive. Choose another or reactivate it."

### Order from a supplier

- Before you start: you need **Manage purchasing**. Only counted,
  shop-owned, active products can be ordered (D62): unique items are
  registered one by one in Stock, and consigned stock comes in through
  **Receive item** in Consignment, never on an order.
- Steps:
  - **Purchasing** → **Suppliers** → **New supplier** for someone new:
    **Name**, **Contact name**, **Phone**, **Email**, **Website**,
    **Account reference** (BICII's account number with them), then
    **Create supplier**.
  - On the supplier's page, **New order** (the supplier is fixed), or
    **Purchasing** → **New order** and pick the supplier. Optionally a
    **Supplier reference** and an expected date; **Create order** opens
    the draft.
  - **Add line**: search the product (each option shows on hand and on
    order), then **Quantity** and **Unit cost**, prefilled from the
    supplier's last cost or the product's cost when there is one;
    **Add line**. Change a line with its **Change line** button.
  - **Submit order** when it is sent to the supplier.
- Success looks like: the order's `PO-` number and the status Submitted;
  the product page's **Suppliers & orders** card shows "On order".
- If it fails: "Only shop-owned products can be ordered from a supplier."
  (a consigned or customer-owned product); "That product is already on
  this order. Change its line instead."; "An order needs at least one
  line." To stop an order, **Cancel order…** with a reason (D61): what was
  already received stays in stock.

### Receive a delivery

- Before you start: you need **Manage purchasing**; the order is submitted
  (a draft says "Submit the order before receiving").
- Steps:
  - Open the order (scan or type its `PO-` number) → **Receive**.
  - For each line, **Receive now** (it starts at what is still to come)
    and the **Actual unit cost** from the supplier's note ("Differs" shows
    when it is not the ordered cost; 0 is allowed for free goods);
    **Receive into** a location (each line can go somewhere else).
  - **Delivery note reference**, **Received** (now unless the note is older;
    at most 30 days back, D64) and **Notes**.
  - Press **Receive N items** once.
- Success looks like: "Received 18 items. 2 still to come.", the order
  Partially received with "18 of 20 received · 2 to come", or Received when
  everything has come. The stock goes up once, and the product's cost and
  the supplier's last cost become the actual cost (D5, D63). Each line of
  the order's **Receipts** has **Print N labels** (N = the count received):
  it opens the product's print sheet at that count, for anyone signed in
  (`tests/e2e/purchasing.spec.ts`, journey 3).
- If it fails: more than is to come is refused; raise the line's ordered
  quantity on the order first (D65). If the connection drops, the screen
  checks whether the delivery was recorded and either shows it or offers
  **Retry**, which never receives twice. A delivery note already recorded
  on this order asks you to tick **This is a different delivery**. A wrong
  count after receiving is corrected with **Adjust stock** and a reason;
  a fully received order is closed, so extra units go on a new order.

### Reorder low stock

- Before you start: you need **Manage purchasing**.
- Steps: **Purchasing** → **Reorder** (also from the Inventory low-stock
  filter and Today's low-stock tile). Choose the **Supplier**; products
  linked to it start ticked, each with on hand, on order and a suggested
  quantity (twice the reorder point less what is on hand and on order,
  D66). Press **Create draft order (N products)**.
- Success looks like: a draft order with those lines at the supplier's
  last cost; check quantities and costs, then **Submit order**.
- Only shop-owned products are listed. A consigned product below its
  reorder point still counts on Today and the Inventory low-stock filter,
  but it is never reordered here: more of it comes from its consignor
  through intake. If only consigned products are low, the list says
  "Nothing is below its reorder point."

### Publish a product

- Before you start: Manage inventory. Publishing needs **A name**, **A sale
  price**, **A public photo** and, for a unique item, **An available
  unit**.
- Steps: on the product, **Publication** → **Make internal** (a new
  product starts as Draft). Add a photo with **Choose photos**, open it and
  choose **Public** in the viewer ("Photo is now public"). Then
  **Publish**. **What the public sees** previews the public listing and the
  QR label URL is shown (the shop's public website address + `/q/` + the
  short ID; "QR address not set" until an admin sets that address, and
  then no label can be printed either).
- Success looks like: toast "Published" and "Public" in the header.
  **Unpublish** makes it internal again ("Listing is internal only").
- If it fails: Publish stays disabled and the card says what is missing,
  e.g. "Still needed: A public photo." The database refuses with "Add a
  public photo before publishing.", "Set a selling price before
  publishing." or "There is no available unit to publish."

### Scan a label or type a code

- Before you start: the camera works only over HTTPS or on `localhost`.
- Steps: **Scan**. Allow camera access and hold the label inside the
  square, or type the code into **Or type the code on the label** (any
  case) and press **Open**.
- Success looks like: the bike, job, product or unit opens.
- If it fails: "Enter a code like P-000123" (not a code). "No record with
  P-999999" with **Scan again**. A QR code from elsewhere shows "Not a BICII
  label" and is never opened; scanning continues. "The camera only works
  over a secure connection. Open the app over HTTPS (or on localhost)."
  (type the code instead; [RUNBOOK](RUNBOOK.md#the-camera-scanner-on-phones-and-ipads)).
  "Camera access is blocked. On iPhone: Settings → Safari → Camera → Allow,
  then reload this page." Labels printed against the shop's current public
  address, or against the earlier one the app is configured to accept,
  both scan.

### Print labels and confirm them

- Before you start: any staff member. Open the product (counted by
  quantity), the unit or the bike: **Print label** is in the header and in
  its **Labels** card. A unique product's labels are its units': its Labels
  card links each U- number. A bike tag (B-) is for the workshop; a
  customer who scans it sees "not found".
- Steps: **Print label**. The sheet shows the label exactly as it will
  print. **How many**: type a number, use − and +, or for a product tap 1,
  5, 10, 20 or 50 (one print job is up to 500 labels of a product, or up
  to 10 of a unit or bike; ask for more and the sheet says "Prints 500 now;
  print again for the remaining 120."). **Printer**: a list of the printers,
  each with what it does ("This device's print dialog", "Opens a PDF to
  share or print"); this device's last printer is already chosen. **Label size** appears when an admin has added
  more than one. Press **Print 10 labels**. In the print view with the
  browser printer press **Print**, pick the label printer, paper at the
  label size (58 × 40 mm), scale 100%, no margins. With the PDF printer
  (iPhone and iPad) press **Open PDF**, then Share → Print with the same
  paper and scale. **Print** and **Open PDF** stay at the top while you
  scroll the labels. Then answer "Did all 10 labels print correctly?" ("Did
  the label print correctly?" for one label), just below the title: **Yes,
  all printed**, or **Something went wrong…**, say what went wrong and
  **Mark as failed**.
- Success looks like: "Marked as printed" (or "Marked as failed") and
  links **Back to P-…** and **Print history**. The record's Labels card
  lists its last three prints and **All label jobs**; **Labels** (More)
  lists every print newest first; **To confirm** shows jobs sent but not
  confirmed, **Failed** the failed ones with their reason; search by short
  ID or name. A job's page shows the label exactly as it printed, the
  printer's name and its type (Browser print or PDF download) on separate
  rows.
- Worth knowing: "Not public yet: anyone who scans this label sees 'not
  found' until it is published." means the label works in the shop but not
  for customers until the product is published (**What the public sees**
  in the Labels card jumps to the preview). When the price changed since
  the last printed label, the Labels card says "The price changed since the
  last printed label (… → …). Reprint the labels on the shelf." A price of
  0 prints as $0.00; a product with no price prints no price line.
  Labels show the name, brand, price, condition (units), the bike's size
  and colour or serial number, the SKU and the short ID: never a cost, a
  consignor, an owner or a note. New stock from a purchase order is
  labelled from the order's **Receipts**: **Print N labels** on a received
  line opens the product's print sheet at the received count
  ([R-029](RISKS.md#r-029--the-purchase-receive-screen-has-no-print-n-labels-shortcut-yet),
  resolved).
- If it fails: a printed or failed job cannot be printed again as it was:
  its print view shows what happened and **Print again**, which opens the
  record's print sheet ("Print again · …", same count and printer) for a
  new job with today's label, linked to the old one ("Reprint of"). After
  printing it, Back returns to where you pressed Print again; it does not
  open the sheet a second time. Print
  label is disabled with the reason when the record is archived ("That
  record is archived. Unarchive it before printing labels."), when the
  shop's public website address is not set (ask an admin), or when there is
  no label template. "This print was already started" means the job exists:
  open the link to its print jobs, or press Print again for a new one. A
  finished job's PDF link answers "This print job is finished. Print again
  from the record to make a new job."

### Set up label printing (admins)

- Before you start: admin. **Settings → Labels and printers**.
- Steps: **QR codes point to** shows the shop's public website address
  every label encodes (a label for P-000123 opens `{address}/q/P-000123`).
  **Change address**, type it (like https://bicii.sg), **Review the
  change**, read what changes and **Change the address**. **Printers**:
  tap a printer to rename it, nudge its **Calibration offset X / Y** in
  0.5 mm steps when labels come out off-centre, switch it off, or **Make
  default**; **Add printer** for another browser-print or PDF printer
  (network and Bluetooth printers need Phase 12). **Label templates**: tap
  one, or **Add template**, to set the size, QR size and margin, QR side,
  which fields print, name lines and text size, watching the preview.
- Success looks like: toasts "QR address saved", "… saved", "… is the
  default printer".
- If it fails: a malformed address shows "Use http:// or https://, a host
  and an optional path, with no ? or # part, under 200 characters." A
  template that does not fit says why under the preview (for example "The
  QR code does not fit: at most 26.0 mm on this label.") and cannot be
  saved. The default printer and default templates cannot be switched off:
  make another the default first. Changing the address does not change
  labels already printed: they keep opening the old address, so keep it
  working (a redirect) ([OPERATIONS.md](OPERATIONS.md#product-administration)).

### Book and run an appointment

- Before you start: the shop's hours, capacity and appointment types are set
  by an admin.
- Steps (book): **Appointments** → **Book appointment** (phone: **Book**),
  or a customer's page → Appointments → **Book appointment**. Choose the
  **Customer**, the **Type**, a **Date** (or **Or pick a date**), a free
  **Time**, optionally the **Bike** and an **Internal note**, then
  **Book**.
- Steps (on the day): open the appointment from Appointments or Today.
  - **Arrived** when they arrive ("Marked as arrived"); **Confirm** marks
    a booking confirmed.
  - **Check in**: choose the bike, check **Requested work** (the customer's
    note is filled in), pick the **Lead mechanic**, and under **New or
    existing job** choose **New job** or the bike's open job; press **Check
    in and open job** (or **Check in and link J-…**).
  - **No-show…** → "Mark as a no-show? If they turn up later today, you can
    still reinstate them as arrived." → **Mark no-show**. **Reinstate as
    arrived** undoes it if they turn up.
  - **Cancel appointment…** → "Why is the appointment cancelled?" →
    **Cancel appointment**. The customer is not told automatically.
- Success looks like: "Checked in. J-… opened." and the job linked both
  ways; "Appointment cancelled"; the appointment's History records each
  step and who did it.
- If it fails: "That time has just filled up. Pick another time." (the
  times reload; the rest of the form is kept). "The shop is closed then."
  "Mark a no-show only after the appointment has started." There is no
  reschedule: cancel and book again, and phone the customer
  ([R-017](RISKS.md#r-017--appointments-mvp-has-no-reschedule-and-no-customer-messages)).

### Help a customer with their website account

Customers sign in on the BICII website, not in this app (Phase 11; the
website's account pages go live when the owner switches them on,
[RUNBOOK](RUNBOOK.md#the-public-site-customer-accounts)).

- How it works: the customer enters their email on the website and types
  the 6-digit code they are sent. The website links them to the customer
  here whose **Email** is the same address, so record emails carefully at
  intake. Customers who are not here yet get a customer record when they
  first book online; it then appears in **Customers** like any other.
- What they see there: their upcoming and past appointments (they can
  cancel until the cutoff), their bikes with the photos marked **Customer**
  or **Public**, and their jobs with status, lines, prices, totals and
  customer photos. Never internal notes, internal photos, costs or other
  customers.
- If it fails: "We can't link your account" means two customers here share
  that email: archive the duplicate or correct one email, then ask them to
  sign in again. "Your account is closed" means their customer is archived:
  unarchive it if they should be back. A customer linked to the wrong
  record needs the fix in
  [RUNBOOK](RUNBOOK.md#the-public-site-customer-accounts) (no screen yet).

### Read Today

- Steps: **Today**. Right now (Received, Waiting, Ready to start, In
  progress, Awaiting collection, Overdue), the day's flow (Checked in,
  Started, Completed, Ready for collection, Collected, Cancelled),
  Appointments (arrivals, still expected, arrived), Stock (parts used, low
  stock, significant adjustments), Needs attention, Activity and the Last 7
  days. Use the day navigator for an earlier day and **Back to today**.
- Money (Gross sales) appears only with View financial reports; Direct
  costs (COGS), Yield, Cult Commons and BICII after Cult Commons also need
  View costs.
- Success looks like: tiles that link to the jobs behind them.
- Money counts jobs completed and in-store sales recorded on the day.
  **Consignment sales** (sales and completed jobs with a consigned item)
  opens that day's sales (the jobs are under Jobs completed);
  **New consignor liability** (also View costs) opens Consignment.
- If it fails: a "Provisional: …" note means cost-pending lines are counted
  at 0. Refunds and restocks are not taken off (D102: the period reports
  show refunds beside gross instead).
- Needs attention lists what you may see (D108): every staff member sees
  overdue and uncollected jobs, stock below zero, stale holds, lines in
  another currency (job lines and, since Phase 9, sale lines) and units
  whose status disagrees with the stock ledger; consignor money unpaid more
  than 30 days after the sale (D107) only with Manage consignments or View
  costs (admins and managers by role); failed integrations only admins.
  Each row opens its record (a job, product, item, consignment item or
  sale). **See all** beside the count, or the "Showing the 20 most urgent
  of …" line, opens the full list on Reports → Exceptions.
- Admins also see **Shopify needs attention** rows under Needs attention:
  an online order or product sync BICII could not finish, with the reason;
  the row opens it in the Shopify queue
  ([Fix a Shopify order](#fix-a-shopify-order-that-needs-attention-admins)).

### Online orders from Shopify

- What happens: a paid Shopify order becomes a sale with source **Online**
  in Sales, at Shopify's prices after discounts (a 3 × $40 line with $20
  off is recorded as 2 × $33.33 and 1 × $33.34), dated when Shopify took
  the order. The stock comes from the online location (the Shop floor), and
  the product's movements show it as **Sold online**. Shopify sending the
  same order twice, or under a new webhook id, still records one sale.
- A refund made in Shopify marks the sale Partly refunded or Refunded, like
  an in-store refund: the stock and the item's status do not change; use
  **Restock…** on the sale if the item came back.
- A Shopify customer becomes a BICII customer only when an admin links
  them; a matching email is never enough.

### Publish a product online

- Who: staff with Manage inventory (everyone else sees the status, and the
  switch says "Needs Manage inventory").
- Steps: open the product → **Online (Shopify)** → switch on **Publish
  online**. The toast says "Published online"; the card then shows
  **Synced**, when, and the **Online quantity** at the online location.
- It needs: the product public (Publication card), a price ($0 counts),
  not archived and not customer-owned. When something is missing the reason
  sits beside the switch, for example "Make the product public first."
- Afterwards every stock, price, name or public-photo change is sent once,
  automatically. **Sync now** sends it again; on a failed sync the card
  shows the reason in red above it.
- If the product later stops being public, is archived or made inactive,
  the switch stays on but the card says why it is not listed, for example
  "Not listed: the product is not public. It goes back online when you
  publish it again."; Shopify has it as a draft until then.
- If the change is saved but the sync cannot run straight away, the toast
  says "Saved. The sync runs from the queue in a moment."
- Switching it off hides the product in Shopify (draft, quantity 0). A
  product linked to one made in Shopify says "Linked to a product made in
  Shopify: BICII sends price and stock only" and never gets a Buy-online
  link.
- **Shopify details** (folded) shows the Shopify product and variant IDs to
  copy. **Test Shopify** on the card means the app is talking to the
  pretend Shopify used for testing.

### Fix a Shopify order that needs attention (admins)

- Where: Today → **Needs attention** shows a **Shopify needs attention**
  row with the order and the problem in words; it opens **More → Shopify →
  Queue** on that item. The queue's **Needs attention** list has them all.
- Nothing was recorded for the order, so nothing has to be undone.
- An unknown product ("… is not linked to a BICII product"): tap the item →
  **Link to a BICII product** for the line → search the product by name or
  P- number → give a reason → **Link and retry**. The toast says
  "Recorded as S-000123"; later orders for that Shopify variant sell the
  same product. A custom Shopify line has no product to link: record it by
  hand if needed, then dismiss.
- Too little stock, a unit already sold in the shop, or an order taxed on
  top: fix the stock (or record it by hand) and tap **Retry**, or refund
  the order in Shopify and **Dismiss…** it with a reason. Dismissing an
  order also closes refunds of it that are waiting, and any other delivery
  of the same order. A dismissal is final: if Shopify sends the order (or
  a dismissed refund) again, it is not recorded ("Earlier delivery
  closed, not recorded"), so dismiss only an order you refunded or
  recorded by hand.
- The item's sheet follows the item: after **Retry** it shows the new
  status, attempt count and reason, and it closes by itself when the item
  is done. It cannot be closed while a retry or a link is being saved.
- Shopify is listed under More (and on the iPad rail) for admins only.
- Items under **Waiting** are retried automatically (1 minute, doubling, up
  to 8 tries); **Recent** shows what was done or dismissed in the last 7
  days. **Open event** shows what Shopify sent.

### Link a Shopify customer (admins)

- Steps: **More → Shopify → Events** → open the order → **Customer** →
  **Link to a BICII customer**. Customers with the same email are listed
  first as "Candidate — same email is not proof"; any customer can be
  searched. Give a reason (how you know it is them) → **Link customer**.
- The link applies to later orders. Sales already recorded are not changed;
  the toast says how many earlier online sales show the customer through
  their Shopify ID.

### Shopify settings and events (admins)

- **More → Shopify**: the connection (Live, Test (fake) or Not connected),
  the shop, the API version and the webhook address to give Shopify; the
  online location; the storefront address (used for the Buy online link on
  public item pages); and **Record Shopify test orders as sales**, which
  needs a reason to change and shows a warning while it is on. Setup and
  recovery: [RUNBOOK "Shopify"](RUNBOOK.md#shopify).
- **Events** lists every webhook, searchable by order name (which also
  finds the order's refunds, named "Refund … of #1042") or webhook id
  and filterable (Failed, Rejected, Processed, Skipped). A delivery whose
  signature did not match is **Rejected** and keeps no body; nothing was
  recorded from it.

### Read reports

- Steps: **Reports** (More on a phone, the rail on an iPad). Choose
  **Day**, **Week** (Monday to Sunday) or **Month**, step with the arrows
  (or `[` and `]` on a keyboard), tap the dates to pick another day, or
  **Custom** for any range up to two years. **Today** comes back to now.
- Choose the **Date basis** (View financial reports): **Sale date** is the
  financial figure (jobs on the day they were completed, sales on the day
  they were paid); **Check-in**, **Completed** and **Collected** count
  jobs only, on that day. So one job shows on different days: checked in
  Monday, completed Wednesday, collected Friday. A job that is not
  finished shows only on Check-in, and a reopened job leaves its old
  completion day until it is completed again (D100, D101).
- Success looks like: Gross sales and the counts at the top; with View
  costs also Direct costs, Yield, Cult Commons and BICII after Cult
  Commons. Below: the period day by day (or week by week), the
  **Breakdown** by job or sale, product, category, service, mechanic,
  ownership or channel (tap a row for the job, the sale or its lines),
  **Stock at cost now** (stock at this moment, whatever period you chose)
  and **Activity** (jobs, appointments and stock, for everyone).
- Refunds are shown beside gross sales, "Refunds recorded: … — not
  deducted from the figures above", and never change gross, yield or Cult
  Commons (D102, a build default the owner is asked to confirm).
- **Export CSV** downloads the table beside it. On an iPhone or iPad
  app it opens in a new window: use Share → Save to Files. The file is a
  snapshot of the moment you export; costs are in it only if you have
  View costs.
- If it fails: "Too many rows to export" means choose a shorter range;
  "Figures changed while exporting" means try again
  ([R-057](RISKS.md#r-057--csv-exports-stop-at-50000-rows-and-refuse-when-figures-change-mid-export)).
  "Costs, yield and Cult Commons need the View costs permission" and
  "… need the View financial reports permission" mean ask an admin.

### Read Customer payments in Reports

- Before you start: View financial reports (admins and managers).
- Steps: **Reports**, any period; **Customer payments** is in the
  financial part, after the Breakdown. The date basis does not apply: it
  counts money by the day it moved.
- Success looks like: five figures with their counts: **Taken online**
  (deposits and balances), **Refunded online**, **Recorded at the
  counter**, **Given back at the counter** and **Net taken**. They are not
  sales ("Not sales: money taken and given back by the day it moved."),
  and the counter figure is only what an admin recorded, never the till's
  takings. **Held on jobs now** (this moment, whatever period) lists, each
  with its own total: **Paid on open jobs** (deposits and payments ahead
  of work not finished), **Paid on jobs awaiting collection** (paid up to
  the bill, with still to pay) and **Paid above the bill**. On the Sale
  date basis a job counts as sales on the day it is completed, so the
  second list is already in that figure and the others are not. A row
  opens its job. **See each payment** lists every movement, newest first,
  100 at a time (refunds and give-backs as negative amounts; counter rows
  say who recorded them and when, which shows a back-dated record).
- **Export CSV** beside each: `bicii-payments-<from>_<to>.csv` for the
  period's movements and `bicii-payments_held-<day>.csv` for what is held
  now.
- If it fails: "You can't open this" without View financial reports.
  Covered by `tests/e2e/reports.spec.ts`.

### Check what needs attention (Exceptions)

- Steps: **Reports** → **Exceptions** (or **See all** under Needs
  attention on Today). The count on the Exceptions link is how many you
  can see.
- Success looks like: the exceptions grouped by what is wrong, the most
  serious first: Stock below zero, Items in an impossible state, Lines in
  another currency, Unsettled consignments (Manage consignments or View
  costs), then overdue jobs, jobs not collected and stale holds. Each row
  says what is wrong and how long ago it started; tap it to open the
  record and fix it there (adjust stock with a reason, restock, settle,
  void or return). Stock and item rows also link to **Open stock
  reconciliation** for that product.
- Nothing here changes anything: an exception clears by itself once its
  cause is fixed. "No exceptions" with the time checked means all clear.
- **Export CSV** downloads the list you can see (at most 200; with more,
  fix the most urgent first and export again).
- If it fails: an item still listed after the fix, ask an admin (it may
  be a bug to report, [RUNBOOK](RUNBOOK.md#when-reconciliation-or-exceptions-show-a-problem)).

### Check stock against the ledger

- Steps: **Inventory** → **Reconcile stock** (or Reports → **Stock
  reconciliation**, or **Check against the ledger** on a product).
- Success looks like: "Every product reconciles with the ledger" and
  "Every item reconciles with the ledger" under **Problems only**.
  **Everything** lists every product by location and every unique item,
  with what the ledger says (on hand, where, and the sale or job that
  last moved it).
- If a row shows a problem: open it (tap the row). With Adjust stock,
  **Fix with a stock adjustment** opens the product, where Adjust stock
  records a counted correction with a reason. Stock below zero is allowed
  when a job part was used before the stock was received: count the shelf
  and adjust, or receive the delivery. A problem that stays after the
  right fix is a bug: tell an admin.
- **Export CSV** downloads products by location or unique items, as
  shown (Problems only or Everything, one product or all).

### Change when unsettled consignments are flagged (admins)

- Steps: **Reports** → **Exceptions** → **Change** beside "Alert
  unsettled consignments after N days". Enter 1 to 365 days and **Save**.
- Success looks like: a toast "Alert unsettled consignments after N
  days"; a sold consignment item with money still owed shows under
  Unsettled consignments once its latest sale is more than N shop days
  old (D107; 30 by default).
- If it fails: "Choose between 1 and 365 days" — the number stays in the
  box to correct. Only admins see Change; everyone else sees the number.

### Set the deposit on indent quotes (admins)

- Before you start: Stripe must be on for a deposit above 0 (D157;
  [RUNBOOK](RUNBOOK.md#stripe-switching-on)). Settings → **Customer
  payments** says **Live** (or **Test mode** or **Fake Stripe (development
  and tests only)** off production), or **Off** with the reason in words,
  naming the setting to fix (never its value).
- Steps: Settings → **Customer payments** → **Change** beside "No deposit
  is asked on indent quotes" (or "Customers pay N% …"). Enter the percent
  (0 to 100) and **Save**. The build ships at 0 and suggests 50% (D151);
  the shop's current production setting is 100%, set by the owner on
  2026-10-15 SGT.
- Success looks like: a toast "Customers pay N% of the approved indent
  parts after answering" (or "No deposit is asked on indent quotes" for
  0). Quotes sent from now on take that percent; quotes already sent keep
  theirs, and the amount is fixed when the customer answers. The change
  is kept in the settings history.
- Also on the page: with Stripe on, the **Webhook endpoint** to paste into
  Stripe's Dashboard, the API version and the seven events to send;
  **Recent Stripe deliveries**, the latest 20 deliveries and checks with
  what each did ("Payment recorded", "Rejected · Signature didn't match",
  …) and a link to the job.
- If it fails: "Set up Stripe first: customers can't pay a deposit until
  it is." while Stripe is off (0 is always allowed, which is how to switch
  deposits off first, before removing Stripe's keys). "Choose from 0 to
  100%." for anything else; the number stays in the box to correct. If
  the page shows "Deposits are asked but Stripe is off", set the deposit
  to 0 or fix Stripe. Only admins see Settings → Customer payments.

### Send a payment link

- Before you start: the job is **Completed** or **Ready for collection**,
  at least $0.50 is still to pay, nothing paid online is still being
  confirmed by Stripe, and Stripe is on (D156; any staff member).
  Otherwise the Customer payments card shows no **Send payment link**.
- Steps: on the job's **Customer payments** card press **Send payment
  link**. The sheet shows **Still to pay** and how to send it:
  **WhatsApp** (only with a mobile number it can use), **Email** (only
  when emails are set up and the customer has an address) or **Copy
  link**; and **Link works for (days)**, 1 to 30, 7 by default. When a
  link is already live it says "This replaces the link sent on …. That
  link stops working." (or, when that link has already expired, "This
  replaces the link sent on …, which expired on ….") Press **Create
  link**.
- Success looks like: **Payment link ready to send** with the link (shown
  only now: if it is lost, send a new one), "It asks $… now and works
  until …", **Open WhatsApp** with the message, or "Emailed to …". The
  card shows the link's line and the timeline "Payment link for $… sent".
  The customer's page always asks what is left to pay at that moment, so
  a payment taken meanwhile is never asked twice.
- What the customer sees: "Hi <first name>, here is your bill", the
  job's lines (never a unit number or serial), Job total, Paid so far and
  **Balance due**, then **Pay $…** through Stripe (card or PayNow) and
  the line "Payments are taken by Stripe on its own page, so Stripe's
  privacy policy applies to them; BICII never sees or keeps your card
  details." Back from Stripe it says "Thanks. We're confirming your
  payment with Stripe…" until Stripe confirms, then "Nothing is left to
  pay. Thank you." If the bill went up while they were on Stripe's page
  (an admin voided a counter payment, say), it says "Thank you. Stripe has
  confirmed your payment. $… is still due on this bill." with **Pay** for
  what is left. A stopped link says "This payment link was replaced or
  stopped. Ask the shop for a new one."; an expired one "This payment
  link has expired. …". A customer who finishes paying on a Stripe page
  left open after the link stopped (Collected, reopen, a new link) also
  comes back to the stopped-link sentence: the money is recorded and
  flagged on the job, but the page does not say it went through
  ([R-092](RISKS.md#r-092--open-checkout-tabs-can-still-be-paid-for-up-to-60-minutes)).
- The link stops by itself when you send a new one, when the job is
  reopened and when it is collected
  ([R-091](RISKS.md#r-091--a-balance-link-is-a-payment-capability)).
  Sending a new link also closes the old link's open Stripe page where it
  can; if a payment on it went through meanwhile, the sheet says so ("A
  payment on the earlier link has just gone through. …").
- If it fails: "Stripe isn't set up, so the customer can't pay online.
  Take the payment at the counter." while Stripe is off; "The email
  didn't go out. Copy the link and send it another way." when the email
  failed (the link still works). Covered by `tests/e2e/payments.spec.ts`
  (Copy link; WhatsApp and email are unit-tested only).

### Take payment at collection

- Before you start: the job is **Ready for collection** (or completed).
  Read the Customer payments card and the line under **Lines**: they say
  what was paid, online and at the counter, and what is left.
- Steps, by how the customer pays:
  - Through Stripe on their phone: **Send payment link** (any staff
    member, above), the customer pays on the page, and the card shows the
    balance **Paid** (press **Check with Stripe** if it doesn't after a
    minute). Then **Collected…**: it says "$… was paid online. Nothing
    is left to pay; take nothing.", and **Mark collected**.
  - Cash, the shop's card terminal or the shop's own PayNow: take what
    **Collected…** says ("Take only $…") and **Mark collected**. Nothing
    needs recording: money taken as the bike leaves is not recorded in
    BICII (D161e). Ask an admin to record a counter payment only for
    money that came in **before** collection (a deposit, or part of the
    bill on an earlier visit), so the page, the link and Collected ask the
    right amount.
- While Stripe is still confirming a payment, **Collected…** says
  "Stripe is still confirming $Z paid online, so $Y still to pay may
  already be covered. Press Check with Stripe before taking anything."
  and names no amount to take. Press **Check with Stripe** on the
  Customer payments card first, and take nothing until the payment shows
  **Paid**; then **Collected…** says what is left, if anything. BICII
  does not stop you marking the job collected meanwhile
  ([R-093](RISKS.md#r-093--mark-collected-is-allowed-while-stripe-is-confirming-a-payment)).
  Collected stops any payment link.

### Record a counter payment (admins)

- Before you start: you are an admin (D161a; a manager or mechanic sees
  no **Record counter payment**). The job is not cancelled. BICII records
  the money; it moves none. It works with Stripe off.
- Steps: on the job's **Customer payments** card press **Record counter
  payment**. Under **What it is for** choose a deposit that is due (or
  was refunded in Stripe), "Record the $120.00 deposit for the quote
  answered …" (its amount is fixed: the deposit's), or **Towards the
  bill** (any amount, prefilled with what is left to pay, also before the
  work is done). Choose **Paid by**: **Cash**, **Card** (the shop's own
  terminal), **PayNow** (the shop's own QR), **Bank transfer** or
  **Other**. **Paid on** is today unless the money came in on an earlier
  day (at most 29 days back, never before the check-in or, for a
  deposit, the quote's answer). Add a **Reference** (the receipt, terminal
  or PayNow reference) and a **Note** if useful. Press **Record $… cash…**
  (or "by card…", "by PayNow…"), check the question that repeats the
  amount and method, then **Record $…**.
- Warnings, which never stop you: "The customer's quote page still asks
  the full $… deposit online. Record the deposit instead if this money is
  for it."; "The deposit stays 'due' on this card, and is asked online
  again if the job is reopened, unless you record it as the deposit.";
  "This is $… more than still to pay; it will show as paid above the
  bill."
- Success looks like: a toast "Recorded $… at the counter on J-…", the
  row under **At the counter** ("Deposit · PayNow", the amount, "Paid …
  · Ref … · recorded by …"), **Paid at the counter** in the totals and the
  timeline "Deposit of $… taken at the counter (PayNow)" or "$… taken at
  the counter (Cash)". A recorded deposit reads **Deposit paid**: the part
  is no longer held back from ordering and the customer's page stops
  asking for it.
- When the customer had a Stripe page open for this job, BICII closes it.
  If a payment on it went through first, the sheet stays open and says
  "An online payment for this job has just gone through; refund it in
  Stripe or record the counter money as given back."; if it could not be
  closed, "An online payment page may still be open for this job; use
  Check with Stripe."
  ([R-092](RISKS.md#r-092--open-checkout-tabs-can-still-be-paid-for-up-to-60-minutes)).
- If it fails: the database's sentence (for example, a deposit that is
  already paid, an amount other than the deposit's, a day in the future
  or before the check-in); what you entered stays to correct. Covered by
  `tests/e2e/payments.spec.ts` (a deposit by PayNow).

### Void a counter payment or record it as given back (admins)

- Before you start: you are an admin. BICII moves no money: a give-back
  happens at the counter first, and is recorded on the day the money goes
  back.
- Steps: on the counter row press one of:
  - **Void (recorded in error)…**: it never came in (a typo, the wrong
    job). It no longer counts, and Reports leave it out of the day it was
    taken, as if it never came in. Record it again, with its original
    date, if it was only wrong.
  - **Given back…**: the shop handed the money back. It no longer counts
    on the job; Reports keep it on the day it was taken and show it
    given back today. To give back only part (for example $400 taken, a
    $380 bill), record the $400 as **Given back…**, then record the $380
    kept as a new counter payment dated today, not back-dated, or that
    day counts twice.
  Answer "Why was it recorded in error?" or "Why was it given back?",
  then **Void payment** or **Record as given back** (or **Keep payment**
  to leave it).
- Success looks like: a toast "$… voided: recorded in error" or "$…
  recorded as given back"; the row struck through with "Recorded in error:
  …" or "Given back: …", who and when; the timeline "Counter payment of $…
  voided (given back)". A voided deposit is due again.
- If it fails: "Give a reason."; a payment already voided the other way
  is refused. Managers see a counter problem in Exceptions, but only an
  admin voids
  ([R-090](RISKS.md#r-090--a-counter-payment-rests-on-an-admins-word)).
  Covered by `tests/e2e/payments.spec.ts` (Given back).

### Invite a colleague

- Before you start: you need Manage staff (an admin has it; anyone else
  only as extra access). An admin invites an Admin, a Manager or a
  Mechanic; anyone else invites Mechanics only (D93).
- Steps: Settings → **Staff** → **Invite staff**. Enter **Name** and
  **Email**. An admin picks the **Role** (Admin, Manager or Mechanic;
  Mechanic is chosen first, and each role's one line is listed under the
  picker). Anyone else sees "They join as a Mechanic." instead of a picker.
  Press **Invite**.
- Success looks like: "<email> can now sign in." and "They join as a
  Mechanic." (or the role picked). The colleague opens the Admin, enters
  that email and types the 6-digit code emailed to them; there is no
  password to hand over. **Set extra access** (or **Open their page** for
  an admin) opens their page.
- If it fails: "An account with that email already exists."; "Only an
  admin can invite a manager." (or an admin) when you are not an admin.
  Covered by `tests/e2e/staff.spec.ts` and `tests/e2e/roles.spec.ts`.

### Change someone's role

- Before you start: admins only, and never your own role (D93). The shop
  always keeps at least one active admin.
- Steps: Settings → **Staff** → open the person. In the **Role** card pick
  **Admin**, **Manager** or **Mechanic** and press **Change role…**. The
  sheet "Change <name> to <Role>?" says what changes: what the new role
  has (for example "Managers have every permission except Manage staff,
  and can record refunds."), any extra access the new role already
  includes ("Their extra access to … is included in the new role and will
  be removed.") and anything they lose. Optionally answer **Why?** (up to
  500 characters), then press **Change role**.
- Success looks like: "<name> is now a <Role>"; the badge beside their name
  shows the new role, the **Extra access** card offers only what the new
  role does not include, and **History** reads "Role changed from <From>
  to <To>" with your name and the reason, plus "Extra access: … removed"
  for each exception the role now includes. Changing the role back later
  does not restore removed extra access (D92).
- If it fails: on your own row the picker is off with "You can't change
  your own role."; "The shop must keep at least one active admin." when the
  change would leave no active admin; "Someone changed their role in the
  meantime. Reload and try again." when another admin changed it after you
  opened the page (nothing changes; reload to see their current role and
  what a change would do); anyone who is not an admin sees the
  role read-only with "Only an admin changes roles." Covered by
  `tests/e2e/roles.spec.ts`.

### Give someone extra access

- Before you start: you need Manage staff. An admin changes anyone's extra
  access but their own; anyone else changes mechanics' only, only
  permissions they hold themselves, never Manage staff and never their own
  (D11, D93).
- Steps: Settings → **Staff** → open the person → **Extra access**. The
  card first says what the role includes ("Included in the Manager role:
  …"); those are never offered as switches. Turn a switch on or off: it
  applies at once.
- Success looks like: "<Permission> granted" or "<Permission> removed";
  History reads "Extra access: <Permission> granted" (or removed) with your
  name; their profile marks it **Extra access**. An admin's card reads
  "Admins have every permission; there is nothing extra to grant."; a
  manager's offers only **Manage staff**; a mechanic's all seven.
- If it fails: a switch you may not change is off with the reason under it
  (for example "Only an admin changes an admin's or a manager's access.").
  Covered by `tests/e2e/staff.spec.ts` and `tests/e2e/roles.spec.ts`.

## Roles and limits

Everyone has one of three roles (D90, [ADR-021](decisions/ADR-021-staff-roles.md)),
shown as a badge on Settings → Your profile and on Settings → Staff:

| Role | What it lets you do |
|---|---|
| Admin | Everything: every permission below, **Record refund** on a sale, ordering an indent part before its deposit is paid (D152), cancelling an indent item that was never fitted on a collected or cancelled job (D149), and the admin-only settings: shop hours, closures, booking capacity, appointment types, the Cult Commons rate, staff and roles (inviting or changing admins and managers, changing anyone's role) (D91, D93), Settings → **Labels and printers** (the QR address, printers, label templates), Settings → **Customer payments** (Stripe and the deposit on indent quotes, D157), **Record counter payment** and its two voids on a job (D161) and **More → Shopify** (settings, the queue, events, linking variants and customers, D86) |
| Manager | Every permission below except Manage staff, **Record refund** on a sale (D91, D94), ordering an indent part before its deposit is paid, with a reason (D152), and cancelling an indent item that was never fitted on a collected or cancelled job, with a reason (D149). Not the admin-only settings, Labels and printers, Shopify, Settings → Customer payments or recording counter payments |
| Mechanic | The workshop: what everyone can do (next paragraph). Anything more only as extra access |

Everyone signed in can use customers, bikes, photos, jobs and their lines,
parts from stock, appointments and check-in, in-store sales, Scan, search,
printing labels (and confirming or failing print jobs), and read the
schedule, appointment types, services and locations. Selling prices and
sale totals are visible to all; costs are not.

**Extra access (exceptions).** An admin can give one person a single
permission on top of their role (D92): for example a mechanic who orders
parts gets Manage purchasing alone, or a manager who invites colleagues gets
Manage staff. A mechanic can have any of them; a manager only Manage staff
(their role already includes the rest); an admin none. Your profile marks
each one **Extra access**. Extra access never includes **Record refund**,
ordering an indent part before its deposit is paid (D152) or cancelling
an indent item on a collected or cancelled job (D149), which are for
admins and managers only, or recording and voiding counter payments
(D161), which are for admins only. Anyone signed in can send a payment
link (D156). Each permission, whether it comes
from your role or as extra access:

| Permission | What changes for you |
|---|---|
| View costs | Cost, yield and Cult Commons on jobs, lines, products, units, movements and sales (the sale sheet's preview and "Below cost" warning); Unit cost on manual lines and adjustments; the Cult Commons rate card; consignment money (balances, amounts owed, charges, payments, item history, agreement photos) read-only |
| View financial reports | The Money section on Today, and on Reports the figures, date basis, breakdown, line drill-down, stock at cost now, Customer payments (with **See each payment**) and their CSV exports (costs inside them also need View costs) |
| Adjust stock | **Adjust stock** on a product; **Restock…** a unit sold on a sale (a consigned one also needs Manage consignments) |
| Manage inventory | New and edited products and units, **Transfer**, publication, **Publish online** and **Sync now**, services, categories and locations; with Adjust stock also **Split off as unique item** |
| Manage staff | Settings → Staff: invite (the colleague signs in with an emailed code; no password to hand over), extra access and deactivation (it ends their sessions at once). Without the Admin role: mechanics only, only within your own permissions, never Manage staff and never your own row ([OPERATIONS.md](OPERATIONS.md#product-administration), D93) |
| Manage consignments | **Receive item**, **New consignor**, edit and archive consignors, **Show payout details**, **Edit terms**, **Add charge** and **Void…**, **Return to consignor…**, **Record payment** and **Reverse…**; with Adjust stock, **Restock…** a consigned unit; sees consignment money |
| Manage purchasing | **Purchasing**: new and edited suppliers and their product links, **New order**, lines, **Submit order**, **Cancel order…**, **Receive**, **Reorder**; sees purchase costs on purchasing screens (line, receipt and last costs, order totals and history). A mechanic given it as extra access sees those costs on purchasing screens only, not job, sale, product-page or report costs (D60); a manager sees them everywhere through View costs |

Without a permission, its buttons are absent and the figures are not sent
to your screen at all. Opening a page you may not use shows "You can't open
this"; an action you may not take says "You don't have permission to do
that." Ask an admin.

Everyone can open Consignment, its consignors and items, and the asking
prices; who is owed what, payments and agreement photos need Manage
consignments or View costs (D48). Anyone may record an in-store sale and
see its total; its cost, yield and Cult Commons need View costs, and an
admin or a manager records a refund (D48, D94).

Everyone can open Purchasing, its orders and suppliers, and see what is
ordered, received and still to come; costs on those screens need View
costs or Manage purchasing (D60).

Everyone can open Reports and see Activity and jobs by mechanic, and
export that list; sales, yield and Cult Commons figures and Customer
payments need View financial reports, and costs inside them View costs
(D30, D154).

Everyone can open Exceptions and Stock reconciliation and export them;
unsettled consignments are listed only with Manage consignments or View
costs, Shopify failures only for admins (D108),
and only an admin changes the unsettled-consignment threshold (D107).

There is no reschedule and no customer messaging; the only data exports
are the report CSVs. Help: ask the owner or an admin.
