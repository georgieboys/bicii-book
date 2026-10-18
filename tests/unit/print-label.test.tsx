import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
  usePathname: () => "/products/9a000000-0000-4000-8000-000000000011",
}));

const createJob = vi.fn();
vi.mock("@/app/(staff)/labels/actions", () => ({
  createPrintJobAction: (...args: unknown[]) => createJob(...args),
  setPrintJobStatusAction: vi.fn(),
}));

import {
  PrintLabelButton,
  type PrintLabelPreset,
  type PrintLabelSetup,
} from "@/components/domain/print-label";
import { LABEL_PRINTER_KEY } from "@/lib/printing/print-sheet";
import { labelLayoutSchema } from "@/lib/printing/schemas";
import type { LabelContent } from "@/lib/printing/types";

import { DEFAULT_LAYOUTS } from "../fixtures/label-layouts";

const ENTITY = "9a000000-0000-4000-8000-000000000011";
const BROWSER = "a8000000-0000-4000-8000-000000000001";
const PDF = "a8000000-0000-4000-8000-000000000002";
const TEMPLATE = "1ab00000-0000-4000-8000-000000000001";
const JOB = "a9000000-0000-4000-8000-000000000001";

const content = (price: string | null): LabelContent => ({
  kind: "product",
  shortId: "P-000011",
  qrPayload: "http://localhost:4000/q/P-000011",
  name: "Bar tape",
  price,
  currency: "SGD",
  sku: "TAPE-1",
  identity: [],
  serialNumber: null,
});

const setup = (
  price: string | null = "39.90",
  isPublic: boolean | null = true,
): PrintLabelSetup => ({
  content: content(price),
  templates: [
    {
      id: TEMPLATE,
      name: "Product 58 × 40",
      kind: "product",
      widthMm: 58,
      heightMm: 40,
      layout: labelLayoutSchema.parse(DEFAULT_LAYOUTS.product),
      isDefault: true,
      active: true,
    },
  ],
  profiles: [
    {
      id: BROWSER,
      name: "This device (browser print)",
      adapter: "browser",
      config: {},
      isDefault: true,
      active: true,
      sortOrder: 0,
    },
    {
      id: PDF,
      name: "PDF download",
      adapter: "pdf",
      config: {},
      isDefault: false,
      active: true,
      sortOrder: 1,
    },
  ],
  defaultTemplateId: TEMPLATE,
  defaultProfileId: BROWSER,
  isPublic,
});

const preset: PrintLabelPreset = {
  requestedQuantity: 620,
  reprintOfId: JOB,
  profileId: PDF,
  templateId: TEMPLATE,
  reprintPrice: "45.00",
};

const dialog = () => screen.getByRole("dialog");
const labelText = () =>
  Array.from(dialog().querySelectorAll("svg text")).map((t) => t.textContent ?? "");

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  createJob.mockReset();
  window.localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe("PrintLabelButton", () => {
  it("is disabled with the reason beneath it when no label can print", () => {
    render(
      <PrintLabelButton
        kind="bike"
        entityId={ENTITY}
        shortId="B-000001"
        setup={null}
        unavailable="That record is archived. Unarchive it before printing labels."
      />,
    );
    const button = screen.getByRole("button", { name: "Print label" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "That record is archived. Unarchive it before printing labels.",
    );
  });

  it("opens the sheet: the label, chips, the remembered printer, and starts the job", async () => {
    window.localStorage.setItem(LABEL_PRINTER_KEY, PDF);
    createJob.mockResolvedValue({ ok: true, data: { jobId: JOB, adapter: "pdf" } });
    render(
      <PrintLabelButton kind="product" entityId={ENTITY} shortId="P-000011" setup={setup()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    // The sheet's module loads when it first opens (next/dynamic).
    await screen.findByRole("dialog");
    expect(
      within(dialog()).getByRole("heading", { name: "Print labels · P-000011" }),
    ).toBeVisible();
    expect(within(dialog()).getByRole("img", { name: /^Label: / })).toBeInTheDocument();
    expect(within(dialog()).getByText("58 × 40 mm · Product 58 × 40")).toBeInTheDocument();
    expect(within(dialog()).getByRole("radio", { name: "PDF download" })).toBeChecked();

    fireEvent.click(within(dialog()).getByRole("button", { name: "10 labels" }));
    const submit = within(dialog()).getByRole("button", { name: "Print 10 labels" });
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/print/labels/${JOB}`));
    expect(replace).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "product",
        entityId: ENTITY,
        quantity: "10",
        profileId: PDF,
        templateId: TEMPLATE,
      }),
    );
    expect(window.localStorage.getItem(LABEL_PRINTER_KEY)).toBe(PDF);
  });

  it("a preset opens the sheet once as Print again, with the cap and the price change", async () => {
    render(
      <PrintLabelButton
        kind="product"
        entityId={ENTITY}
        shortId="P-000011"
        setup={setup("39.90")}
        preset={preset}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Print again · P-000011" })).toBeVisible(),
    );
    expect(
      screen.getByText(/Price changed since that print \(\$45\.00 → \$39\.90\)/),
    ).toBeVisible();
    expect(screen.getByText("Prints 500 now; print again for the remaining 120.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Print 500 labels" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "PDF download" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(replace).toHaveBeenCalledWith(`/products/${ENTITY}`, { scroll: false });
    // Opened manually later: no preset any more.
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    expect(screen.getByRole("heading", { name: "Print labels · P-000011" })).toBeVisible();
  });

  it("printing from a preset replaces the deep link, so Back cannot reopen the sheet", async () => {
    createJob.mockResolvedValue({ ok: true, data: { jobId: JOB, adapter: "pdf" } });
    render(
      <PrintLabelButton
        kind="product"
        entityId={ENTITY}
        shortId="P-000011"
        setup={setup("39.90")}
        preset={preset}
      />,
    );
    const submit = await screen.findByRole("button", { name: "Print 500 labels" });
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/print/labels/${JOB}`));
    expect(push).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ reprintOfId: JOB }));
  });

  it("lists the printers as radios with their hints, never a sideways scroller", () => {
    render(
      <PrintLabelButton kind="product" entityId={ENTITY} shortId="P-000011" setup={setup()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    const printers = within(dialog()).getByRole("group", { name: "Printer" });
    const radios = within(printers).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(
      within(printers).getByRole("radio", { name: "PDF download" }),
    ).toHaveAccessibleDescription("Opens a PDF to share or print");
    expect(
      within(printers).getByRole("radio", { name: "This device (browser print)" }),
    ).toBeChecked();
    expect(within(printers).queryByRole("radiogroup")).toBeNull();
  });

  it("a zero price prints $0.00 and a missing price prints no price line (D58, D24 amended)", () => {
    const { unmount } = render(
      <PrintLabelButton
        kind="product"
        entityId={ENTITY}
        shortId="P-000011"
        setup={setup("0.00")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    expect(labelText()).toContain("$0.00");
    unmount();

    render(
      <PrintLabelButton kind="product" entityId={ENTITY} shortId="P-000011" setup={setup(null)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    expect(labelText().some((t) => t.includes("$"))).toBe(false);
    expect(labelText()).toContain("P-000011");
  });

  it("says when a scan would show 'not found' and keeps the error on a refusal", async () => {
    createJob.mockResolvedValue({
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: { quantity: ["Print 1 to 500 labels per job."] },
    });
    render(
      <PrintLabelButton
        kind="product"
        entityId={ENTITY}
        shortId="P-000011"
        setup={setup("39.90", false)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    expect(screen.getByText(/^Not public yet: anyone who scans this label/)).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Print 1 label" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the highlighted fields.");
    expect(screen.getByText("Print 1 to 500 labels per job.")).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });

  it("a conflict mints a new id and links the record's print jobs", async () => {
    createJob.mockResolvedValue({
      ok: false,
      error: "That print was already started.",
      code: "print_job_conflict",
    });
    render(
      <PrintLabelButton kind="product" entityId={ENTITY} shortId="P-000011" setup={setup()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    const submit = screen.getByRole("button", { name: "Print 1 label" });
    await act(async () => fireEvent.click(submit));
    expect(await screen.findByRole("link", { name: "See P-000011's print jobs" })).toHaveAttribute(
      "href",
      "/labels?q=P-000011",
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Print 1 label" })));
    const [first, second] = createJob.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(first).not.toBe(second);
  });
});
