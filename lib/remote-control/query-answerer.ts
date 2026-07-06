/**
 * Remote read-query answerer (renderer side).
 *
 * The Rust inbound server cannot read Dexie / renderer state directly, so a GET
 * read endpoint emits a `remote-control://query` event and blocks on a oneshot.
 * This module runs the matching Dexie read and resolves it via the
 * `remote_control_query_response` command. Mirrors the gateway's
 * `gateway://decide` ⇄ `gateway_decision_response` round-trip.
 *
 * Every value returned over the GET surface is summarised to an allowlisted set
 * of fields — never a raw row dump — and any free-form text is passed through
 * the PII gate first. `goal.rawObjective` (verbatim user text) is never
 * returned; the already-redacted `safeObjective` is used instead.
 */

import type { RemoteControlQueryEvent } from "@/types/remote-control"
import { remoteControlQueryResponse } from "@/lib/tauri/remote-control"
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

/** Number of rows returned per read. Keeps payloads small over the loopback GET. */
const READ_LIMIT = 50

/** Return the text only when it passes the PII gate, else undefined. */
function safeText(text: string | undefined): string | undefined {
  if (!text) return undefined
  return hasNoLeakingPii(text) ? text : undefined
}

function str(params: Record<string, unknown>, key: string): string | null {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Concatenate a UIMessage's text parts (tool/file parts carry no readable text). */
function extractMessageText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter(
      (p): p is { type: string; text: string } =>
        !!p &&
        typeof p === "object" &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string"
    )
    .map((p) => p.text)
    .join("")
}

/** Map a goal's lifecycle status onto the remote run-status projection value. */
function mapGoalStatus(status: string, isTerminal: boolean): string {
  if (status === "completed") return "succeeded"
  if (status === "stopped") return "cancelled"
  // budget_limited / turn_limited / timed_out / preempted — a non-success exit.
  if (isTerminal) return "failed"
  return "running"
}

async function resolveQuery(kind: string, params: Record<string, unknown>): Promise<unknown> {
  switch (kind) {
    case "tasks": {
      const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
      const tasks = await schedulerDb.getAllTasks()
      return {
        tasks: tasks.map((t) => ({
          id: t.id,
          name: safeText(t.name),
          type: t.type,
          status: t.status,
          runCount: t.runCount,
          successCount: t.successCount,
          failureCount: t.failureCount,
          nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : undefined,
          lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : undefined,
        })),
      }
    }
    case "workflow.runs": {
      const workflowId = str(params, "workflowId")
      if (!workflowId) throw new Error("workflowId required")
      const { listWorkflowRuns } = await import("@/lib/db/workflows")
      const runs = await listWorkflowRuns({ workflowId, limit: READ_LIMIT })
      return {
        runs: runs.map((r) => ({
          id: r.id,
          workflowId: r.workflowId,
          status: r.status,
          triggerKind: r.triggerKind,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          error: safeText(r.error?.message),
        })),
      }
    }
    case "goals": {
      const sessionId = str(params, "sessionId")
      if (!sessionId) throw new Error("sessionId required")
      const { getGoalRuntime } = await import("@/lib/goal/runtime")
      const goals = await getGoalRuntime().listGoalsBySession(sessionId)
      return {
        goals: goals.map((g) => ({
          id: g.id,
          sessionId: g.sessionId,
          status: g.status,
          turnsUsed: g.turnsUsed,
          tokensUsed: g.tokensUsed,
          // `safeObjective` is already PII-redacted; `rawObjective` is never sent.
          objective: g.safeObjective,
        })),
      }
    }
    case "audit": {
      const { listRemoteControlAudit } = await import("@/lib/db/remote-control-audit")
      const entries = await listRemoteControlAudit({ direction: "inbound", limit: READ_LIMIT })
      return {
        audit: entries.map((e) => ({
          id: e.id,
          at: e.at,
          kind: e.kind,
          target: e.target,
          runId: e.runId,
          result: e.result,
          // `fields` were PII-gated at write, but re-gate defensively before egress.
          fields: hasNoLeakingPii(JSON.stringify(e.fields ?? {})) ? e.fields : { redacted: true },
        })),
      }
    }
    case "run.status": {
      const runId = str(params, "runId")
      if (!runId) throw new Error("runId required")
      // Workflow runs carry the same server runId in the durable `workflowRuns`
      // table — prefer it (terminal-aware + restart-durable) over the projection.
      const { getDb } = await import("@/lib/db/schema")
      const wf = await getDb().workflowRuns.get(runId)
      if (wf) {
        return {
          run: {
            runId,
            target: "workflow.run",
            status: wf.status,
            startedAt: wf.startedAt,
            updatedAt: wf.completedAt ?? wf.startedAt,
          },
        }
      }
      const { getRemoteRunStatus } = await import("@/lib/db/remote-control-run-status")
      const row = await getRemoteRunStatus(runId)
      if (!row) return { run: null }
      // `goal.create` runs the goal loop in the background after the command
      // resolves, so the stored stamp stalls at `running`. Derive the live
      // status from the authoritative `goals` table via the `correlationId`
      // (`goalId`) — the same terminal-aware trick `workflow.run` uses above.
      if (row.target === "goal.create" && row.correlationId) {
        const { getGoal } = await import("@/lib/db/goals")
        const goal = await getGoal(row.correlationId)
        if (goal) {
          const { isTerminalGoalStatus } = await import("@/types/goal")
          return {
            run: {
              runId: row.runId,
              target: row.target,
              status: mapGoalStatus(goal.status, isTerminalGoalStatus(goal.status)),
              startedAt: row.startedAt,
              updatedAt: Date.now(),
            },
          }
        }
      }
      return {
        run: {
          runId: row.runId,
          target: row.target,
          status: row.status,
          detail: safeText(row.detail),
          startedAt: row.startedAt,
          updatedAt: row.updatedAt,
        },
      }
    }
    case "teams": {
      const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
      return {
        teams: agentTeamManager.list().map((t) => ({
          id: t.id,
          name: safeText(t.name),
          status: t.status,
        })),
      }
    }
    case "team": {
      const teamId = str(params, "teamId")
      if (!teamId) throw new Error("teamId required")
      const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
      const t = agentTeamManager.get(teamId)
      if (!t) return { team: null }
      return {
        team: {
          id: t.id,
          name: safeText(t.name),
          status: t.status,
          description: safeText(t.description),
          task: safeText(t.task),
        },
      }
    }
    case "workflows": {
      const { listWorkflows } = await import("@/lib/db/workflows")
      const rows = await listWorkflows()
      return {
        workflows: rows.slice(0, READ_LIMIT).map((w) => ({
          id: w.id,
          name: safeText(w.name),
          nodeCount: Array.isArray(w.nodes) ? w.nodes.length : 0,
          isTemplate: w.isTemplate ?? false,
          updatedAt: w.updatedAt,
        })),
      }
    }
    case "plugins": {
      const { listPlugins } = await import("@/lib/db/plugins")
      const rows = await listPlugins()
      return {
        plugins: rows.map((p) => ({
          id: p.id,
          name: safeText(p.name),
          version: p.version,
          type: p.type,
          source: p.source,
          enabled: p.enabled,
          status: p.status,
        })),
      }
    }
    case "connectors": {
      const { listAdapterInstances } = await import("@/lib/db/adapter-instances")
      const rows = await listAdapterInstances()
      return {
        connectors: rows.map((c) => ({
          id: c.id,
          type: c.type,
          displayName: safeText(c.displayName),
          enabled: c.enabled,
          transportMode: c.transportMode,
        })),
      }
    }
    case "backups": {
      const { listBackupHistory } = await import("@/lib/db/backup-history")
      const rows = await listBackupHistory({ limit: READ_LIMIT })
      return {
        backups: rows.map((b) => ({
          id: b.id,
          completedAt: b.completedAt,
          type: b.type,
          success: b.success,
          encryption: b.encryption,
          sizeBytes: b.sizeBytes,
          error: safeText(b.errorMessage),
        })),
      }
    }
    case "ocr.cache": {
      const { ocrCacheStats } = await import("@/lib/db/ocr-results")
      return { ocrCache: await ocrCacheStats() }
    }
    case "runs": {
      const { listRemoteRunStatus } = await import("@/lib/db/remote-control-run-status")
      const rows = await listRemoteRunStatus(READ_LIMIT)
      return {
        runs: rows.map((r) => ({
          runId: r.runId,
          target: r.target,
          status: r.status,
          detail: safeText(r.detail),
          startedAt: r.startedAt,
          updatedAt: r.updatedAt,
        })),
      }
    }
    case "messages": {
      const sessionId = str(params, "sessionId")
      if (!sessionId) throw new Error("sessionId required")
      const { listMessages } = await import("@/lib/db/messages")
      const rows = await listMessages(sessionId)
      // PII red-line: message bodies are the most sensitive read on the surface.
      // Gate each row's text individually and DROP any that fails — never emit a
      // partially-redacted body. Tool/file-only messages carry no text and are
      // likewise dropped (this is a conversational-text summary).
      const messages = rows
        .slice(-READ_LIMIT)
        .map((m) => {
          const text = safeText(extractMessageText((m as { parts?: unknown }).parts))
          return text ? { id: m.id, role: m.role, text } : null
        })
        .filter((m): m is NonNullable<typeof m> => m !== null)
      return { messages }
    }
    default:
      throw new Error(`unknown query kind: ${kind}`)
  }
}

/**
 * Answer one `remote-control://query` event. Always resolves the Rust oneshot —
 * on error it sends an `{ error }` envelope so the GET returns promptly with a
 * 200 error body rather than timing out to 503.
 */
export async function answerRemoteControlQuery(event: RemoteControlQueryEvent): Promise<void> {
  const { requestId, kind, params } = event
  try {
    const payload = await resolveQuery(kind, params ?? {})
    await remoteControlQueryResponse(requestId, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("remote-control query answer failed", { kind, error: message })
    await remoteControlQueryResponse(requestId, { error: message }).catch((e) =>
      log.warn("remote-control query error-response failed", { error: e })
    )
  }
}
