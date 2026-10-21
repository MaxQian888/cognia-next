/**
 * The plugin contract's share of `lib/placement/types.ts`, which re-exports these.
 */
/** How a caller wants placement resolved. */
export type PlacementConstraint =
  /** Run wherever the parent ran. The zero-configuration default. */
  | { mode: "colocate" }
  /** Run on exactly this candidate, or wait for it. */
  | { mode: "pinned"; ref: string }
  /** Run on the least-loaded compatible candidate. */
  | { mode: "auto" }
