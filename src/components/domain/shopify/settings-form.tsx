"use client";

import { useActionState, useState } from "react";

import { saveShopifySettingsAction } from "@/app/(staff)/shopify/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import type { ShopifySettingsDTO } from "@/lib/domain/shopify";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { TEST_ORDERS_WARNING } from "@/lib/shopify";
import { callAction } from "@/lib/call-action";

type State = ActionResult<ShopifySettingsDTO> | null;

/**
 * Shopify settings (admins; D83, D84, D89): the online location (the stock
 * Shopify sells: a segmented control for up to four locations, else a
 * native select), the storefront address the Buy-online link uses, and
 * whether Shopify test orders are recorded as sales, which needs a reason
 * whenever it changes. Saved through useActionState; a refused save shows
 * what was typed again (ActionResult.values).
 */
export function ShopifySettingsForm({
  settings,
  locations,
}: {
  settings: ShopifySettingsDTO;
  locations: { id: string; name: string }[];
}) {
  const { toast } = useToast();
  const [locationId, setLocationId] = useState(settings.onlineLocationId ?? "");
  const [acceptTest, setAcceptTest] = useState(settings.acceptTestOrders);
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => saveShopifySettingsAction(prev, formData), formData);
    if (result.ok) toast({ title: "Shopify settings saved", tone: "success" });
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const testChanged = acceptTest !== settings.acceptTestOrders;

  return (
    <form ref={formRef} action={formAction} noValidate className="flex flex-col gap-5">
      {state && !state.ok ? (
        <p role="alert" className="text-sm font-medium text-danger-deep">
          {state.error}
        </p>
      ) : null}
      <Field
        label="Online location"
        hint="Shopify sells the stock counted here; online orders take it from here."
        error={errors?.onlineLocationId?.[0]}
        required
      >
        {locations.length <= 4 ? (
          <SegmentedControl
            label="Online location"
            name="onlineLocationId"
            value={locationId || null}
            onValueChange={setLocationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
          />
        ) : (
          <Select
            name="onlineLocationId"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Storefront address"
        hint="Used for the Buy online link on public item pages. Leave empty for no link."
        error={errors?.storefrontUrl?.[0]}
      >
        <Input
          name="storefrontUrl"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          maxLength={200}
          placeholder="https://shop.bicii.sg"
          defaultValue={values?.storefrontUrl ?? settings.storefrontUrl ?? ""}
        />
      </Field>
      <div className="flex flex-col gap-1">
        <Switch
          label="Record Shopify test orders as sales"
          description={TEST_ORDERS_WARNING}
          name="acceptTestOrders"
          checked={acceptTest}
          onCheckedChange={setAcceptTest}
        />
        <input
          type="hidden"
          name="wasAcceptingTestOrders"
          value={settings.acceptTestOrders ? "true" : "false"}
        />
      </div>
      {testChanged || errors?.reason ? (
        <Field
          label="Reason"
          hint="Needed when you change whether test orders are recorded."
          error={errors?.reason?.[0]}
          required
        >
          <Textarea
            name="reason"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            defaultValue={values?.reason ?? ""}
          />
        </Field>
      ) : null}
      <div>
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          Save settings
        </Button>
      </div>
    </form>
  );
}
