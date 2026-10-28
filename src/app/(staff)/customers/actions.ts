"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import {
  createCustomer as create,
  searchCustomerOptions,
  setCustomerArchived as setArchived,
  updateCustomer as update,
} from "@/lib/domain/customers";

/** Optional text: trimmed, at most `max` characters, blank stored as null. */
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .optional()
    .transform((v) => (v ? v : null));

// The same shape the customers_email_check constraint accepts.
const EMAIL = /^[^@\s]+@[^@\s]+$/;

const customerSchema = z
  .object({
    /** New customer: the form's idempotency key. Edit: the customer. */
    id: z.guid({ error: "Unknown customer." }),
    firstName: text(100, "first name"),
    lastName: text(100, "last name"),
    displayName: text(200, "name"),
    email: text(320, "email").refine((v) => v === null || EMAIL.test(v), {
      error: "Enter a valid email address.",
    }),
    phone: text(40, "phone number"),
    internalNotes: text(10_000, "notes"),
  })
  .refine((c) => c.firstName || c.lastName || c.displayName || c.email || c.phone, {
    error: "Enter a name, an email or a phone number.",
    path: ["firstName"],
  });

/** New customer (src/lib/domain/customers.ts createCustomer). */
export const createCustomer = staffAction(
  customerSchema,
  { name: "customers.create" },
  async ({ id, ...input }, { supabase }) => create(supabase, id, input),
);

export const updateCustomer = staffAction(
  customerSchema,
  { name: "customers.update" },
  async ({ id, ...input }, { supabase }) => {
    await update(supabase, id, input);
    refresh();
    return null;
  },
);

export const setCustomerArchived = staffAction(
  z.object({ customerId: z.guid({ error: "Unknown customer." }), archived: z.boolean() }),
  { name: "customers.set_archived" },
  async ({ customerId, archived }, { supabase }) => {
    await setArchived(supabase, customerId, archived);
    refresh();
    return null;
  },
);

/** Active customers matching a query, for customer pickers. */
export const searchCustomers = staffAction(
  z.object({ q: z.string().trim().max(200) }),
  { name: "customers.search_options" },
  async ({ q }, { supabase }) => (q ? searchCustomerOptions(supabase, q) : []),
);
