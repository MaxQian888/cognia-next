import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import {
  buildProjectCoordinatorManifestEntries,
  buildProjectThreadManifestEntries,
  type ProjectCoordinatorManifestEntry,
} from "@/lib/claude/project-coordinator-builtin-tools"
import { useChatStore } from "@/stores/chat"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import { projectRoleToolsApply } from "./config"
import { buildCoordinatorContextSection, type DigestThreadInput } from "./digest"
import { PROJECT_COORDINATOR_PROTOCOL, PROJECT_THREAD_PROTOCOL } from "./protocol"
import { defaultThreadRuntimeDeps } from "./thread-runtime"

/**
 * What a coordinator or thread turn adds to its send options (ADR-0204) —
 * tools, a session-stable protocol, and (coordinator only) the per-turn
 * project status. One entry point so `resolveSendOptions` carries a single
 * gated block instead of the feature's details.
 */

export interface ProjectRoleSendExtras {
  pluginTools: ProjectCoordinatorManifestEntry[]
  /** Session-stable: safe in the cached prompt prefix. */
  protocol: string
  /** Changes every turn: belongs in the dynamic tail. */
  dynamicSection?: string
}

export interface SendExtrasDeps {
  listThreads: (coordinatorSessionId: string) => Promise<ChatSession[]>
  threadInput: (thread: ChatSession) => DigestThreadInput
  now: () => number
}

function defaultDeps(): SendExtrasDeps {
  return {
    listThreads: defaultThreadRuntimeDeps().listThreads,
    threadInput: (thread) => ({
      thread,
      status: sessionStatusOf(thread.id),
      pendingApprovals: useChatStore.getState().sessions[thread.id]?.pendingApprovals.length ?? 0,
    }),
    now: Date.now,
  }
}

export async function resolveProjectRoleSendExtras(
  session: Pick<ChatSession, "id" | "projectRole">,
  project: Pick<Project, "coordinator">,
  deps: SendExtrasDeps = defaultDeps()
): Promise<ProjectRoleSendExtras | undefined> {
  if (!projectRoleToolsApply(session, project)) return undefined
  if (session.projectRole === "thread") {
    return { pluginTools: buildProjectThreadManifestEntries(), protocol: PROJECT_THREAD_PROTOCOL }
  }
  const threads = await deps.listThreads(session.id)
  return {
    pluginTools: buildProjectCoordinatorManifestEntries(),
    protocol: PROJECT_COORDINATOR_PROTOCOL,
    dynamicSection: buildCoordinatorContextSection(
      project,
      threads.map(deps.threadInput),
      deps.now()
    ),
  }
}
