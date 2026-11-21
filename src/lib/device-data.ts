/**
 * What the Admin keeps on a device for the person signed in: the intake
 * draft (src/lib/intake-draft.ts) and the recent searches
 * (src/lib/recent-searches.ts). Both are removed when someone signs out
 * (SignOutButton) and whenever the login page opens, which also covers a
 * session that expired or was revoked, so the next person on a shared
 * device never sees them. Never throws: each helper wraps its storage.
 */
import { clearDraft } from "@/lib/intake-draft";
import { clearRecentSearches } from "@/lib/recent-searches";

export function clearSignedInDeviceData(): void {
  clearDraft();
  clearRecentSearches();
}
