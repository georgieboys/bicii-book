"use client";

import { useActionState, useId, useState, useTransition } from "react";

import {
  saveAdventureDraftAction,
  setAdventureCheckpointsAction,
} from "@/app/(staff)/adventures/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";
import type { AdventureCheckpoint, AdventureRevision } from "@/lib/domain/adventures";

type State = ActionResult<unknown> | null;

const hours = (minutes: number | null) => (minutes === null ? "" : String(minutes / 60));

/**
 * The draft's content and rules (manage_adventures). Saves every field at
 * once with the draft's version, so a save from a stale screen is refused
 * ("Someone changed this draft…") instead of overwriting.
 */
export function DraftForm({ draft }: { draft: AdventureRevision }) {
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(
      () => saveAdventureDraftAction(prev as ActionResult<{ version: number }> | null, formData),
      formData,
    );
    if (result.ok) toast({ title: "Draft saved", tone: "success" });
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const v = (key: string, fallback: string) => values?.[key] ?? fallback;

  return (
    <Card
      title="Content and rules"
      actions={
        <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
          Save draft
        </Button>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
        // Saving refreshes the page with the new version; remount so the
        // fields show what was saved.
        key={draft.version}
      >
        <input type="hidden" name="revisionId" value={draft.id} />
        <input type="hidden" name="expectedVersion" value={draft.version} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}

        <Field label="Name" error={errors?.name?.[0]} required>
          <Input name="name" autoComplete="off" defaultValue={v("name", draft.name)} />
        </Field>
        <Field
          label="Summary"
          hint="One or two sentences for the route list."
          error={errors?.summary?.[0]}
        >
          <Textarea name="summary" rows={2} defaultValue={v("summary", draft.summary)} />
        </Field>
        <Field
          label="Description"
          hint="The full write-up on the route's page."
          error={errors?.description?.[0]}
        >
          <Textarea
            name="description"
            rows={5}
            defaultValue={v("description", draft.description)}
          />
        </Field>
        <Field label="Note" hint="A caution or tip shown with the route." error={errors?.note?.[0]}>
          <Textarea name="note" rows={2} defaultValue={v("note", draft.note)} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Distance (km)" error={errors?.distanceKm?.[0]} required>
            <Input
              name="distanceKm"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={v("distanceKm", draft.distanceKm)}
            />
          </Field>
          <Field
            label="Nominal days"
            hint="Certification prices are based on this. Needed to sell."
            error={errors?.nominalDays?.[0]}
          >
            <Input
              name="nominalDays"
              inputMode="numeric"
              autoComplete="off"
              defaultValue={v("nominalDays", draft.nominalDays?.toString() ?? "")}
            />
          </Field>
          <Field
            label="Maximum time (hours)"
            hint="Needed to sell certification."
            error={errors?.maxElapsedMinutes?.[0]}
          >
            <Input
              name="maxElapsedMinutes"
              inputMode="numeric"
              autoComplete="off"
              defaultValue={v("maxElapsedMinutes", hours(draft.maxElapsedMinutes))}
            />
          </Field>
          <Field
            label="Minimum time (hours)"
            hint="Leave blank for none."
            error={errors?.minElapsedMinutes?.[0]}
          >
            <Input
              name="minElapsedMinutes"
              inputMode="numeric"
              autoComplete="off"
              defaultValue={v("minElapsedMinutes", hours(draft.minElapsedMinutes))}
            />
          </Field>
          <Field label="Region" error={errors?.region?.[0]}>
            <Input name="region" autoComplete="off" defaultValue={v("region", draft.region)} />
          </Field>
          <Field label="Terrain" hint="Paths, trail, road…" error={errors?.terrain?.[0]}>
            <Input name="terrain" autoComplete="off" defaultValue={v("terrain", draft.terrain)} />
          </Field>
          <Field label="When to start" hint="Like: Around 3pm" error={errors?.whenToStart?.[0]}>
            <Input
              name="whenToStart"
              autoComplete="off"
              defaultValue={v("whenToStart", draft.whenToStart)}
            />
          </Field>
          <Field label="Start and finish" error={errors?.startFinish?.[0]}>
            <Input
              name="startFinish"
              autoComplete="off"
              defaultValue={v("startFinish", draft.startFinish)}
            />
          </Field>
          <Field
            label="Time zone"
            hint="Like Asia/Singapore or Asia/Bangkok."
            error={errors?.timeZone?.[0]}
            required
          >
            <Input
              name="timeZone"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={v("timeZone", draft.timeZone)}
            />
          </Field>
          <Field label="Checkpoints are ridden" error={errors?.checkpointOrder?.[0]}>
            <Select
              name="checkpointOrder"
              defaultValue={v("checkpointOrder", draft.checkpointOrder)}
            >
              <option value="any">In any order</option>
              <option value="sequence">In the listed order</option>
            </Select>
          </Field>
        </div>

        <Field
          label="Route link"
          hint="The Strava (or other) route, starting with https://"
          error={errors?.routeUrl?.[0]}
        >
          <Input
            name="routeUrl"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            defaultValue={v("routeUrl", draft.routeUrl ?? "")}
          />
        </Field>
        <Field
          label="Rules"
          hint="What counts as a certified ride. Public."
          error={errors?.rules?.[0]}
        >
          <Textarea name="rules" rows={4} defaultValue={v("rules", draft.rules)} />
        </Field>
        <Field
          label="Equipment"
          hint="What riders must bring or may use. Public."
          error={errors?.equipment?.[0]}
        >
          <Textarea name="equipment" rows={3} defaultValue={v("equipment", draft.equipment)} />
        </Field>
        <Field
          label="Rider instructions"
          hint="Shown only to riders who bought it."
          error={errors?.riderInstructions?.[0]}
        >
          <Textarea
            name="riderInstructions"
            rows={3}
            defaultValue={v("riderInstructions", draft.riderInstructions)}
          />
        </Field>
        <Field
          label="Emergency procedure"
          hint="Shown only to riders who bought it."
          error={errors?.emergencyProcedure?.[0]}
        >
          <Textarea
            name="emergencyProcedure"
            rows={3}
            defaultValue={v("emergencyProcedure", draft.emergencyProcedure)}
          />
        </Field>
        <Field label="Staff notes" hint="Never shown to riders." error={errors?.staffNotes?.[0]}>
          <Textarea name="staffNotes" rows={2} defaultValue={v("staffNotes", draft.staffNotes)} />
        </Field>
        <Checkbox
          name="isPlanned"
          label="Still being planned"
          description="Shown on bicii.sg as coming, never offered for sale."
          defaultChecked={values ? values.isPlanned === "on" : draft.isPlanned}
        />
      </form>
    </Card>
  );
}

type EditableCheckpoint = {
  key: number;
  label: string;
  instructions: string;
  latitude: string;
  longitude: string;
  mandatory: boolean;
  photoRequired: boolean;
};

let nextKey = 0;
const toEditable = (c: AdventureCheckpoint): EditableCheckpoint => ({
  key: nextKey++,
  label: c.label,
  instructions: c.instructions,
  latitude: c.latitude ?? "",
  longitude: c.longitude ?? "",
  mandatory: c.mandatory,
  photoRequired: c.photoRequired,
});

/**
 * The draft's checkpoints, in order. Edited here and saved as a whole list
 * (set_adventure_checkpoints); coordinates are optional review aids.
 */
export function CheckpointsEditor({
  revisionId,
  checkpoints,
}: {
  revisionId: string;
  checkpoints: AdventureCheckpoint[];
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<EditableCheckpoint[]>(() => checkpoints.map(toEditable));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const update = (key: number, patch: Partial<EditableCheckpoint>) =>
    setItems((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const move = (index: number, by: -1 | 1) =>
    setItems((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item);
      return next;
    });

  const save = () =>
    start(async () => {
      setError(null);
      const payload = JSON.stringify(
        items.map((c) => ({
          label: c.label,
          instructions: c.instructions,
          latitude: c.latitude.trim() === "" ? null : c.latitude.trim(),
          longitude: c.longitude.trim() === "" ? null : c.longitude.trim(),
          mandatory: c.mandatory,
          photoRequired: c.photoRequired,
        })),
      );
      const result = await callAction(() =>
        setAdventureCheckpointsAction({ revisionId, checkpoints: payload }),
      );
      if (result.ok) toast({ title: "Checkpoints saved", tone: "success" });
      else {
        const fieldError = result.fieldErrors
          ? Object.values(result.fieldErrors).flat()[0]
          : undefined;
        setError(fieldError ?? result.error);
      }
    });

  return (
    <Card
      title="Checkpoints"
      actions={
        <Button onClick={save} pending={pending} pendingLabel="Saving…">
          Save checkpoints
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {error}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="text-sm text-dust-700">
            No checkpoints yet. Riders photograph each one as evidence.
          </p>
        ) : (
          <ol aria-label="Checkpoints" className="flex flex-col gap-4">
            {items.map((c, index) => (
              <li key={c.key} className="flex flex-col gap-3 rounded-md border border-hairline p-3">
                <div className="flex items-center gap-2">
                  <span className="eyebrow text-dust-500">Checkpoint {index + 1}</span>
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Down
                  </Button>
                  <IconButton
                    aria-label={`Remove checkpoint ${index + 1}`}
                    icon={<CloseIcon />}
                    onClick={() => setItems((list) => list.filter((x) => x.key !== c.key))}
                  />
                </div>
                <Field label="Name" required>
                  <Input
                    value={c.label}
                    onChange={(e) => update(c.key, { label: e.target.value })}
                  />
                </Field>
                <Field label="What the photo must show">
                  <Textarea
                    rows={2}
                    value={c.instructions}
                    onChange={(e) => update(c.key, { instructions: e.target.value })}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Latitude" hint="Optional, decimal degrees.">
                    <Input
                      inputMode="decimal"
                      value={c.latitude}
                      onChange={(e) => update(c.key, { latitude: e.target.value })}
                    />
                  </Field>
                  <Field label="Longitude" hint="Optional, decimal degrees.">
                    <Input
                      inputMode="decimal"
                      value={c.longitude}
                      onChange={(e) => update(c.key, { longitude: e.target.value })}
                    />
                  </Field>
                </div>
                <Checkbox
                  label="Must be visited"
                  checked={c.mandatory}
                  onChange={(e) => update(c.key, { mandatory: e.target.checked })}
                />
                <Checkbox
                  label="Needs a photo"
                  checked={c.photoRequired}
                  onChange={(e) => update(c.key, { photoRequired: e.target.checked })}
                />
              </li>
            ))}
          </ol>
        )}
        <div>
          <Button
            variant="outline"
            icon={<PlusIcon className="size-5" />}
            onClick={() =>
              setItems((list) => [
                ...list,
                {
                  key: nextKey++,
                  label: "",
                  instructions: "",
                  latitude: "",
                  longitude: "",
                  mandatory: true,
                  photoRequired: true,
                },
              ])
            }
          >
            Add checkpoint
          </Button>
        </div>
      </div>
    </Card>
  );
}
