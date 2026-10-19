"use client";

import { useState, useTransition, type FormEvent } from "react";

import {
  createCategory,
  setCategoryArchived,
  updateCategory,
} from "@/app/(staff)/settings/services/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { Category, CategoryKind } from "@/lib/domain/services";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

const EMPTY: Record<CategoryKind, string> = {
  service: "No categories yet. Services without one are listed under Other.",
  product: "No categories yet. Products can be added without one and filed later.",
};

/**
 * Service or product categories (manage_inventory): the list, add one,
 * rename one in place, archive and bring back. Categories are never
 * deleted; a service or product filed under an archived one keeps it.
 */
export function CategoriesEditor({
  categories,
  kind = "service",
}: {
  categories: Category[];
  kind?: CategoryKind;
}) {
  const active = categories.filter((c) => !c.archived);
  const archived = categories.filter((c) => c.archived);
  return (
    <div className="flex flex-col gap-5">
      {active.length === 0 ? (
        <p className="text-dust-700">{EMPTY[kind]}</p>
      ) : (
        <ul aria-label="Categories" className="flex flex-col divide-y divide-hairline">
          {active.map((c) => (
            <CategoryRow key={c.id} category={c} kind={kind} />
          ))}
        </ul>
      )}
      <AddCategory kind={kind} />
      {archived.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="eyebrow text-dust-500">Archived categories</h3>
          <ul aria-label="Archived categories" className="flex flex-col divide-y divide-hairline">
            {archived.map((c) => (
              <CategoryRow key={c.id} category={c} kind={kind} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CategoryRow({ category, kind }: { category: Category; kind: CategoryKind }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [error, setError] = useState<string | undefined>();

  const rename = (e: FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const result = await callAction(() => updateCategory({ id: category.id, name, kind }));
      if (!result.ok) {
        setError(result.fieldErrors?.name?.[0] ?? result.error);
        return;
      }
      setError(undefined);
      setEditing(false);
      toast({ title: `Renamed to ${name.trim()}`, tone: "success" });
    });
  };

  const archive = (next: boolean) =>
    startTransition(async () => {
      const result = await callAction(() =>
        setCategoryArchived({ id: category.id, archived: next, kind }),
      );
      if (!result.ok) {
        toast({ title: `${category.name} not changed`, description: result.error, tone: "error" });
        return;
      }
      toast({
        title: next ? `${category.name} archived` : `${category.name} restored`,
        tone: "success",
      });
    });

  if (editing) {
    return (
      <li className="py-2">
        <form onSubmit={rename} className="flex flex-wrap items-end gap-2" noValidate>
          <Field
            label={`Rename ${category.name}`}
            error={error}
            className="min-w-0 flex-1 basis-48"
          >
            <Input
              autoFocus
              autoComplete="off"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" pending={pending} pendingLabel="Saving…">
            Save
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="flex min-h-tap flex-wrap items-center justify-between gap-2 py-1">
      <span className="font-medium">{category.name}</span>
      <span className="flex gap-1">
        {category.archived ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Rename ${category.name}`}
            onClick={() => {
              setName(category.name);
              setEditing(true);
            }}
          >
            Rename
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${category.archived ? "Unarchive" : "Archive"} ${category.name}`}
          pending={pending}
          onClick={() => archive(!category.archived)}
        >
          {category.archived ? "Unarchive" : "Archive"}
        </Button>
      </span>
    </li>
  );
}

function AddCategory({ kind }: { kind: CategoryKind }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [id, setId] = useState(newId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const result = await callAction(() => createCategory({ id, name, kind }));
      if (!result.ok) {
        setError(result.fieldErrors?.name?.[0] ?? result.error);
        return;
      }
      toast({ title: `${name.trim()} added`, tone: "success" });
      setError(undefined);
      setName("");
      setId(newId());
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
      <Field label="New category" error={error} className="min-w-0 flex-1 basis-48">
        <Input
          autoComplete="off"
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
        />
      </Field>
      <Button type="submit" variant="outline" pending={pending} pendingLabel="Adding…">
        Add category
      </Button>
    </form>
  );
}
