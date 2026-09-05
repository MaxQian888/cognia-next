/**
 * One entry point for "refresh everything bound in this workspace".
 *
 * Two kinds of binding coexist (spec 2026-09-06, D1):
 *   - `github-repo` in `mirror` mode keeps the ADR-0132 read-only mirror,
 *     refreshed by `runWorkspaceGithubSync` exactly as before.
 *   - every other binding (`github-repo` in `import` mode, Lark tasklists and
 *     Bitables, plugin providers) goes through `reconcileBinding`.
 *
 * The toolbar button, the scheduler executor and the RPC all call this, so a
 * schedule can never drift from the manual path.
 */

import { listIssueProjects } from "@/lib/db/issue-projects"
import { runWorkspaceGithubSync, type RunWorkspaceGithubSyncResult } from "@/lib/issues/sync-runner"
import { reconcileBinding } from "./engine"
import { getIssueSyncRegistry, type IssueSyncRegistry } from "./registry"
import type { IssueSyncBinding, IssueSyncFailure, ReconcileOutcome } from "./types"

export interface RunWorkspaceIssueSyncInput {
  /** Workspace scope. Omit to sweep every workspace. */
  projectId?: string
  /** Only this provider's bindings (the mirror still runs unless `mirror: false`). */
  providerId?: string
  /** Skip the GitHub mirror refresh. */
  mirror?: boolean
  /** Ignore watermarks and read everything again. */
  full?: boolean
}

export interface RunWorkspaceIssueSyncResult {
  /** Mirror bindings plus provider bindings considered. Zero means nothing is bound. */
  bindingCount: number
  mirror: RunWorkspaceGithubSyncResult
  outcomes: ReconcileOutcome[]
  failures: IssueSyncFailure[]
}

export interface RunWorkspaceIssueSyncDeps {
  registry?: IssueSyncRegistry
  runMirror?: typeof runWorkspaceGithubSync
  reconcile?: typeof reconcileBinding
  listContainers?: typeof listIssueProjects
}

/** Every provider binding in scope, in provider registration order. */
export async function resolveWorkspaceSyncBindings(
  projectId?: string,
  registry: IssueSyncRegistry = getIssueSyncRegistry(),
  listContainers: typeof listIssueProjects = listIssueProjects
): Promise<IssueSyncBinding[]> {
  const containers = await listContainers(projectId === undefined ? {} : { projectId })
  return registry.list().flatMap((provider) => provider.resolveBindings(containers))
}

export async function runWorkspaceIssueSync(
  input: RunWorkspaceIssueSyncInput = {},
  deps: RunWorkspaceIssueSyncDeps = {}
): Promise<RunWorkspaceIssueSyncResult> {
  const registry = deps.registry ?? getIssueSyncRegistry()
  const runMirror = deps.runMirror ?? runWorkspaceGithubSync
  const reconcile = deps.reconcile ?? reconcileBinding

  const mirror =
    input.mirror === false
      ? { repoCount: 0, results: [], failures: [] }
      : await runMirror({
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.full ? { full: true } : {}),
        })

  const bindings = (
    await resolveWorkspaceSyncBindings(input.projectId, registry, deps.listContainers)
  ).filter((binding) => !input.providerId || binding.providerId === input.providerId)

  const outcomes: ReconcileOutcome[] = []
  const failures: IssueSyncFailure[] = []
  // Sequential on purpose: bindings of one provider share a credential and a
  // rate limit, and two bindings can write the same label catalogue.
  for (const binding of bindings) {
    const provider = registry.get(binding.providerId)
    if (!provider) continue
    try {
      outcomes.push(await reconcile(binding, provider, input.full ? { full: true } : {}))
    } catch (error) {
      failures.push({ binding, error })
    }
  }

  return { bindingCount: mirror.repoCount + bindings.length, mirror, outcomes, failures }
}
