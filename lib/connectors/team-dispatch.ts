/**
 * Dispatch an inbound IM message to an Agent Team (control-plane multi-agent).
 *
 * When a conversation is bound to a team (`ConversationOverrideRow.teamId`),
 * the connector runtime routes the inbound message here instead of the
 * single-character `runAndCapture` path. This reuses the *exact* primitive the
 * `action.team.run` workflow node uses (`runTeamLifecycle`) — passing
 * `triggeredFrom { source: "im" }` so the already-wired
 * `workflow-progress-runner` fans the team's progress + final result back to
 * the originating conversation. No second executor, no `resolveSendOptions`
 * change.
 *
 * The team runtime + store are dynamically imported (matching
 * `action.team.run`) so the heavy Agent-Team graph never enters the connector
 * bundle eagerly — important for the static-export mobile bundle. Loaders are
 * injectable for tests.
 */

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

export interface StartTeamRunFromIMInput {
  teamId: string
  /** The inbound message text — seeded as the team's objective. */
  goal: string
  adapterId: string
  conversationKey: string
  sessionId?: string
}

export interface StartTeamRunFromIMResult {
  started: boolean
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
  loadBuildDeps?: () => Promise<() => Record<string, unknown>>
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

async function defaultLoadBuildDeps(): Promise<() => Record<string, unknown>> {
  const { buildAgentTeamRuntimeDeps } = await import("@/lib/ai/agent/agent-team-runtime-deps")
  return buildAgentTeamRuntimeDeps as unknown as () => Record<string, unknown>
}

/**
 * Kick off a team run for an inbound IM message. Fire-and-forget: the lifecycle
 * is launched but NOT awaited (a team run can take minutes; the connector
 * runtime must ack the inbound event fast). Progress + final result flow back
 * to the conversation through the `workflow-progress-runner` via the
 * `triggeredFrom` origin. Returns once the run is launched (or a fast failure
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
  let buildAgentTeamRuntimeDeps: () => Record<string, unknown>
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
  }

  const partial = buildAgentTeamRuntimeDeps()
  const lifecycleDeps: Record<string, unknown> = {
    ...partial,
    triggeredFrom,
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

  // Fire-and-forget. The progress-runner owns IM fan-out; we swallow the
  // "already running" / lifecycle errors here (they surface via the run row /
  // notification path), never letting them reject the inbound dispatch.
  void Promise.resolve(runTeamLifecycle(teamId, lifecycleDeps)).catch(() => undefined)

  return { started: true }
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
