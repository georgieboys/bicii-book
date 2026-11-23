/**
 * Keep-moving screen fixes (owner 2026-11-23: staff finish what they are
 * doing in place): a labour line from Add service, a new supplier from the
 * supplier picker, a new consignor from the one-off part sheet, "Tell the
 * customer" on a finished job and Today's "Pay owners" card.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const searchServiceOptions = vi.fn();
const addManualLine = vi.fn();
const addWorkOrderNote = vi.fn();
vi.mock("@/app/(staff)/jobs/actions", () => ({
  searchServiceOptions: (...args: unknown[]) => searchServiceOptions(...args),
  addServiceLine: vi.fn(),
  addManualLine: (...args: unknown[]) => addManualLine(...args),
  addWorkOrderNote: (...args: unknown[]) => addWorkOrderNote(...args),
}));
const searchSuppliers = vi.fn();
vi.mock("@/app/(staff)/purchasing/actions", () => ({
  searchSuppliers: (...args: unknown[]) => searchSuppliers(...args),
}));
const createSupplier = vi.fn();
vi.mock("@/app/(staff)/purchasing/supplier-actions", () => ({
  createSupplier: (...args: unknown[]) => createSupplier(...args),
  updateSupplier: vi.fn(),
}));
const searchConsignorsAction = vi.fn();
const createConsignorAction = vi.fn();
vi.mock("@/app/(staff)/consignment/actions", () => ({
  searchConsignorsAction: (...args: unknown[]) => searchConsignorsAction(...args),
  createConsignorAction: (...args: unknown[]) => createConsignorAction(...args),
  updateConsignorAction: vi.fn(),
  customerContactAction: vi.fn(),
}));
vi.mock("@/app/(staff)/customers/actions", () => ({
  searchCustomers: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

import { AddServiceButton, labourLineLabel } from "@/components/domain/add-service-sheet";
import { ConsignorSheet } from "@/components/domain/consignor-sheet";
import { newSupplierLabel, SupplierPicker } from "@/components/domain/purchasing/supplier-picker";
import { TellCustomerButton } from "@/components/domain/tell-customer";
import { PayOwners, payOwnersHeadline } from "@/components/domain/today/pay-owners";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { ToastProvider } from "@/components/ui/toast";
import { owedToConsignors } from "@/lib/consignment";
import {
  canTellCustomer,
  readyMailtoHref,
  readyMessage,
  readySubject,
  toldCustomerNote,
} from "@/lib/ready-message";

const JOB = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("A sheet opened from inside another sheet's form", () => {
  it("submits only its own form", () => {
    const outer = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const inner = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={outer}>
        <Sheet open onOpenChange={vi.fn()} title="New customer">
          <form onSubmit={inner}>
            <button type="submit">Create</button>
          </form>
        </Sheet>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("Add service: Add as labour line", () => {
  it("names the typed words in the row", () => {
    expect(labourLineLabel("  Wheel true  ")).toBe("Add “Wheel true” as labour line");
    expect(labourLineLabel("")).toBe("Add as labour line");
  });

  it("opens the manual line sheet with the search as its description", async () => {
    searchServiceOptions.mockResolvedValue({ ok: true, data: [] });
    render(
      <ToastProvider>
        <AddServiceButton workOrderId={JOB} viewCosts={false} currency="SGD" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search services"), {
        target: { value: "Wheel true" },
      });
    });
    expect(await screen.findByText(/No active service matches/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("option", { name: /as labour line/ }));
    expect(screen.getByRole("heading", { name: "Add manual line" })).toBeTruthy();
    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toBe("Wheel true");
  });
});

describe("Supplier picker: New supplier", () => {
  it("names the typed words in the row", () => {
    expect(newSupplierLabel(" Velo Parts ")).toBe("New supplier “Velo Parts”");
    expect(newSupplierLabel("")).toBe("New supplier");
  });

  it("creates the supplier over the picker and chooses it", async () => {
    searchSuppliers.mockResolvedValue({ ok: true, data: [] });
    createSupplier.mockResolvedValue({ ok: true, data: { id: "x" } });
    const onSelect = vi.fn<(o: PickerOption | null) => void>();
    render(
      <ToastProvider>
        <SupplierPicker value={null} onSelect={onSelect} />
      </ToastProvider>,
    );
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Search supplier/), {
        target: { value: "Velo Parts" },
      });
    });
    expect(await screen.findByText(/Add it as a new supplier/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("option", { name: /New supplier “Velo Parts”/ }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Velo Parts");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create supplier" }));
    });
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: "Velo Parts" })),
    );
    expect(screen.queryByRole("heading", { name: "New supplier" })).toBeNull();
  });
});

describe("New consignor from a one-off part", () => {
  it("starts from what was typed and hands the new consignor back", async () => {
    createConsignorAction.mockResolvedValue({ ok: true, data: { id: "x" } });
    const onCreated = vi.fn();
    render(
      <ToastProvider>
        <ConsignorSheet open onOpenChange={vi.fn()} initialName="Mei Ling" onCreated={onCreated} />
      </ToastProvider>,
    );
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Mei Ling");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create consignor" }));
    });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ label: "Mei Ling" })),
    );
  });
});

describe("Tell the customer", () => {
  const base = {
    firstName: "Angelo",
    jobNumber: "J-000005",
    bikeTitle: "Bianchi Specialissima",
    currency: "SGD",
  };

  it("shows on completed and ready-for-collection jobs only", () => {
    expect(canTellCustomer("completed")).toBe(true);
    expect(canTellCustomer("ready_for_collection")).toBe(true);
    expect(canTellCustomer("in_progress")).toBe(false);
    expect(canTellCustomer("collected")).toBe(false);
  });

  it("names the bike, the job, the balance due and the address", () => {
    const text = readyMessage({ ...base, balanceDue: "180.5" });
    expect(text).toContain("Hi Angelo, your Bianchi Specialissima is ready for collection");
    expect(text).toContain("(job J-000005)");
    expect(text).toContain("Balance due on collection: $180.50.");
    expect(text).toContain("294 River Valley Road");
  });

  it("says when nothing is due, and leaves money out when it is unknown", () => {
    expect(readyMessage({ ...base, balanceDue: "0.00" })).toContain("nothing is due");
    const unknown = readyMessage({ ...base, firstName: null, balanceDue: null });
    expect(unknown.startsWith("Hi, your")).toBe(true);
    expect(unknown).not.toMatch(/due|paid/);
  });

  it("builds a mailto with subject and body, or none without an address", () => {
    const href = readyMailtoHref("a@example.com", readySubject("J-000005"), "Hi\nthere");
    expect(href).toBe(
      "mailto:a@example.com?subject=Your%20bike%20is%20ready%20for%20collection%20(job%20J-000005)&body=Hi%0Athere",
    );
    expect(readyMailtoHref(null, "s", "t")).toBeNull();
  });

  it("opens WhatsApp with the message and leaves one note in the timeline", async () => {
    addWorkOrderNote.mockResolvedValue({ ok: true, data: { id: 1 } });
    render(
      <ToastProvider>
        <TellCustomerButton
          workOrderId={JOB}
          jobNumber="J-000005"
          phone="9123 4567"
          email={null}
          message="Hi, ready"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tell the customer" }));
    const link = screen.getByRole("link", { name: "Open WhatsApp" });
    expect(link.getAttribute("href")).toBe("https://wa.me/6591234567?text=Hi%2C%20ready");
    expect(screen.queryByRole("link", { name: "Email" })).toBeNull();
    await act(async () => {
      fireEvent.click(link);
    });
    expect(addWorkOrderNote).toHaveBeenCalledWith(
      expect.objectContaining({
        workOrderId: JOB,
        kind: "note",
        body: toldCustomerNote("whatsapp", "Hi, ready"),
      }),
    );
  });

  it("offers Copy when the customer has neither phone nor email", () => {
    render(
      <ToastProvider>
        <TellCustomerButton
          workOrderId={JOB}
          jobNumber="J-000005"
          phone={null}
          email={null}
          message="Hi"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tell the customer" }));
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByText(/no WhatsApp number or email on file/)).toBeTruthy();
  });
});

describe("Today: Pay owners", () => {
  const rows = [
    { id: "c1", name: "Ben", outstanding: "40.00", awaitingItems: 1 },
    { id: "c2", name: "Aisha", outstanding: "120.50", awaitingItems: 3 },
    { id: "c3", name: "Chen", outstanding: "0.00", awaitingItems: 0 },
    { id: "c4", name: "Dev", outstanding: null, awaitingItems: null },
    { id: "c5", name: "Eve", outstanding: "-5.00", awaitingItems: 0 },
  ];

  it("totals the consignors owed money, most owed first", () => {
    const owed = owedToConsignors(rows)!;
    expect(owed.total).toBe("160.50");
    expect(owed.items).toBe(4);
    expect(owed.consignors.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(payOwnersHeadline(owed.total, owed.items)).toBe(
      "Owed to consignors: $160.50 on 4 items",
    );
  });

  it("is hidden when nobody is owed anything", () => {
    expect(owedToConsignors(rows.slice(2))).toBeNull();
    const { container } = render(<PayOwners owed={null} />);
    expect(container.textContent).toBe("");
  });

  it("links each consignor to their page", () => {
    render(<PayOwners owed={owedToConsignors(rows)} />);
    expect(screen.getByText("Owed to consignors: $160.50 on 4 items")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Aisha/ }).getAttribute("href")).toBe(
      "/consignment/consignors/c2",
    );
  });
});
