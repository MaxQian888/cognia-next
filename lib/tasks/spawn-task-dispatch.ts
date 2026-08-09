import type { UIMessage } from "ai"
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { renderBranchSeed } from "@/lib/chat/branch-session"
import {
  createResourceWorkbenchSession,
  deleteResourceWorkbenchSession,
} from "@/lib/db/resource-workbench-sessions"
import { listMessages } from "@/lib/db/messages"
import { getSession, updateSession } from "@/lib/db/sessions"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import {
  renderSpawnedTaskPrompt,
  spawnTaskModelReply,
  type SpawnedTaskBrief,
} from "./spawn-task-core"

export interface SpawnTaskDispatchDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  createAside: (binding: SessionSurfaceBinding, title: string) => Promise<ChatSession>
  deleteAside: (sessionId: string) => Promise<void>
  listMessages: (sessionId: string) => Promise<UIMessage[]>
  updateSession: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  gateInheritedContent: (content: string) => boolean
}

export interface SpawnTaskRevealDeps {
  clearArtifact: (parentSessionId: string) => void
  selectAside: (resourceKey: string, taskSessionId: string) => void
  revealSidechat: () => void
}

function defaultDispatchDeps(): SpawnTaskDispatchDeps {
  return {
    getSession,
    createAside: createResourceWorkbenchSession,
    deleteAside: deleteResourceWorkbenchSession,
    listMessages,
    updateSession,
    gateInheritedContent: hasNoLeakingPiiDeep,
  }
}

function defaultRevealDeps(): SpawnTaskRevealDeps {
  return {
    clearArtifact: (parentSessionId) =>
      useArtifactStore.getState().setActiveArtifact(null, parentSessionId),
    selectAside: (resourceKey, taskSessionId) =>
      useContextWorkbenchStore.getState().setSessionOverride(resourceKey, taskSessionId),
    revealSidechat: () => useArtifactDockLayoutStore.getState().revealSidechat(),
  }
}

export async function dispatchSpawnTask(
  parentSessionId: string,
  brief: SpawnedTaskBrief,
  deps: SpawnTaskDispatchDeps = defaultDispatchDeps()
) {
  const parent = await deps.getSession(parentSessionId)
  if (!parent) throw new Error(`Parent session ${parentSessionId} was not found`)
  if (parent.kind === "resource-workbench") {
    throw new Error("A resource workbench session cannot spawn another task")
  }

  let inheritedTranscript: string | undefined
  if (brief.mode === "inherit") {
    const { content } = renderBranchSeed(await deps.listMessages(parentSessionId))
    if (content && !deps.gateInheritedContent(content)) {
      throw new Error("The inherited task context was blocked by the PII redaction gate")
    }
    inheritedTranscript = content || undefined
  }

  const binding: SessionSurfaceBinding = { kind: "session", sessionId: parentSessionId }
  const task = await deps.createAside(binding, brief.title)
  try {
    if ((await deps.listMessages(task.id)).length > 0) {
      throw new Error("The new task session is not empty")
    }

    const patch: Partial<ChatSession> = {
      spawnedTask: {
        mode: brief.mode,
        pendingPrompt: renderSpawnedTaskPrompt(brief),
      },
    }
    if (brief.mode === "inherit") {
      if (parent.sdkSessionId) {
        patch.forkedFromSdkSessionId = parent.sdkSessionId
      } else if (inheritedTranscript) {
        patch.branchSeed = { kind: "transcript", content: inheritedTranscript }
      }
    }
    await deps.updateSession(task.id, patch)
  } catch (error) {
    try {
      await deps.deleteAside(task.id)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Failed to stage the spawned task and roll back its sidechat"
      )
    }
    throw error
  }

  return spawnTaskModelReply({ taskSessionId: task.id, brief })
}

export function revealSpawnedTask(
  parentSessionId: string,
  taskSessionId: string,
  deps: SpawnTaskRevealDeps = defaultRevealDeps()
): void {
  deps.clearArtifact(parentSessionId)
  deps.selectAside(`session:${parentSessionId}`, taskSessionId)
  deps.revealSidechat()
}
