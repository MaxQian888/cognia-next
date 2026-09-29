import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import {
  buildProjectCoordinatorManifestEntries,
  buildProjectThreadManifestEntries,
  type ProjectCoordinatorManifestEntry,
} from "@/lib/claude/project-coordinator-builtin-tools"
import { useChatStore } from "@/stores/chat"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import { projectRoleToolsApply, resolveCoordinatorConfig } from "./config"
import { buildCoordinatorContextSection, type DigestThreadInput } from "./digest"
import { PROJECT_COORDINATOR_PROTOCOL, PROJECT_THREAD_PROTOCOL } from "./protocol"
import { listProjectThreads } from "./thread-runtime"
import { updateCoordinator } from "./project-access"
import { buildSetupRecommendationsSection, shouldOfferSetup } from "./setup-recommendations"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask } from "@/types/scheduler"
import { listSessionPrObservationsByProject } from "@/lib/db/session-pr-observations"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"

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
  prStatuses: (projectId: string) => Promise<ReadonlyMap<string, PrDerivedStatus>>
  threadInput: (thread: ChatSession) => Omit<DigestThreadInput, "pr">
  now: () => number
  listSchedules: (projectId: string) => Promise<ScheduledTask[]>
  markSetupOffered: (projectId: string, at: number) => void
}

function defaultDeps(): SendExtrasDeps {
  return {
    listThreads: listProjectThreads,
    prStatuses: async (projectId) =>
      new Map(
        (await listSessionPrObservationsByProject(projectId)).map(
          (row) => [row.sessionId, row.derivedStatus] as const
        )
      ),
    threadInput: (thread) => ({
      thread,
      status: sessionStatusOf(thread.id),
      pendingApprovals: useChatStore.getState().sessions[thread.id]?.pendingApprovals.length ?? 0,
    }),
    now: Date.now,
    listSchedules: (projectId) => schedulerDb.getTasksByProject(projectId),
    markSetupOffered: (projectId, at) => {
      updateCoordinator(projectId, { setupOfferedAt: at })
    },
  }
}

export async function resolveProjectRoleSendExtras(
  session: Pick<ChatSession, "id" | "projectRole" | "projectId">,
  project: Pick<Project, "coordinator"> & Partial<Pick<Project, "roots">>,
  deps: SendExtrasDeps = defaultDeps()
): Promise<ProjectRoleSendExtras | undefined> {
  if (!projectRoleToolsApply(session, project)) return undefined
  if (session.projectRole === "thread") {
    return { pluginTools: buildProjectThreadManifestEntries(), protocol: PROJECT_THREAD_PROTOCOL }
  }
  const [threads, prStatuses] = await Promise.all([
    deps.listThreads(session.id),
    session.projectId ? deps.prStatuses(session.projectId) : new Map<string, PrDerivedStatus>(),
  ])
  const status = buildCoordinatorContextSection(
    project,
    threads.map((thread) => ({ ...deps.threadInput(thread), pr: prStatuses.get(thread.id) })),
    deps.now()
  )
  const setup = await setupSection(session.projectId, project, threads.length, deps)
  return {
    pluginTools: buildProjectCoordinatorManifestEntries(),
    protocol: PROJECT_COORDINATOR_PROTOCOL,
    dynamicSection: setup ? `${status}\n\n${setup}` : status,
  }
}

/** The one-off setup offer, recorded as offered the moment it is included. */
async function setupSection(
  projectId: string | undefined,
  project: Pick<Project, "coordinator"> & Partial<Pick<Project, "roots">>,
  threadCount: number,
  deps: SendExtrasDeps
): Promise<string | undefined> {
  const { setupOfferedAt } = resolveCoordinatorConfig(project)
  if (!projectId || !shouldOfferSetup({ setupOfferedAt, threadCount })) return undefined
  // A schedule read that fails leaves the list out; the offer stands.
  const schedules = await deps.listSchedules(projectId).catch(() => [])
  deps.markSetupOffered(projectId, deps.now())
  return buildSetupRecommendationsSection({ project, schedules })
}
