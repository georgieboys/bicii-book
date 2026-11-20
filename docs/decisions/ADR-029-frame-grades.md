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

Like the bands it replaces, a grade is a price level, not a verdict on
quality or safety; the site keeps saying so.

Considered: an enum (a price per grade would still need a table);
grade-driven prices (the owner wants to fine tune each frame); the site's
own copy of the prices (two places to change).
