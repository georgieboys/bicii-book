/**
 * A count with its noun, singular for exactly 1: `plural(1, "day", "days")`
 * is "1 day", `plural(0, "day", "days")` is "0 days". The one shared helper
 * for counted text in the app; pass both forms so irregular nouns read right.
 */
export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;
