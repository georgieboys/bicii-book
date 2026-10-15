import pg from "pg";

/**
 * Direct SQL on the E2E database (the one global-setup resets: PGDATABASE,
 * default bicii_dev), for the few assertions no screen can make: that an
 * unknown email got no Auth user, ageing a sign-in code past its expiry,
 * holding Auth's per-address interval open, and deactivating someone
 * without ending their sessions (the hosted window of PLAN D71), and the
 * states no screen can build any more: a job closed before D149b's guard
 * (closeBeforeTheGuard). Superuser connection; never use it to set up data
 * a screen should create (answerQuoteByLink is the quote page's own RPC,
 * for specs whose subject is not that page). (config.mjs is an ES module; Playwright compiles specs to
 * CommonJS, hence the dynamic import.)
 */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const { devDatabaseUrl } = await import("../../scripts/devstack/config.mjs");
  const client = new pg.Client({ connectionString: devDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/**
 * Runs `fn` in one transaction on the E2E database (committed if it
 * returns, rolled back if it throws), for statements that must not be seen
 * apart, such as disabling a trigger for one update.
 */
export async function sqlTransaction(
  fn: (
    query: <T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      values?: unknown[],
    ) => Promise<T[]>,
  ) => Promise<void>,
): Promise<void> {
  const { devDatabaseUrl } = await import("../../scripts/devstack/config.mjs");
  const client = new pg.Client({ connectionString: devDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await fn(async (text, values = []) => (await client.query(text, values)).rows);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Moves a job through `statuses` as `authUserId` (set_work_order_status,
 * as the screens do) with 20261014000900's two D149b/c work_orders
 * triggers switched off for that one transaction, so the job closes with
 * its approved items unfitted and any open quote left open: the state of
 * the jobs that closed before the guard (production's J-000002; R-082's
 * residual), which D149's admin or manager cancel still serves.
 */
export async function closeBeforeTheGuard(
  workOrderId: string,
  statuses: readonly string[],
  authUserId: string,
): Promise<void> {
  const triggers = (verb: "enable" | "disable") =>
    `alter table public.work_orders ${verb} trigger work_orders_require_settled_requests, ${verb} trigger work_orders_withdraw_open_quote`;
  await sqlTransaction(async (query) => {
    await query(triggers("disable"));
    await query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role: "authenticated", sub: authUserId }),
    ]);
    await query("set local role authenticated");
    for (const status of statuses) {
      await query("select public.set_work_order_status($1, $2::public.work_order_status)", [
        workOrderId,
        status,
      ]);
    }
    await query("reset role");
    await query(triggers("enable"));
  });
}

/**
 * The customer's answer by link, signed out (anon), as the quote page
 * sends it: every item approved unless `approve(description)` says no.
 * For specs whose subject is not the quote page (indent.spec.ts walks it).
 */
export async function answerQuoteByLink(
  link: string,
  name: string,
  approve: (description: string) => boolean = () => true,
): Promise<void> {
  const token = link.slice(link.lastIndexOf("/") + 1);
  await sqlTransaction(async (query) => {
    await query("set local role anon");
    const [quote] = await query<{ q: { items: { id: string; description: string }[] } }>(
      "select public.quote_by_token($1) as q",
      [token],
    );
    const decisions = quote.q.items.map((i) => ({
      item_id: i.id,
      approve: approve(i.description),
    }));
    await query("select public.answer_quote($1, $2::jsonb, $3)", [
      token,
      JSON.stringify(decisions),
      name,
    ]);
  });
}
