/**
 * The plugin contract's share of `lib/prompts/types.ts`, which re-exports these.
 */
/** What kind of resource a catalog entry is. Drives grouping and the allowed edit. */
export type PromptResourceKind =
  /** A code-owned template a feature sends on its own call (title, judge, …). */
  | "feature-template"
  /** A persona or identity: character, agent mode, subagent. */
  | "role"
  /** An on-demand procedure: a Skill bundle. */
  | "procedure"
  /** Project or user rules: instruction files, project custom instructions. */
  | "project-rule"
  /** The base every chat turn starts from (default append, CLI base). */
  | "runtime-baseline"
  /** Text a parser or host contract depends on; inspectable, never editable. */
  | "protocol"
  /** Text the user inserts into the composer as their own message. */
  | "composer-template"

/** Where an override may apply, most specific last. */
export type PromptScope = "account" | "workspace" | "agent" | "session"

/** UI grouping of the code-owned catalog. */
export type PromptGroup =
  | "chat"
  | "generation"
  | "completion"
  | "agents"
  | "goals"
  | "team"
  | "knowledge"
  | "developer"
  | "twin"
  | "permissions"
  | "routing"

/** One placeholder an editable body may reference as `{{name}}`. */
export interface PromptVariableSpec {
  name: string
  /** A body that omits a required variable cannot be published. */
  required: boolean
  /** Upper bound the owner clips the value to before interpolation. */
  maxChars: number
}
