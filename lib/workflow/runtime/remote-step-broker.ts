/** Durable Host half of `action.mobile.*` execution (ADR-0061 P3 / ADR-0136). */

import Dexie from "dexie"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getHostEventPublisher } from "@/lib/companion/host-event-publisher"
import {
  cancelHostDispatch,
  consumeHostDispatchResult,
  enqueueHostDispatch,
  storeHostDispatchResultChunk,
  type HostDispatchResultChunk,
} from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import { createHostDispatchRunner } from "@/lib/placement/host-dispatch-runner"
import { isTauri } from "@/lib/platform/detect"
import { HOST_DISPATCH_MAX_RESULT_CHARS } from "@/types/placement/host-dispatch"
import { createMobileStepHostDelivery } from "./mobile-step-delivery"
import { emitCompanionEvent } from "./companion-run-events"
import {
  RESULT_CHUNK_CHARS,
  type RemoteStepRequest,
  type RemoteStepResult,
} from "./remote-step-protocol"

export {
  RESULT_CHUNK_CHARS,
  STEP_EXECUTE_CHANNEL,
  STEP_PENDING_PUSH_CHANNEL,
  type RemoteStepRequest,
  type RemoteStepResult,
} from "./remote-step-protocol"

export interface DispatchRemoteStepInput {
  targetDeviceId: string
  kind: string
  params: Record<string, unknown>
  runId: string
  stepId: string
  workflowId: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface RemoteStepBrokerDeps {
  emit?: (event: string, payload: unknown) => Promise<void>
  isTauriFn?: () => boolean
  now?: () => number
  accountId?: string
}

export class RemoteStepExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string
  ) {
    super(message)
    this.name = "RemoteStepExecutionError"
  }
}

function stableRequestId(input: DispatchRemoteStepInput): string {
  return `rst_${encodeURIComponent(input.runId)}_${encodeURIComponent(input.stepId)}_${encodeURIComponent(input.targetDeviceId)}`
}

function resultError(result: Extract<RemoteStepResult, { ok: false }>): RemoteStepExecutionError {
  const code = result.code ?? "device_error"
  const retryable = code === "timeout" || code === "dispatch_failed" || code === "unavailable"
  return new RemoteStepExecutionError(code, retryable, result.message)
}

async function waitForDurableResult(
  requestId: string,
  timeoutAt: number,
  signal: AbortSignal | undefined,
  now: () => number
): Promise<RemoteStepResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      subscription?.unsubscribe()
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => {
      void cancelHostDispatch(requestId, "aborted", now())
      finish(() => reject(new RemoteStepExecutionError("aborted", false, "remote step aborted")))
    }
    const timer = setTimeout(
      () => {
        void cancelHostDispatch(requestId, "timeout", now())
        finish(() =>
          reject(new RemoteStepExecutionError("timeout", true, "remote step timed out on device"))
        )
      },
      Math.max(0, timeoutAt - now())
    )

    const subscription = Dexie.liveQuery(() => getDb().hostDispatchQueue.get(requestId)).subscribe({
      next(row) {
        if (!row || settled) return
        if (row.status === "succeeded") {
          void consumeHostDispatchResult(requestId).then((json) => {
            if (!json) return
            try {
              const result = JSON.parse(json) as RemoteStepResult
              if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
                throw new Error("not a RemoteStepResult")
              }
              finish(() => resolve(result))
            } catch {
              finish(() =>
                reject(
                  new RemoteStepExecutionError(
                    "malformed",
                    false,
                    "remote step result was malformed"
                  )
                )
              )
            }
          })
          return
        }
        if (row.status === "failed" || row.status === "deadletter" || row.status === "cancelled") {
          const code =
            row.terminalCode ?? (row.status === "deadletter" ? "dispatch_failed" : row.status)
          finish(() =>
            reject(
              new RemoteStepExecutionError(
                code,
                code === "dispatch_failed" || code === "timeout",
                row.lastError ?? `remote step ${code}`
              )
            )
          )
        }
      },
      error(error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      },
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function dispatchRemoteStep(
  input: DispatchRemoteStepInput,
  deps: RemoteStepBrokerDeps = {}
): Promise<unknown> {
  const hostCanPublish = deps.isTauriFn
    ? deps.isTauriFn()
    : isTauri() || getHostEventPublisher() !== null
  if (!hostCanPublish) {
    throw new RemoteStepExecutionError(
      "unavailable",
      true,
      "remote step dispatch requires an active Companion Host event publisher"
    )
  }
  const now = deps.now ?? Date.now
  const issuedAt = now()
  const requestId = stableRequestId(input)
  const timeoutAt = issuedAt + input.timeoutMs
  const request: RemoteStepRequest = {
    requestId,
    targetDeviceId: input.targetDeviceId,
    kind: input.kind,
    params: input.params,
    runId: input.runId,
    stepId: input.stepId,
    workflowId: input.workflowId,
    issuedAt,
    timeoutAt,
  }
  const accountId = deps.accountId ?? getActiveAccountId()
  const job = await enqueueHostDispatch({
    id: requestId,
    accountId,
    domain: "mobile-step",
    targetRef: input.targetDeviceId,
    kind: input.kind,
    payload: request as unknown as Record<string, unknown>,
    idempotencyKey: `mobile-step:${input.runId}:${input.stepId}:${input.targetDeviceId}`,
    runId: input.runId,
    stepId: input.stepId,
    expiresAt: timeoutAt,
    now: issuedAt,
  })
  if (now() >= job.expiresAt) {
    await cancelHostDispatch(job.id, "timeout", now())
    throw new RemoteStepExecutionError("timeout", true, "remote step deadline already expired")
  }
  const runner = createHostDispatchRunner({
    accountId,
    jobId: job.id,
    now,
    deliver: createMobileStepHostDelivery({ emit: deps.emit ?? emitCompanionEvent }),
  })
  try {
    await runner.kick()
    const result = await waitForDurableResult(job.id, job.expiresAt, input.signal, now)
    if (!result.ok) throw resultError(result)
    return result.output
  } finally {
    await runner.stop()
  }
}

export type RemoteStepResultChunk = HostDispatchResultChunk
export type ResolveRemoteStepOutcome =
  | { ok: true; complete: boolean }
  | { ok: false; reason: "not-found" | "wrong-device" | "malformed" | "terminal" }

export async function resolveRemoteStep(
  fromDeviceId: string,
  payload: RemoteStepResultChunk
): Promise<ResolveRemoteStepOutcome> {
  const outcome = await storeHostDispatchResultChunk(fromDeviceId, payload)
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason === "wrong-target" ? "wrong-device" : outcome.reason,
    }
  }
  return outcome
}

export function chunkRemoteStepResult(
  requestId: string,
  result: RemoteStepResult,
  chunkChars: number = RESULT_CHUNK_CHARS
): RemoteStepResultChunk[] {
  if (!Number.isInteger(chunkChars) || chunkChars <= 0) {
    throw new RangeError("remote step result chunk size must be a positive integer")
  }
  const safeChunkChars = Math.min(chunkChars, RESULT_CHUNK_CHARS)
  let json = JSON.stringify(result)
  if (json.length > HOST_DISPATCH_MAX_RESULT_CHARS) {
    json = JSON.stringify({
      ok: false,
      code: "result_too_large",
      message: "the remote step result exceeded the durable transfer limit",
    } satisfies RemoteStepResult)
  }
  const total = Math.max(1, Math.ceil(json.length / safeChunkChars))
  return Array.from({ length: total }, (_, seq) => ({
    requestId,
    seq,
    total,
    chunk: json.slice(seq * safeChunkChars, (seq + 1) * safeChunkChars),
  }))
}

/** Compatibility test seam; durable state is reset through the database. */
export function __resetRemoteStepBrokerForTesting(): void {}
