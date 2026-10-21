/**
 * The plugin contract's share of `lib/prompts/resources.ts`, which re-exports these.
 */
export type PromptResourceSource =
  | "code"
  | "character"
  | "preset"
  | "skill"
  | "custom-mode"
  | "instruction-file"
  | "workspace-instructions"
  | "app-setting"
  | "composer-template"
  | "subagent-template"
  | "team-template"

/** What the Prompt Center may do with a resource's text. */
export type PromptEditCapability =
  /** Drafts, scoped overrides, history: the generic override store. */
  | "publish"
  /** Save the owner's own text in place. */
  | "source"
  /** The owner's text is shipped or plugin-owned; edits create the owner's custom copy or variant. */
  | "custom-copy"
  /** Readable here; the owner's own screen edits it (composer templates). */
  | "owner-only"

/** The text of an owner resource as the Prompt Center edits it. */
export interface OwnerPromptDocument {
  key: string
  text: string
  /**
   * What the text derives from, for comparison: a variant's base, the shipped
   * prompt a copy was made from. Absent when the resource is original.
   */
  baseText?: string
  /** Precondition for the next save (a file hash). Opaque to the UI. */
  version?: string
  /** Why the text cannot be saved in place, when it cannot. */
  readOnlyReason?: "built-in" | "plugin" | "immutable" | "host-unsupported"
  /** The variant or copy a `custom-copy` edit would update rather than create again. */
  customKey?: string
}
