import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import type { ContextResource } from "@/types/context-workbench"

interface ResourceSessionRepository {
  get: (id: string) => Promise<ChatSession | undefined>
  findByBinding?: (binding: SessionSurfaceBinding) => Promise<ChatSession | undefined>
  put: (session: ChatSession) => Promise<void>
  update: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  now?: () => number
}

/**
 * Maps a workbench resource onto the persisted binding of its embedded chat
 * session.
 *
 * A `session` resource maps to a binding too: a conversation can own a
 * *sidechat*, an aside for checking something without spending turns in the
 * main thread. The aside is an ordinary `resource-workbench` row like every
 * other binding — it is the main session that is the "resource" here.
 *
 * A `resource-workbench` session is not itself bindable: letting an aside own
 * an aside would nest without limit, and there is no surface that would render
 * the second level anyway. Callers pass the resource, so the guard belongs
 * where the resource is built (`appliesTo`); this function only handles what it
 * is given.
 */
export function surfaceBindingForContextResource(
  resource: ContextResource
): SessionSurfaceBinding | null {
  switch (resource.kind) {
    case "canvas-document":
      return { kind: "canvas-document", documentId: resource.documentId }
    case "project-file":
      return {
        kind: "project-file",
        projectId: resource.projectId,
        rootId: resource.rootId,
        relPath: resource.relPath,
      }
    case "artifact":
      return { kind: "artifact", artifactId: resource.artifactId }
    case "workflow":
      return { kind: "workflow", workflowId: resource.workflowId }
    case "session":
      // "none" is the dock's placeholder while no conversation is open, and a
      // workbench session's own id carries this prefix — binding to the latter
      // would make an aside of an aside.
      return resource.sessionId === "none" || resource.sessionId.startsWith("resource-workbench:")
        ? null
        : { kind: "session", sessionId: resource.sessionId }
  }
}

function bindingParts(binding: SessionSurfaceBinding): string[] {
  switch (binding.kind) {
    case "canvas-document":
      return ["canvas", binding.documentId]
    case "project-file":
      return ["project", binding.projectId, binding.rootId, binding.relPath]
    case "artifact":
      return ["artifact", binding.artifactId]
    case "workflow":
      return ["workflow", binding.workflowId]
    case "session":
      return ["session", binding.sessionId]
  }
}

export function resourceWorkbenchSessionId(
  binding: SessionSurfaceBinding,
  _workbenchInstanceId?: string
): string {
  return `resource-workbench:${bindingParts(binding).map(encodeURIComponent).join(":")}`
}

export async function ensureResourceWorkbenchSession(
  binding: SessionSurfaceBinding,
  title: string,
  repository: ResourceSessionRepository,
  workbenchInstanceId?: string
): Promise<ChatSession> {
  const id = resourceWorkbenchSessionId(binding, workbenchInstanceId)
  const existing = (await repository.get(id)) ?? (await repository.findByBinding?.(binding))
  if (existing) {
    if (
      existing.kind !== "resource-workbench" ||
      existing.visibility !== "embedded" ||
      JSON.stringify(existing.surfaceBinding) !== JSON.stringify(binding)
    ) {
      const patch: Partial<ChatSession> = {
        kind: "resource-workbench",
        visibility: "embedded",
        surfaceBinding: binding,
        updatedAt: repository.now?.() ?? Date.now(),
      }
      await repository.update(existing.id, patch)
      return { ...existing, ...patch }
    }
    return existing
  }

  const now = repository.now?.() ?? Date.now()
  const session: ChatSession = {
    id,
    title,
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: binding,
    createdAt: now,
    updatedAt: now,
  }
  await repository.put(session)
  return session
}

export async function migrateResourceSessionBinding(
  sessionId: string,
  binding: SessionSurfaceBinding,
  repository: Pick<ResourceSessionRepository, "update" | "now">
): Promise<void> {
  await repository.update(sessionId, {
    surfaceBinding: binding,
    updatedAt: repository.now?.() ?? Date.now(),
  })
}
