"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import {
  removeSupplierProduct,
  setSupplierProduct,
} from "@/app/(staff)/purchasing/supplier-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";

import { ShortId } from "../short-id";
import { PurchaseProductPicker, type PurchaseProductOption } from "./purchase-product-picker";
import { SupplierPicker } from "./supplier-picker";

type Ref = { id: string; name: string };
type ProductRef = Ref & { shortId: string };

export type SupplierProductLinkFields = {
  supplierSku: string | null;
  leadDays: number | null;
  preferred: boolean;
};

type State = ActionResult<null> | null;

/**
 * Link a product to a supplier, or change the link (manage_purchasing):
 * the supplier's SKU, lead time in days and Preferred (one preferred
 * supplier per product: switching it on replaces another). Opened from a
 * supplier's page (supplier fixed; the product picked, or fixed when
 * editing) or from a product page (product fixed; the supplier picked).
 * Editing offers Remove link (two steps; a link is a relationship, so no
 * reason). The last cost is never edited here: receiving sets it (D63).
 */
export function SupplierProductSheet({
  supplier,
  product,
  link,
  preferredElsewhere,
  onClose,
}: {
  supplier?: Ref;
  product?: ProductRef;
  /** Edit this link (supplier and product both fixed). */
  link?: SupplierProductLinkFields;
  /** The product's current preferred supplier, when another one and known. */
  preferredElsewhere?: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [pickedSupplier, setPickedSupplier] = useState<PickerOption | null>(null);
  const [pickedProduct, setPickedProduct] = useState<PurchaseProductOption | null>(null);
  const [preferred, setPreferred] = useState(link?.preferred ?? false);
  const [removing, setRemoving] = useState(false);
  const supplierId = supplier?.id ?? pickedSupplier?.id ?? "";
  const productId = product?.id ?? pickedProduct?.id ?? "";
  const productName = product?.name ?? pickedProduct?.label ?? "the product";
  const supplierName = supplier?.name ?? pickedSupplier?.label ?? "the supplier";

  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => setSupplierProduct(prev, formData), formData);
    if (result.ok) {
      toast({
        title: link ? "Supplier link saved" : `${productName} linked to ${supplierName}`,
        tone: "success",
      });
      onClose();
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
      title={link ? "Supplier link" : product ? "Add supplier" : "Add product"}
      footer={
        removing ? undefined : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              pending={pending}
              pendingLabel="Saving…"
              disabled={!supplierId || !productId}
            >
              {link ? "Save" : "Link"}
            </Button>
          </>
        )
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="supplierId" value={supplierId} />
        <input type="hidden" name="productId" value={productId} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {supplier ? (
          <div className="flex flex-col gap-1">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Supplier</span>
            <p className="font-medium">{supplier.name}</p>
          </div>
        ) : (
          <Field label="Supplier" error={errors?.supplierId?.[0]} required>
            <SupplierPicker value={pickedSupplier} onSelect={setPickedSupplier} required />
          </Field>
        )}
        {product ? (
          <div className="flex flex-col gap-1">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Product</span>
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {product.name} <ShortId value={product.shortId} />
            </p>
          </div>
        ) : (
          <Field label="Product" error={errors?.productId?.[0]} required>
            <PurchaseProductPicker value={pickedProduct} onSelect={setPickedProduct} required />
          </Field>
        )}
        <Field
          label="Supplier SKU"
          hint="The supplier's own code for it, to put on the order."
          error={errors?.supplierSku?.[0]}
        >
          <Input
            name="supplierSku"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            defaultValue={values?.supplierSku ?? link?.supplierSku ?? ""}
          />
        </Field>
        <Field label="Lead time" hint="Days from order to delivery." error={errors?.leadDays?.[0]}>
          <NumberInput
            kind="quantity"
            name="leadDays"
            suffix="days"
            defaultValue={values?.leadDays ?? (link?.leadDays != null ? String(link.leadDays) : "")}
          />
        </Field>
        <Switch
          name="preferred"
          label="Preferred supplier"
          description={
            preferredElsewhere
              ? `Replaces ${preferredElsewhere} as this product's preferred supplier.`
              : "A product has one preferred supplier: switching this on replaces any other."
          }
          checked={preferred}
          onCheckedChange={setPreferred}
        />
      </form>
      {link && supplier && product ? (
        <RemoveLink
          supplier={supplier}
          product={product}
          onRemoved={onClose}
          onConfirming={setRemoving}
        />
      ) : null}
    </Sheet>
  );
}

function RemoveLink({
  supplier,
  product,
  onRemoved,
  onConfirming,
}: {
  supplier: Ref;
  product: ProductRef;
  onRemoved: () => void;
  onConfirming: (confirming: boolean) => void;
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const armed = useArmed(confirming);
  const keepRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const was = useRef(false);

  useEffect(() => {
    onConfirming(confirming);
    const cancelled = was.current && !confirming;
    was.current = confirming;
    if (confirming) keepRef.current?.focus();
    else if (cancelled) startRef.current?.focus();
  }, [confirming, onConfirming]);

  const remove = () =>
    start(async () => {
      const result = await callAction(() =>
        removeSupplierProduct({
          supplierId: supplier.id,
          productId: product.id,
        }),
      );
      if (!result.ok) {
        toast({ title: "Link not removed", description: result.error, tone: "error" });
        return;
      }
      was.current = false;
      setConfirming(false);
      toast({ title: `${product.name} unlinked from ${supplier.name}`, tone: "success" });
      onRemoved();
    });

  return (
    <div className="mt-6 border-t border-hairline pt-4">
      {confirming ? (
        <div key="confirm" className="flex flex-col gap-3 rounded-xl bg-waiting-soft p-4">
          <p className="text-sm font-medium text-waiting-deep">
            Stop listing {supplier.name} as a supplier of {product.name}? Orders already placed stay
            as they are.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button key="keep" ref={keepRef} variant="outline" onClick={() => setConfirming(false)}>
              Keep link
            </Button>
            <Button
              key="remove"
              variant="solid"
              disabled={!armed}
              pending={pending}
              pendingLabel="Removing…"
              onClick={remove}
            >
              Remove link
            </Button>
          </div>
        </div>
      ) : (
        <div key="start">
          <Button ref={startRef} variant="outline" onClick={() => setConfirming(true)}>
            Remove link…
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Add product" on a supplier's page, or "Add supplier" on a product's. */
export function AddSupplierProductButton({
  supplier,
  product,
  preferredElsewhere,
}: {
  supplier?: Ref;
  product?: ProductRef;
  preferredElsewhere?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<PlusIcon className="size-4" />}
        onClick={() => setOpen(true)}
      >
        {product ? "Add supplier" : "Add product"}
      </Button>
      {open ? (
        <SupplierProductSheet
          supplier={supplier}
          product={product}
          preferredElsewhere={preferredElsewhere}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** A supplier's product row that opens the link sheet (manage_purchasing). */
export function EditSupplierProductButton({
  supplier,
  product,
  link,
  children,
}: {
  supplier: Ref;
  product: ProductRef;
  link: SupplierProductLinkFields;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left focus-inset hover:bg-dust-100"
      >
        <span className="sr-only">Change link: </span>
        {children}
      </button>
      {open ? (
        <SupplierProductSheet
          supplier={supplier}
          product={product}
          link={link}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
