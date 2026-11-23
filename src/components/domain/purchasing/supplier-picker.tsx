"use client";

import { useState } from "react";

import { searchSuppliers } from "@/app/(staff)/purchasing/actions";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { callAction } from "@/lib/call-action";

import { SupplierSheet } from "./supplier-sheet";

/** The list's last row: a new supplier named after what was typed. */
export function newSupplierLabel(query: string): string {
  const q = query.trim();
  return q ? `New supplier “${q}”` : "New supplier";
}

/**
 * Find an active supplier by name, contact, email, account reference or
 * phone digits (staff_search; archived suppliers never appear, since they
 * take no new orders). Every picker sits where manage_purchasing is
 * needed anyway, so the list ends with "New supplier": it opens the
 * supplier sheet over this one, starting from what was typed, and chooses
 * the new supplier, so nothing typed in the surrounding sheet is lost.
 * Wrap in <Field> for its label.
 */
export function SupplierPicker({
  name,
  value,
  onSelect,
  required,
  disabled,
  placeholder = "Search supplier name, contact or phone",
}: {
  name?: string;
  value?: PickerOption | null;
  onSelect?: (option: PickerOption | null) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [creating, setCreating] = useState<string | null>(null);
  const search = async (q: string): Promise<PickerOption[]> => {
    const result = await callAction(() => searchSuppliers({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  return (
    <>
      <SearchPicker
        search={search}
        name={name}
        value={value}
        onSelect={onSelect}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        minChars={1}
        debounceMs={250}
        emptyMessage="No active supplier matches. Add it as a new supplier."
        action={{ label: newSupplierLabel, onSelect: (q) => setCreating(q.trim()) }}
      />
      <SupplierSheet
        open={creating !== null}
        onOpenChange={(open) => (open ? null : setCreating(null))}
        initialName={creating ?? ""}
        onCreated={(created) => {
          setCreating(null);
          onSelect?.({ id: created.id, label: created.name });
        }}
      />
    </>
  );
}
