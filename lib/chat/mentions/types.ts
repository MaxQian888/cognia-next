/**
 * Structured mention handles (ContextRef) — the persisted counterpart of the
 * composer's inline `@…` tokens.
 *
 * Inline tokens stay the wire format (the CLI resolves `@path` natively and
 * prompts stay compact); a `ContextRef[]` is additionally captured at send
 * time (`resolve-mentions.ts`) and stored as `metadata.mentions` on the user
 * message row, making mentions searchable/auditable without regex re-parsing.
 * Legacy messages without the field fall back to the regex path
 * (`read.ts` `getMessageMentions`).
 *
 * Chip-style picks (skill / preset / workflow element) mutate session state
 * rather than inserting a token — they are session context, not message
 * mentions, and are deliberately NOT captured here.
 */

export type ContextRefKind =
  "file" | "agent" | "subagent" | "skill" | "preset" | "wfNode" | "wfEdge"

export interface ContextRef {
  kind: ContextRefKind
  /** Stable id: relPath for files, agent name, subagent handle, skill/preset/graph id. */
  id: string
  /** Display label when it differs from `id`. */
  label?: string
  /** The raw inline token as inserted/typed, e.g. `@src/app.ts`. */
  raw?: string
}
