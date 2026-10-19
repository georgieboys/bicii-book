"use client";

import { searchConsignorsAction } from "@/app/(staff)/consignment/actions";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { callAction } from "@/lib/call-action";

/**
 * Find an active consignor by name, phone or email (staff_search kind
 * consignor; archived consignors never appear, since they take in no new
 * items). The last row, "New consignor", hands the typed text back so the
 * intake can create one in the same commit. Wrap in <Field> for its label.
 */
export function ConsignorPicker({
  value,
  onSelect,
  onNew,
  required,
}: {
  value?: PickerOption | null;
  onSelect?: (option: PickerOption | null) => void;
  /** "New consignor": receives what was typed (a name to start from). */
  onNew?: (query: string) => void;
  required?: boolean;
}) {
  const search = async (q: string): Promise<PickerOption[]> => {
    const result = await callAction(() => searchConsignorsAction({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  return (
    <SearchPicker
      search={search}
      value={value}
      onSelect={onSelect}
      required={required}
      placeholder="Search name, phone or email"
      minChars={1}
      debounceMs={250}
      emptyMessage="No active consignor matches."
      action={
        onNew
          ? {
              label: (q) => (q.trim() ? `New consignor “${q.trim()}”` : "New consignor"),
              onSelect: (q) => onNew(q.trim()),
            }
          : undefined
      }
    />
  );
}
