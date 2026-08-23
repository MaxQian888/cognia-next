/**
 * Mobile remote-step server (ADR 0061 P3) — the phone half of "run this
 * step on a paired device".
 *
 * Subscribes to `workflow://step-execute` frames from the paired desktop,
 * executes the ones addressed to THIS device through the Capacitor
 * facilities (`lib/capacitor/*` outcome façades), and answers via the
 * chunked `workflow_step_result` RPC (32 KiB slices under the 64 KiB body
 * cap — a camera capture doesn't fit in one call).
 *
 * Foreground-first by design: camera / barcode steps open native UI, so
 * they only run while the app is open. A backgrounded phone is woken by
 * the ids-only `workflow://step-pending` push; opening the app re-attaches
 * the WS, which replays recent frames (event-bus ring buffer) — stale or
 * duplicate replays are dropped by the timeout + seen-id guards below.
 *
 * One step at a time: native capture UI cannot run concurrently, so a
 * second request while one is in flight answers `busy` immediately (the
 * hub surfaces that as a step failure it can retry or route around).
 */

import {
  chunkRemoteStepResult,
  type RemoteStepRequest,
  type RemoteStepResult,
} from "@/lib/workflow/runtime/remote-step-broker"
import { STEP_EXECUTE_CHANNEL } from "@/lib/workflow/runtime/remote-step-broker"
import { loggers } from "@cognia/logging"
import {
  beginMobileStepReceipt,
  persistMobileStepResult,
  recoverInterruptedMobileSteps,
  vacuumMobileStepTombstones,
} from "@/lib/db/mobile-step-receipts"

const log = loggers.sync

type MobileStepExecutor = (params: Record<string, unknown>) => Promise<RemoteStepResult>

function failure(code: string, message: string): RemoteStepResult {
  return { ok: false, code, message }
}

function mapOutcomeFailure(outcome: { kind: string } & Record<string, unknown>): RemoteStepResult {
  switch (outcome.kind) {
    case "permission_denied":
      return failure("permission_denied", "the user denied the required permission")
    case "cancelled":
      return failure("cancelled", "the user cancelled the capture")
    case "unsupported":
      return failure("unsupported", "this device does not support the facility")
    default:
      return failure(
        "error",
        typeof outcome.message === "string" ? outcome.message : "device execution failed"
      )
  }
}

async function runCamera(params: Record<string, unknown>): Promise<RemoteStepResult> {
  const { pickPhoto } = await import("@/lib/capacitor/camera")
  const quality = typeof params.quality === "number" ? params.quality : 70
  const width = typeof params.width === "number" ? params.width : 1280
  const outcome = await pickPhoto({ source: "camera", quality, width, resultType: "base64" })
  if (outcome.kind !== "captured") return mapOutcomeFailure(outcome)
  if (!outcome.base64) return failure("error", "capture returned no image data")
  return { ok: true, output: { format: outcome.format, base64: outcome.base64 } }
}

async function runScanBarcode(params: Record<string, unknown>): Promise<RemoteStepResult> {
  const { scan } = await import("@/lib/capacitor/barcode")
  const formats = Array.isArray(params.formats)
    ? (params.formats.filter((f) => typeof f === "string") as string[])
    : undefined
  const outcome = await scan(formats ? { formats } : {})
  if (outcome.kind !== "scanned") return mapOutcomeFailure(outcome)
  return { ok: true, output: { raw: outcome.raw } }
}

async function runLocation(params: Record<string, unknown>): Promise<RemoteStepResult> {
  const { getCurrentPosition } = await import("@/lib/capacitor/geolocation")
  const outcome = await getCurrentPosition({
    enableHighAccuracy: params.enableHighAccuracy === true,
  })
  if (outcome.kind !== "ok") return mapOutcomeFailure(outcome)
  return { ok: true, output: outcome.value }
}

async function runShare(params: Record<string, unknown>): Promise<RemoteStepResult> {
  const { share } = await import("@/lib/capacitor/share")
  const outcome = await share({
    title: typeof params.title === "string" ? params.title : undefined,
    text: typeof params.text === "string" ? params.text : undefined,
    url: typeof params.url === "string" ? params.url : undefined,
  })
  if (outcome.kind !== "shared") return mapOutcomeFailure(outcome)
  return { ok: true, output: { activityType: outcome.activityType ?? null } }
}

async function runNotify(params: Record<string, unknown>): Promise<RemoteStepResult> {
  const { schedule } = await import("@/lib/capacitor/local-notifications")
  const title = typeof params.title === "string" ? params.title : ""
  if (!title) return failure("error", "notify requires a title")
  const outcome = await schedule([
    {
      id: Math.floor(Math.random() * 2_000_000_000),
      title,
      body: typeof params.body === "string" ? params.body : "",
    },
  ])
  if (outcome.kind !== "ok") return mapOutcomeFailure(outcome)
  return { ok: true, output: { notificationIds: outcome.value } }
}

/** Kind → device executor. Keys mirror the hub's proxy node kinds. */
export const MOBILE_STEP_EXECUTORS: Record<string, MobileStepExecutor> = {
  "action.mobile.camera": runCamera,
  "action.mobile.scanBarcode": runScanBarcode,
  "action.mobile.location": runLocation,
  "action.mobile.share": runShare,
  "action.mobile.notify": runNotify,
}

export interface RemoteStepServerTransport {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  subscribe<T>(event: string, handler: (payload: T) => void): () => void
}

export interface RemoteStepServerDeps {
  transport: RemoteStepServerTransport
  /** This device's paired id (`CompanionConfig.deviceId`). */
  getDeviceId: () => string | undefined
  executors?: Record<string, MobileStepExecutor>
  now?: () => number
  receipts?: {
    begin: typeof beginMobileStepReceipt
    persistResult: typeof persistMobileStepResult
    recoverInterrupted: typeof recoverInterruptedMobileSteps
    vacuum: typeof vacuumMobileStepTombstones
  }
}

/**
 * Install the server. Returns a teardown function (boot-provider shape).
 */
export function installRemoteStepServer(deps: RemoteStepServerDeps): () => void {
  const executors = deps.executors ?? MOBILE_STEP_EXECUTORS
  const now = deps.now ?? Date.now
  const receipts = deps.receipts ?? {
    begin: beginMobileStepReceipt,
    persistResult: persistMobileStepResult,
    recoverInterrupted: recoverInterruptedMobileSteps,
    vacuum: vacuumMobileStepTombstones,
  }
  const recoveredDevices = new Set<string>()
  const recoveryByDevice = new Map<string, Promise<void>>()
  let inFlight = false

  const recoverDevice = async (deviceId: string): Promise<void> => {
    if (recoveredDevices.has(deviceId)) return
    const active = recoveryByDevice.get(deviceId)
    if (active) return active
    const recovery = (async () => {
      await receipts.recoverInterrupted(deviceId, chunkRemoteStepResult, now())
      await receipts.vacuum(now()).catch(() => 0)
      recoveredDevices.add(deviceId)
    })().finally(() => recoveryByDevice.delete(deviceId))
    recoveryByDevice.set(deviceId, recovery)
    return recovery
  }

  const logHandlerFailure = (stage: string, error: unknown): void => {
    log.warn(`remote step: ${stage} failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Boot recovery must not depend on the Host replaying another step. An idle
  // restart still converts abandoned native UI work into an interrupted result
  // and vacuums the 24-hour receipt tombstones.
  queueMicrotask(() => {
    const ownId = deps.getDeviceId()
    if (ownId) void recoverDevice(ownId).catch((error) => logHandlerFailure("recovery", error))
  })

  const respond = async (requestId: string, result: RemoteStepResult): Promise<void> => {
    await receipts.persistResult(requestId, chunkRemoteStepResult(requestId, result), now())
  }

  const handle = async (frame: RemoteStepRequest): Promise<void> => {
    const ownId = deps.getDeviceId()
    if (!ownId || frame.targetDeviceId !== ownId) return
    if (typeof frame.requestId !== "string" || !frame.requestId) return
    // Stale replay from the WS ring buffer — the desktop gave up already.
    if (typeof frame.timeoutAt === "number" && now() > frame.timeoutAt) return

    // A receipt left `executing` belongs to an earlier process. Turn it into
    // a terminal interrupted result before looking at the replayed frame; the
    // native camera/share UI must never be opened a second time automatically.
    await recoverDevice(ownId)
    const begin = await receipts.begin({
      requestId: frame.requestId,
      deviceId: ownId,
      kind: frame.kind,
      timeoutAt: frame.timeoutAt,
      now: now(),
    })
    if (!begin.execute) return

    if (inFlight) {
      await respond(
        frame.requestId,
        failure("busy", "another remote step is already running on this device")
      ).catch(() => undefined)
      return
    }

    const executor = executors[frame.kind]
    if (!executor) {
      await respond(
        frame.requestId,
        failure("unsupported", `this device has no executor for ${frame.kind}`)
      ).catch(() => undefined)
      return
    }

    inFlight = true
    try {
      let result: RemoteStepResult
      try {
        result = await executor(frame.params ?? {})
      } catch (err) {
        result = failure("error", err instanceof Error ? err.message : String(err))
      }
      await respond(frame.requestId, result)
    } catch (err) {
      // Persistence failed — do not erase the executing guard and risk a
      // second prompt. Startup recovery will convert it to interrupted.
      log.warn("remote step: result queue persistence failed", {
        requestId: frame.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inFlight = false
    }
  }

  return deps.transport.subscribe<RemoteStepRequest>(STEP_EXECUTE_CHANNEL, (frame) => {
    void handle(frame).catch((error) => logHandlerFailure("request", error))
  })
}
