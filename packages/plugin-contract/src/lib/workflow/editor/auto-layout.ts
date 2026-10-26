/**
 * The plugin contract's share of `lib/workflow/editor/auto-layout.ts`, which re-exports these.
 */

export type AutoLayoutDirection = keyof typeof ELK_DIRECTIONS

/** Editor-facing flow directions mapped onto elkjs' `elk.direction` values. */
export const ELK_DIRECTIONS = {
  LR: "RIGHT",
  RL: "LEFT",
  TB: "DOWN",
  BT: "UP",
} as const
