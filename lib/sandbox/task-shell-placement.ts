/**
 * Where a session's `container` shell tier runs (ADR-0224 A8): the runtime
 * environment its project resolves to, through the same resolution an
 * external agent's spawn goes through (`prepareRunEnvironment`).
 *
 * The difference from a spawn is the opt-in. A spawn with no runtime selection
 * is `off` and runs on the existing path. A session bound to the container tier
 * has already asked to leave the Host, so a project without a selection gets
 * the deployment's default environment (`source: auto`) rather than nothing,
 * and anything short of a placement refuses: there is no host path to fall
 * back to.
 *
 * The surface is `unattended` on purpose. The container tier runs on an
 * always-on Host, where a turn is mostly a Bot or a scheduled task, and an
 * unattended resolution refuses an unapproved repository declaration instead
 * of quietly running the deployment default in its place.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { SandboxRuntimeError } from "@cognia/plugin-sdk/api/sandbox"
import { isHeadlessHost } from "@/lib/platform/detect"
import { isSessionScratchWorkspace } from "@/lib/task-workspace/managed-workspace"
import type { Project } from "@/types"
import type { SandboxPlacement } from "@/types/sandbox/environment-spec"

import type { SandboxPlacementOutcome } from "./environment-placement"
import type { RunEnvironmentRequest, RunEnvironmentSources } from "./run-environment"

export interface TaskShellPlacementInput {
  sessionId: string
  /** The session's working directory: the workspace the runtime mounts. */
  workspaceRoot: string
}

export interface TaskShellPlacementSources {
  session(
    sessionId: string
  ): Promise<Pick<ChatSession, "projectId" | "executionContext"> | undefined>
  project(projectId: string): Promise<Pick<Project, "roots"> | undefined>
  prepare(
    request: RunEnvironmentRequest,
    sources: RunEnvironmentSources
  ): Promise<SandboxPlacementOutcome>
  runEnvironment(): Promise<RunEnvironmentSources>
  /** The words for a refused or fallen-back outcome, when there are any. */
  describe(outcome: SandboxPlacementOutcome): Promise<string | undefined>
}

function refused(message: string): SandboxRuntimeError {
  return new SandboxRuntimeError("placement-unavailable", message)
}

/** Resolve the placement, or refuse with the reason a user can act on. */
export async function resolveTaskShellPlacement(
  input: TaskShellPlacementInput,
  sources: TaskShellPlacementSources
): Promise<SandboxPlacement> {
  const session = await sources.session(input.sessionId)
  const scratch = isHeadlessHost() && isSessionScratchWorkspace({ ...session, id: input.sessionId })
  const projectId = session?.executionContext?.projectId || session?.projectId
  if (!projectId) {
    throw refused(
      "The container shell tier runs in a project's runtime environment, and this session belongs to no project."
    )
  }
  const project = scratch ? null : await sources.project(projectId)
  const base = await sources.runEnvironment()
  const runEnvironment: RunEnvironmentSources = scratch
    ? {
        ...base,
        // A scratch has no project configuration. Its files cannot select an image,
        // setup command or approval from Default (or from a previous turn's output).
        selection: async () => ({
          runtime: { source: { kind: "auto" }, isolationMinimum: "container", updatedAt: 0 },
          policy: undefined,
        }),
        declarationFiles: async () => ({ files: [], searched: [] }),
        workspaceConfig: async () => ({ kind: "absent" }),
        restricted: async () => false,
        serverApprovals: async () => [],
        deviceApproval: async () => undefined,
      }
    : {
        ...base,
        selection: async (id, environmentId) => {
          const selected = await base.selection(id, environmentId)
          // Choosing the tier is the opt-in a spawn gets from the selection.
          return selected.runtime
            ? selected
            : { ...selected, runtime: { source: { kind: "auto" }, updatedAt: 0 } }
        },
      }
  const environmentId = scratch ? undefined : session?.executionContext?.environmentId
  const outcome = await sources.prepare(
    {
      agentId: `task-shell:${input.sessionId}`,
      projectId,
      ...(environmentId ? { environmentId } : {}),
      project: project ?? null,
      executionRoot: input.workspaceRoot,
      surface: "unattended",
    },
    runEnvironment
  )
  if (outcome.kind === "placed") return outcome.placement
  const detail = (await sources.describe(outcome).catch(() => undefined)) ?? outcomeCode(outcome)
  throw refused(
    `The container shell tier could not be placed in this project's runtime environment, and will not run on this machine instead: ${detail}`
  )
}

function outcomeCode(outcome: SandboxPlacementOutcome): string {
  return outcome.kind === "refused" || outcome.kind === "fallback" ? outcome.code : outcome.kind
}

/** The real sources; every import is dynamic so a non-container bind loads none. */
export function defaultTaskShellPlacementSources(): TaskShellPlacementSources {
  return {
    session: async (sessionId) => {
      const { getSession } = await import("@/lib/db/sessions")
      return getSession(sessionId)
    },
    project: async (projectId) => {
      const { useProjectStore } = await import("@/stores/project/project-store")
      return useProjectStore.getState().projects.find((project) => project.id === projectId)
    },
    prepare: async (request, runEnvironment) => {
      const { prepareRunEnvironment } = await import("./run-environment")
      return prepareRunEnvironment(request, runEnvironment)
    },
    runEnvironment: async () => {
      const { defaultRunEnvironmentSources } = await import("./run-environment")
      return defaultRunEnvironmentSources()
    },
    describe: async (outcome) => {
      const { outcomeMessage } = await import("./environment-outcome-message")
      return outcomeMessage(outcome)
    },
  }
}
