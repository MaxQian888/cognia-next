/**
 * Dispatch an inbound IM message to an Agent Team (control-plane multi-agent).
 *
 * When a conversation is bound to a team (`ConversationOverrideRow.teamId`),
 * the connector runtime routes the inbound message here instead of the
 * single-character `runAndCapture` path. This reuses the *exact* primitive the
 * `action.team.run` workflow node uses (`runTeamLifecycle`) — passing
 * `triggeredFrom { source: "im" }` so the execution bridge
 * (`lib/execution/workflow-bridge.ts`) + the durable run-presentation runner
 * (`lib/connectors/run-presentation/runner.ts`) fan the team's progress +
 * final result back to the originating conversation. No second executor, no
 * `resolveSendOptions` change.
 *
 * The team runtime + store are dynamically imported (matching
 * `action.team.run`) so the heavy Agent-Team graph never enters the connector
 * bundle eagerly — important for the static-export mobile bundle. Loaders are
 * injectable for tests.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"

export interface StartTeamRunFromIMInput {
  teamId: string
  /** The inbound message text — seeded as the team's objective. */
  goal: string
  adapterId: string
  conversationKey: string
  sessionId?: string
  characterId?: string
  permissionCeiling?: AgentPermissionCeiling
  /**
   * The conversation's ChatSession. Required to bind the run to the thread
   * that asked for it — without a binding the run-presentation runner has
   * nothing to project onto and every control callback is rejected as a
   * conversation mismatch. Optional only so existing callers compile; a
   * dispatch without it produces an uncarded, uncontrollable run.
   */
  session?: ChatSession
  /**
   * remoteUserId of the person whose message started this run. Scopes the plan
   * card's buttons to them (or a configured operator), the same rule the tool
   * approval card uses.
   */
  initiatorUserId?: string
  /**
   * Plan approval owed by the conversation's AUTONOMY level, independent of
   * risk. ORed into the team's own flag and the risk-derived gate inside the
   * lifecycle; it can raise a gate, never lower one.
   */
  requirePlanApprovalFloor?: boolean
}

export interface StartTeamRunFromIMResult {
  started: boolean
  runId?: string
  reason?: "team_not_found" | "no_team_id" | "dispatch_error"
}

// Minimal structural shapes for the dynamically-imported modules so the loaders
// stay injectable + typed without importing the heavy graph eagerly.
interface TeamStoreLike {
  getTeam(teamId: string): unknown
  getTeammates(teamId: string): unknown
  getTeamTasks(teamId: string): unknown
  updateTeam(teamId: string, updates: { task?: string }): void
  addMessage(input: unknown): unknown
  setTaskStatus(taskId: string, status: unknown, result?: string, error?: string): unknown
  updateTeammate(teammateId: string, updates: unknown): unknown
}

export interface StartTeamRunFromIMDeps {
  /** Returns the live Agent-Team store state (`useAgentTeamStore.getState()`). */
  loadStore?: () => Promise<TeamStoreLike>
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

async function defaultLoadStore(): Promise<TeamStoreLike> {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return useAgentTeamStore.getState() as unknown as TeamStoreLike
}

async function defaultLoadRunTeamLifecycle(): Promise<
  StartTeamRunFromIMDeps["loadRunTeamLifecycle"] extends () => Promise<infer R> ? R : never
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

/**
 * Kick off a team run for an inbound IM message. Fire-and-forget: the lifecycle
 * is launched but NOT awaited (a team run can take minutes; the connector
 * runtime must ack the inbound event fast). Progress + final result flow back
 * to the conversation through the execution bridge + run-presentation
 * runner via the `triggeredFrom` origin. Returns once the run is launched (or a fast failure
 * is detected: missing team / no team id).
 */
export async function startTeamRunFromIM(
  input: StartTeamRunFromIMInput,
  deps: StartTeamRunFromIMDeps = {}
): Promise<StartTeamRunFromIMResult> {
  const teamId = input.teamId?.trim()
  if (!teamId) return { started: false, reason: "no_team_id" }

  const loadStore = deps.loadStore ?? defaultLoadStore
  const loadRunTeamLifecycle = deps.loadRunTeamLifecycle ?? defaultLoadRunTeamLifecycle
  const loadBuildDeps = deps.loadBuildDeps ?? defaultLoadBuildDeps

  let store: TeamStoreLike
  let runTeamLifecycle: Awaited<
    ReturnType<NonNullable<StartTeamRunFromIMDeps["loadRunTeamLifecycle"]>>
  >
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

  if (!store.getTeam(teamId)) return { started: false, reason: "team_not_found" }

  const entryPersona = input.characterId
    ? await (deps.loadCharacter ?? defaultLoadCharacter)(input.characterId)
    : undefined
  if (input.characterId && !entryPersona) {
    return { started: false, reason: "dispatch_error" }
  }

  // Seed the team's objective from the inbound text so the run works on the
  // user's request. Empty goals leave the existing objective untouched.
  if (input.goal.trim()) {
    try {
      store.updateTeam(teamId, { task: input.goal.trim() })
    } catch {
      /* best-effort — a stored objective still lets the run proceed */
    }
  }

  const triggeredFrom: WorkflowTriggeredFrom = {
    source: "im",
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.characterId ? { characterId: input.characterId } : {}),
  }

  const partial = buildAgentTeamRuntimeDeps(entryPersona ? { entryPersona } : undefined)
  const runId = `run_team_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`

  // Give the lifecycle a way to ASK. `origin: "im"` alone put this run under
  // the headless policy, whose plan gate fails fast on the premise that there
  // is no human — true for a 3am scheduler run, false for a chat thread with a
  // person in it and a working approval channel. Supplying the delegate is the
  // proof of that channel; without a delivery target there is genuinely no
  // surface to ask on, so the old fail-fast behaviour stands.
  const deliveryTarget = input.session?.platformBinding?.deliveryTarget
  const conversationRef = deliveryTarget?.conversationRef
  const planApprovalDelegate =
    deliveryTarget && conversationRef
      ? async (request: { planText: string; revision: number; riskReason?: string }) => {
          const { makeImPlanApprovalDelegate } = await import("@/lib/connectors/hitl/plan-approval")
          return makeImPlanApprovalDelegate({
            runId,
            teamId,
            objective: input.goal.trim() || teamId,
            adapterId: input.adapterId,
            conversationKey: input.conversationKey,
            conversationRef,
            deliveryTarget,
            ...(input.initiatorUserId ? { initiatorUserId: input.initiatorUserId } : {}),
          })(request)
        }
      : undefined

  const lifecycleDeps: Record<string, unknown> = {
    ...partial,
    runId,
    triggeredFrom,
    // Belt-and-braces: the lifecycle also derives "im" from triggeredFrom,
    // but stating it keeps the headless gate policy explicit.
    origin: "im",
    ...(planApprovalDelegate ? { planApprovalDelegate } : {}),
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

  // Create the execution run AND its conversation binding BEFORE firing the
  // lifecycle. Afterwards would race: the lifecycle can emit its first events
  // (and the runner can wake on them) before the binding exists, and the
  // runner only projects onto a binding it can already see.
  if (input.session) {
    const now = Date.now()
    try {
      const { ensureImTeamExecutionRun } = await import("@/lib/execution/agent-team-bridge")
      await ensureImTeamExecutionRun({
        seed: {
          sourceRunId: runId,
          objective: input.goal.trim() || teamId,
          startedAt: now,
          updatedAt: now,
        },
        session: input.session,
      })
    } catch {
      /* best-effort: an unbound run still executes, it is just uncarded */
    }
  }

  // Fire-and-forget. The run-presentation runner owns IM fan-out; we swallow the
  // "already running" / lifecycle errors here (they surface via the run row /
  // notification path), never letting them reject the inbound dispatch.
  void Promise.resolve(runTeamLifecycle(teamId, lifecycleDeps)).catch(() => undefined)

  return { started: true, runId }
}

/**
 * Resolve a team by id (exact) or display name (case-insensitive) from the
 * live Agent-Team store. Used by the `/team <name|id>` control command. Returns
 * `undefined` when no team matches or the store can't be read.
 */
export async function resolveTeamByNameOrId(
  nameOrId: string
): Promise<{ id: string; name: string } | undefined> {
  try {
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const state = useAgentTeamStore.getState() as unknown as {
      getTeam(id: string): { id: string; name: string } | undefined
      teams?: Record<string, { id: string; name: string }>
    }
    const byId = state.getTeam(nameOrId)
    if (byId) return { id: byId.id, name: byId.name }
    const all = Object.values(state.teams ?? {})
    const byName = all.find((t) => t.name.toLowerCase() === nameOrId.toLowerCase())
    return byName ? { id: byName.id, name: byName.name } : undefined
  } catch {
    return undefined
  }
}
