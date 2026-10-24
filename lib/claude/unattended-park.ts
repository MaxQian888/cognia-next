/**
 * Parking an unattended tool request until a person answers (ADR-0224 A7).
 *
 * A Bot or scheduled-task turn that asks to use a tool has nobody at a
 * keyboard. Before this, the unattended responder denied the request on the
 * spot and the run ended `needs_approval` with the work undone. Parking keeps
 * the turn alive instead: the sidecar holds the tool call (its waiter is
 * bounded by `SendOptions.approvalTtlMs`), and the host
 *
 *   1. opens one `agent-turn` execution run for the turn, the first time it
 *      parks, so the request has a durable home the cockpit and the phone can
 *      address;
 *   2. raises a `tool_approval` interrupt on it, whose `requestDigest` is the
 *      sidecar request id;
 *   3. announces it on `run://approval-pending`, which wakes a paired phone;
 *   4. waits in the approval registry, which `execution_run_control` (desktop
 *      cockpit) and `execution_run_approval_respond` (the phone) resolve through the
 *      agent-turn control handler.
 *
 * Nobody answering before the park TTL is a denial, recorded as an expired
 * interrupt; the turn then finishes `needs_approval` as before. The turn
 * ending first (its abort signal) withdraws the question.
 */

import type { PermissionClass, PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "./run-and-capture"
import type { RunApprovalOrigin } from "@/lib/execution/run-approval-push"
import {
  forgetRunApprovalOutbound,
  rememberRunApprovalOutbound,
} from "@/lib/execution/run-approval-outbound"

/** How long a parked request waits for a person before it is denied. */
export const UNATTENDED_PARK_TTL_MS = 30 * 60 * 1000

/**
 * The sidecar's own ceiling on the same wait. A little longer than the park,
 * so the host's answer (or its timeout) normally decides; this only fires
 * when the host died while the request was parked.
 */
export const UNATTENDED_SIDECAR_APPROVAL_TTL_MS = UNATTENDED_PARK_TTL_MS + 2 * 60 * 1000

export interface UnattendedParkOptions {
  origin: RunApprovalOrigin
  /** The turn's chat session: the approval registry key and the run's session. */
  sessionId: string
  /** What the run is, for its title ("Bot: Release notes"). */
  label: string
  projectId?: string
  ttlMs?: number
  /** The turn's abort signal: an ended turn withdraws its questions. */
  signal?: AbortSignal
  now?: () => number
  /** Injectable for tests; the defaults are the real modules. */
  deps?: Partial<UnattendedParkDeps>
}

export type ParkOutcome =
  | { kind: "approved"; decision: CapturePermissionDecision }
  | { kind: "denied"; message?: string }
  | { kind: "expired" }
  | { kind: "withdrawn" }

export interface UnattendedPark {
  /** Park one request and resolve with what became of it. */
  park(request: PermissionRequestEvent): Promise<ParkOutcome>
  /** Close the turn's run, if one was opened. Idempotent. */
  finish(status: "completed" | "failed" | "cancelled", summary?: string): Promise<void>
  /** The run opened for this turn, once something parked. */
  runId(): string | null
}

export interface UnattendedParkDeps {
  openRun(input: {
    runId: string
    sessionId: string
    title: string
    projectId?: string
    startedAt: number
  }): Promise<void>
  finishRun(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    summary?: string
  ): Promise<void>
  createInterrupt(input: {
    id: string
    runId: string
    title: string
    toolName: string
    requestDigest: string
    permissionClass?: PermissionClass
    projectId?: string
    expiresAt: number
    createdAt: number
  }): Promise<void>
  expireInterrupt(runId: string, interruptId: string): Promise<void>
  announce(
    interrupt: { id: string; runId: string; type: "tool_approval"; expiresAt: number },
    context: { origin: RunApprovalOrigin; permissionClass?: PermissionClass }
  ): Promise<void>
  announceResolved(input: {
    interruptId: string
    runId: string
    status: "approved" | "denied" | "expired"
  }): Promise<void>
  awaitDecision(
    sessionId: string,
    requestId: string,
    options: { ttlMs: number; signal?: AbortSignal; onExpire: () => void }
  ): Promise<CapturePermissionDecision>
  newId(): string
}

/** The interrupt id a parked request gets: one per run and sidecar request. */
export function parkedInterruptId(runId: string, requestId: string): string {
  return `tool-interrupt:${runId}:${requestId}`
}

const CLASS_TITLES: Record<PermissionClass, string> = {
  workspace: "workspace change",
  outbound: "outbound message",
  secrets: "secret use",
  hostConfig: "host configuration change",
}

/** The interrupt title: the tool, and the class that made it ask. */
export function parkedInterruptTitle(request: PermissionRequestEvent): string {
  const cls = request.permissionClass
  return cls ? `Approve ${request.toolName} (${CLASS_TITLES[cls]})` : `Approve ${request.toolName}`
}

function defaultDeps(): UnattendedParkDeps {
  return {
    openRun: async (input) => {
      const { createExecutionRun, getExecutionRun } = await import("@/lib/db/execution-runs")
      const { AgentRunEventProducer } = await import("@/lib/execution/sources/agent-turn")
      if (!(await getExecutionRun(input.runId))) {
        await createExecutionRun({
          id: input.runId,
          kind: "agent-turn",
          sourceId: input.runId,
          sessionId: input.sessionId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          title: input.title,
          status: "queued",
          currentRevision: 0,
          startedAt: input.startedAt,
          updatedAt: input.startedAt,
        })
      }
      await new AgentRunEventProducer(input.runId).start(input.startedAt, {
        surface: "unattended",
      })
    },
    finishRun: async (runId, status, summary) => {
      const { getExecutionRun } = await import("@/lib/db/execution-runs")
      const { AgentRunEventProducer } = await import("@/lib/execution/sources/agent-turn")
      const run = await getExecutionRun(runId)
      if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return
      await new AgentRunEventProducer(runId).finish(status, Date.now(), summary)
    },
    createInterrupt: async (input) => {
      const { createRunInterrupt } = await import("@/lib/execution/run-control")
      await createRunInterrupt({
        id: input.id,
        runId: input.runId,
        type: "tool_approval",
        status: "pending",
        title: input.title,
        toolName: input.toolName,
        requestDigest: input.requestDigest,
        ...(input.permissionClass ? { permissionClass: input.permissionClass } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      })
    },
    expireInterrupt: async (runId, interruptId) => {
      const { expireRunInterruptFromSource } = await import("@/lib/execution/run-control")
      await expireRunInterruptFromSource(runId, interruptId)
    },
    announce: async (interrupt, context) => {
      const { announceRunApproval } = await import("@/lib/execution/run-approval-push")
      await announceRunApproval(interrupt, context)
    },
    announceResolved: async (input) => {
      const { announceRunApprovalResolved } = await import("@/lib/execution/run-approval-push")
      await announceRunApprovalResolved(input)
    },
    awaitDecision: async (sessionId, requestId, options) => {
      const { awaitApproval } = await import("@/lib/connectors/hitl/approval-registry")
      return awaitApproval(sessionId, requestId, options)
    },
    newId: () => crypto.randomUUID(),
  }
}

export function createUnattendedPark(options: UnattendedParkOptions): UnattendedPark {
  const deps = { ...defaultDeps(), ...options.deps }
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? UNATTENDED_PARK_TTL_MS
  let runId: string | null = null
  let opening: Promise<string> | null = null
  let finished = false

  const ensureRun = (): Promise<string> => {
    opening ??= (async () => {
      const id = `unattended:${options.sessionId}:${deps.newId()}`
      await deps.openRun({
        runId: id,
        sessionId: options.sessionId,
        title: options.label,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        startedAt: now(),
      })
      runId = id
      return id
    })()
    return opening
  }

  return {
    runId: () => runId,
    async park(request) {
      const run = await ensureRun()
      const interruptId = parkedInterruptId(run, request.requestId)
      const createdAt = now()
      const expiresAt = createdAt + ttlMs
      await deps.createInterrupt({
        id: interruptId,
        runId: run,
        title: parkedInterruptTitle(request),
        toolName: request.toolName,
        requestDigest: request.requestId,
        ...(request.permissionClass ? { permissionClass: request.permissionClass } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        expiresAt,
        createdAt,
      })
      // An outbound request's recipients, for the phone that answers it
      // (ADR-0239). Held in memory only: the interrupt row is metadata-only.
      if (request.outbound) rememberRunApprovalOutbound(interruptId, request.outbound)
      try {
        await deps
          .announce(
            { id: interruptId, runId: run, type: "tool_approval", expiresAt },
            {
              origin: options.origin,
              ...(request.permissionClass ? { permissionClass: request.permissionClass } : {}),
            }
          )
          .catch(() => undefined)
        let expired = false
        const decision = await deps.awaitDecision(options.sessionId, request.requestId, {
          ttlMs,
          ...(options.signal ? { signal: options.signal } : {}),
          onExpire: () => {
            expired = true
          },
        })
        if (expired) {
          // The registry's TTL fired, or the turn ended with the question open.
          // Either way nobody answered: the interrupt is expired, not denied.
          await deps.expireInterrupt(run, interruptId).catch(() => undefined)
          await deps
            .announceResolved({ interruptId, runId: run, status: "expired" })
            .catch(() => undefined)
          return options.signal?.aborted ? { kind: "withdrawn" } : { kind: "expired" }
        }
        // An answer came through the control gate, which already resolved the
        // interrupt row; tell foreground cards it is gone.
        const approved = decision.decision === "allow"
        await deps
          .announceResolved({
            interruptId,
            runId: run,
            status: approved ? "approved" : "denied",
          })
          .catch(() => undefined)
        return approved
          ? { kind: "approved", decision }
          : {
              kind: "denied",
              ...(decision.decision === "deny" && decision.message
                ? { message: decision.message }
                : {}),
            }
      } finally {
        forgetRunApprovalOutbound(interruptId)
      }
    },
    async finish(status, summary) {
      if (finished) return
      finished = true
      const run = opening ? await opening.catch(() => null) : null
      if (run) await deps.finishRun(run, status, summary).catch(() => undefined)
    },
  }
}
