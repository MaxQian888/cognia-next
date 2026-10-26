// The harness sections of an agent profile (ADR-0237).
//
// An agent's behaviour is shaped by more than its persona prompt. Harness
// Evolution treats eight components as the agent's editable harness: the
// persona prompt (`Character.systemPrompt`), the sections below, the skills in
// `Character.skillIds` and the script resources those skills carry.
//
// These sections live on the profile, not in a side table, so a variant
// inherits them from its base or owns them like any other profile field, and an
// evolved variant's `ownFields` says exactly what an adoption changed.
//
// Nothing here can widen what a run may do. Subagent tool lists are clamped to
// the parent's tools when the resolver registers them, and tool rules can only
// add text, shorten output or deny a call.

/** One delegated subagent the agent may call (component C5). */
export interface HarnessSubagentDefinition {
  /** Directory-style id: lowercase letters, digits, `_` and `-`. */
  name: string
  /** When to delegate to it. Shown to the parent as the subagent's description. */
  description: string
  /** The subagent's own instructions. It never sees the parent conversation. */
  prompt: string
  /**
   * Tools it may use. Intersected with the parent's resolved allow list, so a
   * subagent can never hold a tool its parent lacks. Absent = the parent's set.
   */
  tools?: string[]
}

/** Versioned schema of the declarative tool rules (component C8). */
export const HARNESS_TOOL_RULES_VERSION = 1

/**
 * Tool-loop middleware, declared instead of coded. A rule targets a tool by exact
 * name, a `prefix*` pattern, or `*`.
 *
 * - `error-hint`: when the tool's result is an error whose text contains one of
 *   `patterns` (case-insensitive substrings, never regular expressions), append
 *   `hint` to what the model sees.
 * - `trim-output`: cap the result the model sees at `maxChars`, keeping the head
 *   and tail and naming the cut.
 * - `call-cap`: deny the tool's calls past `maxCalls` in one turn, with `reason`
 *   as the teaching message.
 * - `verify-after-write`: after a successful call, append `reminder` (re-open
 *   and check what was written).
 */
export type HarnessToolRule =
  | {
      id: string
      kind: "error-hint"
      tool: string
      patterns: string[]
      hint: string
    }
  | {
      id: string
      kind: "trim-output"
      tool: string
      maxChars: number
    }
  | {
      id: string
      kind: "call-cap"
      tool: string
      maxCalls: number
      reason: string
    }
  | {
      id: string
      kind: "verify-after-write"
      tool: string
      reminder: string
    }

export type HarnessToolRuleKind = HarnessToolRule["kind"]

export const HARNESS_TOOL_RULE_KINDS: readonly HarnessToolRuleKind[] = [
  "error-hint",
  "trim-output",
  "call-cap",
  "verify-after-write",
]

/** The harness sections stored on an agent profile. Every field is optional. */
export interface CharacterHarness {
  /** Standing rules that apply to every run (component C2). Always in context. */
  guardrails?: string
  /**
   * Durable facts about the agent's domain (component C3). Always in context.
   * This is profile text, not the Memory subsystem: nothing here is recalled,
   * scored or learned from conversations.
   */
  memory?: string
  /** How and when to use the available tools (component C4). Always in context. */
  toolGuidance?: string
  /** Delegated subagents registered for the agent's own runs (component C5). */
  subagents?: HarnessSubagentDefinition[]
  /** Declarative tool-loop middleware (component C8). */
  toolRules?: HarnessToolRule[]
  /** The Harness Evolution snapshot these sections were last adopted from. */
  adoptedSnapshotId?: string
}

/** True when the harness carries anything that affects a run. */
export function hasHarnessContent(harness: CharacterHarness | undefined | null): boolean {
  if (!harness) return false
  return Boolean(
    harness.guardrails?.trim() ||
    harness.memory?.trim() ||
    harness.toolGuidance?.trim() ||
    (harness.subagents?.length ?? 0) > 0 ||
    (harness.toolRules?.length ?? 0) > 0
  )
}

/** How Harness Evolution may start runs. `disabled` keeps the feature switched on but idle. */
export type HarnessEvolutionStartMode = "disabled" | "manual" | "failure-triggered" | "background"

export const HARNESS_EVOLUTION_START_MODES: readonly HarnessEvolutionStartMode[] = [
  "disabled",
  "manual",
  "failure-triggered",
  "background",
]

/** A model choice for one evolution role. Absent fields fall back to the agent's own model. */
export interface HarnessEvolutionRoleModelSetting {
  providerId?: string
  model?: string
}

/**
 * Persisted Harness Evolution preferences (`AppSettings.harnessEvolution`).
 * Absent means the feature is off. Normalisation, defaults and clamping live in
 * `lib/harness/settings.ts`; nothing here is trusted unclamped.
 */
export interface StoredHarnessEvolutionSettings {
  /** Feature flag. Off unless the user turns it on. */
  enabled?: boolean
  /**
   * The most a run may start by itself. `manual`: only from the user;
   * `failure-triggered`: also offered after a failed turn; `background`: also on
   * a schedule over recent failures. Each mode includes the ones before it.
   */
  startMode?: HarnessEvolutionStartMode
  /** Default recursion style for new runs. */
  defaultMode?: "parallel" | "sequential"
  /** Default k. */
  defaultK?: number
  /** Default budget ceilings for new runs. */
  budget?: {
    maxIterations?: number
    maxCandidates?: number
    maxParallelRuns?: number
    maxModelCalls?: number
    maxTokens?: number
    maxCostUsd?: number
    maxWallTimeMs?: number
    maxTurnsPerRollout?: number
  }
  /** Adopt low-risk task/session improvements without asking. Default false. */
  autoAdoptLowRisk?: boolean
  /** Hand relevant library experiences to editors. Default true. */
  useExperiences?: boolean
  editorChannel?: "auto" | "agentic" | "structured"
  /** Per-role model overrides. */
  models?: Partial<
    Record<
      "executor" | "editor" | "composer" | "selector" | "reflector",
      HarnessEvolutionRoleModelSetting
    >
  >
  /** MCP servers the user declared read-only and safe to call during probes. */
  probeAllowedMcpServerIds?: string[]
  /** Background mode: hours between scheduled sweeps. */
  backgroundIntervalHours?: number
  /** Background mode: the most runs one sweep may start. */
  backgroundMaxRunsPerSweep?: number
  /** Failure-triggered mode: hours before the same agent is offered again. */
  failureOfferCooldownHours?: number
  /** Experiences kept per agent before the least useful are archived. */
  experienceCapPerAgent?: number
}
