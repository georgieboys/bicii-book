# ADR-029: Frame grades

Date: 2026-11-20.
Status: accepted (the owner's requirements 2026-11-20 SGT).
Decision owner: Abhishek Cherian George (owner) for business meaning;
design by the build agent.

## Context

The site set out frame prices as five named bands (Found gems S$200-349 up
to Collector pieces S$1,000+). The owner wants a shorthand to sell with:
"S, A, B, C. Two plus ratings for each ... S being best. This way when I
sell a build I can say b++ frame; classic + build." Grades give suggested
prices "with ability to fine tune": C steps S$50, B S$100, A S$200, S
S$500, and each letter starts at a round number.

## Decision (D260)

1. **Twelve grades**, C, C+, C++, B, B+, B++, A, A+, A++, S, S+, S++, in
   `frame_grades` with a suggested price each: C S$200, C+ 250, C++ 300,
   B 400, B+ 500, B++ 600, A 800, A+ 1,000, A++ 1,200, S 1,500, S+ 2,000,
   S++ 2,500. Admins may change a suggested price.
2. **A frame carries its grade** (`products.frame_grade`). The product form
   shows the grade's suggested price under Sale price with **Use it**; it
   never changes a price by itself, so a consigned frame's asking price
   and every hand-set price stay as they are.
3. **The site** reads the grades (`public_frame_grades`) for its frame
   pricing, so there is one copy of the suggested prices, and a frame's
   public page names its grade (`reporting.public_items.frame_grade`).

Like the bands it replaces, a grade is not a verdict on safety; the site
keeps saying so. (Amended below: a grade is the frame itself, and its
price is a base.)

Considered: an enum (a price per grade would still need a table);
grade-driven prices (the owner wants to fine tune each frame); the site's
own copy of the prices (two places to change).

## Amendment 2026-11-20: a grade is the frame; its price is a base

The owner, 2026-11-20: "A frame may be a B plus grade, but it may have
extra work done to it, like disc brakes or repainting or kintsugi. So
pricing has to be separate from the grade itself." A grade is about the
frame itself, before any work done to it, so it is set by judging the
frame, never read from its price. A grade's price (`suggested_price`) is a
base price: work done to the frame is priced on top. The Admin offers the
base under Sale price ("Base price for B+: $500.00, before any work on the
frame", **Use it**) and never changes a price by itself; it does not
suggest a grade from a price. This replaces "a grade is a price level" in
the decision above. The Frame grade field shows for products in a frames
category, or one that already has a grade.

## Amendment 2026-11-20: the grade on Shopify

The owner, 2026-11-20: the frames on Shopify show their grade. A graded
product's Shopify title ends "· B+ frame", it is tagged "Grade B+", and its
description ends with the owner's line "Frame grade B+ (C to S++, S best):
the frame itself, before any work done to it. Not a safety rating." The
line goes last (the owner chose first; moved after review) because Shopify
takes a product's search and link-preview snippet from the start of its
description, which should keep describing the frame. The sync state carries
`frame_grade`; a grade change queues the product's sync, and the migration
queued every product graded before that. A BICII-made product's tags are
BICII's, like its title and photos: an ungraded one is pushed with none, so
removing a grade removes its tag ([R-130](../RISKS.md#r-130--bicii-replaces-the-tags-of-the-products-it-made-on-shopify)).
Not shown on Shopify: a grouped product's grade (its listing is the
group's) and a product made in Shopify (price and stock only, D84). The
owner's grades for the three frames on Shopify, set after the migration:
P-000144 Marin Bolinas Ridge B, P-000145 KHS Montaña Descent B+, P-000146
KHS Comp B+.
