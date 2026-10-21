/**
 * The Prompt Center's read model (ADR-0236 §5.1): one list over every prompt
 * resource, each kept by its own owner.
 *
 * Code-owned slots (`code`) are the only resources whose text lives in the
 * generic override store. Everything else keeps its existing authority, a
 * character row, a preset, a Skill, a custom mode, an instruction file in a
 * repository, the workspace record, an app setting, and an adapter here only
 * reads it and writes it back through that owner's own service. There is never
 * a second active copy of a domain text.
 *
 * Adapters state what the editor may do instead of pretending every write is
 * the same: a built-in character is changed by creating a variant, a built-in
 * preset or Skill by a custom copy, a file by a checked write against the hash
 * that was read, and composer templates are user messages that are only listed.
 */

import type { PromptGroup, PromptOperation, PromptResourceKind } from "./types"
import type {
  OwnerPromptDocument,
  PromptEditCapability,
  PromptResourceSource,
} from "@cognia/plugin-contract/lib/prompts/resources"
export type {
  OwnerPromptDocument,
  PromptEditCapability,
  PromptResourceSource,
} from "@cognia/plugin-contract/lib/prompts/resources"

export interface PromptResourceSummary {
  /** Stable key, `<source>:<owner id>`. */
  key: string
  source: PromptResourceSource
  kind: PromptResourceKind
  operation: PromptOperation
  /** The owner's display name. Absent for code entries, which the UI labels by id. */
  name?: string
  /** For `code` resources. */
  promptId?: string
  group?: PromptGroup
  builtIn: boolean
  /** Differs from what shipped (an override, an edited copy, a variant owning its prompt). */
  modified: boolean
  edit: PromptEditCapability
  /** Settings section that owns the resource, for "Open in …". */
  ownerSection?: string
  /** Short secondary line (a file's path, a preset's category). */
  detail?: string
  /**
   * A `code` slot whose definition is not available here (its plugin is
   * disabled or removed, or this version no longer ships it) but that still
   * holds overrides. Listed so the user's text is never silently dropped; it
   * is exported with the profile and can be removed, not edited.
   */
  unavailable?: true
}

/** What the adapters need beyond the account database. */
export interface PromptResourceContext {
  /** The workspace whose files and record the instruction adapters read. */
  workspace?: {
    id: string
    name: string
    roots: readonly string[]
    customInstructions?: string
  }
}

export interface PromptCustomCopyOptions {
  /** Name of a newly created copy or variant; the UI passes a localized one. */
  name?: string
}

export interface OwnerPromptAdapter {
  source: Exclude<PromptResourceSource, "code">
  list(ctx: PromptResourceContext): Promise<PromptResourceSummary[]>
  read(key: string, ctx: PromptResourceContext): Promise<OwnerPromptDocument | undefined>
  /** Save in place. `version` is the document's precondition. Returns the saved document. */
  save?(
    key: string,
    text: string,
    version: string | undefined,
    ctx: PromptResourceContext
  ): Promise<OwnerPromptDocument>
  /** Create (or update) the owner's custom copy with `text`; returns the copy's key. */
  saveCustom?(
    key: string,
    text: string,
    ctx: PromptResourceContext,
    options?: PromptCustomCopyOptions
  ): Promise<string>
  /** Make the resource the default its owner applies (a preset's default binding). */
  makeDefault?(key: string, ctx: PromptResourceContext): Promise<void>
  /** Return a derived resource to its base (a variant following its base again). */
  reset?(key: string, ctx: PromptResourceContext): Promise<void>
}

/** `<source>:<id>` → its parts. The id may itself contain colons (file keys do). */
export function parseResourceKey(key: string): { source: string; id: string } {
  const at = key.indexOf(":")
  return at < 0 ? { source: key, id: "" } : { source: key.slice(0, at), id: key.slice(at + 1) }
}

export function resourceKey(source: PromptResourceSource, id: string): string {
  return `${source}:${id}`
}
