import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Timeline } from "@/components/domain/job-timeline";
import type { TimelineEntry } from "@/lib/domain/workshop";

const entry = (id: number): TimelineEntry => ({
  id,
  type: "note_added",
  at: "2026-10-04T02:00:00Z",
  actorName: "Nur",
  title: "Note added",
  detail: `Note ${id}`,
  tone: "neutral",
});

describe("Timeline", () => {
  it("says nothing about earlier events when it shows them all", () => {
    render(<Timeline entries={[entry(2), entry(1)]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says when older events, the check-in among them, were left out, and links to more", () => {
    render(
      <Timeline entries={[entry(3), entry(2)]} truncated moreHref="/jobs/x?events=all#timeline" />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Showing the newest 2 events. Earlier ones, including the check-in, are not shown.",
    );
    expect(screen.getByRole("link", { name: "Show earlier events" })).toHaveAttribute(
      "href",
      "/jobs/x?events=all#timeline",
    );
  });

  it("links an entry's title when it has an href (the appointment a job came from)", () => {
    render(
      <Timeline
        entries={[
          {
            ...entry(4),
            type: "appointment_linked",
            title: "Opened from the appointment on Tue 6 Oct 10:00 (Service drop-off)",
            detail: null,
            tone: "info",
            href: "/appointments/e2000000-0000-4000-8000-000000000003",
          },
          entry(3),
        ]}
      />,
    );
    expect(
      screen.getByRole("link", {
        name: "Opened from the appointment on Tue 6 Oct 10:00 (Service drop-off)",
      }),
    ).toHaveAttribute("href", "/appointments/e2000000-0000-4000-8000-000000000003");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("quotes what someone wrote, but not the app's own details", () => {
    render(
      <Timeline
        entries={[
          {
            ...entry(6),
            type: "build_extra_marked",
            title: "Rear derailleur charged on top of the package",
            detail: "$89.00",
            plain: true,
          },
          entry(5),
        ]}
      />,
    );
    expect(screen.getByText("$89.00")).toBeInTheDocument();
    expect(screen.queryByText("“$89.00”")).toBeNull();
    expect(screen.getByText("“Note 5”")).toBeInTheDocument();
  });

  it("still says so when there is no further page", () => {
    render(<Timeline entries={[entry(1)]} truncated moreHref={null} />);
    expect(screen.getByRole("note")).toHaveTextContent("Showing the newest 1 events.");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
