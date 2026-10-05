/**
 * The workspace revision code evidence is bound to. The evidence bundle itself
 * lives in `@cognia/agent-orchestration/evidence` (ADR-0217); this stays
 * app-side because it reads the task workspace's captured changes.
 */

import type { ResourceChange } from "@/lib/task-workspace/types"
import { sha256Hex } from "@/lib/data/crypto"

/** Bind code evidence to captured source changes; generated rows carry metadata only. */
export async function workspaceEvidenceRevision(
  changes: readonly ResourceChange[]
): Promise<string | undefined> {
  const source = changes.filter((change) => change.captureClass !== "generated")
  if (
    source.length === 0 ||
    source.some((change) => change.kind !== "deleted" && !change.hash?.trim())
  )
    return undefined
  const resources = source
    .map((change) =>
      JSON.stringify({
        runId: change.runId,
        path: change.path,
        oldPath: change.oldPath,
        kind: change.kind,
        hash: change.hash,
        beforeHash: change.beforeHash,
        revision: change.revision,
        resourceKind: change.resourceKind,
        beforeMode: change.beforeMode,
        afterMode: change.afterMode,
      })
    )
    .sort()
  return `workspace:sha256:${await sha256Hex(JSON.stringify(resources))}`
}
