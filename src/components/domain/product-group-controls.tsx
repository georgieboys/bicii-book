"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import {
  createProductGroupAction,
  setProductGroupAction,
  setProductGroupArchivedAction,
  updateProductGroupAction,
} from "@/app/(staff)/products/groups/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";
import { OPTION_NAME_MAX, OPTION_VALUE_MAX } from "@/lib/product-group-forms";
import { newId } from "@/lib/uuid";

export type EditableGroup = {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  optionName: string;
};

type State = ActionResult<{ id: string }> | null;

/** "New group" (manage_inventory): opens the group page once saved. */
export function NewProductGroupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New group
      </Button>
      {open ? <GroupSheet group={null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** "Edit" on a group's page (manage_inventory). */
export function EditProductGroupButton({ group }: { group: EditableGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      {open ? <GroupSheet group={group} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * A group's name (its title online), description, brand and the name of
 * its one option ("Colour", "Size"). Saving re-syncs every member online.
 */
function GroupSheet({ group, onClose }: { group: EditableGroup | null; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => group?.id ?? newId());
  const [name, setName] = useState(group?.name ?? "");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = group
      ? await callAction(() => updateProductGroupAction(prev, formData), formData)
      : await callAction(() => createProductGroupAction(prev, formData), formData);
    if (result.ok) {
      toast({ title: group ? `${name.trim()} saved` : `${name.trim()} added`, tone: "success" });
      onClose();
      if (!group) router.push(`/products/groups/${id}`);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={group ? `Edit ${group.name}` : "New group"}
      description="Products in a group are sold as one item online, with a choice of option."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {group ? "Save" : "Add group"}
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
        <Field
          label="Name"
          hint="Shown as the item's title online."
          error={errors?.name?.[0]}
          required
        >
          <Input
            name="name"
            autoComplete="off"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Option"
          hint="What the products differ by, such as Colour or Size."
          error={errors?.optionName?.[0]}
          required
        >
          <Input
            name="optionName"
            autoComplete="off"
            maxLength={OPTION_NAME_MAX}
            defaultValue={(values?.optionName as string) ?? group?.optionName ?? "Colour"}
          />
        </Field>
        <Field label="Brand" error={errors?.brand?.[0]}>
          <Input
            name="brand"
            autoComplete="off"
            maxLength={200}
            defaultValue={(values?.brand as string) ?? group?.brand ?? ""}
          />
        </Field>
        <Field
          label="Description"
          hint="Shown online for the whole group."
          error={errors?.description?.[0]}
        >
          <Textarea
            name="description"
            rows={5}
            defaultValue={(values?.description as string) ?? group?.description ?? ""}
          />
        </Field>
      </form>
    </Sheet>
  );
}

/** Archive or unarchive a group (one with live products refuses). */
export function ArchiveGroupButton({ id, archived }: { id: string; archived: boolean }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      pending={pending}
      onClick={() =>
        start(async () => {
          const result = await callAction(() =>
            setProductGroupArchivedAction({ id, archived: !archived }),
          );
          toast(
            result.ok
              ? { title: archived ? "Group restored" : "Group archived", tone: "success" }
              : { title: "Not changed", description: result.error, tone: "error" },
          );
        })
      }
    >
      {archived ? "Unarchive" : "Archive"}
    </Button>
  );
}

export type GroupChoice = { id: string; label: string; optionName: string };

/**
 * "Group" on a product's page (manage_inventory): put it in a group with
 * its option value, change the value, or take it out. A product already
 * on Shopify keeps its group (the database refuses), so the sheet then
 * offers only the option value.
 */
export function ProductGroupButton({
  productId,
  current,
  groups,
  locked,
}: {
  productId: string;
  current: { groupId: string; optionValue: string } | null;
  groups: GroupChoice[];
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {current ? "Change" : "Add to a group"}
      </Button>
      {open ? (
        <MembershipSheet
          productId={productId}
          current={current}
          groups={groups}
          locked={locked}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function MembershipSheet({
  productId,
  current,
  groups,
  locked,
  onClose,
}: {
  productId: string;
  current: { groupId: string; optionValue: string } | null;
  groups: GroupChoice[];
  locked: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [groupId, setGroupId] = useState(current?.groupId ?? groups[0]?.id ?? "");
  const [optionValue, setOptionValue] = useState(current?.optionValue ?? "");
  const [state, setState] = useState<ActionResult<null> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const option = groups.find((g) => g.id === groupId)?.optionName ?? "Option";

  const save = (next: { groupId: string | null; optionValue: string | null }) =>
    start(async () => {
      const result = await callAction(() => setProductGroupAction({ productId, ...next }));
      setState(result);
      if (!result.ok) return;
      toast({ title: next.groupId ? "Group saved" : "Taken out of the group", tone: "success" });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Group"
      description="Products in a group are sold as one item online, one choice per product."
      footer={
        <>
          {current && !locked ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => save({ groupId: null, optionValue: null })}
            >
              Take out
            </Button>
          ) : null}
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save({ groupId: groupId || null, optionValue });
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {groups.length === 0 ? (
          <p className="text-sm text-dust-700">
            There are no groups yet. Make one under Products → Groups first.
          </p>
        ) : (
          <Field
            label="Group"
            hint={locked ? "This product is on Shopify, so its group stays." : undefined}
            error={errors?.groupId?.[0]}
            required
          >
            <Select
              name="groupId"
              value={groupId}
              disabled={locked}
              onChange={(e) => setGroupId(e.target.value)}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label={option}
          hint={`This product's ${option.toLowerCase()}, such as Black.`}
          error={errors?.optionValue?.[0]}
          required
        >
          <Input
            name="optionValue"
            autoComplete="off"
            maxLength={OPTION_VALUE_MAX}
            value={optionValue}
            onChange={(e) => setOptionValue(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}
