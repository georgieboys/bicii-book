/**
 * Which paths are open to signed-out visitors (the customer's quote page,
 * /quote/<token>, since Phase 13 step 3, D143; the customer's payment
 * link, /pay/<token>, since Phase 14 step 3, D156f). Everything else is a
 * staff route: proxy.ts sends signed-out requests for it to /login (an
 * optimisation only; every page and action still calls requireStaff()).
 */
const PUBLIC_PREFIXES = ["/login", "/dev/", "/api/health", "/quote/", "/pay/"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`),
  );
}
