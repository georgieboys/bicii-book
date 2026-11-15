# ADR-027: Product groups (variants)

Date: 2026-11-15.
Status: accepted (the owner asked for it on 2026-11-15 SGT: "build the
product groups for variants").
Decision owner: Abhishek Cherian George (owner) for business meaning;
design by the build agent.

## Context

The shop sells one style in several colours or sizes (the 2026-11-14
shipment: five retro saddle colours, four hollow saddles, five jockey wheel
colours). Stock, cost, labels and consignment are per colour, so each
colour is its own BICII product. Online, each product was its own Shopify
product with one variant (D84), which is poor for shoppers and for search:
five pages for one saddle.

Two ways out: real variants inside one BICII product (stock, labels, cost,
consignment and the ledger per variant: a rewrite of D45, the ledger and
every screen), or a thin grouping over the existing products. The owner
asked for the second.

## Decision

1. **A group over products (D241).** `product_groups` (G-######: name,
   description, brand, the name of its one option such as "Colour").
   A member product carries `product_group_id` and `option_value`
   ("Black"); values are unique in the group, archived members included,
   because their Shopify variants stay. Everything else (stock, price,
   cost, labels, consignment, sales, the ledger) stays per product,
   unchanged.
2. **Membership rules (D242).** A product with Shopify ids cannot join,
   leave or change its group (its standalone Shopify product would be
   orphaned); a product linked to a Shopify-made product never joins;
   an archived group takes no members, and a group with live members is
   not archived.
3. **One Shopify product per group (D243).** Handle `bicii-g-<n>`; title,
   description and vendor from the group; one variant per member that is
   published online with a price, or was pushed before; the members'
   public photos; ACTIVE while any member is effectively online. Each
   member keeps its own sync job, stock and price (D83 unchanged). The
   first job to push a changed group runs productSet for the whole group,
   stores every member's variant ids (`record_product_group_push`) and
   queues the others, which then set only their own stock. Inbound orders
   are unchanged: each variant maps to its product.
4. **The public view (D244).** `reporting.public_items` gains
   `group_short_id`, `group_name`, `option_name` and `option_value`; a
   grouped row's Buy-online link opens its variant (`?variant=`). The
   public site's item page lists the group's choices.
5. **Handles (D245).** A grouped member's handle is its group's.

## Consequences

- One page per style on Shopify and a colour picker on the public site,
  with no change to inventory, money or consignment semantics.
- A product sold online on its own before grouping cannot join a group;
  re-enter it as a new product (R-120).
- A consigned batch and a shop-bought batch of the same colour are two
  products and cannot share an option value in one group (R-120): give
  the second a distinct value or leave it out of the group until the
  first sells through.
- Each member's job may run productSet with the same input; the group
  hash keeps that to the first job after a change.
