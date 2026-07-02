/**
 * Auto-orchestration engine types (ADR-0022 follow-up).
 *
 * The engine turns a single objective into a runnable team by generating the
 * three pieces a team needs but that today are hand-authored: a routing
 * assessment, a specialist roster, and a task DAG. The output is a serializable
 * `AutoOrchestrationProposal` with **index-based** references (a task's
 * `assignedTo` / `dependencies` point at array positions, not store ids) so the
 * proposal exists before any store row is created and can be previewed,
 * edited, and approved before materialization.
 *
 * Every stage is pure and platform-agnostic: it takes an injected `LlmClient`
 * plus a `CapabilityCatalog`, and fails OPEN to a deterministic heuristic so a
 * flaky model never wedges the pipeline.
 */

import type {
  TeamMemberRole,
  TeamRoutingAssessment,
  TeammateCapabilityOverlay,
} from "@/types/agent/agent-team"

/**
 * The capabilities currently resolvable by the runtime, flattened to arrays so
 * they can be embedded in an LLM prompt and validated against. Built from
 * `buildKnownCapabilityIds()` (the same source the capability audit uses), so
 * the composer can only ever assign capabilities that actually resolve.
 */
export interface CapabilityCatalog {
  skillIds: string[]
  mcpServerIds: string[]
  nativeAnthropicToolIds: string[]
  characterPackIds: string[]
  externalAgentPresetIds: string[]
  subagentIds: string[]
}

/** A proposed teammate, before it is materialized into the store. */
export interface ProposedTeammate {
  name: string
  role: TeamMemberRole
  /** One-line role/purpose blurb shown in the preview. */
  description: string
  /** Free-form specialization tag (e.g. "security", "testing"). */
  specialization?: string
  /** Capability overlay (validated against the catalog — never hallucinated). */
  capabilities?: TeammateCapabilityOverlay
}

/** A proposed task, before it is materialized. References are array indices. */
export interface ProposedTask {
  title: string
  description: string
  /** Indices into `tasks[]` that must finish first (always < this task's index). */
  dependencies: number[]
  /** Index into `roster[]` this task is assigned to. */
  assignedTo: number
  expectedOutput?: string
}

/** The full proposal returned by `planAutoOrchestration`. */
export interface AutoOrchestrationProposal {
  /** The PII-redacted objective the proposal was generated from. */
  objective: string
  assessment: TeamRoutingAssessment
  roster: ProposedTeammate[]
  tasks: ProposedTask[]
  /**
   * The chosen executor (single-send / council / ensemble / team-* / handoff),
   * derived from the assessment + operator consensus signal. Optional so
   * materialize-only callers and older proposals are unaffected; consumers
   * recompute via `chooseExecutor` when absent. See `dispatch-executor.ts`.
   */
  executor?: import("./dispatch-executor").DispatchDecision
}
