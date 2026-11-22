import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const createCustomer = vi.fn();
const updateCustomer = vi.fn();
vi.mock("@/app/(staff)/customers/actions", () => ({
  createCustomer: (...args: unknown[]) => createCustomer(...args),
  updateCustomer: (...args: unknown[]) => updateCustomer(...args),
  searchCustomers: vi.fn(),
}));

const createBike = vi.fn();
vi.mock("@/app/(staff)/bikes/actions", () => ({
  createBike: (...args: unknown[]) => createBike(...args),
  updateBike: vi.fn(),
}));

import { BikeSheet } from "@/components/domain/bike-sheet";
import { CustomerSheet, EditCustomerButton } from "@/components/domain/customer-sheet";
import { ToastProvider } from "@/components/ui/toast";

beforeEach(() => {
  push.mockReset();
  createCustomer.mockReset();
  updateCustomer.mockReset();
  createBike.mockReset();
  createCustomer.mockImplementation(async (_prev: unknown, formData: FormData) => ({
    ok: true,
    data: { id: formData.get("id") },
  }));
  createBike.mockImplementation(async (_prev: unknown, formData: FormData) => ({
    ok: true,
    data: { id: formData.get("id") },
  }));
});

describe("CustomerSheet", () => {
  it("opens the new customer's page by default (Phase 1)", async () => {
    const onOpenChange = vi.fn();
    render(
      <ToastProvider>
        <CustomerSheet open onOpenChange={onOpenChange} />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ana" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create customer" }));
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/customers\//)));
  });

  it("hands a new customer to onCreated instead of navigating (intake)", async () => {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    render(
      <ToastProvider>
        <CustomerSheet open onOpenChange={onOpenChange} onCreated={onCreated} />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Lim" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create customer" }));
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const [created] = onCreated.mock.calls[0];
    expect(created.label).toBe("Ana Lim");
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("closes on a stale refusal and reopens with the refreshed values (audit A-11)", async () => {
    const customer = {
      id: "d0000000-0000-4000-8000-000000000145",
      firstName: "Ana",
      lastName: "Lim",
      displayName: null,
      email: null,
      phone: "+65 9123 4567",
      internalNotes: null,
      updatedAt: "2026-11-22T02:00:00.123456+00:00",
    };
    const sent: (FormDataEntryValue | null)[] = [];
    updateCustomer.mockImplementation(async (_prev: unknown, formData: FormData) => {
      sent.push(formData.get("expectedUpdatedAt"));
      return sent.length === 1
        ? { ok: false, error: "This changed since you opened it.", code: "stale_edit" }
        : { ok: true, data: null };
    });
    const { rerender } = render(
      <ToastProvider>
        <EditCustomerButton customer={customer} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    // The sheet is gone and the toast says what to do; nothing asks for a reload.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(screen.getByText("Not saved: this changed while you had it open")).toBeTruthy();

    // The action refreshed the page: the button now holds the current row.
    const current = { ...customer, phone: "+65 8000 0000", updatedAt: "2026-11-22T03:00:00+00:00" };
    rerender(
      <ToastProvider>
        <EditCustomerButton customer={current} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("+65 8000 0000");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([customer.updatedAt, current.updatedAt]);
  });
});

describe("BikeSheet", () => {
  it("hands a new bike to onCreated with its title instead of navigating (intake)", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ToastProvider>
        <BikeSheet
          open
          onOpenChange={onOpenChange}
          owner={{ id: "00000000-0000-4000-8000-000000000001", label: "Ana Lim" }}
          onCreated={onCreated}
        />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText(/^Brand/), { target: { value: "Brompton" } });
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: "C Line" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add bike" }));
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0].label).toBe("Brompton C Line");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("opens the new bike by default (Phase 1)", async () => {
    render(
      <ToastProvider>
        <BikeSheet
          open
          onOpenChange={vi.fn()}
          owner={{ id: "00000000-0000-4000-8000-000000000001", label: "Ana Lim" }}
        />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText(/^Brand/), { target: { value: "Brompton" } });
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: "C Line" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add bike" }));
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/bikes\//)));
  });
});
