/**
 * Projects Strix security scans onto the canonical run journal as
 * `kind: "security-scan"`.
 *
 * The scan already had a durable record — the plugin's own namespaced `runs`
 * table — but nothing outside the plugin panel could see it. A pentest is
 * long-running, expensive and attacks a real system, which makes it exactly
 * the kind of work the cockpit exists to answer "what is running?" about, and
 * it was the one long-running thing with no answer there.
 *
 * Unlike the other bridges, this one is NOT driven by a Dexie subscription.
 * The plugin's tables are namespaced behind `ctx.dexie` and only exist while
 * the plugin is activated, so there is nothing app-side to subscribe to.
 * `runScan` already emits every state transition through its `onRun` callback,
 * so the panel hands each one here — the projection follows the scan rather
 * than polling for it.
 *
 * ## What deliberately does not cross
 *
 * No finding titles, no descriptions, no proof-of-concept code, and no
 * remediation text. The journal is projected into IM cards and remote
 * surfaces; a working exploit against a named host is the last thing that
 * should travel there. What crosses is the target, a count, and a status.
 */

import {
  createExecutionRun,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import {
  securityScanExecutionRunId,
  securityScanRunStatus,
  type SecurityScanRunRecord,
} from "@cognia/plugin-sdk/api/security-findings"

export {
  securityScanExecutionRunId,
  securityScanRunStatus,
  type SecurityScanRunRecord,
} from "@cognia/plugin-sdk/api/security-findings"

/**
 * A scan whose report could not be read is `failed`, not `completed`.
 *
 * This is the mapping the whole kind exists for. Strix exits 0 having written
 * an artifact nobody could parse, and the plugin already refuses to call that
 * "done" — projecting it as `completed` here would put a green row in the
 * cockpit for a scan that may have found criticals.
 */
const TERMINAL_EVENT = {
  completed: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
} as const

/**
 * Project one scan record. Safe to call repeatedly with the same record —
 * `runScan` emits `onRun` on every write, including ones that change nothing.
 */
export async function syncSecurityScanExecutionRun(record: SecurityScanRunRecord): Promise<void> {
  const runId = securityScanExecutionRunId(record.runId)
  const status = securityScanRunStatus(record)
  const existing = await getExecutionRun(runId)

  if (!existing) {
    await createExecutionRun({
      id: runId,
      kind: "security-scan",
      sourceId: record.runId,
      // The target is the one piece of scan detail that must cross: a row
      // reading "Security scan" with no subject is unusable when two are
      // running. It is a value the operator typed and asserted authorization
      // for, not scanner output.
      title: record.target,
      status: "running",
      currentRevision: 0,
      startedAt: record.startedAt,
      updatedAt: record.startedAt,
    })
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        "run.started",
        { safeTitle: true, title: record.target },
        { ts: record.startedAt, sourceEventId: `security-scan:${record.runId}:started` }
      )
    )
  }

  if (status === "running") return

  // A settled run's journal is closed, so a repeat settle is the ordinary
  // result of `onRun` firing again, not an error. `sourceEventId` makes the
  // append idempotent regardless.
  const current = existing ?? (await getExecutionRun(runId))
  if (current && ["completed", "failed", "cancelled"].includes(current.status)) return

  await runEventJournal
    .append(
      runId,
      semanticRunEvent(
        TERMINAL_EVENT[status as keyof typeof TERMINAL_EVENT],
        {
          // A count, never the findings. `summary` is projected onto IM cards.
          summary: record.reportUnreadable
            ? "Scan report could not be read — treat as inconclusive"
            : status === "completed"
              ? `Scan finished with ${record.findingsCount} finding(s)`
              : undefined,
        },
        {
          ts: record.endedAt ?? Date.now(),
          sourceEventId: `security-scan:${record.runId}:${status}`,
        }
      )
    )
    .catch(() => undefined)
}
