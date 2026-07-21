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
 * session. Returns `null` for the `session` resource: it *is* a chat session
 * already, so it never owns a nested resource-workbench session and must not
 * be given a `SessionSurfaceBinding` (that type is a persisted Dexie column).
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
      return null
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
