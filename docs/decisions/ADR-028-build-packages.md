# ADR-028: Build packages (labour and a parts budget)

Date: 2026-11-17.
Status: accepted (the owner's requirements 2026-11-17 SGT).
Decision owner: Abhishek Cherian George (owner) for business meaning;
design by the build agent.

## Context

The public site sells four full builds for a frame (Classic S$390,
Classic+ S$785, Restomod S$1,075, Restomod+ S$1,680) and three build-only
packages on the customer's own bike (Full Send S$220, Clean Slate from
S$325, Strip and rebuild S$360). The owner, 2026-11-17:

- a full build includes products and service revenue: the frame is full
  product revenue; of the build, S$180 goes to labour (service revenue)
  and the balance is the parts budget (product revenue);
- the parts actually fitted are assigned to the build and make up the
  budget, with individual prices adjustable, or one gross discount across
  all of them so the total matches the budget, because not every part can
  be billed at its full customer price;
- payment is taken in full at checkout on Shopify, but recognised as
  revenue only when the build is delivered;
- the agent's defaults he accepted: parts are never charged above their
  shelf price, so parts under budget leave the difference to labour
  (service revenue); S$180 for all four, changeable per package.

The workshop's jobs already split revenue this way: a job's service lines
are service revenue and its part lines product revenue, recognised when
the job is completed (D32). What was missing was the package, its fixed
price and a way to price the parts to the budget, since lines are
immutable except voiding (D15).

## Decision

1. **Packages (D246).** `build_packages`: kind (`full_build`,
   `build_only`), name, price (or a "from" price), labour amount, the
   service the labour line is recorded as, public and sort order. Admins
   write them; staff read; `public_build_packages()` gives the site the
   public, live ones without the labour split.
2. **A job's package (D247).** `work_order_builds`, one per job, set by
   `set_work_order_build` on an open job: it snapshots the price and
   labour amount and adds the job's labour line, a service line at the
   labour amount. A "from" price above the base is labour.
3. **Repricing (D248).** A live part line or the labour line of a job with
   a package may have its sale price changed, nothing else, only through
   `reprice_build_line` and `fit_build_to_budget`, only while the job is
   open, each with a job event; the first change keeps the original price
   in `unit_list_price_snapshot`. The line rules trigger allows this one
   path when the private writer marks its own statement; every other line
   stays immutable except voiding.
4. **Fit to budget (D249).** The parts are the job's live inventory lines.
   Above the budget at list prices, each part's price is its list price
   times budget / list total, to the cent (the one gross discount); at or
   under it, they stay at list. The labour line takes the rest, so the
   package always adds up to its price. Other service and manual lines are
   outside the package and billed on top.
5. **Revenue (D250).** Unchanged rules: the completed job recognises the
   labour line as service revenue and the parts as product revenue. A
   price below cost is allowed and reports as a loss line (D1). The frame
   remains its own sale at full price.
6. **Clearing (D251)** voids the labour line and returns repriced parts to
   their list prices.

## Consequences

- The package's revenue split is in the ledger, not in a side table: the
  reports, Cult Commons and margins work unchanged.
- A repriced line shows its final price; the history is in the job's
  `line_repriced` and `build_fitted` events and the list price column.
- Selling online and the site's signed-in screens: see the amendment
  below.

## Alternatives considered

- **Shopify variants of each frame** (frame plus Classic, and so on): the
  frame is one unit, so each variant would carry its own stock and the
  frame could sell twice; the package money would land on the consigned
  frame's sale; and every price change would touch every frame.
- **Void and re-add to reprice:** keeps strict immutability but moves
  stock out and back in for every fit, and a quantity part's consigned
  FIFO item could change.

## Amendment 2026-11-17: selling full builds online (D252-D256)

The owner: full payment is taken on Shopify at purchase, but recognised as
revenue only when the build is delivered.

1. **Packages on Shopify (D252).** A full build is its own Shopify
   product, one variant at the package price, inventory not tracked (it is
   a service). An admin presses Put on Shopify in Settings; the Admin
   pushes it straight away (packages change rarely, so no queue) and
   records the ids. The site's frame page offers each online full build
   with a Shopify cart link holding the frame and the package
   (`public_build_offers`).
2. **Orders (D253).** A line whose variant is a package's becomes a build
   order per unit, at its share of what Shopify charged; the frame is the
   order's sale as before.
3. **Money held (D254).** A build order is customer money held, like a
   deposit: on its job it counts as paid (`paid_shopify`) and in the
   payment movements, never in sales. The revenue is the job's lines at
   completion (D250), so the build counts when it is delivered.
4. **Linking (D255)** puts the order on the build's job and sets its
   package.
5. **Refunds (D256)** stay on the order's sale; staff settle the build
   side (R-122).

The build-only packages are offered in the site's signed-in screens (the
bike page and the booking form), named in the booking's note; they are
paid at intake.

## Amendment 2026-11-20: frame options and pictures on Shopify (D257-D259)

The owner, 2026-11-20: the full builds on Shopify need pictures and three
frame options: a prepared frame from BICII and the customer's own prepared
frame at no extra charge (the own frame accepted only after an inspection,
with cleanup quoted separately), and a donor bike at S$185. The site has
said the same since 2026-11-19 ("Where the frame comes from").

1. **Frame options (D257).** Each full build's Shopify product gets a
   "Frame" option and a variant per frame option, pushed with the product
   group push (D243) untracked. The BICII-frame variant keeps the original
   SKU, so its id, which `public_build_offers` puts in the site's cart
   links, survives. The donor-bike variant exists only when the package has
   an active donor service; its price is the package price plus that
   service's price, from `build_package_online_prices` so Postgres does the
   arithmetic. The product description explains each option.
2. **Donor money (D258).** An order on the donor variant becomes a build
   order whose `donor_amount` is the strip's share. Linking it adds a line
   of the donor service for that amount and sets the build's price to the
   rest, so labour, parts budget and the job's total still add up to what
   the customer paid.
3. **Pictures (D259).** A package has an `image_url`; the four full builds
   point at the site's generated pictures, so a price change on the site
   redraws them on the next deploy and a re-push sends them to Shopify.

Considered: a separate Shopify product per frame option (three products a
package, harder to compare); a variant price computed in TypeScript (the
money rule keeps it in Postgres); charging the strip as a second product in
the cart (the customer could drop it).

