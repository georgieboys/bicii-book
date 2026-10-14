/**
 * Proving a serialisation, not only an outcome (TESTING.md "Concurrency"):
 * the first call runs in an open transaction that holds its locks, the
 * second starts on another connection and must be seen waiting on a lock
 * (pg_stat_activity wait_event_type 'Lock': row, transaction-id and
 * advisory locks all report it) before the first commits. The same
 * pattern as consignment-concurrency.test.ts, with each side's own claims
 * (Phase 14's races mix the service role and staff).
 *
 * Commits, so only for a per-file clone (isolatedDatabase()).
 */
import type pg from "pg";

import { actAs, openConnections, scalar, type Claims } from "./harness";
import { committed, type Outcome } from "./inventory-fixtures";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `c`'s backend is blocked on a lock, watched from `observer`.
 * Fails if `settled()` turns true first (the statement finished without
 * waiting) or after `timeoutMs`.
 */
export async function untilBlocked(
  observer: pg.Client,
  c: pg.Client,
  settled: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const pid = (c as unknown as { processID: number }).processID;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (settled()) throw new Error("the second transaction finished without waiting on a lock");
    const waiting = await scalar<number>(
      observer,
      `select count(*)::int from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    );
    if (waiting === 1) return;
    if (Date.now() > deadline) throw new Error("the second transaction never waited on a lock");
    await pause(20);
  }
}

/**
 * Runs `first.run` as `first.as` in an open transaction, starts
 * `second.run` as `second.as` in a committed transaction on another
 * connection, proves it waits on a lock, commits the first, and returns
 * both outcomes. `observer` reads pg_stat_activity (any other connection).
 */
export async function race<A, B>(
  observer: pg.Client,
  first: { as: Claims; run: (tx: pg.Client) => Promise<A> },
  second: { as: Claims; run: (tx: pg.Client) => Promise<B> },
): Promise<[Outcome<A>, Outcome<B>]> {
  const [a, b] = await openConnections(2);
  try {
    await a.query("begin");
    await actAs(a, first.as);
    let firstResult: Outcome<A>;
    try {
      firstResult = { ok: true, value: await first.run(a) };
    } catch (error) {
      await a.query("rollback");
      throw error;
    }
    let settled = false;
    const secondResult = committed(b, second.run, second.as).finally(() => {
      settled = true;
    });
    try {
      await untilBlocked(observer, b, () => settled);
    } catch (error) {
      await a.query("rollback");
      await secondResult;
      throw error;
    }
    await a.query("commit");
    return [firstResult, await secondResult];
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
}
