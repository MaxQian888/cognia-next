import type { ChatSession } from "@cognia/agent-config-types"
import { getSession, listWorkspaceSessions, updateSession } from "@/lib/db/sessions"
import { startNewSession, type NewSessionInput } from "@/lib/chat/start-session"
import { thinkingLevelPatch } from "@/lib/ai/thinking-level"
import { resolveCoordinatorConfig } from "./config"
import { projectAccess, type ProjectAccess } from "./project-access"

/**
 * The workspace's coordinator conversation (ADR-0204): one per workspace,
 * created on first use, found again through the pointer on the workspace row
 * and — should that pointer be lost — by its role.
 */

export interface CoordinatorSessionDeps extends ProjectAccess {
  getSession: (id: string) => Promise<ChatSession | undefined>
  listWorkspaceSessions: (projectId: string) => Promise<ChatSession[]>
  startNewSession: (input: NewSessionInput) => Promise<ChatSession>
  updateSession: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
}

function defaultDeps(): CoordinatorSessionDeps {
  return {
    ...projectAccess,
    getSession,
    listWorkspaceSessions,
    startNewSession,
    updateSession,
  }
}

function isLiveCoordinator(session: ChatSession, projectId: string): boolean {
  return (
    session.projectRole === "coordinator" &&
    session.projectId === projectId &&
    session.archivedAt === undefined &&
    session.importTombstonedAt === undefined
  )
}

export interface EnsureCoordinatorInput {
  projectId: string
  /** Shown in the conversation list; the caller localises it. */
  title: string
  /** Move the UI to the coordinator. Default false — opening is a separate act. */
  activate?: boolean
}

const inFlight = new Map<string, Promise<ChatSession>>()

/**
 * Return the workspace's coordinator conversation, creating it if needed.
 * Idempotent, and concurrent calls for one workspace share a single creation.
 */
export function ensureCoordinatorSession(
  input: EnsureCoordinatorInput,
  deps: CoordinatorSessionDeps = defaultDeps()
): Promise<ChatSession> {
  const pending = inFlight.get(input.projectId)
  if (pending) return pending
  const run = resolveOrCreateCoordinator(input, deps).finally(() => {
    inFlight.delete(input.projectId)
  })
  inFlight.set(input.projectId, run)
  return run
}

async function resolveOrCreateCoordinator(
  input: EnsureCoordinatorInput,
  deps: CoordinatorSessionDeps
): Promise<ChatSession> {
  const project = deps.getProject(input.projectId)
  if (!project) throw new Error(`Workspace ${input.projectId} was not found`)
  const config = resolveCoordinatorConfig(project)

  if (config.sessionId) {
    const pointed = await deps.getSession(config.sessionId)
    if (pointed && isLiveCoordinator(pointed, input.projectId)) return pointed
  }

  // The pointer is missing or stale (row deleted, pointer never written after
  // a crash). A coordinator found by role wins over creating a second one.
  const byRole = (await deps.listWorkspaceSessions(input.projectId)).find((session) =>
    isLiveCoordinator(session, input.projectId)
  )
  if (byRole) {
    deps.updateCoordinator(input.projectId, { sessionId: byRole.id })
    return byRole
  }

  const model = config.model.coordinator
  const created = await deps.startNewSession({
    projectId: input.projectId,
    title: input.title,
    executionLocation: "local",
    rememberChoice: false,
    activate: input.activate ?? false,
    ...(model?.modelId ? { model: model.modelId } : {}),
  })
  const patch: Partial<ChatSession> = {
    projectRole: "coordinator",
    titleAuto: false,
    ...(model?.effort ? thinkingLevelPatch(model.effort) : {}),
  }
  await deps.updateSession(created.id, patch)
  deps.updateCoordinator(input.projectId, { sessionId: created.id })
  return { ...created, ...patch }
}

/** The coordinator conversation of a workspace, if one exists — never creates. */
export async function findCoordinatorSession(
  projectId: string,
  deps: Pick<CoordinatorSessionDeps, "getProject" | "getSession"> = defaultDeps()
): Promise<ChatSession | undefined> {
  const sessionId = resolveCoordinatorConfig(deps.getProject(projectId)).sessionId
  if (!sessionId) return undefined
  const session = await deps.getSession(sessionId)
  return session && isLiveCoordinator(session, projectId) ? session : undefined
}
