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
 * Chip-style picks leave no token, so re-parsing the text can never find them.
 * They enter through `MentionPickContext.recordMention` instead, and the send
 * path merges both lists. Two groups, split by whether a citation even exists:
 *
 *   - `skill` / `preset` / `wfNode` / `wfEdge` mutate SESSION STATE. Enabling a
 *     skill is not a statement about this message, so they record nothing and
 *     these kinds stay declared-but-unproduced. That is deliberate, and
 *     `read.ts` still accepts them so a future producer needs no migration.
 *   - `doc` (ADR-0134) and `entity` DO carry a citation: their body is read at
 *     pick time and staged — as an attachment and as a context chip
 *     respectively — so no `@…` token survives and this ref is the only record
 *     that the turn cited that document or record. `doc` ids are
 *     `<providerId>:<documentId>`; `entity` ids are `<entityKind>:<recordId>`.
 */

export type ContextRefKind =
  "file" | "agent" | "subagent" | "skill" | "preset" | "wfNode" | "wfEdge" | "doc" | "entity"

export interface ContextRef {
  kind: ContextRefKind
  /**
   * Stable id: relPath for files, agent name, subagent handle, skill / preset /
   * graph id, `<providerId>:<documentId>` for a document,
   * `<entityKind>:<recordId>` for a record.
   */
  id: string
  /** Display label when it differs from `id`. */
  label?: string
  /** The raw inline token as inserted/typed, e.g. `@src/app.ts`. */
  raw?: string
}
