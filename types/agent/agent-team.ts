/**
 * AgentTeam Type Definitions
 * Defines types for coordinating multiple agent instances working together as a team.
 *
 * Inspired by Claude Code's Agent Teams design:
 * - One lead agent coordinates work, assigns tasks, synthesizes results
 * - Teammates work independently, each in its own context window
 * - Shared task list with dependency management
 * - Inter-agent messaging (direct + broadcast)
 * - Plan approval workflow
 *
 * Reuses existing SubAgent/Orchestrator infrastructure where possible.
 */

import type { ProviderName } from "@cognia/provider-types/provider"
import type { SubAgentTokenUsage, SubAgentPriority } from "./sub-agent"
import type { TwinSettings } from "@/types/twin"
import type { ExternalAgentPresetId, NonExecutablePresetId } from "@/lib/ai/agent/external/presets"
import type { ProjectEditorSession } from "@/types/editor/project-editor"
import type {
  AgentTeamEnvironmentRef,
  AgentTeamEvidencePolicy,
  AgentTeamGithubDeliveryPolicy,
  AgentTeamRepositoryBinding,
  AgentTeamResourcePolicy,
  AgentTeamRetrospectivePolicy,
  AgentTeamWriteMode,
} from "./agent-team-runtime"

// ============================================================================
// Team Core Types
// ============================================================================

/**
 * Team member role
 */
export type TeamMemberRole = "lead" | "teammate"

/** Built-in portrait identifiers for Agent Team members and bot identities. */
export type AgentTeamAvatarId =
  | "coordinator"
  | "researcher"
  | "coder"
  | "designer"
  | "planner"
  | "data-analyst"
  | "writer"
  | "browser-scout"
  | "workflow-engineer"
  | "memory-archivist"
  | "security-guardian"
  | "reviewer"
  | "operator"
  | "translator"
  | "creative-agent"
  | "general-assistant"

/**
 * Team status
 */
export type TeamStatus =
  "idle" | "planning" | "executing" | "paused" | "completed" | "failed" | "cancelled"

/**
 * Teammate status
 */
export type TeammateStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "shutdown"

/**
 * Display mode for the team UI
 */
export type TeamDisplayMode = "compact" | "expanded" | "split"

/**
 * Team execution mode
 */
export type TeamExecutionMode =
  | "coordinated" // Lead coordinates all work
  | "autonomous" // Teammates self-claim tasks
  | "delegate" // Lead only delegates, never implements

/**
 * Higher-level execution patterns a team run can be routed to, in the order
 * every picker offers them.
 *
 * The list existed four more times before this: the router's own
 * `EXECUTION_PATTERNS`, the workflow params schema, the workflow inspector's
 * hand-written `<SelectItem>`s, and the auto-compose dialog. Deriving the union
 * from the array is what makes a fifth copy impossible.
 *
 * `ultracode_orchestration` is ADR-0022's addendum: the lead plans a
 * composition of quality patterns (sweep, loop-until-dry, adversarial or
 * perspective-diverse verify, judge panel, completeness critic, synthesize)
 * that fan out tool-enabled teammates. Recommended automatically for complex
 * tasks when `AgentTeamConfig.ultracode.enabled` is on.
 */
export const TEAM_EXECUTION_PATTERNS = [
  "manager_worker",
  "parallel_specialists",
  "background_handoff",
  "external_handoff",
  "single_agent_recommended",
  "ultracode_orchestration",
] as const

/** Higher-level execution pattern selected for a team run. */
export type TeamExecutionPattern = (typeof TEAM_EXECUTION_PATTERNS)[number]

/**
 * Tabs of the dedicated Agent Team page, a page ADR-0140 dissolved.
 *
 * DORMANT ON PURPOSE, and this comment is the type-level half of that label.
 * There is no live reader: the nav it named,
 * `components/agent/workspace/workspace-tab-nav.tsx`, is gone, and the live
 * Squads addressing is `SQUAD_TAB_PARAM` in
 * `components/settings/squads/nav-config.ts` plus the `?tab=` union in
 * `components/squads/squad-fleet-console.tsx`.
 *
 * The union survives because the VALUE does: `workspaceTab` is inside
 * `partializeAgentTeamState` (`stores/agent/agent-team-store/store.ts`) and
 * inside the `cognia-agent-teams` backup snapshot, so a stored preference from
 * before the dissolution still round-trips through both. Deleting the type
 * would force a persist-version decision on the busiest store in the repo to
 * remove a field nothing reads. Its behaviour is pinned by
 * `stores/agent/agent-team-store/selectors.test.ts`.
 */
export type AgentTeamWorkspaceTab =
  | "overview"
  | "tasks"
  | "chat"
  | "activity"
  | "operations"
  | "worktrees"
  | "editor"
  | "members"
  | "settings"

/**
 * Persisted per-team state of the project Editor tab. Restores the open file
 * set, active file, selected project root (main repo vs a worktree), and the
 * three-pane layout when the tab is reopened. Unsaved draft content is NOT
 * persisted — the on-disk file is the source of truth.
 */
export type AgentTeamEditorSession = ProjectEditorSession

/**
 * Current operator focus inside the Agent Team workspace
 */
export interface AgentTeamWorkspaceFocus {
  teammateId: string | null
  taskId: string | null
  messageId: string | null
}

/**
 * Routing assessment produced before a run starts
 */
export interface TeamRoutingAssessment {
  recommendedPattern: TeamExecutionPattern
  confidence: number
  reason: string
  factors: {
    taskComplexity: "simple" | "moderate" | "complex"
    specializationNeeded: boolean
    contextIsolationNeeded: boolean
    delegationCandidate: boolean
    budgetPressure: "low" | "medium" | "high"
  }
  createdAt: Date
  overridePattern?: TeamExecutionPattern
  acceptedPattern?: TeamExecutionPattern
}

/**
 * The concrete executor an auto-orchestration proposal should run through.
 * Inferred ABOVE {@link TeamExecutionPattern} — council/ensemble are not team
 * shapes (no roster/DAG/store team) and the pattern union is woven through
 * exhaustive switches, so it must never be widened to carry these. The
 * mapping logic lives in `lib/ai/agent/team/auto/dispatch-executor.ts`; the
 * types live here so `AgentTeam` can persist the decision without `types/`
 * importing from `lib/`.
 */
export type TeamExecutorKind =
  | "single-send"
  | "council"
  | "ensemble"
  | "team-flat"
  | "team-ultracode"
  | "background-handoff"
  | "external-handoff"

/**
 * Where a team run was triggered from. Anything not "interactive" is
 * headless — no operator is watching a modal, so the HITL gates resolve
 * through `lib/ai/agent/team/gate-policy.ts` instead of blocking.
 */
export type TeamRunOrigin =
  "interactive" | "scheduler" | "remote" | "external" | "plugin" | "im" | "delegation"

/** Executor decision stamped on a team at materialization (provenance). */
export interface TeamDispatchDecision {
  kind: TeamExecutorKind
  /** The team pattern this decision was derived from (provenance). */
  fromPattern: TeamExecutionPattern
  /** Echoes the assessment confidence for the preview badge. */
  confidence: number
  /** Human-readable rationale for the chosen executor. */
  reason: string
}

/**
 * Structured claimant identity for an external-handoff pickup (ADR 0061
 * P4). Replaces the bare `claimedBy` string so the claim records WHO
 * resolved it — an external agent over the bridge, a paired device, or the
 * desktop itself — instead of a hardcoded constant.
 */
export interface TeamPickupClaimant {
  kind: "external-agent" | "device" | "desktop"
  id: string
  label?: string
}

/**
 * External-handoff pickup state. Set when a proposal materializes with the
 * `external-handoff` executor; cleared semantics are additive — an external
 * agent claims the team through the bridge's `team_run`, which stamps
 * `claimant`/`claimedAt` (idempotently — a second run never overwrites a
 * LIVE claim; an expired claim lease re-advertises the pickup).
 */
export interface TeamExternalPickup {
  requestedAt: Date
  /**
   * Pickup addressed to one specific executor (paired-device id or a
   * bridge client name). Absent = any claimant may take it.
   */
  targetId?: string
  /** Legacy string mirror of `claimant.id` — kept for persisted-store and
   *  bridge-consumer compatibility. Prefer `claimant`. */
  claimedBy?: string
  /** Structured claim identity (ADR 0061 P4). */
  claimant?: TeamPickupClaimant
  claimedAt?: Date
  /**
   * Claim lease. A claim whose lease expired while the team never left its
   * pre-run status frees the pickup — the claimant died between claim and
   * dispatch. Absent on legacy claims (treated as non-expiring).
   */
  claimLeaseExpiresAt?: Date
}

/**
 * Budget escalation behavior when usage crosses thresholds
 */
export type TeamBudgetEscalationAction =
  "notify" | "pause_for_review" | "reduce_concurrency" | "handoff_to_background"

/**
 * Governance policy for approvals and budget escalation
 */
export interface TeamGovernancePolicy {
  approval: {
    requirePlanApproval: boolean
    requireDelegationApproval: boolean
    /**
     * When true, a teammate's successful auto-run routes the board task to
     * `review` instead of `completed`; a human then makes the existing
     * `review → completed | failed` move (`task-move-guard.ts`). Governs
     * FINAL BOARD ACCEPTANCE only — the wave runner's dependency progression
     * uses its in-memory doneIds, so downstream tasks still consume the
     * output while the card sits in review. Optional/off by default.
     */
    requireResultReview?: boolean
  }
  budget: {
    tokenBudget: number
    warningThreshold: number
    criticalThreshold: number
    onCritical: TeamBudgetEscalationAction
  }
  escalation: {
    allowOperatorPatternOverride: boolean
    pauseOnHighRisk: boolean
  }
  /**
   * Optional delivery policy. When `quietHours` is set, delegations launched
   * during the window are deferred to `awaiting_approval` unless the operator
   * forces them through. Reuses the connector quiet-hours predicate
   * (`lib/connectors/outbound-runner.ts:isInQuietHours`).
   */
  delivery?: {
    quietHours?: {
      /** Local start time, "HH:MM". */
      from: string
      /** Local end time, "HH:MM". */
      to: string
      /** IANA timezone, e.g. "Asia/Shanghai". */
      tz: string
    }
  }
}

// ============================================================================
// Plugin Capability Composition (ADR-pending — Agent Team plugin integration)
// ============================================================================

/**
 * Default pool of plugin-contributed capabilities a team enables for all of
 * its teammates. Each list is a flat array of overlay-registry ids; the
 * runtime `capability-resolver` unions these with the per-teammate overlay
 * to produce the final `ResolvedCapabilities` passed into the Claude SDK.
 *
 * All ids reference live overlay registries:
 *   - `mcpServerIds` → `lib/db/mcp-servers.ts` rows (host) + plugin presets
 *     promoted to mcp-servers; consumed by `SendOptions.mcpServers`.
 *   - `skillIds` → host skills + `skill-registry` overlay (scope=team|global).
 *   - `nativeAnthropicToolIds` → `native-anthropic-tool-registry`
 *     (e.g. `computer_20251124` / `bash_20250124` / `text_editor_20250728`).
 *   - `characterPackIds` → `character-pack-registry`. The team uses
 *     `getPackCharacterByRuntimeId` to project a pack character into a
 *     teammate's persona at run time.
 *   - `externalAgentPresetIds` → `lib/ai/agent/external/presets.ts`.
 *   - `subagentIds` → built-in name or `<pluginId>:<subagentId>`
 *     resolved through `resolveAllSubagents`.
 *   - `a2uiTemplateIds` → A2UI template registry (existing) consumed by
 *     the IM ⇄ A2UI bridge.
 */
export interface TeamCapabilityBundle {
  mcpServerIds?: string[]
  skillIds?: string[]
  nativeAnthropicToolIds?: string[]
  characterPackIds?: string[]
  externalAgentPresetIds?: string[]
  subagentIds?: string[]
  a2uiTemplateIds?: string[]
}

/**
 * Per-key 3-state overlay: `replace` short-circuits (final = replace);
 * otherwise final = (team default ∖ remove) ∪ add. Empty / undefined
 * fields fall through to the team default unchanged.
 */
export interface CapabilityListOverlay {
  /** Add these ids to the team default. */
  add?: string[]
  /** Subtract these ids from the team default. */
  remove?: string[]
  /** Replace the team default entirely with this list (wins over add/remove). */
  replace?: string[]
}

/**
 * Per-teammate overlay over `AgentTeamConfig.capabilities`. Each field is
 * independently overlaid via `CapabilityListOverlay` semantics — leave a
 * field undefined to inherit the team default unchanged.
 */
export interface TeammateCapabilityOverlay {
  mcpServerIds?: CapabilityListOverlay
  skillIds?: CapabilityListOverlay
  nativeAnthropicToolIds?: CapabilityListOverlay
  characterPackIds?: CapabilityListOverlay
  externalAgentPresetIds?: CapabilityListOverlay
  subagentIds?: CapabilityListOverlay
  a2uiTemplateIds?: CapabilityListOverlay
}

/**
 * Flattened capability set resolved from `team.config.capabilities`
 * combined with `teammate.config.capabilities`. This is the shape
 * `lib/claude/build-options.ts` consumes when assembling `SendOptions`
 * for a teammate dispatch.
 */
export interface ResolvedCapabilities {
  mcpServerIds: string[]
  skillIds: string[]
  nativeAnthropicToolIds: string[]
  characterPackIds: string[]
  externalAgentPresetIds: string[]
  subagentIds: string[]
  a2uiTemplateIds: string[]
}

/** Empty resolved bundle used by tests and the capability-resolver fast path. */
export const EMPTY_RESOLVED_CAPABILITIES: ResolvedCapabilities = {
  mcpServerIds: [],
  skillIds: [],
  nativeAnthropicToolIds: [],
  characterPackIds: [],
  externalAgentPresetIds: [],
  subagentIds: [],
  a2uiTemplateIds: [],
}

// ============================================================================
// Team Configuration
// ============================================================================

/**
 * Team configuration
 */
export interface AgentTeamConfig {
  /**
   * Squad definition contract revision (ADR-0168). Every Squad executes on the
   * one durable coordinator; there is no runtime selector. A definition below
   * `SQUAD_DEFINITION_CONTRACT_VERSION` is upgraded in place by
   * `lib/agent-team/definition-contract.ts` the first time it is read, and an
   * inbound row that still carries the retired `runtimeVersion` key has it
   * dropped at the boundary.
   */
  contractVersion?: number
  /** Writable child coordination policy. Defaults to single-writer. */
  writeMode?: AgentTeamWriteMode
  /**
   * Exactly one primary repository; dependency repositories are optional.
   * A Squad without one is not runnable — `SquadReadiness` reports
   * `missing_primary_repository` and dispatch is refused.
   */
  repositories?: AgentTeamRepositoryBinding[]
  /**
   * Immutable environment profile version captured when a run starts. A Squad
   * without one is not runnable — `SquadReadiness` reports
   * `missing_environment_ref`.
   */
  environmentRef?: AgentTeamEnvironmentRef
  resourcePolicy?: AgentTeamResourcePolicy
  evidencePolicy?: AgentTeamEvidencePolicy
  retrospectivePolicy?: AgentTeamRetrospectivePolicy
  githubDeliveryPolicy?: AgentTeamGithubDeliveryPolicy
  /** Immutable operator constraints copied into the durable decision ledger at run start. */
  userConstraints?: Array<{ title: string; detail: string }>
  /** Maximum number of teammates */
  maxTeammates: number
  /** Maximum concurrent active teammates */
  maxConcurrentTeammates: number
  /** Default execution mode */
  executionMode: TeamExecutionMode
  /** Preferred higher-level execution pattern derived from legacy execution mode or user override */
  preferredExecutionPattern?: TeamExecutionPattern
  /** Display mode for UI */
  displayMode: TeamDisplayMode
  /** Default provider for teammates */
  defaultProvider?: ProviderName
  /** Default model for teammates */
  defaultModel?: string
  /** Default API key */
  defaultApiKey?: string
  /** Default base URL */
  defaultBaseURL?: string
  /** Default system prompt for all teammates */
  defaultSystemPrompt?: string
  /** Default temperature */
  defaultTemperature?: number
  /** Default max steps per teammate */
  defaultMaxSteps?: number
  /** Default timeout per teammate (ms) */
  defaultTimeout?: number
  /** Whether teammates require plan approval before executing */
  requirePlanApproval?: boolean
  /**
   * Auto-raise the plan-approval gate when a run is assessed medium/high risk
   * (ADR-0070). Default true. Only ever raises: an operator-set
   * `requirePlanApproval` is never lowered by the assessment. Set false to
   * restore the pre-ADR-0070 behavior where only `requirePlanApproval` gates —
   * note that this also lets a *headless* risky run proceed unattended.
   */
  riskGating?: boolean
  /**
   * Blocking lead review of every task's work before dependents may start
   * (ADR-0071). When `enabled`, the synthesizer emits an
   * `action.team.task.review` node after each task's dispatch and repoints that
   * task's dependents at the review node, so an unapproved task blocks
   * downstream work instead of being caught after the fact.
   *
   * The configured lead judges the worker's output plus a deterministic diff of
   * what it actually changed, and returns `approved` / `changes_requested`. A
   * `changes_requested` verdict re-dispatches the SAME worker in the SAME
   * worktree with the lead's feedback, then reviews again — up to
   * `maxRevisions` times (default 2). Exhausting the budget, losing the
   * original worker, or a reviewer/provider failure fails the task and the run:
   * the point of a blocking gate is that unreviewed work never lands.
   *
   * Default OFF — a run with no reviewer configured behaves exactly as before.
   * Distinct from `governancePolicy.approval.requireResultReview`, which is a
   * HUMAN board gate; the two compose (automated approval then hands the card
   * to a human instead of completing it).
   */
  taskReview?: {
    enabled?: boolean
    /** Worker revision attempts after a `changes_requested`. Default 2. */
    maxRevisions?: number
  }
  /** Auto-shutdown teammates when all tasks complete */
  autoShutdown?: boolean
  /** Token budget for the entire team */
  tokenBudget?: number
  /** Enable inter-agent messaging */
  enableMessaging?: boolean
  /** Enable shared task list */
  enableSharedTaskList?: boolean
  /** Maximum retries for failed tasks (0 = no retry) */
  maxRetries?: number
  /** Maximum plan revision rounds before auto-approve (1-5) */
  maxPlanRevisions?: number
  /** Enable automatic task retry on failure */
  enableTaskRetry?: boolean
  /** Enable deadlock recovery (cancel/reorder blocked tasks) */
  enableDeadlockRecovery?: boolean
  /** Governance policy for approvals, budgets, and escalation */
  governancePolicy?: TeamGovernancePolicy
  /**
   * Team-level tool ALLOW ceiling. When set, it is the parent ceiling every
   * teammate dispatch is clamped against (allow-list intersect) — a teammate
   * can only further-restrict, never widen beyond it. Undefined = no ceiling.
   */
  allowedTools?: string[]
  /**
   * Team-level tool DENY list. Always cascades (unioned into every teammate's
   * disallowed tools). Undefined = none.
   */
  disallowedTools?: string[]
  /**
   * Team-level permission-mode ceiling clamped onto every teammate dispatch
   * (the effective mode is the lesser-permissive of team and teammate).
   * Undefined = no mode ceiling.
   */
  defaultPermissionMode?: import("./external-agent").AcpPermissionMode
  /**
   * Team-level OS-sandbox default (ADR-0028). When true, every teammate dispatch
   * runs its Bash/Edit/Write through the per-platform OS sandbox unless the
   * teammate opts out. A teammate may enable it individually even when this is
   * unset. See `teammateToCharacter`.
   */
  sandboxEnabled?: boolean
  /**
   * Team-level OS-sandbox resource/network **ceiling** (ADR-0028). Cascades
   * monotonically: a teammate's own `TeammateConfig.sandboxPolicy` may only
   * further-restrict this (writable roots narrow, network tightens, caps lower)
   * via `clampSandboxPolicy`. Only consulted when the sandbox resolves enabled.
   */
  sandboxPolicy?: import("@cognia/agent-config-types").SandboxResourcePolicy
  /** Max result tokens before auto-summarization (context isolation) */
  maxResultTokens?: number
  /** Auto-clean shared memory when team completes */
  autoCleanSharedMemory?: boolean
  /** Maximum shared memory entries per team */
  maxSharedMemoryEntries?: number
  /**
   * Per ADR-0022 §2 Layer 1.5. Minimum non-whitespace characters required in
   * a teammate's output before it is considered a success. Default 0 (only
   * non-empty is enforced — empty/whitespace always retries).
   */
  minOutputChars?: number
  /** Run optional refusal-pattern detection on teammate output. Default false. */
  detectRefusal?: boolean
  /** Patterns considered refusals when detectRefusal is true. */
  refusalPatterns?: string[]
  /**
   * Default pool of plugin capabilities every teammate inherits. Each
   * teammate may further override the pool via
   * `TeammateConfig.capabilities` (see `CapabilityListOverlay`).
   * Undefined or empty fields produce empty resolved arrays.
   */
  capabilities?: TeamCapabilityBundle
  /**
   * Team-level default execution binding (ADR-0090 Phase 7). Precedence:
   * member `execution` → run override → THIS team default → app default.
   * Refs only — never raw credentials or endpoints. No dedicated UI writer
   * yet: set via team templates / programmatic config (the member-level field
   * ships first; the team-default editor lands with the coordinator picker).
   */
  defaultExecution?: TeammateExecutionBinding
  /**
   * Maximum TEAM delegation depth (ADR-0090 Phase 7). Counts orchestrated
   * teammate→teammate delegations only and is DISTINCT from the native
   * subagent `dispatchContext.maxDepth` budget. Default 2: depths 0/1/2 may
   * delegate; a depth-2 child asking to delegate again is refused with a
   * typed `DelegationDepthExceededError`.
   */
  maxTeamDelegationDepth?: number
  /**
   * Optional id of the plugin-contributed shared-memory adapter this team
   * mirrors its KV into (see `shared-memory-adapter-registry`). Undefined =
   * local-only (Zustand). When set, `publishEntry` / `deleteEntry` mirror to
   * the adapter and `syncSharedMemoryFromAdapter` can pull remote changes.
   */
  sharedMemoryAdapterId?: string
  /**
   * Employee Digital Twins (ADR-0003) the WHOLE team may consult on demand via
   * the `twin_knowledge_search` collaboration tool. This is the team-level
   * knowledge pool — distinct from a member's own `TeammateConfig.twinId`
   * (which additionally gives that member the twin's persona + per-task RAG).
   * A member-bound `twinId` is also implicitly queryable. Undefined / empty =
   * the tool is not offered. See `lib/claude/team-builtin-tools.ts`.
   */
  knowledgeTwinIds?: string[]
  /**
   * Ultracode orchestration settings (ADR-0022 addendum). When `enabled`, the
   * team can run the multi-agent quality-pattern composition instead of a flat
   * task DAG. `autoMode` decides whether a complex task triggers it
   * automatically (`"auto"`, the default), always, or never. The numeric knobs
   * cap fan-out for each pattern; undefined values fall back to the planner's
   * per-stage choice clamped to the workflow concurrency ceiling.
   */
  ultracode?: {
    enabled?: boolean
    /** `"auto"` (default): orchestrate only when routing judges the task complex. */
    autoMode?: "auto" | "always" | "never"
    /** Hard cap on loop-until-dry finder rounds. Default 4. */
    maxFinderRounds?: number
    /** Independent skeptics per finding in adversarial verify. Default 3. */
    skepticsPerFinding?: number
    /** Independent judges per attempt in the judge panel. Default 3. */
    judgesPerAttempt?: number
    /** Consecutive empty finder rounds that stop loop-until-dry. Default 2. */
    dryRoundsToStop?: number
  }
  /**
   * Absolute repo path tool-enabled teammates run in (the synthesized Character's
   * `workingDir`, scoping Read/Bash/Edit). Falls back to the originating chat
   * session's `workingDir` when unset. Only meaningful on the desktop sidecar
   * path; ignored by the web/mobile text-only fallback.
   */
  workingDir?: string
  /**
   * Per-dispatch git-worktree isolation. When `enabled`, each teammate dispatch
   * runs in its own `git worktree` + branch (`agent/<runId>/<teammate>/<taskId>`)
   * branched off `workingDir`'s HEAD, so parallel agents never share a working
   * tree / index / branch. Off by default → identical to today's shared-dir
   * behavior. Desktop-only (git ops run in Rust/Tauri); a no-op on web/mobile.
   *
   * `reconcile` decides how the per-dispatch branches are integrated once the
   * run (or a fan-out group) settles:
   *   - `"manual"` (default): leave the branches for the user to review/merge.
   *   - `"merge-all"`: merge each branch into a fresh integration branch off
   *     `baseRef`; a conflict aborts and is reported (never touches the user's
   *     real branch).
   *   - `"select"`: keep one branch per `selectStrategy`, discard the rest per
   *     `retain`.
   *   - `"pipeline"`: sequential dispatches share one worktree/branch.
   * `retain` controls worktree/branch cleanup after reconcile (default
   * `"keep-winner"`). `baseRef` overrides the branch-point (default =
   * `workingDir` HEAD at run start). `backend` is a Phase-2 seam (only `"local"`
   * today; `"container"` / `"e2b"` reserved for the untrusted-code safety wall).
   */
  workspaceIsolation?: {
    enabled?: boolean
    reconcile?: "manual" | "merge-all" | "select" | "pipeline"
    selectStrategy?: "manual" | "first-success" | "judge"
    retain?: "all" | "keep-winner" | "prune-losers"
    baseRef?: string
    backend?: "local"
  }
  /**
   * Stage-checkpoint adaptive re-planning (model-in-the-loop). When `enabled`,
   * the flat task path runs as Kahn-layer "waves"; between waves a lead model
   * reviews completed results and may inject / cancel / reorder remaining tasks
   * or finish early. Disabled (default) runs the legacy single-pass DAG
   * unchanged. `requireApproval` routes each replan decision through the team
   * approval gate before it is applied; `maxInjectedTasksPerCheckpoint` caps how
   * many new tasks a single checkpoint may add. Fail-open: any lead failure
   * continues as planned.
   */
  adaptiveReplan?: {
    enabled?: boolean
    requireApproval?: boolean
    maxInjectedTasksPerCheckpoint?: number
  }
  /**
   * Autonomous progress ledger (Magentic-One style). Layered on the adaptive
   * wave runner: after each wave a deterministic check detects whether the team
   * is stalling (no new completed tasks / no net new output). After
   * `stallThreshold` consecutive stalled waves an LLM judge diagnoses the run and
   * may escalate beyond a plain re-plan — autonomously opening a consensus round
   * or delegating — when the matching `allow*` flag is set. Default OFF; the
   * legacy lead-only re-plan checkpoint is used when disabled.
   */
  progressLedger?: {
    enabled?: boolean
    /** Consecutive stalled waves before the LLM judge runs. Default 2. */
    stallThreshold?: number
    /** Allow the ledger to autonomously open a consensus round on stall. */
    allowAutonomousConsensus?: boolean
    /** Allow the ledger to autonomously delegate work on stall. */
    allowAutonomousDelegation?: boolean
  }
  /**
   * Stream live teammate progress (tool calls + accumulated output) into the
   * workspace activity panel during a run. Default ON; set false to keep the
   * panel quiet (only start/done/failed markers are emitted). Cheap — forwards
   * already-parsed sidecar events, throttled to tool boundaries.
   */
  streamProgress?: boolean
  /**
   * Guarded nudges (ADR — compaction/nudge). When a teammate turn fails on a
   * provider rate limit, the runtime parses the cooldown and schedules a single
   * "continue" nudge once it elapses (instead of aborting the wave). Guards:
   * max nudges per member per hour, exponential backoff, agenda-fingerprint
   * de-dup, and a busy-signal skip (recent tool activity). Default ON.
   */
  nudges?: {
    enabled?: boolean
    /** Max nudges delivered to one member within a rolling hour. Default 2. */
    maxPerMemberPerHour?: number
    /** Skip a nudge when the member had tool activity within this window (ms). Default 60000. */
    busySignalWindowMs?: number
  }
  /**
   * GitHub PR feedback loop (ADR — team PR feedback; ported from
   * agent-orchestrator). When `enabled` and the run has worktree isolation on a
   * git repo with resolvable GitHub credentials, each teammate's PR is observed
   * (CI / review / merge-conflict) and actionable feedback is routed back to the
   * team as a guarded `review_pickup` nudge; a derived PR status shows in the
   * workspace. Default OFF; inert (silent) when the gate isn't met.
   *
   * The loop is run-scoped: it observes during the run and for `observeWindowMs`
   * after the task DAG completes, then is disposed. A teammate only gets a PR if
   * it opens one itself (via its git/gh tools) or `publishPr` is on.
   */
  prFeedback?: {
    enabled?: boolean
    /** Auto-push each teammate's branch and open a PR (else observe self-opened PRs). */
    publishPr?: boolean
    /** PR observation poll interval (ms). Default 30000. */
    pollIntervalMs?: number
    /** How long to keep observing after the task DAG completes (ms). Default 0 (one pass). */
    observeWindowMs?: number
    /** Run the internal reviewer agent against each PR and route its verdict. */
    reviewer?: { enabled?: boolean }
  }
}

/**
 * Default team configuration
 */
export const DEFAULT_TEAM_CONFIG: AgentTeamConfig = {
  writeMode: "single-writer",
  maxTeammates: 10,
  maxConcurrentTeammates: 5,
  executionMode: "coordinated",
  preferredExecutionPattern: "manager_worker",
  displayMode: "expanded",
  defaultTemperature: 0.7,
  defaultMaxSteps: 15,
  defaultTimeout: 600000, // 10 minutes
  requirePlanApproval: false,
  riskGating: true,
  autoShutdown: true,
  enableMessaging: true,
  enableSharedTaskList: true,
  maxRetries: 1,
  maxPlanRevisions: 3,
  enableTaskRetry: true,
  enableDeadlockRecovery: true,
  governancePolicy: {
    approval: {
      requirePlanApproval: false,
      requireDelegationApproval: false,
      requireResultReview: false,
    },
    budget: {
      tokenBudget: 0,
      warningThreshold: 0.8,
      criticalThreshold: 0.95,
      onCritical: "notify",
    },
    escalation: {
      allowOperatorPatternOverride: true,
      pauseOnHighRisk: false,
    },
  },
  adaptiveReplan: {
    enabled: false,
    requireApproval: false,
    maxInjectedTasksPerCheckpoint: 5,
  },
  progressLedger: {
    enabled: false,
    stallThreshold: 2,
    allowAutonomousConsensus: false,
    allowAutonomousDelegation: false,
  },
  streamProgress: true,
  nudges: {
    enabled: true,
    maxPerMemberPerHour: 2,
    busySignalWindowMs: 60_000,
  },
}

// ============================================================================
// Team Member (Teammate)
// ============================================================================

/**
 * Runtime that executes a teammate's tasks. `claude` goes through the Tauri
 * Anthropic sidecar; every other value is an external-agent preset id and
 * dispatches to that external ACP/CLI agent (see
 * `lib/ai/agent/external/presets.ts`; `resolveTeammatePresetId` treats the
 * runtime string as the preset id directly). Covers the full executable preset
 * catalog — `custom`, service-discovered preview integrations, and the managed
 * DeepSeek Harness profiles are excluded because they have no fixed executable
 * backend.
 *
 * Derived from `NonExecutablePresetId` rather than repeating its members: the
 * hand-copied exclusion list silently absorbed the three DeepSeek Harness ids
 * when ADR-0120 added them, which made every `Record<TeammateRuntime, …>` in
 * the workspace non-exhaustive for runtimes the picker cannot even offer.
 */
export type TeammateRuntime = "claude" | Exclude<ExternalAgentPresetId, NonExecutablePresetId>

/** Default runtime when a teammate has no explicit runtime configured. */
export const DEFAULT_TEAMMATE_RUNTIME: TeammateRuntime = "claude"

/**
 * Reserved virtual teammate IDs for `@claude` / `@codex` mentions that work
 * even when no real teammate with that name is in the team.
 */
export const VIRTUAL_AGENT_IDS = {
  CLAUDE: "__virtual_claude__",
  CODEX: "__virtual_codex__",
} as const

export type VirtualAgentId = (typeof VIRTUAL_AGENT_IDS)[keyof typeof VIRTUAL_AGENT_IDS]

/** Reserved mention names — case-insensitive, must not collide with teammate names. */
export const RESERVED_MENTION_NAMES = ["claude", "codex"] as const

/** Sentinel sender id used when the human operator sends a message in workspace chat. */
export const TEAM_USER_SENDER_ID = "__user__"

/**
 * Teammate configuration (per-member overrides)
 */
/**
 * Per-teammate execution binding (ADR-0090 Phase 7). Everything here is an
 * id/ref — the resolver freezes the actual spec at dispatch:
 *  - `inherit`: use the run/team/app default chain;
 *  - `pinned`: pin runtime/deployment/credential/model-role by REFERENCE;
 *  - `pool`: the coordinator may pick among candidate deployment ids only —
 *    it never sees endpoints or credentials.
 */
export type TeammateExecutionTarget =
  { mode: "colocate" } | { mode: "auto" } | { mode: "pinned"; hostRef: string }

type TeammateExecutionTargetBinding = {
  /** Host placement is independent from deployment/runtime selection. */
  executionTarget?: TeammateExecutionTarget
}

export type TeammateExecutionBinding = TeammateExecutionTargetBinding &
  (
    | { mode: "inherit" }
    | {
        mode: "pinned"
        /** External runtimes pin via `TeammateConfig.runtime`, not here. */
        runtimePolicy?: "auto" | "claude-agent-sdk" | "ai-sdk"
        /** Deployment profile id (ADR-0090 P1 store) — an id, never a URL. */
        deploymentRef?: string
        /** Credential PROFILE reference — never key material. */
        credentialProfileRef?: string
        /** Frozen model role the teammate runs as. */
        modelRole?: "primary" | "fast" | "powerful"
      }
    | {
        mode: "pool"
        /** Deployment/profile candidate ids the coordinator may choose from. */
        candidateIds: string[]
      }
  )

export interface TeammateConfig {
  /** Custom system prompt */
  systemPrompt?: string
  /**
   * Provider override.
   * @deprecated ADR-0090 Phase 7: readable for legacy rows; new configs use
   * `execution` (pinned `deploymentRef`) instead.
   */
  provider?: ProviderName
  /** Model override */
  model?: string
  /**
   * API key override.
   * @deprecated ADR-0090 Phase 7: deprecated-READABLE only. New writes are
   * rejected (`assertNoNewRawTeammateCredentials`); use a credential profile
   * reference on `execution` instead — raw keys never enter new team configs.
   */
  apiKey?: string
  /**
   * Base URL override.
   * @deprecated ADR-0090 Phase 7: deprecated-READABLE only. New writes are
   * rejected; endpoints live on the deployment profile (`execution`).
   */
  baseURL?: string
  /** Temperature override */
  temperature?: number
  /** Max steps override */
  maxSteps?: number
  /** Timeout override (ms) */
  timeout?: number
  /** Available tools for this teammate */
  tools?: string[]
  /** Require plan approval before executing */
  requirePlanApproval?: boolean
  /** Specialization area (e.g., "security", "performance", "testing") */
  specialization?: string
  /**
   * Which runtime executes this teammate. `"claude"` (default) goes through
   * the Anthropic sidecar; the others dispatch to an external ACP agent.
   */
  runtime?: TeammateRuntime
  /** Custom metadata */
  metadata?: Record<string, unknown>
  /**
   * Per-teammate overlay on the team's default capability pool. Each entry
   * is a `CapabilityListOverlay` (add / remove / replace). Leave undefined
   * to inherit the team default unchanged. See `lib/ai/agent/team/capability-resolver.ts`.
   */
  capabilities?: TeammateCapabilityOverlay
  /**
   * Bind this teammate to an Employee Digital Twin (ADR-0003). When set, every
   * dispatch synthesizes a `Character` carrying this `twinId` so the shared
   * `resolveSendOptions` twin runtime injects the twin's persona (voice /
   * playbooks / entities) plus per-task RAG knowledge — the teammate acts as
   * that digital employee. Undefined = a plain teammate with no twin.
   * See `lib/ai/agent/team/teammate-character.ts` + `dispatch-teammate.ts`.
   */
  twinId?: string
  /**
   * Per-teammate override of the twin runtime knobs (RAG topK, style few-shot,
   * hybrid, citations). Undefined = the twin's own `DEFAULT_TWIN_SETTINGS`.
   * Only meaningful when `twinId` is set.
   */
  twinSettings?: TwinSettings
  /**
   * Per-teammate OS-sandbox enablement (ADR-0028). Overrides
   * `AgentTeamConfig.sandboxEnabled`. When resolved true, the synthesized
   * `Character` carries `sandboxEnabled` so `resolveSendOptions` routes this
   * teammate's Bash/Edit/Write through the OS sandbox.
   */
  sandboxEnabled?: boolean
  /**
   * Per-teammate OS-sandbox resource/network policy (ADR-0028). Clamped DOWN to
   * the team-level `AgentTeamConfig.sandboxPolicy` ceiling via `clampSandboxPolicy`
   * — a teammate can only narrow, never widen. Only meaningful when the sandbox
   * resolves enabled.
   */
  sandboxPolicy?: import("@cognia/agent-config-types").SandboxResourcePolicy
  /**
   * Execution binding for this teammate (ADR-0090 Phase 7): inherit | pinned |
   * pool. Wins the precedence chain (member → run → team default → app
   * default). Refs only — raw credentials are rejected at write time.
   */
  execution?: TeammateExecutionBinding
}

/**
 * Teammate definition
 */
export interface AgentTeammate {
  /** Unique identifier */
  id: string
  /** Team ID this teammate belongs to */
  teamId: string
  /** Human-readable name */
  name: string
  /** Description of the teammate's role/purpose */
  description: string
  /** Role in the team */
  role: TeamMemberRole
  /** Stable built-in portrait. Older persisted teammates resolve one on read. */
  avatarId?: AgentTeamAvatarId
  /** Current status */
  status: TeammateStatus
  /** Configuration */
  config: TeammateConfig
  /** Spawn prompt from the lead */
  spawnPrompt?: string
  /** Current task ID being worked on */
  currentTaskId?: string
  /** Proposed plan (when in awaiting_approval) */
  proposedPlan?: string
  /** Plan approval feedback from lead */
  planFeedback?: string
  /** Completed task IDs */
  completedTaskIds: string[]
  /** Token usage */
  tokenUsage: SubAgentTokenUsage
  /** Progress percentage (0-100) */
  progress: number
  /** Last activity description */
  lastActivity?: string
  /** Creation timestamp */
  createdAt: Date
  /** Last active timestamp */
  lastActiveAt?: Date
  /** Error message if failed */
  error?: string
  /** Specialization area */
  specialization?: string
}

// ============================================================================
// Shared Task List
// ============================================================================

/**
 * Task status in the shared task list
 */
export type TeamTaskStatus =
  | "pending"
  | "blocked" // Waiting for dependencies
  | "claimed" // Claimed by a teammate
  | "in_progress"
  | "review" // Completed, waiting for review
  | "completed"
  | "failed"
  | "cancelled"

/**
 * Shared task definition
 */
export interface AgentTeamTask {
  /** Unique identifier */
  id: string
  /** Team ID */
  teamId: string
  /** Task title */
  title: string
  /** Detailed task description/prompt */
  description: string
  /** Current status */
  status: TeamTaskStatus
  /** Priority level */
  priority: SubAgentPriority
  /** Assigned teammate ID (null if unassigned) */
  assignedTo?: string
  /** Claimed by teammate ID */
  claimedBy?: string
  /** Dependencies - task IDs that must complete first */
  dependencies: string[]
  /** Tags for categorization */
  tags: string[]
  /** Expected deliverable description */
  expectedOutput?: string
  /** Actual result/output */
  result?: string
  /** Error message if failed */
  error?: string
  /** Creation timestamp */
  createdAt: Date
  /** Started timestamp */
  startedAt?: Date
  /** Completed timestamp */
  completedAt?: Date
  /** Estimated duration (ms) */
  estimatedDuration?: number
  /** Actual duration (ms) */
  actualDuration?: number
  /** Token usage for this task */
  tokenUsage?: SubAgentTokenUsage
  /** Order in the task list */
  order: number
  /** Number of retry attempts made */
  retryCount?: number
  /** First-class delegation / handoff lifecycle record */
  delegationRecord?: TeamDelegationRecord
  /** Traceable discussion thread — findings, decisions, blockers, results. */
  comments?: AgentTaskComment[]
  /** Task-level file/artifact/link attachments. */
  attachments?: TaskCommentAttachment[]
  /** Custom metadata */
  metadata?: Record<string, unknown>
}

/**
 * A reference attachment on a task or task comment. We have no server, so nothing is
 * copied — `ref` points at an existing resource the human opens from the workspace:
 * an artifact id, a workspace-relative file path, or a URL.
 */
export interface TaskCommentAttachment {
  /** Unique id. */
  id: string
  /** Display name (file name / artifact title / link label). */
  name: string
  /** What `ref` points at. */
  kind: "artifact" | "file" | "link"
  /** Artifact id, workspace-relative path, or URL — per `kind`. */
  ref: string
  /** Optional MIME type. */
  mimeType?: string
  /** Optional size in bytes. */
  sizeBytes?: number
}

/**
 * A comment on a task — the durable, board-visible delivery channel. Teammates record
 * findings, decisions, blockers, and results here (via `task_add_comment`); the operator
 * reads them in the task's expanded thread.
 */
export interface AgentTaskComment {
  /** Unique id. */
  id: string
  /** The task this comment belongs to. */
  taskId: string
  /** Teammate id of the author (or "user" for the operator). */
  authorId: string
  /** Author display name. */
  authorName: string
  /** Comment body (markdown). */
  text: string
  /** Creation timestamp. */
  createdAt: Date
  /** Optional attachments on this comment. */
  attachments?: TaskCommentAttachment[]
}

// ============================================================================
// Inter-Agent Messaging
// ============================================================================

/**
 * Message type
 */
export type TeamMessageType =
  | "direct" // Message to a specific teammate
  | "broadcast" // Message to all teammates
  | "system" // System notification
  | "plan_approval" // Plan approval request
  | "plan_feedback" // Plan approval response
  | "task_update" // Task status update
  | "result_share" // Sharing results between teammates
  | "shutdown" // Shutdown request/response
  | "idle" // Idle notification
  | "task_assignment" // Task assignment notification
  | "consensus" // Consensus request/vote

/**
 * Structured message payload (discriminated union)
 * Mirrors open-claude-code's structured protocol for typed inter-agent communication.
 */
export type StructuredMessagePayload =
  | { type: "shutdown_request"; reason?: string }
  | { type: "shutdown_response"; requestId: string; approved: boolean; reason?: string }
  | { type: "plan_approval_request"; planSummary: string }
  | { type: "plan_approval_response"; requestId: string; approved: boolean; feedback?: string }
  | { type: "idle_notification" }
  | { type: "task_assignment"; taskId: string; taskTitle?: string }
  | { type: "consensus_request"; consensusId: string; question: string }
  | { type: "consensus_vote"; consensusId: string; option: string }
  | {
      type: "nudge"
      nudgeType: "agenda_sync" | "review_pickup" | "rate_limit_resume"
      generation: number
    }

/**
 * Type guard: check if a message has a structured payload
 */
export function isStructuredMessage(
  msg: AgentTeamMessage
): msg is AgentTeamMessage & { structuredPayload: StructuredMessagePayload } {
  return msg.structuredPayload !== undefined
}

/**
 * Inter-agent message
 */
export interface AgentTeamMessage {
  /** Unique identifier */
  id: string
  /** Team ID */
  teamId: string
  /** Message type */
  type: TeamMessageType
  /** Sender teammate ID */
  senderId: string
  /** Sender name (for display) */
  senderName: string
  /** Recipient teammate ID (null for broadcast) */
  recipientId?: string
  /** Recipient name (for display) */
  recipientName?: string
  /** Message content */
  content: string
  /** Related task ID */
  taskId?: string
  /** Whether the message has been read */
  read: boolean
  /** Timestamp */
  timestamp: Date
  /** Custom metadata */
  metadata?: Record<string, unknown>
  /** Structured protocol payload for typed inter-agent communication */
  structuredPayload?: StructuredMessagePayload
}

// ============================================================================
// Shared Memory / Blackboard
// ============================================================================

/**
 * Entry in the team's shared memory (blackboard pattern)
 */
export interface SharedMemoryEntry {
  /** Unique key for this entry */
  key: string
  /** The stored value */
  value: unknown
  /** Who wrote this entry */
  writtenBy: string
  /** Writer's name for display */
  writerName?: string
  /** When it was written */
  writtenAt: Date
  /** Optional expiration */
  expiresAt?: Date
  /** Version number (incremented on update) */
  version: number
  /** Tags for filtering */
  tags?: string[]
  /** Access control: which teammate IDs can read (empty = all) */
  readableBy?: string[]
}

/**
 * Shared memory namespace for organizing entries
 */
export type SharedMemoryNamespace =
  | "results" // Task results shared across teammates
  | "context" // Contextual information (e.g., user preferences)
  | "artifacts" // Generated artifacts (code, documents)
  | "decisions" // Team decisions and consensus results
  | "metadata" // Execution metadata
  | "custom" // User-defined namespace

// ============================================================================
// Consensus / Voting
// ============================================================================

/**
 * Types of consensus decisions
 */
export type ConsensusType =
  | "majority" // Simple majority (>50%)
  | "supermajority" // Two-thirds majority (>66%)
  | "unanimous" // All must agree
  | "weighted" // Weighted by teammate expertise/role
  | "lead_override" // Lead can override after vote

/**
 * Status of a consensus request
 */
export type ConsensusStatus = "open" | "resolved" | "timeout" | "cancelled"

/**
 * A vote from a teammate
 */
export interface ConsensusVote {
  /** Teammate who voted */
  voterId: string
  /** Voter's name */
  voterName: string
  /** The selected option index */
  optionIndex: number
  /** Optional reasoning */
  reasoning?: string
  /** Weight of this vote (for weighted consensus) */
  weight?: number
  /** When the vote was cast */
  votedAt: Date
}

/**
 * A consensus request for team-wide decisions
 */
export interface ConsensusRequest {
  /** Unique ID */
  id: string
  /** Team this belongs to */
  teamId: string
  /** Who initiated the vote */
  initiatorId: string
  /** The question or decision to be made */
  question: string
  /** Available options to vote on */
  options: string[]
  /** Type of consensus required */
  type: ConsensusType
  /** Current status */
  status: ConsensusStatus
  /** Collected votes */
  votes: ConsensusVote[]
  /** The winning option index (set when resolved) */
  winningOption?: number
  /** Summary of the decision */
  summary?: string
  /** Related task ID */
  taskId?: string
  /** Timeout for voting (ms) */
  timeoutMs?: number
  /** Creation timestamp */
  createdAt: Date
  /** Resolution timestamp */
  resolvedAt?: Date
}

/**
 * Input for creating a consensus request
 */
export interface CreateConsensusInput {
  teamId: string
  initiatorId: string
  question: string
  options: string[]
  type?: ConsensusType
  taskId?: string
  timeoutMs?: number
}

/**
 * Input for casting a vote
 */
export interface CastVoteInput {
  consensusId: string
  voterId: string
  optionIndex: number
  reasoning?: string
}

// ============================================================================
// Inter-Agent Bridge Types
// ============================================================================

/**
 * Source type for cross-system delegation.
 *
 * `twin` (ADR-0003 integration) runs a background agent whose prompt is
 * pre-injected with an Employee Digital Twin's persona + knowledge — i.e. the
 * sub-problem is answered "as" that digital employee. See
 * `lib/ai/agent/team/delegation-orchestrator.ts:delegateToTwin`.
 */
export type AgentSystemType = "sub_agent" | "team" | "background" | "twin"

/**
 * Lifecycle status for a task handoff / delegation
 */
export type TeamDelegationStatus =
  "pending" | "awaiting_approval" | "active" | "completed" | "failed" | "cancelled" | "timeout"

/**
 * First-class delegation record attached to an originating task
 */
export interface TeamDelegationRecord {
  id: string
  sourceTeamId: string
  sourceTaskId: string
  targetType: AgentSystemType
  targetId?: string
  status: TeamDelegationStatus
  reason: string
  manual: boolean
  createdAt: Date
  updatedAt: Date
  completedAt?: Date
  error?: string
  result?: string
  metadata?: Record<string, unknown>
  /**
   * The parent↔child exchange contract for this delegation (ADR-0090
   * Phase 7). Refs/ids only — validated secret-free at build time. Additive:
   * legacy records simply lack it.
   */
  envelope?: import("@cognia/agent-config-types/handoff-envelope").HandoffEnvelope
}

/**
 * A delegation request between agent systems
 */
export interface AgentDelegation {
  /** Unique delegation ID */
  id: string
  /** Which system initiated the delegation */
  sourceType: AgentSystemType
  /** ID of the source agent/team/background-agent */
  sourceId: string
  /** Which system is being delegated to */
  targetType: AgentSystemType
  /** ID of the target (set after creation) */
  targetId?: string
  /** The task being delegated */
  task: string
  /** Configuration overrides for the target */
  config?: Record<string, unknown>
  /** Current status */
  status: "pending" | "active" | "completed" | "failed" | "cancelled"
  /** Result from the delegate */
  result?: string
  /** Error if failed */
  error?: string
  /** Creation timestamp */
  createdAt: Date
  /** Completion timestamp */
  completedAt?: Date
}

// ============================================================================
// Team Definition
// ============================================================================

/**
 * Agent Team definition
 */
export interface AgentTeam {
  /** Unique identifier */
  id: string
  /**
   * Owning workspace id — Workspace isolation (Dexie v86). Live teams are
   * per-project; reusable team *templates* stay profile-shared. Stamped from
   * the active project on create. Optional only for type-compat with rows
   * mid-flight: agent-team-store persist v7 backfills every persisted
   * pre-isolation team to `DEFAULT_PROJECT_ID`, and `updateTeam` stamps a
   * missing value on the next save, so at runtime a workspace filter may treat
   * an absent value as "not this workspace" — nothing is grandfathered.
   */
  projectId?: string
  /** Team name */
  name: string
  /** Team description/purpose */
  description: string
  /** Original task that spawned this team */
  task: string
  /** Team status */
  status: TeamStatus
  /** Team configuration */
  config: AgentTeamConfig
  /** Latest routing recommendation for the team */
  routingAssessment?: TeamRoutingAssessment
  /** Operator-selected execution intent for the team */
  selectedExecutionPattern?: TeamExecutionPattern
  /**
   * Executor decision stamped at materialization (auto-orchestration
   * provenance). Optional and absent on pre-existing teams — consumers must
   * guard. Additive field, no persist version bump (see store header).
   */
  dispatchDecision?: TeamDispatchDecision
  /**
   * External-handoff pickup state. Present only on teams materialized with
   * the `external-handoff` executor. Dates serialize to ISO strings through
   * the JSON persist layer — consumers tolerate string-or-Date.
   */
  externalPickup?: TeamExternalPickup
  /** Lead teammate ID */
  leadId: string
  /** All teammate IDs (including lead) */
  teammateIds: string[]
  /** Shared task list IDs */
  taskIds: string[]
  /** Message IDs */
  messageIds: string[]
  /** Overall progress (0-100) */
  progress: number
  /** Total token usage across all teammates */
  totalTokenUsage: SubAgentTokenUsage
  /** Final synthesized result */
  finalResult?: string
  /** Error message if failed */
  error?: string
  /** Creation timestamp */
  createdAt: Date
  /** Started timestamp */
  startedAt?: Date
  /** Completed timestamp */
  completedAt?: Date
  /** Total duration (ms) */
  totalDuration?: number
  /** Session ID that created this team */
  sessionId?: string
  /** Custom metadata */
  metadata?: Record<string, unknown>
  /** Shared memory entries (blackboard pattern) */
  sharedMemory?: Record<string, SharedMemoryEntry>
  /** Active consensus request IDs */
  consensusIds?: string[]
  /** Active delegation IDs (cross-system) */
  delegationIds?: string[]
  /** Parent delegation ID if this team was spawned by another agent system */
  parentDelegationId?: string
  /** Unified execution report for the current or latest run */
  executionReport?: TeamExecutionReport
}

/**
 * Execution report checkpoint type
 */
export type TeamExecutionCheckpointType =
  | "routing_assessed"
  | "pattern_selected"
  | "approval_requested"
  | "approval_resolved"
  | "delegation_started"
  | "delegation_completed"
  | "delegation_failed"
  | "task_retried"
  | "task_failed"
  | "task_completed"
  | "budget_escalated"
  | "consensus_recorded"

/**
 * Structured report checkpoint for a team run
 */
export interface TeamExecutionCheckpoint {
  id: string
  type: TeamExecutionCheckpointType
  timestamp: Date
  summary: string
  taskId?: string
  teammateId?: string
  delegationId?: string
  data?: Record<string, unknown>
}

/**
 * Summary statistics for a team execution report
 */
export interface TeamExecutionReportSummary {
  completedTasks: number
  failedTasks: number
  cancelledTasks: number
  blockedTasks: number
  delegatedTasks: number
  approvalsRequested: number
  retries: number
  totalTokens: number
  nextActions: string[]
}

/**
 * Unified execution report for a team run
 */
export interface TeamExecutionReport {
  id: string
  teamId: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  routingAssessment?: TeamRoutingAssessment
  activeExecutionPattern?: TeamExecutionPattern
  checkpoints: TeamExecutionCheckpoint[]
  summary?: TeamExecutionReportSummary
  traceSessionId?: string
  createdAt: Date
  updatedAt: Date
  completedAt?: Date
}

/**
 * Derived governance-facing summary for workspace-level operator feedback
 */
export interface TeamGovernanceSummary {
  recommendedPattern?: TeamExecutionPattern
  activeExecutionPattern?: TeamExecutionPattern
  selectedExecutionPattern?: TeamExecutionPattern
  routingReason?: string
  confidence?: number
  nextActions: string[]
  traceSessionId?: string
  checkpointCount: number
  approvalsRequested: number
  delegatedTasks: number
  blockedTasks: number
  completedTasks: number
  failedTasks: number
}

// ============================================================================
// Input Types
// ============================================================================

/**
 * Input for creating a new team
 */
export interface CreateTeamInput {
  name: string
  description?: string
  task: string
  config?: Partial<AgentTeamConfig>
  sessionId?: string
  metadata?: Record<string, unknown>
  /**
   * Display name for the auto-created Team Lead teammate. UI passes a
   * translated string (e.g., `t("agentTeam.defaultTeamLeadName")`); the
   * store keeps the literal so subsequent renders do not require i18n
   * context. Falls back to "Team Lead" when omitted.
   */
  leadName?: string
  /**
   * Display description for the auto-created Team Lead teammate. Same
   * i18n contract as `leadName`. Falls back to the English description
   * when omitted.
   */
  leadDescription?: string
}

/**
 * Input for adding a teammate
 */
export interface AddTeammateInput {
  teamId: string
  name: string
  description?: string
  role?: TeamMemberRole
  avatarId?: AgentTeamAvatarId
  config?: TeammateConfig
  spawnPrompt?: string
}

/**
 * Input for creating a task
 */
export interface CreateTaskInput {
  teamId: string
  title: string
  description: string
  priority?: SubAgentPriority
  dependencies?: string[]
  tags?: string[]
  expectedOutput?: string
  assignedTo?: string
  estimatedDuration?: number
  order?: number
  metadata?: Record<string, unknown>
}

/**
 * Input for adding a comment to a task. `authorId` is a teammate id or "user"; the store
 * resolves `authorName`. Attachments omit their `id` (the store mints it).
 */
export interface AddTaskCommentInput {
  taskId: string
  authorId: string
  /**
   * Display-name override for authors outside the roster (e.g. plugin
   * actors with `authorId: "plugin:<id>"`). Roster/`"user"`/`"system"`
   * authors resolve their names automatically when omitted.
   */
  authorName?: string
  text: string
  attachments?: Array<Omit<TaskCommentAttachment, "id">>
}

/**
 * Input for sending a message
 */
export interface SendMessageInput {
  teamId: string
  senderId: string
  type?: TeamMessageType
  recipientId?: string
  content: string
  taskId?: string
  metadata?: Record<string, unknown>
  /** Structured protocol payload for typed inter-agent communication */
  structuredPayload?: StructuredMessagePayload
}

// ============================================================================
// Team Events (for callbacks)
// ============================================================================

/**
 * Team event types
 */
export type TeamEventType =
  | "team_created"
  | "team_started"
  | "team_completed"
  | "team_failed"
  | "team_cancelled"
  | "teammate_added"
  | "teammate_started"
  | "teammate_completed"
  | "teammate_failed"
  | "teammate_shutdown"
  | "task_created"
  | "task_claimed"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "message_sent"
  | "plan_submitted"
  | "plan_approved"
  | "plan_rejected"
  | "routing_assessed"
  | "pattern_selected"
  | "approval_requested"
  | "delegation_started"
  | "delegation_completed"
  | "delegation_failed"
  | "progress_update"
  | "task_retried"
  | "deadlock_resolved"
  | "budget_exceeded"

/**
 * Team event
 */
export interface AgentTeamEvent {
  type: TeamEventType
  teamId: string
  teammateId?: string
  taskId?: string
  messageId?: string
  data?: Record<string, unknown>
  timestamp: Date
}

/**
 * Team execution options (callbacks)
 */
export interface TeamExecutionOptions {
  onEvent?: (event: AgentTeamEvent) => void
  onTeammateStart?: (teammate: AgentTeammate) => void
  onTeammateComplete?: (teammate: AgentTeammate) => void
  onTeammateError?: (teammate: AgentTeammate, error: string) => void
  onTaskComplete?: (task: AgentTeamTask) => void
  onMessage?: (message: AgentTeamMessage) => void
  onProgress?: (progress: number, activity?: string) => void
  onPlanSubmitted?: (teammate: AgentTeammate, plan: string) => void
  onComplete?: (team: AgentTeam) => void
  onError?: (error: string) => void
}

// ============================================================================
// Team Templates
// ============================================================================

/**
 * Predefined team template
 */
export interface AgentTeamTemplate {
  id: string
  name: string
  description: string
  category:
    | "review"
    | "research"
    | "development"
    | "debugging"
    | "analysis"
    | "general"
    | "documentation"
    | "security"
  /** Teammate definitions */
  teammates: Array<{
    name: string
    description: string
    specialization?: string
    config?: TeammateConfig
    /** Optional teammate-specific system prompt (wins over config.systemPrompt). */
    systemPrompt?: string
    /** Per-teammate capability overlay applied on top of the team pool. */
    capabilities?: TeammateCapabilityOverlay
    /** Optional per-teammate governance hints (opt-in apply in the preview). */
    governanceHints?: Partial<TeamGovernancePolicy>
    /** Display-only tags shown on the teammate row in the template preview. */
    tags?: string[]
    /** Lucide icon name for the teammate row. */
    iconKey?: string
  }>
  /** Default tasks */
  taskTemplates?: Array<{
    title: string
    description: string
    priority: SubAgentPriority
    assignedToIndex?: number
  }>
  /** Default config overrides */
  config?: Partial<AgentTeamConfig>
  icon?: string
  isBuiltIn?: boolean
}

/**
 * Built-in team templates
 */
export const BUILT_IN_TEAM_TEMPLATES: AgentTeamTemplate[] = [
  {
    id: "parallel-review",
    name: "Parallel Code Review",
    description: "Split code review across multiple specialized reviewers",
    category: "review",
    teammates: [
      {
        name: "Security Reviewer",
        description: "Reviews code for security vulnerabilities and best practices",
        specialization: "security",
      },
      {
        name: "Performance Reviewer",
        description: "Reviews code for performance issues and optimization opportunities",
        specialization: "performance",
      },
      {
        name: "Test Coverage Reviewer",
        description: "Reviews test coverage and suggests additional test cases",
        specialization: "testing",
      },
    ],
    config: {
      executionMode: "coordinated",
      requirePlanApproval: false,
    },
    icon: "ShieldCheck",
    isBuiltIn: true,
  },
  {
    id: "competing-hypotheses",
    name: "Competing Hypotheses",
    description: "Investigate a problem from different angles with competing theories",
    category: "debugging",
    teammates: [
      {
        name: "Hypothesis A",
        description: "Investigates the first potential root cause",
        specialization: "debugging",
      },
      {
        name: "Hypothesis B",
        description: "Investigates an alternative potential root cause",
        specialization: "debugging",
      },
      {
        name: "Hypothesis C",
        description: "Investigates a third potential root cause",
        specialization: "debugging",
      },
    ],
    config: {
      executionMode: "autonomous",
      enableMessaging: true,
    },
    icon: "FlaskConical",
    isBuiltIn: true,
  },
  {
    id: "research-team",
    name: "Research Team",
    description: "Multi-perspective research with synthesis",
    category: "research",
    teammates: [
      {
        name: "Primary Researcher",
        description: "Conducts the main research and gathers information",
        specialization: "research",
      },
      {
        name: "Fact Checker",
        description: "Validates findings and cross-references sources",
        specialization: "verification",
      },
      {
        name: "Synthesizer",
        description: "Combines findings into a coherent summary",
        specialization: "writing",
      },
    ],
    config: {
      executionMode: "coordinated",
      requirePlanApproval: true,
    },
    icon: "BookOpen",
    isBuiltIn: true,
  },
  {
    id: "full-stack-dev",
    name: "Full Stack Development",
    description: "Parallel frontend, backend, and test development",
    category: "development",
    teammates: [
      {
        name: "Frontend Developer",
        description: "Implements UI components and client-side logic",
        specialization: "frontend",
      },
      {
        name: "Backend Developer",
        description: "Implements API endpoints and server-side logic",
        specialization: "backend",
      },
      {
        name: "Test Engineer",
        description: "Writes tests and validates implementations",
        specialization: "testing",
      },
    ],
    config: {
      executionMode: "coordinated",
      requirePlanApproval: true,
    },
    icon: "Layers",
    isBuiltIn: true,
  },
  {
    id: "cross-layer",
    name: "Cross-Layer Coordination",
    description: "Changes spanning multiple layers owned by different teammates",
    category: "development",
    teammates: [
      {
        name: "Data Layer",
        description: "Handles database schemas, migrations, and data access",
        specialization: "data",
      },
      {
        name: "API Layer",
        description: "Implements API routes and business logic",
        specialization: "api",
      },
      {
        name: "UI Layer",
        description: "Implements user interface and interactions",
        specialization: "ui",
      },
    ],
    config: {
      executionMode: "coordinated",
      enableMessaging: true,
    },
    icon: "GitBranch",
    isBuiltIn: true,
  },
  {
    id: "documentation-team",
    name: "Documentation Team",
    description: "Generate comprehensive documentation with API docs, guides, and examples",
    category: "documentation",
    teammates: [
      {
        name: "API Documenter",
        description: "Documents public APIs, parameters, return types, and usage examples",
        specialization: "api-docs",
      },
      {
        name: "Guide Writer",
        description: "Writes user guides, tutorials, and getting-started documentation",
        specialization: "technical-writing",
      },
      {
        name: "Example Creator",
        description: "Creates code examples, snippets, and sample projects",
        specialization: "examples",
      },
    ],
    config: {
      executionMode: "coordinated",
      requirePlanApproval: false,
    },
    icon: "FileText",
    isBuiltIn: true,
  },
  {
    id: "refactoring-team",
    name: "Refactoring Team",
    description: "Safe code refactoring with analysis, implementation, and verification",
    category: "development",
    teammates: [
      {
        name: "Code Analyzer",
        description: "Analyzes current code structure, identifies patterns and dependencies",
        specialization: "code-analysis",
      },
      {
        name: "Refactorer",
        description: "Implements the refactoring changes following best practices",
        specialization: "refactoring",
      },
      {
        name: "Regression Tester",
        description: "Verifies no regressions and validates the refactored code",
        specialization: "testing",
      },
    ],
    config: {
      executionMode: "coordinated",
      enableMessaging: true,
      requirePlanApproval: true,
    },
    icon: "RefreshCw",
    isBuiltIn: true,
  },
  {
    id: "security-audit",
    name: "Security Audit",
    description: "Comprehensive security review from multiple angles",
    category: "security",
    teammates: [
      {
        name: "Vulnerability Scanner",
        description: "Identifies potential security vulnerabilities in the codebase",
        specialization: "vulnerability-detection",
      },
      {
        name: "Auth Reviewer",
        description: "Reviews authentication and authorization implementations",
        specialization: "auth-security",
      },
      {
        name: "Data Safety Auditor",
        description: "Checks data handling, encryption, and privacy compliance",
        specialization: "data-security",
      },
    ],
    config: {
      executionMode: "autonomous",
    },
    icon: "ShieldAlert",
    isBuiltIn: true,
  },
]

// ============================================================================
// Display Configuration
// ============================================================================

/**
 * Team status display configuration. `labelKey` is under `agentTeam.status.*`.
 */
export const TEAM_STATUS_CONFIG: Record<
  TeamStatus,
  { labelKey: string; color: string; icon: string }
> = {
  idle: { labelKey: "idle", color: "text-muted-foreground", icon: "Circle" },
  planning: { labelKey: "planning", color: "text-blue-500", icon: "Brain" },
  executing: { labelKey: "executing", color: "text-primary", icon: "Play" },
  paused: { labelKey: "paused", color: "text-yellow-500", icon: "Pause" },
  completed: { labelKey: "completed", color: "text-green-500", icon: "CheckCircle" },
  failed: { labelKey: "failed", color: "text-destructive", icon: "XCircle" },
  cancelled: { labelKey: "cancelled", color: "text-orange-500", icon: "Ban" },
}

/**
 * Teammate status display configuration. `labelKey` is under `agentTeam.teammateStatus.*`.
 */
export const TEAMMATE_STATUS_CONFIG: Record<
  TeammateStatus,
  { labelKey: string; color: string; icon: string }
> = {
  idle: { labelKey: "idle", color: "text-muted-foreground", icon: "Circle" },
  planning: { labelKey: "planning", color: "text-blue-500", icon: "FileText" },
  awaiting_approval: { labelKey: "awaitingApproval", color: "text-yellow-500", icon: "Clock" },
  executing: { labelKey: "executing", color: "text-primary", icon: "Loader2" },
  paused: { labelKey: "paused", color: "text-yellow-500", icon: "Pause" },
  completed: { labelKey: "completed", color: "text-green-500", icon: "CheckCircle" },
  failed: { labelKey: "failed", color: "text-destructive", icon: "XCircle" },
  cancelled: { labelKey: "cancelled", color: "text-orange-500", icon: "Ban" },
  shutdown: { labelKey: "shutdown", color: "text-muted-foreground", icon: "Power" },
}

/**
 * Task status display configuration. `labelKey` is under `agentTeam.taskStatus.*`.
 */
export const TASK_STATUS_CONFIG: Record<
  TeamTaskStatus,
  { labelKey: string; color: string; icon: string }
> = {
  pending: { labelKey: "pending", color: "text-muted-foreground", icon: "Circle" },
  blocked: { labelKey: "blocked", color: "text-red-400", icon: "Lock" },
  claimed: { labelKey: "claimed", color: "text-blue-400", icon: "Hand" },
  in_progress: { labelKey: "inProgress", color: "text-primary", icon: "Loader2" },
  review: { labelKey: "review", color: "text-purple-500", icon: "Eye" },
  completed: { labelKey: "completed", color: "text-green-500", icon: "CheckCircle" },
  failed: { labelKey: "failed", color: "text-destructive", icon: "XCircle" },
  cancelled: { labelKey: "cancelled", color: "text-orange-500", icon: "Ban" },
}

/**
 * Derived PR status (ADR — team PR feedback). Re-exported from the observation
 * layer so team UI + this display map share one union. Computed at read time
 * from durable facts — never stored.
 */
export type { PrDerivedStatus } from "@/lib/github/pr-observe/types"

/**
 * PR status display configuration. `labelKey` is under `agentTeam.prStatus.*`.
 * Colors follow the agent-orchestrator status palette (ci_failed red,
 * changes/review amber, mergeable/approved green, merged/pr_open muted).
 */
export const PR_STATUS_CONFIG: Record<
  import("@/lib/github/pr-observe/types").PrDerivedStatus,
  { labelKey: string; color: string; icon: string }
> = {
  none: { labelKey: "none", color: "text-muted-foreground", icon: "Circle" },
  pr_open: { labelKey: "prOpen", color: "text-muted-foreground", icon: "GitPullRequest" },
  draft: { labelKey: "draft", color: "text-muted-foreground", icon: "GitPullRequestDraft" },
  ci_pending: { labelKey: "ciPending", color: "text-yellow-500", icon: "Loader2" },
  ci_failed: { labelKey: "ciFailed", color: "text-destructive", icon: "XCircle" },
  changes_requested: {
    labelKey: "changesRequested",
    color: "text-yellow-500",
    icon: "MessageSquareWarning",
  },
  merge_conflict: { labelKey: "mergeConflict", color: "text-orange-500", icon: "GitMerge" },
  review_pending: { labelKey: "reviewPending", color: "text-blue-400", icon: "Eye" },
  approved: { labelKey: "approved", color: "text-green-500", icon: "Check" },
  mergeable: { labelKey: "mergeable", color: "text-green-500", icon: "GitPullRequestArrow" },
  merged: { labelKey: "merged", color: "text-purple-500", icon: "GitMerge" },
  closed: { labelKey: "closed", color: "text-muted-foreground", icon: "GitPullRequestClosed" },
}
