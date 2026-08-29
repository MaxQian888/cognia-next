"use client"

import type { ChatSession } from "@cognia/agent-config-types"
import { getDeviceId } from "@/lib/device/device-identity"
import { CollabError, type CollabClient } from "./client"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "./runtime-client"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"

const HEARTBEAT_INTERVAL_MS = 30_000

interface ActiveSharedRun {
  client: CollabClient
  orgId: string
  sharedSessionId: string
  runId: string
  leaseId: string
  deviceId: string
  token: string
  baselineMessageIds: Set<string>
  heartbeat: ReturnType<typeof setInterval>
  /** The scheduler that armed `heartbeat`. Cancelling with any other one leaks it. */
  cancel: typeof globalThis.clearInterval
  leaseLost: boolean
  onLeaseLost?: () => void
}

export type BeginSharedRunResult =
  | { kind: "private" }
  | { kind: "queued"; queueItemId: string }
  | { kind: "acquired"; setLeaseLostHandler: (handler: () => void) => void }

export interface SharedRunCoordinatorDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
  getDeviceId?: () => Promise<string | null>
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

const activeRuns = new Map<string, ActiveSharedRun>()

function operationId(prefix: string, runId: string): string {
  return `${prefix}:${runId}`
}

interface SharedRunMessage {
  id: string
  role: string
  parts?: unknown[]
  createdAt?: number
}

async function sessionMessages(localSessionId: string): Promise<SharedRunMessage[]> {
  const { useChatStore } = await import("@/stores/chat")
  return (useChatStore.getState().sessions[localSessionId]?.messages ?? []) as SharedRunMessage[]
}

export async function beginSharedSessionRun(
  session: Pick<ChatSession, "id" | "collaboration"> | undefined,
  runId: string,
  queuedPayload: Record<string, unknown>,
  deps: SharedRunCoordinatorDeps = {}
): Promise<BeginSharedRunResult> {
  const binding = session?.collaboration
  if (!binding) return { kind: "private" }
  assertSharedChatClientEnabled()
  const context = await (deps.resolveContext ?? resolveCurrentCollabContext)()
  if (!context || context.orgId !== binding.orgId) {
    throw new Error("Shared session connection is unavailable")
  }
  const deviceId = await (deps.getDeviceId ?? getDeviceId)()
  if (!deviceId) throw new Error("Stable device identity is unavailable")

  let acquired: Awaited<ReturnType<CollabClient["acquireSessionRunLease"]>>
  try {
    acquired = await context.client.acquireSessionRunLease(context.orgId, binding.sessionId, {
      runId,
      deviceId,
      operationId: operationId("run-lease", runId),
    })
  } catch (error) {
    if (!(error instanceof CollabError) || error.status !== 409) throw error
    const queued = await context.client.enqueueSessionRunInput(context.orgId, binding.sessionId, {
      payload: queuedPayload,
      operationId: operationId("run-queue", runId),
    })
    return { kind: "queued", queueItemId: queued.id }
  }

  try {
    const messageId =
      typeof queuedPayload.messageId === "string" ? queuedPayload.messageId : `user:${runId}`
    const parts = Array.isArray(queuedPayload.parts)
      ? queuedPayload.parts
      : [{ type: "text", text: String(queuedPayload.content ?? "") }]
    await context.client.appendSessionEvent(context.orgId, binding.sessionId, {
      kind: "message.created",
      payload: {
        messageId,
        role: "user",
        parts,
        createdAt:
          typeof queuedPayload.createdAt === "number" ? queuedPayload.createdAt : Date.now(),
        author: { kind: "human", id: context.userId },
      },
      operationId: operationId("user-message", runId),
    })
    await context.client.appendSessionRunEvent(
      context.orgId,
      binding.sessionId,
      runId,
      acquired.token,
      {
        kind: "run.started",
        payload: { deviceId },
        operationId: operationId("run-start", runId),
      }
    )
  } catch (error) {
    await context.client
      .releaseSessionRunLease(context.orgId, binding.sessionId, acquired.lease.id, "failed")
      .catch(() => undefined)
    throw error
  }

  const schedule = deps.setInterval ?? globalThis.setInterval
  const cancel = deps.clearInterval ?? globalThis.clearInterval
  const active: ActiveSharedRun = {
    client: context.client,
    orgId: context.orgId,
    sharedSessionId: binding.sessionId,
    runId,
    leaseId: acquired.lease.id,
    deviceId,
    token: acquired.token,
    baselineMessageIds: new Set((await sessionMessages(session.id)).map((message) => message.id)),
    heartbeat: undefined as never,
    cancel,
    leaseLost: false,
  }
  active.heartbeat = schedule(() => {
    void active.client
      .heartbeatSessionRunLease(active.orgId, active.sharedSessionId, active.leaseId, {
        deviceId: active.deviceId,
        token: active.token,
      })
      .catch(() => {
        if (active.leaseLost) return
        active.leaseLost = true
        cancel(active.heartbeat)
        active.onLeaseLost?.()
      })
  }, HEARTBEAT_INTERVAL_MS)
  // A second run on the same local session (a retry, a duplicate submit, a turn
  // that died before `finishSharedSessionRun`) must not strand the previous
  // heartbeat: overwriting the map entry alone left a 30s timer beating a dead
  // lease — and holding its `CollabClient` — for the rest of the page's life.
  stopHeartbeat(activeRuns.get(session.id))
  activeRuns.set(session.id, active)
  return {
    kind: "acquired",
    setLeaseLostHandler: (handler) => {
      active.onLeaseLost = handler
      if (active.leaseLost) handler()
    },
  }
}

export async function finishSharedSessionRun(
  localSessionId: string,
  status: "completed" | "failed" | "cancelled"
): Promise<void> {
  const active = activeRuns.get(localSessionId)
  if (!active) return
  activeRuns.delete(localSessionId)
  stopHeartbeat(active)
  const kind = status === "completed" ? "run.completed" : "run.failed"
  if (status === "completed") {
    const assistant = (await sessionMessages(localSessionId))
      .toReversed()
      .find((message) => message.role === "assistant" && !active.baselineMessageIds.has(message.id))
    if (assistant) {
      await active.client.appendSessionRunEvent(
        active.orgId,
        active.sharedSessionId,
        active.runId,
        active.token,
        {
          kind: "message.created",
          payload: {
            messageId: assistant.id,
            role: "assistant",
            parts: assistant.parts ?? [],
            createdAt: assistant.createdAt ?? Date.now(),
            author: { kind: "agent", id: `run:${active.runId}` },
          },
          operationId: operationId(`assistant-message:${assistant.id}`, active.runId),
        }
      )
    }
  }
  await active.client.appendSessionRunEvent(
    active.orgId,
    active.sharedSessionId,
    active.runId,
    active.token,
    {
      kind,
      payload: status === "cancelled" ? { reason: "cancelled" } : {},
      operationId: operationId(`run-${status}`, active.runId),
    }
  )
  await active.client
    .releaseSessionRunLease(
      active.orgId,
      active.sharedSessionId,
      active.leaseId,
      status === "completed" || status === "cancelled" ? "released" : "failed"
    )
    .catch(() => undefined)
}

export function resetSharedRunCoordinatorForTesting(): void {
  for (const active of activeRuns.values()) stopHeartbeat(active)
  activeRuns.clear()
}

/**
 * Cancel a run's heartbeat with the scheduler that armed it. `globalThis` is
 * the wrong one whenever the caller injected `deps.setInterval`/`clearInterval`
 * — the handle belongs to the injected pair, so the timer survived.
 */
function stopHeartbeat(active: ActiveSharedRun | undefined): void {
  if (!active) return
  active.cancel(active.heartbeat)
}
