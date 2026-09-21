/**
 * The one entry an agent turn, a Squad member or a workflow node uses to run
 * its turn as Router + Fusion work (ADR-0188 B5, D3; master plan D3/D21).
 *
 * Three call sites share the same three-line dance — read the choice, ask the
 * gate, run the explicit guard — and getting any of it wrong on one of them
 * would put Router + Fusion on a path that is supposed to be untouched. So it
 * lives here once, next to the gate it asks:
 *
 *   auto / no choice  → `{ kind: "skipped" }`: the caller runs exactly the code
 *                       it ran before. `auto` is today's behaviour, which on an
 *                       enabled surface already means a ledgered ordinary call
 *                       (`utility-ledger.ts`) that falls back on a fault (D38).
 *   surface off       → `{ kind: "skipped" }` as well (D37).
 *   surface tripped   → `RouterFusionUnavailableError`. Explicitly chosen fusion
 *                       work is never answered by something else (§2.1.3, D38).
 *   dormant mode      → a refusal with `FUSION_MODE_UNAVAILABLE`; `delegate` is
 *                       offered but inert until WP-D4 wires its sandbox.
 *   otherwise         → the run, through `runExplicitFusion`: an infrastructure
 *                       fault becomes `ROUTER_FUSION_UNAVAILABLE` and counts
 *                       towards the surface breaker; a refusal is a value.
 *
 * Everything behind the gate is loaded dynamically by `load-engine.ts`, so an
 * account with `agentsWorkflows` off evaluates this module and nothing else.
 */

import type { AppSettings } from "@cognia/agent-config-types"

import { routerFusionChatRunActive } from "./chat-fusion-run"
import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { runExplicitFusion, trippedSurfaceError } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

/** The surface every agent, Squad and workflow generation is booked on (D27). */
export const AGENTS_WORKFLOWS_SURFACE = "agentsWorkflows" as const

/**
 * What an agent turn, a Squad member or a workflow node may be set to.
 * `auto` is the default and means "unchanged": the caller's existing path.
 */
export const FUSION_ACTION_CHOICES = ["auto", "direct", "cascade", "panel", "delegate"] as const
export type FusionActionChoice = (typeof FUSION_ACTION_CHOICES)[number]
/** A choice that asks for a fusion run; `auto` is excluded by construction. */
export type FusionActionMode = Exclude<FusionActionChoice, "auto">

/**
 * The modes this build can actually execute on the agents / workflows surface.
 *
 * It mirrors the Run API's `EXECUTABLE_MODES` — the list
 * `agents/agent-fusion-run.ts` hands the router — because a mode the router
 * filters out would be refused for want of a route rather than run, and a
 * picker that offered it would be lying. `explicit-run.test.ts` pins the two
 * against each other; the gate cannot import the host module itself, so the
 * test is what keeps the copy honest. A mode that is listed in
 * {@link FUSION_ACTION_CHOICES} but missing here is offered disabled with a
 * "Later release" note (Rule 7), and refused here at runtime.
 */
export const WIRED_FUSION_ACTION_MODES: readonly FusionActionMode[] = [
  "direct",
  "cascade",
  "panel",
  "delegate",
]

export function isFusionActionChoice(value: unknown): value is FusionActionChoice {
  return typeof value === "string" && (FUSION_ACTION_CHOICES as readonly string[]).includes(value)
}

export function isWiredFusionActionMode(value: unknown): value is FusionActionMode {
  return (
    typeof value === "string" && (WIRED_FUSION_ACTION_MODES as readonly string[]).includes(value)
  )
}

/** A stored value read back as a choice; anything unknown reads as `auto`. */
export function fusionActionChoiceOf(value: unknown): FusionActionChoice {
  return isFusionActionChoice(value) ? value : "auto"
}

/** What the pickers offer, and what a stored choice is validated against. */
export interface FusionActionAvailability {
  /** The `agentsWorkflows` surface is on, so a mode other than `auto` can run. */
  surfaceEnabled: boolean
  /** Modes this account can execute right now. Empty while the surface is off. */
  allowed: FusionActionMode[]
  /** Offered, disabled, labelled "Later release" — dormant on all three axes. */
  dormant: FusionActionMode[]
}

/**
 * Which action choices the account's settings allow.
 *
 * With Router + Fusion off — the default — nothing but `auto` is allowed, and
 * a picker shows the whole field as inert rather than pretending a choice
 * would do something. A tripped surface is still "enabled": the breaker is a
 * runtime pause the user re-arms, not a configuration change, and an explicit
 * choice made while it is open is reported rather than silently downgraded.
 */
export function fusionActionAvailability(
  settings: RouterFusionGateSettings | null | undefined
): FusionActionAvailability {
  const surfaceEnabled = routerFusionGate(settings, AGENTS_WORKFLOWS_SURFACE) !== "off"
  const dormant = FUSION_ACTION_CHOICES.filter(
    (choice): choice is FusionActionMode => choice !== "auto" && !isWiredFusionActionMode(choice)
  )
  return {
    surfaceEnabled,
    allowed: surfaceEnabled ? [...WIRED_FUSION_ACTION_MODES] : [],
    dormant,
  }
}

/** Why a stored action choice cannot run. Each value is an i18n key of `routerFusionModes.errors`. */
export type FusionActionIssue =
  /** Router + Fusion (or its agents/workflows surface) is switched off. */
  | "surfaceOff"
  /** The mode exists but this build cannot execute it yet. */
  | "modeDormant"
  /** `delegate` edits files, so it needs a workspace to edit them in. */
  | "workspaceRequired"

/**
 * Validate one stored choice. `null` means it may run. `auto` is always valid:
 * it is the absence of a choice.
 */
export function validateFusionActionChoice(input: {
  action: unknown
  settings: RouterFusionGateSettings | null | undefined
  /** Whether the caller has a workspace (a project / working directory). */
  hasWorkspace: boolean
}): FusionActionIssue | null {
  const action = fusionActionChoiceOf(input.action)
  if (action === "auto") return null
  const availability = fusionActionAvailability(input.settings)
  if (!availability.surfaceEnabled) return "surfaceOff"
  if (!isWiredFusionActionMode(action)) return "modeDormant"
  if (action === "delegate" && !input.hasWorkspace) return "workspaceRequired"
  return null
}

/** Whether a stored choice asks for a fusion run at all (one property read). */
export function fusionActionRequested(value: unknown): value is FusionActionMode {
  return isFusionActionChoice(value) && value !== "auto"
}

/**
 * INV-09 — the scopes with an `agentsWorkflows` fusion run in flight in this
 * window, counted so a second turn winding down cannot clear the mark of the
 * turn started after it.
 *
 * A scope is whatever the caller's turns share: a chat session id for agent
 * turns, the team run id for Squad members, the workflow run id for nodes. A
 * turn started while its own scope is running a fusion run has a fusion
 * ancestor, and the router refuses to nest one orchestrated run inside another.
 */
const fusionScopes = new Map<string, number>()

/** Whether this scope already runs a fusion turn — its own, or the chat turn it belongs to. */
export function fusionAncestorActive(scopeId: string | null | undefined): boolean {
  if (!scopeId) return false
  return (fusionScopes.get(scopeId) ?? 0) > 0 || routerFusionChatRunActive(scopeId)
}

function enterScope(scopeId: string | null | undefined): () => void {
  if (!scopeId) return () => {}
  fusionScopes.set(scopeId, (fusionScopes.get(scopeId) ?? 0) + 1)
  return () => {
    const left = (fusionScopes.get(scopeId) ?? 1) - 1
    if (left > 0) fusionScopes.set(scopeId, left)
    else fusionScopes.delete(scopeId)
  }
}

export function __resetFusionScopesForTesting(): void {
  fusionScopes.clear()
}

/** The fusion run itself, as the host module describes it. */
type AgentFusionRunInput = Parameters<RouterFusionHost["runAgentsWorkflowsFusion"]>[0]
export type AgentFusionAnswer = Extract<
  Awaited<ReturnType<RouterFusionHost["runAgentsWorkflowsFusion"]>>,
  { kind: "answered" }
>

export interface ExplicitFusionTurnInput {
  /** The chosen mode. Callers pass their stored choice through `fusionActionRequested` first. */
  mode: FusionActionMode
  origin: AgentFusionRunInput["origin"]
  featureId: string
  messages: AgentFusionRunInput["messages"]
  jsonSchema?: Record<string, unknown> | null
  workspaceId?: string | null
  workspaceRoot?: string | null
  /**
   * The conversation or run this turn belongs to. Turns that share a scope
   * nest: one started while the scope already runs a fusion turn has a fusion
   * ancestor (INV-09).
   */
  scopeId?: string | null
  /**
   * Force the ancestor flag. A caller that knows it runs inside a fusion run
   * (a delegate worker's workflow, a replayed child run) says so; everyone
   * else lets {@link fusionAncestorActive} answer from the scope.
   */
  hasFusionAncestor?: boolean
  /** The account settings the gate reads; also what the run is routed against. */
  settings: RouterFusionGateSettings | null | undefined
  signal?: AbortSignal
  deadlineMs?: number
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

export type ExplicitFusionTurnOutcome =
  /** The surface is off, so the caller runs its own path, byte for byte. */
  | { kind: "skipped" }
  | AgentFusionAnswer
  | { kind: "refused"; code: string; reasons: string[]; runId?: string }

/**
 * Run an explicitly chosen agent / Squad / workflow turn as a fusion run.
 *
 * Returns `{ kind: "skipped" }` — and loads nothing — while the surface is off.
 * Throws `RouterFusionUnavailableError` when the surface is paused or the
 * infrastructure fails; every other outcome is a value.
 */
export async function runExplicitAgentFusionTurn(
  input: ExplicitFusionTurnInput
): Promise<ExplicitFusionTurnOutcome> {
  const gate = routerFusionGate(input.settings, AGENTS_WORKFLOWS_SURFACE)
  if (gate === "off") return { kind: "skipped" }
  if (gate === "tripped") throw trippedSurfaceError(AGENTS_WORKFLOWS_SURFACE)
  if (!isWiredFusionActionMode(input.mode)) {
    return {
      kind: "refused",
      code: "FUSION_MODE_UNAVAILABLE",
      reasons: [`mode:${input.mode}:not_wired`],
    }
  }
  const hasFusionAncestor = input.hasFusionAncestor ?? fusionAncestorActive(input.scopeId)
  const leaveScope = enterScope(input.scopeId)
  try {
    return await runExplicitFusion<ExplicitFusionTurnOutcome>({
      surface: AGENTS_WORKFLOWS_SURFACE,
      threshold: breakerThresholdOf(input.settings),
      fusion: async () => {
        const host = await (input.loadHost ?? loadRouterFusionHost)()
        return host.runAgentsWorkflowsFusion({
          mode: input.mode,
          origin: input.origin,
          featureId: input.featureId,
          messages: input.messages,
          jsonSchema: input.jsonSchema ?? null,
          workspaceId: input.workspaceId ?? null,
          workspaceRoot: input.workspaceRoot ?? null,
          hasFusionAncestor,
          // Every caller hands the gate the full account settings; the gate type
          // only names the part it reads.
          appSettings: input.settings as AppSettings,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        })
      },
    })
  } finally {
    leaveScope()
  }
}
