/**
 * Where a workspace's work runs on an always-on host (ADR-0224 A11).
 *
 * A workspace names folders on the device that created it. When the host has
 * none of them, its work runs in a clone of the workspace's repository
 * (`Project.repository`) instead, supplied by the host itself
 * (`task_workspace_project_source_ensure`): a fresh clone through the shared
 * mirror cache with the git credential a paired device stored for that git
 * host. Every surface that turns a workspace into a working directory on the
 * host asks here:
 *
 * - a built-in turn (`resolveSendOptions`) and a dispatched child
 *   (`resolveSessionCwd`),
 * - a phone turn on an external agent (`remote-run-service`),
 * - a scheduled external-agent task (its `payload.cwd`),
 * - host agent placement, which matches a working directory back to its
 *   workspace through {@link knownHostRoots}.
 *
 * A path inside the workspace's primary folder maps to the same path inside
 * the clone, so a task set to run in `app/web` still does. A directory that
 * belongs to no workspace folder is left as it is. Off a host, or for a
 * workspace with neither a folder here nor a repository, nothing changes;
 * a workspace whose folder is missing and whose repository cannot be
 * supplied is an error, never a silent fall back to another directory.
 *
 * Answers are remembered for a few minutes per workspace, so a burst of
 * turns does not fetch the repository once each; the clone itself is brought
 * up to date by the task workspace each run starts from.
 */

import { isHeadlessHost } from "@/lib/platform/detect"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import type { ProjectSource } from "@/lib/task-workspace/types"
import { allRootPaths } from "@/lib/workspace/roots"
import type { Project } from "@/types"

/** How long one answer is reused for a workspace. */
export const HOST_PROJECT_SOURCE_TTL_MS = 5 * 60 * 1000

export type HostProject = Pick<Project, "id" | "roots" | "repository">

export interface HostProjectSourceDeps {
  isHost(): boolean
  ensure(input: { roots: string[]; remoteUrl?: string | null }): Promise<ProjectSource>
  now(): number
}

/** A workspace the host has no folder or clone for. */
export class HostProjectSourceError extends Error {
  readonly code = "host_project_source_unavailable"
  constructor(
    readonly projectId: string,
    cause: string
  ) {
    super(`This host cannot reach workspace ${projectId}'s files: ${cause}`)
    this.name = "HostProjectSourceError"
  }
}

interface Remembered {
  key: string
  at: number
  source: ProjectSource
}

const remembered = new Map<string, Remembered>()
const pending = new Map<string, Promise<ProjectSource>>()

function keyOf(project: HostProject, roots: readonly string[]): string {
  return JSON.stringify([roots, project.repository?.remoteUrl ?? null])
}

/**
 * The workspace's directory on this host, or `null` off a host and for a
 * workspace with neither folders nor a repository.
 */
export async function resolveHostProjectSource(
  project: HostProject,
  deps: HostProjectSourceDeps = defaultHostProjectSourceDeps()
): Promise<ProjectSource | null> {
  if (!deps.isHost()) return null
  const roots = allRootPaths(project)
  const remoteUrl = project.repository?.remoteUrl ?? null
  if (roots.length === 0 && !remoteUrl) return null
  const key = keyOf(project, roots)
  const now = deps.now()
  const known = remembered.get(project.id)
  if (known && known.key === key && now - known.at < HOST_PROJECT_SOURCE_TTL_MS) {
    return known.source
  }
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const request = deps
    .ensure({ roots, remoteUrl })
    .then((source) => {
      remembered.set(project.id, { key, at: deps.now(), source })
      return source
    })
    .catch((error: unknown) => {
      throw new HostProjectSourceError(
        project.id,
        error instanceof Error ? error.message : String(error)
      )
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

/** Clone roots already resolved for a workspace, for matching a path back to it. */
export function knownHostRoots(projectId: string): string[] {
  const known = remembered.get(projectId)
  return known && known.source.source === "clone" ? [known.source.root] : []
}

/** `cwd` under `from`, moved under `to`. */
function rebase(cwd: string, from: string, to: string): string {
  const suffix = cwd.replace(/[\\/]+$/, "").slice(from.replace(/[\\/]+$/, "").length)
  const trimmed = suffix.replace(/^[\\/]+/, "")
  return trimmed ? `${to.replace(/[\\/]+$/, "")}/${trimmed}` : to
}

/**
 * Where work that would run in `cwd` for `project` runs on this host: `cwd`
 * itself off a host, outside the workspace, or when the workspace's folder is
 * here; the matching path in its clone otherwise; the clone (or the folder
 * that exists) when no directory was given.
 */
export async function hostWorkingDirectory(
  input: { cwd?: string | null; project?: HostProject | null },
  deps: HostProjectSourceDeps = defaultHostProjectSourceDeps()
): Promise<string | undefined> {
  const cwd = input.cwd?.trim() || undefined
  const project = input.project
  if (!project || !deps.isHost()) return cwd
  const roots = allRootPaths(project)
  if (cwd && !roots.some((root) => isPathUnderRoot(cwd, root))) return cwd
  const source = await resolveHostProjectSource(project, deps)
  if (!source) return cwd
  if (source.source === "local") {
    return cwd && isPathUnderRoot(cwd, source.root) ? cwd : source.root
  }
  if (cwd && source.standsFor && isPathUnderRoot(cwd, source.standsFor)) {
    return rebase(cwd, source.standsFor, source.root)
  }
  return source.root
}

/** Forget every remembered answer (tests). */
export function resetHostProjectSources(): void {
  remembered.clear()
  pending.clear()
}

export function defaultHostProjectSourceDeps(): HostProjectSourceDeps {
  return {
    isHost: isHeadlessHost,
    ensure: async (input) => {
      const { ensureProjectWorkspaceSource } = await import("@/lib/task-workspace/client")
      return ensureProjectWorkspaceSource(input)
    },
    now: () => Date.now(),
  }
}
