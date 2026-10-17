import type { BestOfNGroup } from "@/types/best-of-n"
import type { AgentChangeset } from "@/lib/scm/types"
import type { ScmHost } from "@/lib/scm/host"
import { createScmRuntime } from "@/lib/scm/runtime"
import { acquireWorkspaceBundle, archiveManagedWorkspace } from "@/lib/task-workspace/client"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"

/** Capture refs can differ from the agent's working tree. Verify a fresh checkout
 * of the recorded commit, never relabel the mutable candidate directory as it. */
export async function checkBestOfNHead(
  group: BestOfNGroup,
  changeset: AgentChangeset,
  projectId: string | null,
  host: ScmHost,
  signal: AbortSignal
) {
  signal.throwIfAborted()
  const bundle = await runWorkspaceUserAction("task_workspace_bundle_acquire", () =>
    acquireWorkspaceBundle({
      ownerType: "team",
      ownerRef: `best-of-n-check:${group.groupId}:${crypto.randomUUID()}`,
      ...(projectId ? { projectId } : {}),
      environmentKind: "managed",
      base: { kind: "gitRef", gitRef: changeset.headSha },
      roots: [{ logicalRootId: group.repositoryId, role: "primary", sourceRoot: group.sourceRoot }],
    })
  )
  try {
    const lease = bundle.leases[0]
    if (bundle.state !== "active" || bundle.leases.length !== 1 || lease.role !== "primary")
      throw new Error("Best-of-N verification workspace is invalid")
    const pinnedHost: ScmHost = {
      ...host,
      async getChangeset(id) {
        const current = await host.getChangeset(id)
        if (!current || id !== changeset.changesetId || current.headSha !== changeset.headSha)
          throw new Error("Best-of-N changeset head changed before verification")
        return { ...current, executionRoot: lease.aliasPath }
      },
    }
    // The manual pick is the only judge. Reuse deterministic SCM review and
    // approved ADR-0188 checks, with no configured AI reviewer.
    return await createScmRuntime({
      projectId,
      configRoot: group.sourceRoot,
      appSettings: null,
      host: pinnedHost,
    }).review(changeset.changesetId, signal)
  } finally {
    const cleanup = await Promise.allSettled(
      bundle.leases.map((lease) =>
        runWorkspaceUserAction("task_workspace_managed_archive", () =>
          archiveManagedWorkspace(lease.workspaceId)
        )
      )
    )
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Best-of-N check workspace cleanup failed"
      )
  }
}
