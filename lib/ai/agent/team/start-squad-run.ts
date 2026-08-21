/**
 * Start a Squad (agent team) run on behalf of a conversation — host-neutral.
 *
 * This is the primitive both conversational surfaces share. It is deliberately
 * the *same* one the `action.team.run` workflow node uses (`runTeamLifecycle`),
 * so a Squad turn gets the whole product pipeline — skills, memory, twin, MCP,
 * hooks, the permission ceiling, tool approval — rather than a second, thinner
 * executor. There is no `resolveSendOptions` change here and there must not be
 * one: that function describes how to run a single model turn, and a Squad run
 * is not one.
 *
 * What the caller supplies is only what genuinely differs between surfaces:
 *
 *  - `triggeredFrom` / `origin` — where the run came from, which decides the
 *    gate policy and who fans progress back.
 *  - `planApprovalDelegate` — a channel to ASK on. IM has to build one (a card
 *    in the thread); desktop chat leaves it absent because the app-root gate
 *    host already answers on the approval bus from whatever surface the user
 *    is on. Absent + a headless origin keeps the old fail-fast behaviour.
 *  - `bindConnectorRun` — whether to create a connector conversation binding.
 *    The IM presentation runner keys off it; chat renders the run inline and
 *    would be projected onto twice if it asked for one.
 *
 * The heavy Agent-Team graph is dynamically imported (matching
 * `action.team.run`) so it never enters a caller's bundle eagerly — which
 * matters for the static-export mobile build. Loaders stay injectable.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"

/** A request for human sign-off on the lead's plan, raised mid-run. */
export interface SquadPlanApprovalRequest {
  planText: string
  revision: number
  riskReason?: string
}

export type SquadPlanApprovalDelegate = (
  request: SquadPlanApprovalRequest
) => Promise<unknown> | unknown

export interface StartSquadRunInput {
  squadId: string
  /** Seeded as the Squad's objective. A blank goal leaves the existing one. */
  goal: string
  /**
   * Gate-policy origin. `"im"` and other headless origins fail a plan gate
   * fast unless a `planApprovalDelegate` proves there is somewhere to ask.
   */
  origin: string
  triggeredFrom: WorkflowTriggeredFrom
  /**
   * The conversation this run belongs to. Without it the run is uncarded:
   * nothing binds it to a thread, so no progress projects and every control
   * callback is rejected as a mismatch.
   */
  session?: ChatSession
  /** Persona to enter the Squad as, when the surface binds one. */
  characterId?: string
  permissionCeiling?: AgentPermissionCeiling
  /**
   * Plan approval owed by the surface's autonomy level, independent of risk.
   * ORed into the Squad's own flag and the risk-derived gate; it can raise a
   * gate, never lower one.
   */
  requirePlanApprovalFloor?: boolean
  planApprovalDelegate?: SquadPlanApprovalDelegate
  /** Create a connector conversation binding for this run (IM only). */
  bindConnectorRun?: boolean
  /** Pre-minted run id. Supplied when the caller needs it before dispatch. */
  runId?: string
}

export interface StartSquadRunResult {
  started: boolean
  runId?: string
  /**
   * The Squad's display name as the store had it at dispatch.
   *
   * Returned rather than looked up by the caller so a chat surface does not
   * have to import the agent-team store — which would drag the whole
   * orchestration graph into the chat bundle — and so the name is the one the
   * run actually used.
   */
  squadName?: string
  reason?: "squad_not_found" | "no_squad_id" | "dispatch_error"
}

// Minimal structural shapes for the dynamically-imported modules so the loaders
// stay injectable + typed without importing the heavy graph eagerly.
export interface SquadStoreLike {
  getTeam(teamId: string): unknown
  getTeammates(teamId: string): unknown
  getTeamTasks(teamId: string): unknown
  updateTeam(teamId: string, updates: { task?: string }): void
  addMessage(input: unknown): unknown
  setTaskStatus(taskId: string, status: unknown, result?: string, error?: string): unknown
  updateTeammate(teammateId: string, updates: unknown): unknown
}

export interface StartSquadRunDeps {
  /** Returns the live Agent-Team store state (`useAgentTeamStore.getState()`). */
  loadStore?: () => Promise<SquadStoreLike>
  /** Returns `runTeamLifecycle`. */
  loadRunTeamLifecycle?: () => Promise<
    (
      teamId: string,
      deps: Record<string, unknown>,
      signal?: AbortSignal
    ) => Promise<{ runId: string; status: string; reason?: string }>
  >
  /** Returns `buildAgentTeamRuntimeDeps` (notifierDeps + lead planning). */
  loadBuildDeps?: () => Promise<
    (options?: {
      entryPersona?: { id: string; name: string; systemPrompt: string }
    }) => Record<string, unknown>
  >
  loadCharacter?: (
    characterId: string
  ) => Promise<{ id: string; name: string; systemPrompt: string } | undefined>
}

async function defaultLoadStore(): Promise<SquadStoreLike> {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return useAgentTeamStore.getState() as unknown as SquadStoreLike
}

async function defaultLoadRunTeamLifecycle(): Promise<
  StartSquadRunDeps["loadRunTeamLifecycle"] extends () => Promise<infer R> ? R : never
> {
  const { runTeamLifecycle } = await import("@/lib/ai/agent/agent-team-runtime")
  return runTeamLifecycle as unknown as never
}

async function defaultLoadBuildDeps(): Promise<
  (options?: {
    entryPersona?: { id: string; name: string; systemPrompt: string }
  }) => Record<string, unknown>
> {
  const { buildAgentTeamRuntimeDeps } = await import("@/lib/ai/agent/agent-team-runtime-deps")
  return buildAgentTeamRuntimeDeps as unknown as (options?: {
    entryPersona?: { id: string; name: string; systemPrompt: string }
  }) => Record<string, unknown>
}

async function defaultLoadCharacter(characterId: string) {
  const { resolveCharacterById } = await import("@/lib/db/characters")
  const character = await resolveCharacterById(characterId)
  return character
    ? { id: character.id, name: character.name, systemPrompt: character.systemPrompt ?? "" }
    : undefined
}

/** Mint a run id in the format the execution bridge and run list expect. */
export function mintSquadRunId(): string {
  return `run_team_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

/**
 * Launch a Squad run. Fire-and-forget: the lifecycle is started but NOT
 * awaited — a Squad run can take minutes, and every caller has something to
 * acknowledge quickly. Returns once the run is launched, or on a fast failure
 * (missing Squad / no id) that the caller can report.
 */
export async function startSquadRun(
  input: StartSquadRunInput,
  deps: StartSquadRunDeps = {}
): Promise<StartSquadRunResult> {
  const squadId = input.squadId?.trim()
  if (!squadId) return { started: false, reason: "no_squad_id" }

  const loadStore = deps.loadStore ?? defaultLoadStore
  const loadRunTeamLifecycle = deps.loadRunTeamLifecycle ?? defaultLoadRunTeamLifecycle
  const loadBuildDeps = deps.loadBuildDeps ?? defaultLoadBuildDeps

  let store: SquadStoreLike
  let runTeamLifecycle: Awaited<ReturnType<NonNullable<StartSquadRunDeps["loadRunTeamLifecycle"]>>>
  let buildAgentTeamRuntimeDeps: (options?: {
    entryPersona?: { id: string; name: string; systemPrompt: string }
  }) => Record<string, unknown>
  try {
    ;[store, runTeamLifecycle, buildAgentTeamRuntimeDeps] = await Promise.all([
      loadStore(),
      loadRunTeamLifecycle(),
      loadBuildDeps(),
    ])
  } catch {
    return { started: false, reason: "dispatch_error" }
  }

  const squad = store.getTeam(squadId) as { name?: unknown } | undefined
  if (!squad) return { started: false, reason: "squad_not_found" }
  const squadName = typeof squad.name === "string" ? squad.name : undefined

  const entryPersona = input.characterId
    ? await (deps.loadCharacter ?? defaultLoadCharacter)(input.characterId)
    : undefined
  // Fail closed: a conversation bound to a Character that has since been
  // deleted must not silently run the Squad as nobody.
  if (input.characterId && !entryPersona) {
    return { started: false, reason: "dispatch_error" }
  }

  // Seed the objective from what the user actually asked for. Empty goals
  // leave the stored objective untouched.
  if (input.goal.trim()) {
    try {
      store.updateTeam(squadId, { task: input.goal.trim() })
    } catch {
      /* best-effort — a stored objective still lets the run proceed */
    }
  }

  const partial = buildAgentTeamRuntimeDeps(entryPersona ? { entryPersona } : undefined)
  const runId = input.runId ?? mintSquadRunId()

  const lifecycleDeps: Record<string, unknown> = {
    ...partial,
    runId,
    triggeredFrom: input.triggeredFrom,
    // Belt-and-braces: the lifecycle also derives the origin from
    // `triggeredFrom`, but stating it keeps the gate policy explicit.
    origin: input.origin,
    ...(input.planApprovalDelegate ? { planApprovalDelegate: input.planApprovalDelegate } : {}),
    ...(input.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
    ...(input.permissionCeiling ? { parentPermissionCeiling: input.permissionCeiling } : {}),
    storeReader: {
      getTeam: (id: string) => store.getTeam(id),
      getTeammates: (id: string) => store.getTeammates(id),
      getTeamTasks: (id: string) => store.getTeamTasks(id),
    },
    storeWriter: {
      addMessage: (m: unknown) => store.addMessage(m),
      setTaskStatus: (taskId: string, status: unknown, result?: string, error?: string) =>
        store.setTaskStatus(taskId, status, result, error),
      updateTeammate: (teammateId: string, updates: unknown) =>
        store.updateTeammate(teammateId, updates),
    },
  }

  // Create the execution run (and, for IM, its conversation binding) BEFORE
  // firing the lifecycle. Afterwards would race: the lifecycle can emit its
  // first events — and a runner can wake on them — before the binding exists,
  // and a runner only projects onto a binding it can already see.
  if (input.session) {
    const now = Date.now()
    const seed = {
      sourceRunId: runId,
      objective: input.goal.trim() || squadId,
      startedAt: now,
      updatedAt: now,
    }
    try {
      const bridge = await import("@/lib/execution/agent-team-bridge")
      if (input.bindConnectorRun) {
        await bridge.ensureImTeamExecutionRun({ seed, session: input.session })
      } else {
        await bridge.ensureTeamExecutionRun(seed)
      }
    } catch {
      /* best-effort: an unbound run still executes, it is just uncarded */
    }
  }

  // Fire-and-forget. Progress and failures surface through the run row and the
  // notification path; they must never reject the caller's dispatch.
  void Promise.resolve(runTeamLifecycle(squadId, lifecycleDeps)).catch(() => undefined)

  return { started: true, runId, ...(squadName ? { squadName } : {}) }
}
