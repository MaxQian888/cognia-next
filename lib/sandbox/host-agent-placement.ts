/**
 * Where an always-on Host starts an external agent for dispatched work
 * (ADR-0224 A8).
 *
 * The interactive lane resolves a project's runtime environment before it
 * connects an agent (`ensureExternalAgentReady`). Every other surface on a
 * headless Host calls this first, so the agent's process starts in the
 * project's runtime environment, or the deployment default when the project
 * selected none. Those surfaces are a phone turn on a Host agent, a scheduled
 * external-agent task, an external teammate, a delegation, and a plugin's
 * external subagent or agent call.
 *
 * - The project comes from the run (its session) or from the working
 *   directory it runs in.
 * - A project that opted out (`ProjectRuntimeSelection.hostProcess`) keeps
 *   the host path, inside the mandatory agent launcher sandbox. So does a run
 *   with no project, which has no workspace a container could mount. Both
 *   clear any stale placement, so an agent left in a container is restarted
 *   on the host.
 * - A refusal stops the run before any process starts.
 * - An agent already running somewhere other than where this run belongs is
 *   restarted where it belongs.
 */

import { isHeadlessHost } from "@/lib/platform/detect"
import type { ResolutionSurface } from "@/lib/project-environment/resolve-environment-spec"
import { allRootPaths } from "@/lib/workspace/roots"
import type { Project } from "@/types"

import type { PlacementProjectInput, SandboxPlacementOutcome } from "./environment-placement"
import { isPathUnderRoot } from "./policy-bridge"
import type { RunEnvironmentRequest, RunEnvironmentSources } from "./run-environment"

export interface HostAgentRunInput {
  agentId: string
  /** The run's project, when the surface knows it (its session's). */
  projectId?: string
  environmentId?: string
  /** Where the agent works; also how a project is found when none is given. */
  cwd?: string
  /**
   * A path inside the project, when `cwd` is not one: a task lease's working
   * copy lives outside the project it was taken from.
   */
  projectPath?: string
  /** Defaults to `unattended`: nobody is at the Host to approve a notice. */
  surface?: ResolutionSurface
}

export type HostAgentPlacement =
  /** Not an always-on Host: nothing was resolved or changed. */
  | { kind: "not-a-host" }
  /** The agent runs on the host path; any stale placement was cleared. */
  | { kind: "host-process"; reason: "opted-out" | "no-project" }
  | { kind: "resolved"; outcome: SandboxPlacementOutcome }

type HostProject = Pick<Project, "id" | "roots"> & { defaultEnvironmentId?: string }

export interface HostAgentPlacementSources {
  isHost(): boolean
  projects(): Promise<readonly HostProject[]>
  selection(projectId: string, environmentId?: string): Promise<PlacementProjectInput>
  runEnvironment(): Promise<RunEnvironmentSources>
  place(
    request: RunEnvironmentRequest,
    sources: RunEnvironmentSources
  ): Promise<SandboxPlacementOutcome>
  /** Forget any placement for the agent and record that it runs on the host. */
  runOnHost(agentId: string): Promise<void>
}

/** The project whose root holds `cwd` most closely. */
function projectForCwd(projects: readonly HostProject[], cwd: string): HostProject | undefined {
  let best: { project: HostProject; length: number } | undefined
  for (const project of projects) {
    for (const root of allRootPaths(project)) {
      if (isPathUnderRoot(cwd, root) && (!best || root.length > best.length)) {
        best = { project, length: root.length }
      }
    }
  }
  return best?.project
}

export async function placeHostAgentRun(
  input: HostAgentRunInput,
  sources: HostAgentPlacementSources = defaultHostAgentPlacementSources()
): Promise<HostAgentPlacement> {
  if (!sources.isHost()) return { kind: "not-a-host" }
  const projects = await sources.projects()
  const project = input.projectId
    ? projects.find((candidate) => candidate.id === input.projectId)
    : (input.projectPath ?? input.cwd)
      ? projectForCwd(projects, (input.projectPath ?? input.cwd)!)
      : undefined
  const projectId = project?.id ?? input.projectId
  if (!projectId) {
    await sources.runOnHost(input.agentId)
    return { kind: "host-process", reason: "no-project" }
  }
  const environmentId = input.environmentId ?? project?.defaultEnvironmentId
  // Unreadable is not an opt-out; placement reads it again and decides.
  const selected = await sources.selection(projectId, environmentId).catch(() => undefined)
  if (selected?.runtime?.hostProcess === true) {
    await sources.runOnHost(input.agentId)
    return { kind: "host-process", reason: "opted-out" }
  }
  const base = await sources.runEnvironment()
  const runEnvironment: RunEnvironmentSources = {
    ...base,
    selection: async (id, environment) => {
      const resolved = await base.selection(id, environment)
      // On an always-on Host a container is the default, not an opt-in.
      return resolved.runtime
        ? resolved
        : { ...resolved, runtime: { source: { kind: "auto" }, updatedAt: 0 } }
    },
  }
  const outcome = await sources.place(
    {
      agentId: input.agentId,
      projectId,
      ...(environmentId ? { environmentId } : {}),
      project: project ?? null,
      executionRoot: input.cwd,
      surface: input.surface ?? "unattended",
    },
    runEnvironment
  )
  return { kind: "resolved", outcome }
}

/** The parts of the external agent manager a placement restarts through. */
export interface HostAgentManager {
  getAgent(agentId: string): { connectionStatus?: string } | undefined
  reconnect(agentId: string): Promise<void>
}

/**
 * Place the run, refuse it when its environment is refused, and restart a
 * connected agent that is running somewhere else. A no-op off an always-on
 * Host.
 */
export async function ensureHostAgentPlacement(
  input: HostAgentRunInput,
  manager: HostAgentManager,
  sources?: HostAgentPlacementSources
): Promise<HostAgentPlacement> {
  const placement = await placeHostAgentRun(input, sources)
  if (placement.kind === "not-a-host") return placement
  const outcome: SandboxPlacementOutcome =
    placement.kind === "resolved" ? placement.outcome : { kind: "off" }
  const { agentNeedsRespawn, RunEnvironmentRefusedError } = await import("./run-environment")
  if (outcome.kind === "refused") {
    const message = await import("./environment-outcome-message")
      .then((module) => module.outcomeMessage(outcome))
      .catch(() => undefined)
    throw new RunEnvironmentRefusedError(outcome.code, message ?? outcome.code, outcome.detail)
  }
  if (
    manager.getAgent(input.agentId)?.connectionStatus === "connected" &&
    agentNeedsRespawn(input.agentId, outcome)
  ) {
    await manager.reconnect(input.agentId)
  }
  return placement
}

/**
 * {@link ensureHostAgentPlacement} for a dispatch site that knows only the
 * agent and where it works: a teammate, a delegation, a plugin's call. Off an
 * always-on Host it returns without loading anything.
 */
export async function placeDispatchedAgent(
  agentId: string,
  cwd: string | undefined,
  manager: HostAgentManager
): Promise<void> {
  if (!isHeadlessHost()) return
  await ensureHostAgentPlacement({ agentId, ...(cwd ? { cwd } : {}) }, manager)
}

/**
 * A workspace's directories on this host besides its own folders: the clone
 * of its repository when its folder is not here (ADR-0224 A11), and the
 * checkout a conversation handed to this host with its code works in (A11b).
 * A path in either belongs to the workspace, so a run there is placed by the
 * workspace's environment rather than run on the host as if it had none.
 */
export function withHostRoots<T extends HostProject>(
  projects: readonly T[],
  extraRoots: (projectId: string) => readonly string[]
): T[] {
  return projects.map((project) => {
    const known = new Set(project.roots.map((root) => root.path))
    const extra = [...new Set(extraRoots(project.id))].filter((path) => !known.has(path))
    if (extra.length === 0) return project
    return {
      ...project,
      roots: [
        ...project.roots,
        ...extra.map((path, index) => ({ id: `host-root-${index}`, path, isPrimary: false })),
      ],
    }
  })
}

export function defaultHostAgentPlacementSources(): HostAgentPlacementSources {
  return {
    isHost: isHeadlessHost,
    projects: async () => {
      const [{ useProjectStore }, { knownHostRoots }, { getDb }] = await Promise.all([
        import("@/stores/project/project-store"),
        import("@/lib/remote-host/code-supply/host-project-source"),
        import("@/lib/db/schema"),
      ])
      const projects = useProjectStore.getState().projects
      // Best-effort: a read that fails names no checkouts, and the clones
      // still count.
      const handedOver = await Promise.resolve()
        .then(() =>
          getDb()
            .sessions.where("projectId")
            .anyOf(projects.map((project) => project.id))
            .filter((session) => session.handoffSource === "thread-handoff" && !!session.workingDir)
            .toArray()
        )
        .catch(() => [])
      const checkouts = new Map<string, string[]>()
      for (const session of handedOver) {
        const list = checkouts.get(session.projectId!) ?? []
        list.push(session.workingDir!)
        checkouts.set(session.projectId!, list)
      }
      return withHostRoots(projects, (projectId) => [
        ...knownHostRoots(projectId),
        ...(checkouts.get(projectId) ?? []),
      ])
    },
    selection: async (projectId, environmentId) => {
      const { defaultRunEnvironmentSources } = await import("./run-environment")
      return defaultRunEnvironmentSources().selection(projectId, environmentId)
    },
    runEnvironment: async () => {
      const { defaultRunEnvironmentSources } = await import("./run-environment")
      return defaultRunEnvironmentSources()
    },
    place: async (request, runEnvironment) => {
      const { placeAgentRun } = await import("./run-environment")
      return placeAgentRun(request, runEnvironment)
    },
    runOnHost: async (agentId) => {
      const [{ recordRunEnvironmentOutcome }, { clearSpawnPlacement }] = await Promise.all([
        import("./run-environment"),
        import("./spawn-placement-registry"),
      ])
      clearSpawnPlacement(agentId)
      recordRunEnvironmentOutcome(agentId, { kind: "off" })
    },
  }
}
