/**
 * Says a list stopped at its cap, so a missing row is never mistaken for
 * none (audit A-76).
 */
export function CappedNote({ count, cap, what }: { count: number; cap: number; what: string }) {
  if (count < cap) return null;
  return (
    <p role="status" className="bg-paper-200 mb-4 rounded-xl px-3 py-2 text-sm text-dust-700">
      Showing the first {cap} {what}. Narrow the list to see the rest.
    </p>
  );
}
