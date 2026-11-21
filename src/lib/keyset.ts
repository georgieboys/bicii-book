/**
 * A keyset cursor for lists ordered by (created_at, id): the last row's
 * pair, carried in one URL parameter as "<ISO instant>_<uuid>".
 */
export type KeysetCursor = { createdAt: string; id: string };

export function encodeKeyset(c: KeysetCursor): string {
  return `${c.createdAt}_${c.id}`;
}

/** The cursor in a URL parameter, or null when it is missing or malformed. */
export function decodeKeyset(value: string | null | undefined): KeysetCursor | null {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))_([0-9a-f-]{36})$/i.exec(
    value ?? "",
  );
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { createdAt: m[1], id: m[2].toLowerCase() };
}

/**
 * The PostgREST `or` filter for the rows after `c` in a list ordered by
 * created_at then id, both descending (newest first) or both ascending.
 */
export function afterKeyset(c: KeysetCursor, ascending: boolean): string {
  const at = JSON.stringify(c.createdAt);
  const op = ascending ? "gt" : "lt";
  return `created_at.${op}.${at},and(created_at.eq.${at},id.${op}.${c.id})`;
}
