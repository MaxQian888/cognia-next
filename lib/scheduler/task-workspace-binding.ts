/**
 * Which workspace a scheduled task belongs to.
 *
 * The scheduler keeps its own Dexie instance (`SchedulerDatabase`), so
 * `ScheduledTask.projectId` is a SOFT foreign key — nothing enforces it, and
 * nothing in this module may hold a static import of the main database. Both
 * lookups are lazy for that reason, and both fail to `null` rather than
 * throwing: a schedule that cannot be attributed is still a schedule, and
 * refusing to create it would be a far worse outcome than an unattributed row.
 *
 * Precedence is the same one the send path uses: the CONVERSATION's workspace
 * outranks the UI pointer. An agent that schedules a follow-up while the user
 * is looking at another repository must bind the schedule to the repository it
 * is working in, not to whatever is on screen at that instant.
 *
 * A Squad sits between the two. An `agent-team` task names the Squad it will
 * run, and a Squad names its own workspace (`AgentTeam.projectId`, stamped at
 * creation and purged per project), so a schedule pointed at a Squad in
 * workspace A while the user is looking at workspace B belongs to A. It ranks
 * below the conversation for the same reason the conversation outranks the UI:
 * the more specific statement of intent wins.
 *
 * Both lookups are also TIME-BOUNDED. Creating a task previously touched only
 * the scheduler's own database; making it wait on the main one would let a slow
 * or absent main database (a headless runner, a shell where it was never
 * opened) block task creation entirely. Attribution is worth waiting a moment
 * for and is not worth failing over.
 */

import type { CreateScheduledTaskInput, ScheduledTask } from "@/types/scheduler"

export interface TaskWorkspaceDeps {
  /** The workspace a conversation belongs to. */
  sessionWorkspace?: (sessionId: string) => Promise<string | null | undefined>
  /** The workspace a Squad belongs to. */
  squadWorkspace?: (squadId: string) => Promise<string | null | undefined>
  /** The workspace the user is in, falling back to Default. */
  activeWorkspace?: () => Promise<string | null | undefined>
  /** How long either lookup may take before the row is left unattributed. */
  timeoutMs?: number
}

/** Default budget for reading the main database during task creation. */
export const WORKSPACE_LOOKUP_TIMEOUT_MS = 1_500

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function defaultSessionWorkspace(sessionId: string): Promise<string | null | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  return (await getDb().sessions.get(sessionId))?.projectId
}

async function defaultSquadWorkspace(squadId: string): Promise<string | null | undefined> {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return useAgentTeamStore.getState().teams[squadId]?.projectId
}

async function defaultActiveWorkspace(): Promise<string | null | undefined> {
  const { resolveScopeProjectId } = await import("@/lib/db/project-scope")
  return resolveScopeProjectId()
}

/**
 * Resolve the owning workspace for a task about to be created.
 *
 * Explicit input wins, then the creating conversation, then the active
 * workspace. `null` only when every source is unavailable.
 */
export async function resolveTaskWorkspace(
  input: Pick<CreateScheduledTaskInput, "projectId" | "createdBy" | "type" | "payload">,
  deps: TaskWorkspaceDeps = {}
): Promise<string | undefined> {
  if (input.projectId) return input.projectId
  const budget = deps.timeoutMs ?? WORKSPACE_LOOKUP_TIMEOUT_MS

  const sessionId = input.createdBy?.sessionId
  if (sessionId) {
    const fromSession = await within(
      Promise.resolve().then(() => (deps.sessionWorkspace ?? defaultSessionWorkspace)(sessionId)),
      budget
    )
    if (fromSession) return fromSession
  }

  // The Squad the task will run. Read only for an `agent-team` task, so no
  // other task type pays for loading the store.
  const squadId =
    input.type === "agent-team" &&
    typeof (input.payload as { teamId?: unknown })?.teamId === "string"
      ? (input.payload as { teamId: string }).teamId
      : undefined
  if (squadId) {
    const fromSquad = await within(
      Promise.resolve().then(() => (deps.squadWorkspace ?? defaultSquadWorkspace)(squadId)),
      budget
    )
    if (fromSquad) return fromSquad
  }

  const active = await within(
    Promise.resolve().then(() => (deps.activeWorkspace ?? defaultActiveWorkspace)()),
    budget
  )
  return active ?? undefined
}

/**
 * Whether a task should be listed while looking at `projectId`.
 *
 * An UNATTRIBUTED task (no workspace — a row written before scheduler v5 whose
 * creator named no session) shows everywhere. It is unattributed, not foreign,
 * and hiding it would make it invisible in every workspace at once, which is
 * how a schedule silently stops being maintained.
 */
export function taskVisibleInWorkspace(
  task: Pick<ScheduledTask, "projectId">,
  projectId: string | null | undefined
): boolean {
  if (!projectId) return true
  return !task.projectId || task.projectId === projectId
}

/**
 * Which workspace id, if any, may scope a list of schedules.
 *
 * Workspace ids are LOCAL. `projects` is absent from `COMPANION_SYNC_TABLES`
 * and `activeProjectId` is categorised `desktop-only` in the settings-sync
 * map, so this device's active workspace names nothing on a paired host.
 *
 * Both scheduler pages used to pass the local id unconditionally. Against a
 * paired host that compared a local id with the host's own bindings and
 * matched none of them, so every attributed schedule over there was filtered
 * out of a list that still counted it. Returning null there means "show the
 * host's schedules unscoped", which is the only honest answer until workspace
 * identity crosses the pairing boundary.
 */
export function workspaceScopeForSchedulerHost(
  hostTarget: "local" | "paired",
  localProjectId: string | null | undefined
): string | undefined {
  if (hostTarget !== "local") return undefined
  return localProjectId ?? undefined
}

/**
 * The session-workspace reader the boot backfill uses.
 *
 * Named separately from the private default so the scheduler can hand it to
 * `SchedulerDatabase.backfillTaskWorkspaces` without that module importing the
 * main database itself — the soft foreign key stays soft.
 */
export async function backfillSessionWorkspace(
  sessionId: string
): Promise<string | null | undefined> {
  return defaultSessionWorkspace(sessionId)
}
