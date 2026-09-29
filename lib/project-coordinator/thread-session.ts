import type { ChatSession, ProjectThreadState } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  createAttachedSession,
  defaultAttachedSessionDeps,
  type AttachedSessionDeps,
} from "@/lib/chat/attached-session"
import { startNewSession, type NewSessionInput } from "@/lib/chat/start-session"
import { thinkingLevelPatch } from "@/lib/ai/thinking-level"
import { gitIsRepo } from "@/lib/git/commands"
import { renderSpawnedTaskPrompt, type SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import {
  resolveCoordinatorConfig,
  resolveThreadExecutionLocation,
  resolveThreadRoot,
} from "./config"
import { projectAccess, type ProjectAccess } from "./project-access"

/**
 * A project thread (ADR-0204) is an attached child of the coordinator that is
 * also a first-class conversation: `kind: "direct"`, listed and searchable,
 * steerable by opening it, and — in a git workspace — isolated in its own
 * managed worktree on its own branch. The brief is the `spawn_task` brief, so
 * a thread and a sidechat task are written the same way.
 */

export interface CreateThreadInput {
  projectId: string
  coordinatorSessionId: string
  brief: SpawnedTaskBrief
  rootId?: string
  proposedBy: ProjectThreadState["proposedBy"]
}

export interface ThreadSessionDeps extends Pick<ProjectAccess, "getProject"> {
  attached: AttachedSessionDeps
  startNewSession: (input: NewSessionInput) => Promise<ChatSession>
  isGitRepo: (path: string) => Promise<boolean>
  gateBrief: (text: string) => boolean
  now: () => number
}

function defaultDeps(): ThreadSessionDeps {
  return {
    getProject: projectAccess.getProject,
    attached: defaultAttachedSessionDeps(),
    startNewSession,
    isGitRepo: gitIsRepo,
    gateBrief: hasNoLeakingPiiDeep,
    now: Date.now,
  }
}

const WORKTREE_SLUG_MAX = 40

/** A branch-safe, recognisable worktree name: `thread/<slug>-<suffix>`. */
export function threadWorktreeName(title: string, uniqueSuffix: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WORKTREE_SLUG_MAX)
    .replace(/-+$/g, "")
  const suffix = uniqueSuffix
    .replace(/[^a-z0-9]/gi, "")
    .slice(-6)
    .toLowerCase()
  return `thread/${slug || "task"}-${suffix || "0"}`
}

export class ThreadCreationError extends Error {
  constructor(
    readonly reason: "workspace-missing" | "coordinator-missing" | "pii",
    message: string
  ) {
    super(message)
    this.name = "ThreadCreationError"
  }
}

/** Create a staged thread; {@link startThread} (thread-runtime) submits it. */
export async function createThreadSession(
  input: CreateThreadInput,
  deps: ThreadSessionDeps = defaultDeps()
): Promise<ChatSession> {
  const project = deps.getProject(input.projectId)
  if (!project) {
    throw new ThreadCreationError("workspace-missing", `Workspace ${input.projectId} was not found`)
  }
  const coordinator = await deps.attached.getSession(input.coordinatorSessionId)
  if (coordinator?.projectRole !== "coordinator" || coordinator.projectId !== input.projectId) {
    throw new ThreadCreationError(
      "coordinator-missing",
      `Session ${input.coordinatorSessionId} is not this workspace's coordinator`
    )
  }

  const prompt = renderSpawnedTaskPrompt(input.brief)
  // Same outbound gate as every other agent-authored hand-off: the brief is
  // model output about to become another run's prompt.
  if (!deps.gateBrief(prompt)) {
    throw new ThreadCreationError("pii", "The thread brief was blocked by the PII redaction gate")
  }

  const config = resolveCoordinatorConfig(project)
  const root = resolveThreadRoot(project, input.rootId)
  const location = await resolveThreadExecutionLocation(project, root?.id, deps)
  const createdAt = deps.now()
  const model = config.model.threads

  const projectThread: ProjectThreadState = {
    coordinatorSessionId: coordinator.id,
    brief: prompt,
    ...(root && input.rootId ? { rootId: root.id } : {}),
    proposedBy: input.proposedBy,
  }

  return createAttachedSession(
    {
      parentSessionId: coordinator.id,
      title: input.brief.title,
      prompt,
      context: { mode: "none" },
      workspace: "independent",
      extra: {
        projectRole: "thread",
        projectThread,
        titleAuto: false,
        ...(model?.effort ? thinkingLevelPatch(model.effort) : {}),
        ...(model?.modelId && model.providerId ? { providerOverride: model.providerId } : {}),
      },
    },
    {
      ...deps.attached,
      createChild: () =>
        deps.startNewSession({
          projectId: input.projectId,
          title: input.brief.title,
          activate: false,
          rememberChoice: false,
          executionLocation: location,
          ...(location === "managedWorktree"
            ? {
                executionBase: { kind: "localHead" as const },
                worktreeName: threadWorktreeName(input.brief.title, createdAt.toString(36)),
              }
            : {}),
          ...(root ? { rootId: root.id } : {}),
          ...(model?.modelId ? { model: model.modelId } : {}),
        }),
    }
  )
}
