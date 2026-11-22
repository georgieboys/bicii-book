/** The paged list's Previous / Next and its "31 to 60 of 132" summary. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageNav, pageRange } from "@/components/ui/page-nav";

describe("pageRange", () => {
  it("says which rows the page shows", () => {
    expect(pageRange(1, 30, 30, 132)).toBe("1 to 30 of 132");
    expect(pageRange(5, 30, 12, 132)).toBe("121 to 132 of 132");
    expect(pageRange(9, 30, 0, 132)).toBe("0 of 132");
  });
});

describe("PageNav", () => {
  it("links the neighbours it is given and shows nothing on a single page", () => {
    const { rerender, container } = render(
      <PageNav
        label="Products"
        summary="31 to 60 of 132"
        previousHref="/inventory"
        nextHref="/inventory?page=3"
      />,
    );
    expect(screen.getByRole("navigation", { name: "Products: pages" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Previous" }).getAttribute("href")).toBe("/inventory");
    expect(screen.getByRole("link", { name: "Next" }).getAttribute("href")).toBe(
      "/inventory?page=3",
    );
    rerender(
      <PageNav label="Products" summary="1 to 4 of 4" previousHref={null} nextHref={null} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
