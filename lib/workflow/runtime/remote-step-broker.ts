/**
 * Remote-step broker (ADR 0061 P3) — the desktop half of "run this step on
 * a paired device".
 *
 * The hub-side proxy executors (`action.mobile.*`) call
 * {@link dispatchRemoteStep}: the request rides the companion event bus as
 * a `workflow://step-execute` WS frame (full params — the authenticated WS
 * terminates on the paired device; same trust as chat streaming) plus an
 * ids-only `workflow://step-pending` push for backgrounded devices. The
 * phone's remote-step server executes and answers through the
 * `workflow_step_result` RPC, which lands back here via
 * {@link resolveRemoteStep}.
 *
 * Results are CHUNKED: the companion HTTP body cap is 64 KiB and a camera
 * capture routinely exceeds it, so the phone sends
 * `JSON.stringify(RemoteStepResult)` in ≤32 KiB slices
 * (`{ requestId, seq, total, chunk }`) and the broker reassembles. The
 * responder identity is the JWT-verified caller device injected by the Rust
 * RPC layer — a result from any device other than the request's target is
 * rejected.
 *
 * In-memory by design, like the approval registry: a remote step only
 * resolves against a live orchestrator; crash-resume re-enters the proxy
 * executor, which re-dispatches with a fresh requestId.
 */

import { isTauri } from "@/lib/platform/detect"
import { emitCompanionEvent } from "./companion-run-events"

export const STEP_EXECUTE_CHANNEL = "workflow://step-execute"
export const STEP_PENDING_PUSH_CHANNEL = "workflow://step-pending"

/** Chunk budget for `workflow_step_result` bodies — safely under the 64 KiB
 *  HTTP cap once JSON envelope + idempotency headers are accounted for. */
export const RESULT_CHUNK_CHARS = 32_768

/** Frame the phone receives on the WS channel. */
export interface RemoteStepRequest {
  requestId: string
  targetDeviceId: string
  kind: string
  params: Record<string, unknown>
  runId: string
  stepId: string
  workflowId: string
  issuedAt: number
  timeoutAt: number
}

/** What the phone's executor produces (before chunking). */
export type RemoteStepResult =
  | { ok: true; output: unknown }
  | { ok: false; message: string; code?: string }

interface PendingRemoteStep {
  request: RemoteStepRequest
  chunks: Map<number, string>
  total?: number
  resolve: (result: RemoteStepResult) => void
  reject: (err: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingRemoteStep>()

let requestCounter = 0
function nextRequestId(runId: string, stepId: string): string {
  requestCounter += 1
  return `rst_${runId}_${stepId}_${requestCounter.toString(36)}`
}

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
}

/**
 * Dispatch a step to a paired device and await its result. Rejects on
 * timeout, abort, or an error result from the device; resolves with the
 * device executor's `output`.
 */
export async function dispatchRemoteStep(
  input: DispatchRemoteStepInput,
  deps: RemoteStepBrokerDeps = {}
): Promise<unknown> {
  if (!(deps.isTauriFn ?? isTauri)()) {
    throw new Error("remote step dispatch requires the desktop companion server")
  }
  const emit = deps.emit ?? emitCompanionEvent
  const issuedAt = Date.now()
  const request: RemoteStepRequest = {
    requestId: nextRequestId(input.runId, input.stepId),
    targetDeviceId: input.targetDeviceId,
    kind: input.kind,
    params: input.params,
    runId: input.runId,
    stepId: input.stepId,
    workflowId: input.workflowId,
    issuedAt,
    timeoutAt: issuedAt + input.timeoutMs,
  }

  const result = await new Promise<RemoteStepResult>((resolve, reject) => {
    const entry: PendingRemoteStep = {
      request,
      chunks: new Map(),
      resolve: (r) => {
        clearTimeout(entry.timeoutHandle)
        pending.delete(request.requestId)
        resolve(r)
      },
      reject: (err) => {
        clearTimeout(entry.timeoutHandle)
        pending.delete(request.requestId)
        reject(err)
      },
      timeoutHandle: setTimeout(() => {
        entry.reject(
          new Error(
            `remote step ${request.kind} timed out after ${input.timeoutMs}ms on device ${input.targetDeviceId}`
          )
        )
      }, input.timeoutMs),
    }
    if (input.signal) {
      if (input.signal.aborted) {
        entry.reject(new Error("remote step aborted"))
        return
      }
      input.signal.addEventListener("abort", () => entry.reject(new Error("remote step aborted")), {
        once: true,
      })
    }
    pending.set(request.requestId, entry)

    void (async () => {
      try {
        await emit(STEP_EXECUTE_CHANNEL, request)
        // Ids only — this payload transits APNs/FCM.
        await emit(STEP_PENDING_PUSH_CHANNEL, {
          requestId: request.requestId,
          runId: request.runId,
          workflowId: request.workflowId,
          targetDeviceId: request.targetDeviceId,
        })
      } catch (err) {
        entry.reject(
          new Error(
            `remote step dispatch failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      }
    })()
  })

  if (!result.ok) {
    const code = result.code ? ` (${result.code})` : ""
    throw new Error(`remote step failed on device: ${result.message}${code}`)
  }
  return result.output
}

/** One chunk of a device's result, as delivered by `workflow_step_result`. */
export interface RemoteStepResultChunk {
  requestId: string
  /** 0-based chunk index. */
  seq: number
  /** Total chunk count for this result. */
  total: number
  /** Slice of `JSON.stringify(RemoteStepResult)`. */
  chunk: string
}

export type ResolveRemoteStepOutcome =
  | { ok: true; complete: boolean }
  | { ok: false; reason: "not-found" | "wrong-device" | "malformed" }

/**
 * Feed a result chunk from a device (RPC arm side). `fromDeviceId` is the
 * JWT-verified caller — only the targeted device may answer.
 */
export function resolveRemoteStep(
  fromDeviceId: string,
  payload: RemoteStepResultChunk
): ResolveRemoteStepOutcome {
  const entry = pending.get(payload.requestId)
  if (!entry) return { ok: false, reason: "not-found" }
  if (entry.request.targetDeviceId !== fromDeviceId) {
    return { ok: false, reason: "wrong-device" }
  }
  if (
    !Number.isInteger(payload.seq) ||
    !Number.isInteger(payload.total) ||
    payload.seq < 0 ||
    payload.total < 1 ||
    payload.seq >= payload.total ||
    typeof payload.chunk !== "string"
  ) {
    return { ok: false, reason: "malformed" }
  }
  if (entry.total === undefined) entry.total = payload.total
  if (entry.total !== payload.total) return { ok: false, reason: "malformed" }
  entry.chunks.set(payload.seq, payload.chunk)
  if (entry.chunks.size < entry.total) return { ok: true, complete: false }

  let assembled = ""
  for (let i = 0; i < entry.total; i += 1) assembled += entry.chunks.get(i) ?? ""
  try {
    const result = JSON.parse(assembled) as RemoteStepResult
    if (typeof result !== "object" || result === null || typeof result.ok !== "boolean") {
      throw new Error("not a RemoteStepResult")
    }
    entry.resolve(result)
    return { ok: true, complete: true }
  } catch {
    entry.reject(new Error("remote step result was malformed"))
    return { ok: false, reason: "malformed" }
  }
}

/** Split a result into RPC-sized chunks (phone side; exported for reuse). */
export function chunkRemoteStepResult(
  requestId: string,
  result: RemoteStepResult,
  chunkChars: number = RESULT_CHUNK_CHARS
): RemoteStepResultChunk[] {
  const json = JSON.stringify(result)
  const total = Math.max(1, Math.ceil(json.length / chunkChars))
  const chunks: RemoteStepResultChunk[] = []
  for (let seq = 0; seq < total; seq += 1) {
    chunks.push({
      requestId,
      seq,
      total,
      chunk: json.slice(seq * chunkChars, (seq + 1) * chunkChars),
    })
  }
  return chunks
}

/** Test-only — drop all pending requests without resolving. */
export function __resetRemoteStepBrokerForTesting(): void {
  for (const entry of pending.values()) clearTimeout(entry.timeoutHandle)
  pending.clear()
}
