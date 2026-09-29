import type { ChatSession, ProjectThreadDeclaredState } from "@cognia/agent-config-types"
import { getSession, updateSession } from "@/lib/db/sessions"
import {
  sendSessionPeerMessage,
  type SendSessionPeerMessageInput,
} from "@/lib/chat/session-peer-messaging"

/**
 * Thread → coordinator reports (ADR-0204). Reports travel as session peer
 * messages, so they get the peer channel's PII gate, dedupe, inbox capacity,
 * the `<session_peer_message>` untrusted-data framing on the model side and a
 * visible row in the coordinator's transcript. The thread↔coordinator
 * lifecycle link lets them past the coordinator's hold (see
 * `resolveInboundPolicy`).
 *
 * Two bounds keep a busy project from turning into a report storm:
 * - reports that land within {@link REPORT_COALESCE_MS} of each other go out
 *   as ONE message, so N threads finishing together cost one coordinator turn;
 * - past {@link MAX_TRIGGERED_REPORTS_PER_HOUR} a report is delivered as a
 *   note (visible, no turn) until the window rolls.
 */

export const REPORT_COALESCE_MS = 5_000
export const MAX_TRIGGERED_REPORTS_PER_HOUR = 6
export const REPORT_TTL_MS = 24 * 60 * 60 * 1000
export const REPORT_SUMMARY_MAX_CHARS = 1_500
const HOUR_MS = 60 * 60 * 1000

export type ThreadOutcome = "completed" | "error" | "interrupted"

export interface ThreadReport {
  threadId: string
  coordinatorSessionId: string
  title: string
  outcome: ThreadOutcome
  summary: string
  declaredState?: ProjectThreadDeclaredState
}

export interface ReportDeps {
  send: (input: SendSessionPeerMessageInput) => Promise<unknown>
  getSession: (id: string) => Promise<ChatSession | undefined>
  updateSession: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  setTimer: (fn: () => void, ms: number) => unknown
  now: () => number
}

function defaultDeps(): ReportDeps {
  return {
    send: sendSessionPeerMessage,
    getSession,
    updateSession,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    now: Date.now,
  }
}

interface PendingBatch {
  reports: ThreadReport[]
  deps: ReportDeps
}

const pending = new Map<string, PendingBatch>()
const triggeredAt = new Map<string, number[]>()

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/** The model-facing report body. One section per thread, newest last. */
export function renderThreadReports(reports: readonly ThreadReport[]): string {
  const sections = reports.map((report) => {
    const state = report.declaredState ? ` · declared: ${report.declaredState}` : ""
    return [
      `### Thread "${report.title}" (${report.threadId}) — ${report.outcome}${state}`,
      truncate(report.summary, REPORT_SUMMARY_MAX_CHARS) || "(no summary)",
    ].join("\n")
  })
  return [
    `Thread report${reports.length > 1 ? "s" : ""} for this project:`,
    ...sections,
    "Read the full result with read_thread_report when the summary is not enough.",
  ].join("\n\n")
}

/** Queue a report; it is sent with any others that arrive in the coalescing window. */
export function reportThreadToCoordinator(
  report: ThreadReport,
  deps: ReportDeps = defaultDeps()
): void {
  const batch = pending.get(report.coordinatorSessionId)
  if (batch) {
    // A newer report from the same thread supersedes its earlier one.
    batch.reports = [...batch.reports.filter((r) => r.threadId !== report.threadId), report]
    return
  }
  pending.set(report.coordinatorSessionId, { reports: [report], deps })
  deps.setTimer(() => void flushThreadReports(report.coordinatorSessionId), REPORT_COALESCE_MS)
}

/** Send the coalesced batch for one coordinator now. */
export async function flushThreadReports(coordinatorSessionId: string): Promise<void> {
  const batch = pending.get(coordinatorSessionId)
  if (!batch) return
  pending.delete(coordinatorSessionId)
  const { reports, deps } = batch
  const now = deps.now()
  const recent = (triggeredAt.get(coordinatorSessionId) ?? []).filter((at) => now - at < HOUR_MS)
  const trigger = recent.length < MAX_TRIGGERED_REPORTS_PER_HOUR
  if (trigger) recent.push(now)
  triggeredAt.set(coordinatorSessionId, recent)

  try {
    await deps.send({
      senderSessionId: reports[0].threadId,
      receiverSessionId: coordinatorSessionId,
      content: renderThreadReports(reports),
      intent: trigger ? "trigger_turn" : "note",
      origin: "agent",
      ttlMs: REPORT_TTL_MS,
    })
  } catch (error) {
    // The PII gate refused the text, or the channel failed: the result stays
    // in the thread (read_thread_report still reaches it), so log, not throw.
    console.warn("project thread report was not delivered", error)
    return
  }
  await Promise.all(
    reports.map(async (report) => {
      const thread = await deps.getSession(report.threadId)
      if (!thread?.projectThread) return
      await deps.updateSession(report.threadId, {
        projectThread: { ...thread.projectThread, lastReportAt: now },
      })
    })
  )
}

export function __resetThreadReportsForTesting(): void {
  pending.clear()
  triggeredAt.clear()
}
