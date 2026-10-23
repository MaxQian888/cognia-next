/**
 * The plugin contract's share of `lib/db/prompt-overrides.ts`, which re-exports these.
 */
import type { PromptScope } from "../prompts/types"

export interface PromptOverrideBindingRow {
  /** `pob_…` */
  id: string
  promptId: string
  scope: PromptScope
  /** Workspace / agent / session id; empty for the account scope. */
  targetId: string
  /** The published revision consumers resolve, or `null` to inherit. */
  activeRevisionId: string | null
  /** Unpublished work in progress, or `null`. */
  draftRevisionId: string | null
  /** Concurrency counter; every mutation must name the value it read. */
  rev: number
  createdAt: number
  updatedAt: number
}

export type PromptRevisionKind = "draft" | "published" | "reset"

/** Who wrote a revision. `plugin` is a change a plugin applied after the user confirmed it. */
export type PromptRevisionOrigin = "editor" | "import" | "restore" | "cli" | "plugin"

export interface PromptOverrideRevisionRow {
  /** `por_…` */
  id: string
  bindingId: string
  promptId: string
  /** The active revision this one was written over, for history. */
  parentId: string | null
  kind: PromptRevisionKind
  /** Static template text. Empty for a `reset` revision. */
  body: string
  /** The definition contract the body was validated against. */
  contractVersion: number
  /** Digest of the shipped default the edit was made against (upgrade compare). */
  baseDigest: string
  origin: PromptRevisionOrigin
  /** Caller-supplied idempotency key; a replay returns the settled binding. */
  mutationId: string
  createdAt: number
}
