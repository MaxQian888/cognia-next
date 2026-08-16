/**
 * Shared coloured-label catalogue (Dexie v170).
 *
 * Before v170 this repo had exactly one real label system — the connector CRM
 * catalogue (`ConversationLabelRow`, table `conversationLabels`, schema v83) —
 * plus five independent free-text `string[]` tag implementations (AgentTask,
 * workflows, scheduler, custom modes, memory). Rather than add a *second*
 * coloured catalogue for issues, v170 generalises the CRM one: the rows move
 * to a shared `labels` table with a `scope` discriminator, ids preserved.
 *
 * Preserving ids is the whole trick — `ConversationOverrideRow.labelIds[]` and
 * `CannedResponseRow.labelIds[]` keep resolving with no migration of their own.
 * `lib/db/crm-types.ts` re-exports `ConversationLabelRow` as an alias of
 * `LabelRow`, so every existing import keeps compiling.
 *
 * Explicitly NOT in scope: unifying the five free-text tag implementations.
 * That is separate technical debt and would balloon this change.
 */

/** Which surface a label belongs to. Labels never cross scopes. */
export const LABEL_SCOPES = ["conversation", "issue"] as const

export type LabelScope = (typeof LABEL_SCOPES)[number]

/** A reusable coloured label. */
export interface LabelRow {
  id: string
  /**
   * Owning surface. Rows migrated from `conversationLabels` carry
   * `"conversation"`; the issue tracker writes `"issue"`.
   */
  scope: LabelScope
  /** Display name, unique within a scope (the CRUD layer enforces it). */
  name: string
  /** Optional oklch/hex color token for the chip. */
  color?: string
  description?: string
  /** Seeded built-in labels (e.g. "bug", "follow-up") cannot be deleted. */
  builtin?: boolean
  /** Manual ordering in the label manager. */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/**
 * Default palette for new labels — oklch tokens that read correctly in both
 * themes. Kept here (not in a component) so the CRUD layer can round-robin a
 * colour when the user doesn't pick one.
 */
export const LABEL_COLORS: readonly string[] = [
  "oklch(0.65 0.19 25)", // red
  "oklch(0.72 0.16 60)", // amber
  "oklch(0.75 0.15 130)", // green
  "oklch(0.70 0.13 195)", // teal
  "oklch(0.62 0.18 265)", // blue
  "oklch(0.60 0.20 305)", // purple
  "oklch(0.68 0.17 350)", // pink
  "oklch(0.60 0.02 260)", // slate
]

/** Deterministic colour pick for a label with no explicit colour. */
export function defaultLabelColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 2147483647
  }
  return LABEL_COLORS[hash % LABEL_COLORS.length]
}
