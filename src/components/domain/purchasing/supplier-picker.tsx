"use client";

import { searchSuppliers } from "@/app/(staff)/purchasing/actions";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { callAction } from "@/lib/call-action";

/**
 * Find an active supplier by name, contact, email, account reference or
 * phone digits (staff_search; archived suppliers never appear, since they
 * take no new orders). Wrap in <Field> for its label.
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
  const search = async (q: string): Promise<PickerOption[]> => {
    const result = await callAction(() => searchSuppliers({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  return (
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
      emptyMessage="No active supplier matches. Add it under Purchasing → Suppliers first."
    />
  );
}
