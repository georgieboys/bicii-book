"use client";

import { useActionState, useId, useState } from "react";

import { createService, updateService } from "@/app/(staff)/settings/services/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import type { Category, SettingsService } from "@/lib/domain/services";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ArchiveControl } from "./archive-control";

type State = ActionResult<{ id: string }> | null;

/** "New service" (manage_inventory). */
export function NewServiceButton({
  categories,
  viewCosts,
}: {
  categories: Category[];
  viewCosts: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New service
      </Button>
      {open ? (
        <ServiceSheet
          service={null}
          categories={categories}
          viewCosts={viewCosts}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** "Edit" on one service row (manage_inventory). */
export function EditServiceButton({
  service,
  categories,
  viewCosts,
}: {
  service: SettingsService;
  categories: Category[];
  viewCosts: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${service.name}`}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
      {open ? (
        <ServiceSheet
          service={service}
          categories={categories}
          viewCosts={viewCosts}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * A service's fields (SPEC §9): name, category (a short native select),
 * price, description, Active (offered on jobs) and Public (for the website
 * listing in Phase 11), and the cost only with view_costs (D14). A new
 * service's id is made when the sheet opens: the idempotency key. Editing
 * also offers archiving. A new price or cost applies to lines added from
 * now on; existing lines keep their snapshot.
 */
function ServiceSheet({
  service,
  categories,
  viewCosts,
  onClose,
}: {
  service: SettingsService | null;
  categories: Category[];
  viewCosts: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => service?.id ?? newId());
  const [name, setName] = useState(service?.name ?? "");
  const [categoryId, setCategoryId] = useState(service?.categoryId ?? "");
  const [price, setPrice] = useState(service?.salePrice ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [cost, setCost] = useState(service?.cost ?? "");
  const [active, setActive] = useState(service?.active ?? true);
  const [isPublic, setIsPublic] = useState(service?.public ?? false);
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = service
      ? await callAction(() => updateService(prev, formData), formData)
      : await callAction(() => createService(prev, formData), formData);
    if (result.ok) {
      toast({
        title: service ? `${name.trim()} saved` : `${name.trim()} created`,
        tone: "success",
      });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  // An archived category stays choosable for a service already filed under it.
  const options = categories.filter((c) => !c.archived || c.id === service?.categoryId);

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={service ? `Edit ${service.name}` : "New service"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {service ? "Save" : "Create service"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="id" value={id} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input
            name="name"
            autoComplete="off"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Category" error={errors?.categoryId?.[0]}>
          <Select
            name="categoryId"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">No category (Other)</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.archived ? " (archived)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Price"
          hint="The default unit price on a job; staff can change it per job."
          error={errors?.salePrice?.[0]}
          required
        >
          <NumberInput kind="money" name="salePrice" value={price} onValueChange={setPrice} />
        </Field>
        {viewCosts ? (
          <Field
            label="Cost"
            hint={
              service
                ? "Staff with cost access only. Leave empty to keep the current cost."
                : "Staff with cost access only. The direct cost per unit; empty is none."
            }
            error={errors?.cost?.[0]}
          >
            <NumberInput kind="money" name="cost" value={cost} onValueChange={setCost} />
          </Field>
        ) : null}
        <Field label="Description" error={errors?.description?.[0]}>
          <Textarea
            name="description"
            rows={3}
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="flex flex-col">
          <Switch
            name="active"
            label="Active"
            description="Offered when adding services to a job."
            checked={active}
            onCheckedChange={setActive}
          />
          <Switch
            name="public"
            label="Public"
            description="May be listed on the BICII website once it shows services."
            checked={isPublic}
            onCheckedChange={setIsPublic}
          />
        </div>
        <p className="rounded-xl bg-sunken p-3 text-sm text-dust-700">
          Changing a price or cost affects new job lines only; existing lines keep their snapshot.
        </p>
      </form>
      {service ? (
        <section
          aria-labelledby={`${formId}-archive`}
          className="mt-6 border-t border-hairline pt-5"
        >
          <h3
            id={`${formId}-archive`}
            className="mb-2 font-display text-xs font-bold tracking-wide uppercase"
          >
            Archive
          </h3>
          <ArchiveControl
            kind="service"
            id={service.id}
            name={service.name}
            archived={service.archived}
          />
        </section>
      ) : null}
    </Sheet>
  );
}
