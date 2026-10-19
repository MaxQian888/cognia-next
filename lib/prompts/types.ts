/**
 * Management contracts for model-facing prompts (ADR-0236).
 *
 * A `PromptDefinitionV1` describes one code-owned prompt slot: who consumes
 * it, which operation an edit performs, which scopes may override it, which
 * placeholders its body may use, and how a change reaches the running
 * consumer. It grants no execution authority: tools, permissions and budgets
 * stay with the owning host code, and nothing in an override body can change
 * them.
 *
 * Domain-owned prompts (characters, presets, Skills, project instruction
 * files) are not described here. They keep their own records and are surfaced
 * through owner adapters (`lib/prompts/adapters/`), so a resource has exactly
 * one active text authority.
 */

export const PROMPT_DEFINITION_SCHEMA_VERSION = 1 as const

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

/**
 * The composition an edit performs. The editor never infers this from a field
 * name: each entry declares it, and the UI states its consequence.
 */
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

/** Where an override may apply, most specific last. */
export type PromptScope = "account" | "workspace" | "agent" | "session"

export const PROMPT_SCOPE_SPECIFICITY: readonly PromptScope[] = [
  "account",
  "workspace",
  "agent",
  "session",
]

/** How a published change reaches its consumer. */
export type PromptActivation =
  /** The consumer resolves at each operation; the next one uses the new text. */
  | "next-operation"
  /** An external agent session caches its instructions; a new session adopts it. */
  | "new-session-required"
  /** The owning loader must reload before the change applies. */
  | "reload-required"
  /** This host cannot apply the entry (e.g. a CLI-only base viewed in the app). */
  | "unsupported"

/** Failure cost of an edit, which sets the validation bar. */
export type PromptRisk =
  /** A wording change; a bad edit degrades output quality only. */
  | "ordinary"
  /** The consumer parses the output or relies on a protocol the text teaches. */
  | "protocol"
  /** The output takes part in an approval decision. */
  | "approval-sensitive"

/** Which shell runs the consumer. */
export type PromptHost = "app" | "cli" | "bootstrap"

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

/** A definition as authored: the schema constant and defaults are filled in. */
export type PromptDefinitionInput = Omit<
  PromptDefinitionV1,
  "schemaVersion" | "variables" | "requiredFragments" | "maxChars"
> &
  Partial<Pick<PromptDefinitionV1, "variables" | "requiredFragments" | "maxChars">>

/** Default body ceiling: generous for prose, bounded so an import cannot bloat a call. */
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

/** Where an override sits. `targetId` is empty for the account scope. */
export interface PromptTargetRef {
  scope: PromptScope
  targetId: string
}

/** The context a consumer resolves in; each id is used only if the entry allows that scope. */
export interface PromptResolutionContext {
  workspaceId?: string
  agentId?: string
  sessionId?: string
}

/** Why a resolution used the shipped body although an override exists. */
export type PromptFallbackReason =
  "contract-incompatible" | "pii-blocked" | "invalid-body" | "snapshot-unavailable"

export type PromptSource =
  | { kind: "default"; fallback?: PromptFallbackReason; skippedRevisionId?: string }
  | { kind: "override"; scope: PromptScope; bindingId: string; revisionId: string }
