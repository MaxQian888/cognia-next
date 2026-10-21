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

export const PROMPT_DEFINITION_SCHEMA_VERSION = 1 as const

export type PromptOperation =
  /** Replace a declared feature slot; typed inputs and parsers stay in the owner. */
  | "replace-template"
  /** Add guidance alongside other applicable rules. */
  | "append-rules"
  /** The existing replacement behaviour of a role prompt (base selection). */
  | "legacy-replace"
  /** Activate an on-demand procedure through its delivery policy. */
  | "activate-procedure"
  /** Narrow a host decision: the edit can only make the outcome more conservative. */
  | "narrow-only"
  /** Visible for inspection only. */
  | "inspect-only"

export const PROMPT_SCOPE_SPECIFICITY: readonly PromptScope[] = [
  "account",
  "workspace",
  "agent",
  "session",
]

export type PromptActivation =
  /** The consumer resolves at each operation; the next one uses the new text. */
  | "next-operation"
  /** An external agent session caches its instructions; a new session adopts it. */
  | "new-session-required"
  /** The owning loader must reload before the change applies. */
  | "reload-required"
  /** This host cannot apply the entry (e.g. a CLI-only base viewed in the app). */
  | "unsupported"

export type PromptRisk =
  /** A wording change; a bad edit degrades output quality only. */
  | "ordinary"
  /** The consumer parses the output or relies on a protocol the text teaches. */
  | "protocol"
  /** The output takes part in an approval decision. */
  | "approval-sensitive"

export type PromptHost = "app" | "cli" | "bootstrap"

export interface PromptDefinitionV1 {
  schemaVersion: typeof PROMPT_DEFINITION_SCHEMA_VERSION
  /** Stable namespaced id; never derived from a display name or the text. */
  id: string
  /**
   * Bumped when the placeholders, required fragments or output contract the
   * consumer depends on change. An override written against an older contract
   * is preserved but no longer applied.
   */
  contractVersion: number
  kind: PromptResourceKind
  group: PromptGroup
  operation: PromptOperation
  /** Scopes that may hold an override. Empty for inspect-only entries. */
  scopes: readonly PromptScope[]
  activation: PromptActivation
  risk: PromptRisk
  hosts: readonly PromptHost[]
  /** The shipped body, exactly as the consumer sends it with no override. */
  defaultBody: string
  variables: readonly PromptVariableSpec[]
  /**
   * Text an override must keep verbatim because the consumer parses against
   * it (JSON keys, trailer markers). Empty for ordinary wording.
   */
  requiredFragments: readonly string[]
  /** Human-readable output contract, shown in the editor. */
  outputContract?: string
  maxChars: number
  /** Source files that resolve this definition, for the detail view. */
  consumers: readonly string[]
}

export type PromptDefinitionInput = Omit<
  PromptDefinitionV1,
  "schemaVersion" | "variables" | "requiredFragments" | "maxChars"
> &
  Partial<Pick<PromptDefinitionV1, "variables" | "requiredFragments" | "maxChars">>

export const DEFAULT_PROMPT_MAX_CHARS = 32_000

export function definePrompt(input: PromptDefinitionInput): PromptDefinitionV1 {
  const def: PromptDefinitionV1 = {
    schemaVersion: PROMPT_DEFINITION_SCHEMA_VERSION,
    variables: [],
    requiredFragments: [],
    maxChars: DEFAULT_PROMPT_MAX_CHARS,
    ...input,
  }
  if (def.operation === "inspect-only" && def.scopes.length > 0) {
    throw new Error(`prompt ${def.id}: an inspect-only entry cannot declare override scopes`)
  }
  if (def.operation !== "inspect-only" && def.scopes.length === 0) {
    throw new Error(`prompt ${def.id}: an editable entry needs at least one scope`)
  }
  return def
}

export interface PromptTargetRef {
  scope: PromptScope
  targetId: string
}

export interface PromptResolutionContext {
  workspaceId?: string
  agentId?: string
  sessionId?: string
}

export type PromptFallbackReason =
  "contract-incompatible" | "pii-blocked" | "invalid-body" | "snapshot-unavailable"

export type PromptSource =
  | { kind: "default"; fallback?: PromptFallbackReason; skippedRevisionId?: string }
  | { kind: "override"; scope: PromptScope; bindingId: string; revisionId: string }
