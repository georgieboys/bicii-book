"use client";

import { useState } from "react";

import { searchCustomers } from "@/app/(staff)/customers/actions";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { callAction } from "@/lib/call-action";

import { CustomerSheet } from "./customer-sheet";

/**
 * Find an active customer by name, phone or email (staff_search; archived
 * customers never appear, since they cannot receive bikes). Wrap in
 * <Field> for its label. With `allowCreate` (New sale, Book appointment;
 * U1-3) the list offers "New customer …", which opens the customer sheet
 * over this one and chooses the new customer, as intake does, so nothing
 * typed in the surrounding sheet is lost.
 */
export function CustomerPicker({
  name,
  value,
  onSelect,
  currentId,
  required,
  placeholder = "Search name, phone or email",
  allowCreate = false,
}: {
  name?: string;
  value?: PickerOption | null;
  onSelect?: (option: PickerOption | null) => void;
  /** Shown but not choosable (e.g. the bike's current owner). */
  currentId?: string | null;
  required?: boolean;
  placeholder?: string;
  /** Offer "New customer" from the list (opens the customer sheet). */
  allowCreate?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const search = async (q: string): Promise<PickerOption[]> => {
    const result = await callAction(() => searchCustomers({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data.map((c) => ({
      ...c,
      disabled: c.id === currentId,
      meta: c.id === currentId ? "Current owner" : undefined,
    }));
  };
  return (
    <>
      <SearchPicker
        search={search}
        name={name}
        value={value}
        onSelect={onSelect}
        required={required}
        placeholder={placeholder}
        minChars={2}
        debounceMs={250}
        emptyMessage={
          allowCreate
            ? "No active customer matches. Add them as a new customer."
            : "No active customer matches. Create them under Customers first."
        }
        action={
          allowCreate
            ? { label: (q) => `New customer “${q}”`, onSelect: () => setCreating(true) }
            : undefined
        }
      />
      {allowCreate ? (
        <CustomerSheet
          open={creating}
          onOpenChange={setCreating}
          onCreated={(created) => {
            setCreating(false);
            onSelect?.({ id: created.id, label: created.label });
          }}
        />
      ) : null}
    </>
  );
}
