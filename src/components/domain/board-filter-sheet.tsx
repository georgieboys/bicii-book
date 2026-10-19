"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { searchIntakeOptions } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChipRadioGroup } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import {
  AGE_FILTERS,
  BOARD_GROUPS,
  CHECKED_IN_PRESETS,
  STATUS_LABELS,
  boardQuery,
  type AgeFilter,
  type BoardFilters,
  type CheckedInPreset,
  type WorkOrderStatus,
} from "@/lib/workshop";
import { callAction } from "@/lib/call-action";

type Picked = { id: string; label: string } | null;

/**
 * "Filters" on the workshop board: statuses (several, e.g. only "Waiting
 * on parts", which the Waiting group otherwise merges with the customer
 * and paused), mechanic, customer, bike, check-in date and age. Apply
 * writes them to the URL; the board renders on the server.
 */
export function BoardFiltersButton({
  filters,
  staff,
  labels,
  activeCount,
}: {
  filters: BoardFilters;
  /** Active staff, for the mechanic filter. */
  staff: { id: string; name: string }[];
  /** Names of the customer and bike already chosen. */
  labels: { customer: string | null; bike: string | null };
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </Button>
      {open ? (
        <BoardFilterSheet
          filters={filters}
          staff={staff}
          labels={labels}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function BoardFilterSheet({
  filters,
  staff,
  labels,
  onClose,
}: {
  filters: BoardFilters;
  staff: { id: string; name: string }[];
  labels: { customer: string | null; bike: string | null };
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [statuses, setStatuses] = useState<WorkOrderStatus[]>(filters.statuses);
  const [mechanicId, setMechanicId] = useState<string | null>(filters.mechanicId);
  const [customer, setCustomer] = useState<Picked>(
    filters.customerId ? { id: filters.customerId, label: labels.customer ?? "Customer" } : null,
  );
  const [bike, setBike] = useState<Picked>(
    filters.bikeId ? { id: filters.bikeId, label: labels.bike ?? "Bike" } : null,
  );
  const [checkedIn, setCheckedIn] = useState<CheckedInPreset>(filters.checkedIn);
  const [age, setAge] = useState<AgeFilter>(filters.age);

  const toggleStatus = (s: WorkOrderStatus, on: boolean) =>
    setStatuses((prev) => (on ? [...prev, s] : prev.filter((x) => x !== s)));

  const search = (kind: "customer" | "bike") => async (q: string) => {
    const result = await callAction(() => searchIntakeOptions({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data
      .filter((o) => o.kind === kind)
      .map((o): PickerOption => ({
        id: o.id,
        label: o.label,
        description: o.description,
        meta: o.meta,
      }));
  };

  const apply = () => {
    const href = `/jobs${boardQuery(filters, {
      statuses,
      mechanicId,
      customerId: customer?.id ?? null,
      bikeId: bike?.id ?? null,
      checkedIn,
      age,
      closedLimit: 0,
    })}`;
    startTransition(() => {
      router.replace(href, { scroll: false });
      onClose();
    });
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      title="Filter jobs"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setStatuses([]);
              setMechanicId(null);
              setCustomer(null);
              setBike(null);
              setCheckedIn("any");
              setAge("any");
            }}
          >
            Reset
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} pending={pending} pendingLabel="Applying…">
            Show jobs
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-display text-xs font-bold tracking-wide uppercase">
            Status
          </legend>
          <p className="text-sm text-dust-500">None ticked: every status.</p>
          {BOARD_GROUPS.map((g) => (
            <div key={g.id} className="flex flex-col">
              <p className="eyebrow mt-2 text-dust-500">{g.label}</p>
              {g.statuses.map((s) => (
                <Checkbox
                  key={s}
                  label={STATUS_LABELS[s]}
                  checked={statuses.includes(s)}
                  onChange={(e) => toggleStatus(s, e.target.checked)}
                />
              ))}
            </div>
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <p
            id="mechanic-filter"
            className="font-display text-xs font-bold tracking-wide uppercase"
          >
            Mechanic
          </p>
          <p className="text-sm text-dust-500">Jobs they are on, as lead or helping.</p>
          <ChipRadioGroup<string | null>
            labelledBy="mechanic-filter"
            value={mechanicId}
            onChange={setMechanicId}
            options={[
              { value: null, children: "Anyone" },
              ...staff.map((s) => ({ value: s.id, children: s.name })),
            ]}
          />
        </div>

        <Field label="Customer">
          <SearchPicker
            search={search("customer")}
            value={customer}
            onSelect={(o) => setCustomer(o ? { id: o.id, label: o.label } : null)}
            minChars={2}
            debounceMs={250}
            placeholder="Search name, phone or email"
            emptyMessage="No active customer matches."
          />
        </Field>

        <Field label="Bike">
          <SearchPicker
            search={search("bike")}
            value={bike}
            onSelect={(o) => setBike(o ? { id: o.id, label: o.label } : null)}
            minChars={2}
            debounceMs={250}
            placeholder="B- number, serial, brand or model"
            emptyMessage="No active bike matches."
          />
        </Field>

        <div className="flex flex-col gap-2">
          <p className="font-display text-xs font-bold tracking-wide uppercase">Checked in</p>
          <SegmentedControl<CheckedInPreset>
            label="Checked in"
            options={CHECKED_IN_PRESETS}
            value={checkedIn}
            onValueChange={setCheckedIn}
          />
        </div>

        <div className="flex flex-col gap-2">
          <p className="font-display text-xs font-bold tracking-wide uppercase">Age</p>
          <SegmentedControl<AgeFilter>
            label="Age"
            options={AGE_FILTERS}
            value={age}
            onValueChange={setAge}
          />
          <p className="text-sm text-dust-500">
            Overdue: not completed more than 7 days after check-in.
          </p>
        </div>
      </div>
    </Sheet>
  );
}
