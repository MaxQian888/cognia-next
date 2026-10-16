/** Disposable child-history projection; the encrypted Host evidence store remains authoritative. */
import { getDb } from "@/lib/db/schema"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { appendRunEventInsideTransaction, semanticRunEvent } from "@/lib/db/execution-runs"
import { isManagedDesktopResultDeletionPending } from "@/lib/automation/managed-desktop-result-deletion"
import type { ManagedDesktopAcceptanceResult } from "@/lib/automation/managed-desktop-results-client"
import type { RunArtifactSnapshot } from "@/types/execution/run"

export function managedDesktopAcceptanceRunId(acceptanceId: string): string {
  return `execution:managed-desktop:${acceptanceId}`
}

/** Only counts and opaque references reach the run journal, never criterion text or image bytes. */
export function managedDesktopVerificationArtifact(
  result: ManagedDesktopAcceptanceResult,
  title: string
): RunArtifactSnapshot | undefined {
  const verdict = result.agentVerdict
  const outcome = verdict?.input.outcome ?? result.systemOutcome?.outcome
  if (!outcome) return undefined
  const base: RunArtifactSnapshot = {
    id: `managed-desktop-result:${result.binding.acceptanceId}`,
    title,
    detailsRef: result.binding.acceptanceId,
  }
  if (outcome === "cancelled") return { ...base, kind: "generic" }
  const criteria = verdict?.input.criteria ?? []
  const total = result.binding.criteria.length
  const passed = criteria.filter((item) => item.outcome === "passed").length
  const failed = criteria.filter((item) => item.outcome === "failed").length
  return {
    ...base,
    kind: "verification",
    verification: {
      conclusion: outcome,
      passed,
      failed,
      skipped: Math.max(0, total - passed - failed),
      total,
    },
  }
}

/** Called after a scoped Host read. Never writes to the parent, even when it is terminal. */
export async function syncManagedDesktopAcceptanceResult(
  result: ManagedDesktopAcceptanceResult,
  scope: { owner: string; assertActive: () => void },
  db = getDb()
): Promise<boolean> {
  const binding = result.binding
  if (binding.ownerAccountId !== scope.owner)
    throw new Error("managed_desktop_result_owner_mismatch")
  const assertActive = () => {
    scope.assertActive()
    if (getDb() !== db) throw new Error("managed_desktop_result_database_changed")
  }
  assertActive()
  const t = await getRuntimeTranslator("settings.managedDesktops.results")
  const title = t("runTitle")
  assertActive()
  return db.transaction(
    "rw",
    [
      db.sessions,
      db.executionRuns,
      db.executionRunEvents,
      db.notificationProjectionWork,
      db.managedDesktopDeletionOutbox,
    ],
    async () => {
      assertActive()
      if (
        !(await db.sessions.get(binding.sessionId)) ||
        (await isManagedDesktopResultDeletionPending(db, {
          conversationId: binding.sessionId,
          taskId: binding.taskId,
          acceptanceId: binding.acceptanceId,
        }))
      )
        return false
      const id = managedDesktopAcceptanceRunId(binding.acceptanceId)
      const existing = await db.executionRuns.get(id)
      if (
        existing &&
        (existing.sessionId !== binding.sessionId ||
          existing.sourceId !== binding.taskId ||
          existing.parentRunId !== binding.parentRunId ||
          existing.managedDesktopHostId !== binding.hostId)
      )
        throw new Error("managed_desktop_result_binding_changed")
      // Approval revisions remain in the independent Host record. Event pruning
      // never causes a terminal child to be reopened or its result to be recreated.
      if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) return true
      if (!existing) {
        await db.executionRuns.add({
          id,
          managedDesktopHostId: binding.hostId,
          kind: "job",
          sourceId: binding.taskId,
          sessionId: binding.sessionId,
          parentRunId: binding.parentRunId,
          title,
          status: "running",
          currentRevision: 0,
          startedAt: result.createdAt,
          updatedAt: result.createdAt,
        })
        await appendRunEventInsideTransaction(
          db,
          id,
          semanticRunEvent(
            "run.started",
            {},
            {
              ts: result.createdAt,
              sourceEventId: `managed-desktop:${binding.acceptanceId}:started`,
            }
          )
        )
      }
      const artifact = managedDesktopVerificationArtifact(result, title)
      if (artifact) {
        const at = result.agentVerdict?.recordedAt ?? result.systemOutcome!.recordedAt
        await appendRunEventInsideTransaction(
          db,
          id,
          semanticRunEvent(
            "artifact.created",
            { ...artifact, artifactId: artifact.id, safeTitle: true },
            {
              ts: at,
              visibility: "detail",
              sourceEventId: `managed-desktop:${binding.acceptanceId}:result`,
            }
          )
        )
        const outcome = result.agentVerdict?.input.outcome ?? result.systemOutcome!.outcome
        const type =
          outcome === "cancelled"
            ? "run.cancelled"
            : outcome === "passed"
              ? "run.completed"
              : "run.failed"
        await appendRunEventInsideTransaction(
          db,
          id,
          semanticRunEvent(
            type,
            {},
            {
              ts: at,
              sourceEventId: `managed-desktop:${binding.acceptanceId}:settled`,
            }
          )
        )
      }
      assertActive()
      return true
    }
  )
}
