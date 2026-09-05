/**
 * Start a Squad run. The only launch seam (ADR-0140, hardened by ADR-0169).
 *
 * Chat, IM, workflow nodes, the scheduler, slash commands, plugins, Issues,
 * Bots, the CLI and paired devices all arrive here. What differs per surface is
 * only what genuinely differs: where the run came from (gate policy and who
 * fans progress back), whether there is a channel to ask a human on, and
 * whether a connector binding is wanted.
 *
 * What is the same for every caller, and enforced here rather than trusted:
 *
 *   1. Readiness. A Squad missing its repository or environment binding is
 *      refused with the blocker codes `evaluateSquadReadiness` computes, the
 *      same codes the settings panel and the fleet show.
 *   2. One live run per Squad. A second start while one is open returns the
 *      open run instead of forking a duplicate. Retries with the same `runId`
 *      are idempotent for the same reason.
 *   3. Fail-closed, transactional creation. The durable run record and the
 *      canonical `ExecutionRun` are written in one transaction BEFORE any
 *      dispatch. If that write fails, nothing executes and the caller is told.
 *
 * The heavy Agent-Team graph is dynamically imported so it never enters a
 * caller's bundle eagerly, which matters for the static-export mobile build.
 * Loaders stay injectable.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import type { SquadReadiness, SquadReadinessBlocker } from "@/lib/agent-team/squad-readiness"

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
   * ORed into the Squad's own flag and the risk-derived gate. It can raise a
   * gate, never lower one.
   */
  requirePlanApprovalFloor?: boolean
  planApprovalDelegate?: SquadPlanApprovalDelegate
  /** Create a connector conversation binding for this run (IM only). */
  bindConnectorRun?: boolean
  /** Pre-minted run id. Doubles as the idempotency key. */
  runId?: string
  /** Manual "run with ultracode" override. Omitted lets the Squad decide. */
  ultracode?: boolean
  /** The settled run this one replaces (a `retry`). */
  parentRunId?: string
}

export type StartSquadRunRefusal =
  | "squad_not_found"
  | "no_squad_id"
  | "dispatch_error"
  /** Readiness blockers stand. See `blockers`. */
  | "not_ready"
  /** A live run already exists. See `runId`. */
  | "already_running"
  /** The run records could not be written. Nothing was started. */
  | "journal_failed"
  /** The Squad bootstrap has not finished (or failed). Nothing was started. */
  | "runtime_not_ready"

export interface StartSquadRunResult {
  started: boolean
  /** The durable run id. On `already_running`, the open run. */
  runId?: string
  /** `execution:team:<runId>`, for callers that watch or link the row. */
  executionRunId?: string
  /**
   * The Squad's display name as the store had it at dispatch. Returned rather
   * than looked up so a chat surface need not import the agent-team store.
   */
  squadName?: string
  reason?: StartSquadRunRefusal
  blockers?: SquadReadinessBlocker[]
  /** True when the same `runId` was already launched and this call was a replay. */
  duplicate?: boolean
}

// Minimal structural shapes for the dynamically-imported modules so the loaders
// stay injectable and typed without importing the heavy graph eagerly.
export interface SquadStoreLike {
  getTeam(teamId: string): unknown
  getTeammates(teamId: string): unknown
  getTeamTasks(teamId: string): unknown
  updateTeam(teamId: string, updates: { task?: string }): void
}

export interface SquadRunRecordsSeed {
  runId: string
  teamId: string
  objective: string
  projectId?: string
  sessionId?: string
  origin: string
  priority?: number
  environmentVersionId?: string
  parentRunId?: string
  startedAt: number
}

export interface StartSquadRunDeps {
  /**
   * Waits for the ordered Squad bootstrap (ADR-0169). Resolves `false` when it
   * failed or timed out. Defaults to `awaitSquadRuntimeReady`.
   */
  awaitRuntimeReady?: () => Promise<boolean>
  /** Returns the live Agent-Team store state (`useAgentTeamStore.getState()`). */
  loadStore?: () => Promise<SquadStoreLike>
  /** Readiness gate. Defaults to `evaluateSquadReadiness` with live readers. */
  evaluateReadiness?: (
    team: AgentTeam,
    teammates: readonly AgentTeammate[]
  ) => Promise<SquadReadiness>
  /** The team's open run, if any. */
  findLiveRun?: (teamId: string) => Promise<{ id: string } | undefined>
  /** Transactional record creation. Throws on failure. */
  createRunRecords?: (
    seed: SquadRunRecordsSeed
  ) => Promise<{ executionRunId: string; created: boolean }>
  /** IM only: bind the execution run to the conversation. */
  bindConnectorRun?: (input: {
    executionRunId: string
    projectId?: string
    session: ChatSession
  }) => Promise<void>
  /** Executes the lifecycle. Fire-and-forget from here. */
  runLifecycle?: (input: {
    teamId: string
    runId: string
    origin: string
    triggeredFrom: WorkflowTriggeredFrom
    sessionId?: string
    ultracode?: boolean
    planApprovalDelegate?: SquadPlanApprovalDelegate
    requirePlanApprovalFloor?: boolean
    permissionCeiling?: AgentPermissionCeiling
    sessionWorkingDir?: string
    entryPersona?: { id: string; name: string; systemPrompt: string }
  }) => Promise<unknown>
  loadCharacter?: (
    characterId: string
  ) => Promise<{ id: string; name: string; systemPrompt: string } | undefined>
  /** Returns `resolveEffectiveCwdForSession` (ADR-0144). */
  resolveSessionCwd?: (session: ChatSession) => Promise<string | null>
  now?: () => number
}

async function defaultAwaitRuntimeReady(): Promise<boolean> {
  const { awaitSquadRuntimeReady } = await import("@/lib/agent-team/bootstrap")
  return awaitSquadRuntimeReady()
}

async function defaultLoadStore(): Promise<SquadStoreLike> {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return useAgentTeamStore.getState() as unknown as SquadStoreLike
}

async function defaultEvaluateReadiness(
  team: AgentTeam,
  teammates: readonly AgentTeammate[]
): Promise<SquadReadiness> {
  const { evaluateSquadReadiness } = await import("@/lib/agent-team/squad-readiness")
  return evaluateSquadReadiness({ team, teammates })
}

async function defaultFindLiveRun(teamId: string) {
  const { findLiveSquadRun } = await import("./squad-run-records")
  return findLiveSquadRun(teamId)
}

async function defaultCreateRunRecords(seed: SquadRunRecordsSeed) {
  const { createSquadRunRecords } = await import("./squad-run-records")
  return createSquadRunRecords(seed)
}

async function defaultBindConnectorRun(input: {
  executionRunId: string
  projectId?: string
  session: ChatSession
}): Promise<void> {
  const { ensureConnectorRunBinding } = await import("@/lib/execution/agent-state-bridge")
  await ensureConnectorRunBinding(input.executionRunId, input.projectId, input.session)
}

async function defaultRunLifecycle(
  input: Parameters<NonNullable<StartSquadRunDeps["runLifecycle"]>>[0]
): Promise<unknown> {
  const { runSquadLifecycle } = await import("./squad-lifecycle-runner")
  return runSquadLifecycle({
    teamId: input.teamId,
    runId: input.runId,
    origin: input.origin,
    triggeredFrom: input.triggeredFrom,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
    ...(input.planApprovalDelegate
      ? {
          planApprovalDelegate: input.planApprovalDelegate as NonNullable<
            import("./squad-lifecycle-runner").RunSquadLifecycleInput["planApprovalDelegate"]
          >,
        }
      : {}),
    ...(input.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
    ...(input.permissionCeiling ? { permissionCeiling: input.permissionCeiling } : {}),
    ...(input.sessionWorkingDir ? { sessionWorkingDir: input.sessionWorkingDir } : {}),
    ...(input.entryPersona ? { entryPersona: input.entryPersona } : {}),
  })
}

async function defaultResolveSessionCwd(session: ChatSession): Promise<string | null> {
  const { resolveEffectiveCwdForSession } = await import("@/hooks/chat/use-effective-cwd")
  return resolveEffectiveCwdForSession(session)
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
 * awaited. A Squad run can take minutes, and every caller has something to
 * acknowledge quickly. Returns once the run is journalled and launched, or
 * with a typed refusal the caller can report.
 */
export async function startSquadRun(
  input: StartSquadRunInput,
  deps: StartSquadRunDeps = {}
): Promise<StartSquadRunResult> {
  const squadId = input.squadId?.trim()
  if (!squadId) return { started: false, reason: "no_squad_id" }
  const now = deps.now ?? Date.now

  // 0. The runtime. Definitions still hydrating, adapters not yet installed
  // or recovery still walking live runs: a launch waits, and if the wait
  // ends without a ready runtime it is refused rather than raced.
  let runtimeReady = false
  try {
    runtimeReady = await (deps.awaitRuntimeReady ?? defaultAwaitRuntimeReady)()
  } catch {
    runtimeReady = false
  }
  if (!runtimeReady) return { started: false, reason: "runtime_not_ready" }

  let store: SquadStoreLike
  try {
    store = await (deps.loadStore ?? defaultLoadStore)()
  } catch {
    return { started: false, reason: "dispatch_error" }
  }

  const squad = store.getTeam(squadId) as AgentTeam | undefined
  if (!squad) return { started: false, reason: "squad_not_found" }
  const squadName = typeof squad.name === "string" ? squad.name : undefined
  const projectId = typeof squad.projectId === "string" ? squad.projectId : undefined
  const named = squadName ? { squadName } : {}

  // 1. Readiness. Blocked Squads stay visible and editable. They do not run.
  const teammates = (store.getTeammates(squadId) as AgentTeammate[] | undefined) ?? []
  let readiness: SquadReadiness
  try {
    readiness = await (deps.evaluateReadiness ?? defaultEvaluateReadiness)(squad, teammates)
  } catch {
    return { started: false, reason: "dispatch_error", ...named }
  }
  if (!readiness.ready) {
    return { started: false, reason: "not_ready", blockers: readiness.blockers, ...named }
  }

  const entryPersona = input.characterId
    ? await (deps.loadCharacter ?? defaultLoadCharacter)(input.characterId)
    : undefined
  // Fail closed: a conversation bound to a Character that has since been
  // deleted must not silently run the Squad as nobody.
  if (input.characterId && !entryPersona) {
    return { started: false, reason: "dispatch_error", ...named }
  }

  // 2. One live run per Squad. A replay of the same run id is the same run.
  const runId = input.runId ?? mintSquadRunId()
  let live: { id: string } | undefined
  try {
    live = await (deps.findLiveRun ?? defaultFindLiveRun)(squadId)
  } catch {
    return { started: false, reason: "dispatch_error", ...named }
  }
  if (live && live.id !== runId) {
    return {
      started: false,
      reason: "already_running",
      runId: live.id,
      executionRunId: `execution:team:${live.id}`,
      ...named,
    }
  }

  // Seed the objective from what the user actually asked for. Empty goals
  // leave the stored objective untouched.
  if (input.goal.trim()) {
    try {
      store.updateTeam(squadId, { task: input.goal.trim() })
    } catch {
      /* best-effort: a stored objective still lets the run proceed */
    }
  }

  // Where the conversation says work happens. The Squad's own `workingDir`
  // knows nothing about the workspace the conversation is in, and the
  // lifecycle prefers this only when the Squad has not named its own
  // repositories.
  const sessionWorkingDir = input.session
    ? await (deps.resolveSessionCwd ?? defaultResolveSessionCwd)(input.session).catch(() => null)
    : null

  // 3. Records first, in one transaction. Failure means nothing executes.
  let executionRunId: string
  let duplicate = false
  try {
    const records = await (deps.createRunRecords ?? defaultCreateRunRecords)({
      runId,
      teamId: squadId,
      objective: input.goal.trim() || squad.task || squadName || squadId,
      ...(projectId ? { projectId } : {}),
      ...(input.session ? { sessionId: input.session.id } : {}),
      origin: input.origin,
      priority: squad.config?.resourcePolicy?.priority ?? 0,
      ...(squad.config?.environmentRef
        ? { environmentVersionId: squad.config.environmentRef.versionId }
        : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      startedAt: now(),
    })
    executionRunId = records.executionRunId
    duplicate = !records.created
  } catch {
    return { started: false, reason: "journal_failed", ...named }
  }
  if (duplicate && live?.id === runId) {
    // The records exist AND the run is live: this is a redelivered start.
    return { started: true, runId, executionRunId, duplicate: true, ...named }
  }

  // The connector binding follows the records, before the lifecycle: a runner
  // only projects onto a binding it can already see.
  if (input.bindConnectorRun && input.session) {
    try {
      await (deps.bindConnectorRun ?? defaultBindConnectorRun)({
        executionRunId,
        ...(projectId ? { projectId } : {}),
        session: input.session,
      })
    } catch {
      /* the run is journalled and controllable without its card */
    }
  }

  // Fire-and-forget. Progress and failures surface through the run row and the
  // notification path. They must never reject the caller's dispatch.
  void Promise.resolve(
    (deps.runLifecycle ?? defaultRunLifecycle)({
      teamId: squadId,
      runId,
      origin: input.origin,
      triggeredFrom: input.triggeredFrom,
      ...(input.session ? { sessionId: input.session.id } : {}),
      ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
      ...(input.planApprovalDelegate ? { planApprovalDelegate: input.planApprovalDelegate } : {}),
      ...(input.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
      ...(input.permissionCeiling ? { permissionCeiling: input.permissionCeiling } : {}),
      ...(sessionWorkingDir ? { sessionWorkingDir } : {}),
      ...(entryPersona ? { entryPersona } : {}),
    })
  ).catch(() => undefined)

  return { started: true, runId, executionRunId, ...named }
}
