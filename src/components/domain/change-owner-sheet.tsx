"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { reclassifyAsConsignmentAction } from "@/app/(staff)/consignment/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { paidAtFromDate, stockToMove, type ChangeOwnerStock } from "@/lib/consignment";
import { RECLASSIFY_REASON_MAX } from "@/lib/consignment-forms";
import { shopToday } from "@/lib/dates";
import { signedQuantity } from "@/lib/inventory";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ConsignorPicker } from "./consignor-picker";

type Result = { itemId: string | null; itemShortId: string | null; quantity: number };

const plain = (n: number) => signedQuantity(n).replace(/^\+/, "");

/**
 * "Change owner" on a shop product counted by quantity (D162). Admins only:
 * the page offers it to the admin role, the action and the RPC check again.
 */
export function ChangeOwnerButton(props: {
  productId: string;
  productName: string;
  stock: ChangeOwnerStock[];
  cost: string | null;
  salePrice: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Change owner
      </Button>
      {open ? <ChangeOwnerSheet {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Makes a shop product's stock a consignor's, on the same product
 * (reclassify_as_consignment): the consignor, the amount owed per item
 * (the product's cost to start with), the asking price (its sale price),
 * the date it came in and a required reason. Its count leaves the shop's
 * stock and comes back as one consignment item, so the P- number and
 * printed labels stay. Stock at two locations is moved to one first; the
 * database refuses a product that has been sold, used, ordered or linked.
 * The item id is made when the sheet opens, so a retry changes it once.
 */
function ChangeOwnerSheet({
  productId,
  productName,
  stock,
  cost,
  salePrice,
  onClose,
}: {
  productId: string;
  productName: string;
  stock: ChangeOwnerStock[];
  cost: string | null;
  salePrice: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [itemId] = useState(newId);
  const [today] = useState(() => shopToday());
  const [consignor, setConsignor] = useState<PickerOption | null>(null);
  const [agreed, setAgreed] = useState(cost ?? "");
  const [asking, setAsking] = useState(salePrice ?? "");
  const [receivedDay, setReceivedDay] = useState(today);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<ActionResult<Result> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const err = (key: string) => errors?.[key]?.[0];

  const moving = stockToMove(stock);
  const split = moving.length > 1;

  const submit = () => {
    const input = {
      itemId,
      productId,
      consignorId: consignor?.id ?? "",
      // With no stock nothing is taken in, so no amount is owed.
      agreedAmountOwed: moving.length === 0 ? "0" : agreed,
      askingPrice: moving.length === 0 ? null : asking || null,
      receivedAt: moving.length === 0 || !receivedDay ? null : paidAtFromDate(receivedDay, today),
      reason,
    };
    start(async () => {
      const result = await callAction(() => reclassifyAsConsignmentAction(input));
      setState(result);
      if (!result.ok) return;
      if (result.data.itemId) {
        toast({
          title: `${result.data.itemShortId ?? "Item"} received from ${consignor?.label ?? "the consignor"}`,
          tone: "success",
        });
        router.push(`/consignment/items/${result.data.itemId}`);
      } else {
        toast({ title: "Now consigned stock", tone: "success" });
        onClose();
      }
    });
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Change owner"
      description={productName}
      footer={
        split ? undefined : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form={formId} pending={pending} pendingLabel="Changing…">
              Make it consigned stock
            </Button>
          </>
        )
      }
    >
      {split ? (
        <p role="alert" className="rounded-xl bg-sunken p-3 text-sm text-dust-700">
          This stock is at {moving.map((s) => `${s.name} (${plain(s.onHand)})`).join(" and ")}. Move
          it to one location with Transfer first, then change the owner.
        </p>
      ) : (
        <form
          id={formId}
          ref={formRef}
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {state && !state.ok ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {state.error}
            </p>
          ) : null}
          <p className="rounded-xl bg-sunken p-3 text-sm text-dust-700">
            For stock that belongs to a consignor but was added as the shop&apos;s.{" "}
            {moving.length === 1
              ? `Its ${plain(moving[0].onHand)} at ${moving[0].name} leave the shop's stock and are received as one consignment item.`
              : "There is no stock, so only the owner changes."}{" "}
            It keeps its P- number and labels. Only stock that was never sold, used on a job or
            ordered can change owner, and it can&apos;t be changed back.
          </p>
          <Field label="Consignor" required error={err("consignorId")}>
            <ConsignorPicker value={consignor} onSelect={setConsignor} required />
          </Field>
          {moving.length === 1 ? (
            <>
              <Field
                label="Amount owed to the consignor when it sells"
                hint="Per item. 0 is allowed. It is the cost of each sale."
                required
                error={err("agreedAmountOwed")}
              >
                <NumberInput kind="money" value={agreed} onValueChange={setAgreed} />
              </Field>
              <Field
                label="Asking price"
                hint="Per item. The public, label and sale price."
                error={err("askingPrice")}
              >
                <NumberInput kind="money" value={asking} onValueChange={setAsking} />
              </Field>
              <Field label="Received" error={err("receivedAt")}>
                <Input
                  type="date"
                  max={today}
                  value={receivedDay}
                  onChange={(e) => setReceivedDay(e.target.value || today)}
                />
              </Field>
            </>
          ) : null}
          <Field
            label="Reason"
            hint="Kept in the product's stock history."
            required
            error={err("reason")}
          >
            <Textarea
              rows={2}
              maxLength={RECLASSIFY_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </form>
      )}
    </Sheet>
  );
}
