/**
 * Hub-side proxy executors for `action.mobile.*` (ADR 0061 P3).
 *
 * These run ON THE HUB: they pick a capable paired device (pinned via
 * `params.deviceId`, else the freshest-seen active device whose reported
 * capability manifest covers the node's requirement) and dispatch the step
 * through the remote-step broker. The device's output marshals back as the
 * step output — to downstream nodes a remote step looks exactly like a
 * local one.
 *
 * Failure surface is structured: no capable device → non-retryable step
 * error naming the missing capability; device-side denial/cancel/timeout
 * propagate the broker's error.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { CapabilityId } from "@/lib/platform/capabilities"
import {
  dispatchRemoteStep,
  RemoteStepExecutionError,
} from "@/lib/workflow/runtime/remote-step-broker"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { isPlaceable } from "@/lib/placement/liveness"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

/** Default wait for the device (human may need to point a camera): 120 s. */
const DEFAULT_STEP_TIMEOUT_MS = 120_000

export interface MobileProxyDeps {
  listDevices?: () => Promise<PairedDeviceRow[]>
  dispatch?: typeof dispatchRemoteStep
  now?: () => number
}

function eligible(row: PairedDeviceRow, capability: CapabilityId): boolean {
  if (row.revokedAt !== undefined || row.pausedAt !== undefined) return false
  return Array.isArray(row.capabilities) && row.capabilities.includes(capability)
}

/**
 * Eligible AND actually reachable.
 *
 * Grants and capabilities say a device is *allowed* to run the step; neither
 * says it is switched on. Selecting purely on those is what let a phone last
 * seen days ago win the sort, absorb the dispatch, and block the run for two
 * minutes before failing — with no attempt at the next candidate.
 */
function placeable(row: PairedDeviceRow, capability: CapabilityId, now: number): boolean {
  if (!eligible(row, capability)) return false
  return isPlaceable({ online: true, lastSeenAt: row.lastSeenAt ?? 0, source: "request" }, now)
}

/**
 * Resolve the target devices for a capability, freshest first.
 *
 * Returns an ordered list rather than one winner so the caller can fail over:
 * a device can go offline between selection and dispatch, and with a single
 * pick that means the whole step fails while an idle, capable phone sits
 * unused.
 */
export async function selectTargetDevices(
  capability: CapabilityId,
  pinnedDeviceId: string | undefined,
  deps: MobileProxyDeps = {}
): Promise<PairedDeviceRow[]> {
  const rows = await (deps.listDevices ?? listPairedDevices)()
  const now = (deps.now ?? Date.now)()
  if (pinnedDeviceId) {
    const pinned = rows.find((r) => r.deviceId === pinnedDeviceId)
    if (!pinned) throw new Error(`paired device ${pinnedDeviceId} not found`)
    if (!eligible(pinned, capability)) {
      throw new Error(
        `paired device ${pinnedDeviceId} is not eligible (revoked/paused or missing '${capability}')`
      )
    }
    if (!placeable(pinned, capability, now)) {
      throw new Error(
        `paired device ${pinnedDeviceId} has not been seen recently — open the app on it and retry`
      )
    }
    return [pinned]
  }
  const candidates = rows.filter((r) => placeable(r, capability, now))
  if (candidates.length === 0) {
    const eligibleButStale = rows.some((r) => eligible(r, capability))
    throw new Error(
      eligibleButStale
        ? `every paired device with the '${capability}' capability is offline — open the app on one and retry`
        : `no paired device reports the '${capability}' capability — pair a phone (and let it connect once) first`
    )
  }
  candidates.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  return candidates
}

/** Single-target convenience for callers that cannot fail over. */
export async function selectTargetDevice(
  capability: CapabilityId,
  pinnedDeviceId: string | undefined,
  deps: MobileProxyDeps = {}
): Promise<PairedDeviceRow> {
  return (await selectTargetDevices(capability, pinnedDeviceId, deps))[0]!
}

/** Generic proxy: strip routing params, dispatch, wrap the device output. */
export async function runMobileStep(
  ctx: StepExecutionContext,
  kind: string,
  capability: CapabilityId,
  deps: MobileProxyDeps = {}
): Promise<StepExecutionResult> {
  const params = { ...(ctx.params as Record<string, unknown>) }
  const pinned =
    typeof params.deviceId === "string" && params.deviceId ? params.deviceId : undefined
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_STEP_TIMEOUT_MS
  delete params.deviceId
  delete params.timeoutMs

  const devices = await selectTargetDevices(capability, pinned, deps)
  const dispatch = deps.dispatch ?? dispatchRemoteStep
  const deadline = (deps.now ?? Date.now)() + timeoutMs

  let lastError: unknown
  for (const device of devices) {
    ctx.log("info", `Dispatching ${kind} to device ${device.deviceId} (${device.label})`)
    try {
      const remainingMs = deadline - (deps.now ?? Date.now)()
      if (remainingMs <= 0) {
        throw new RemoteStepExecutionError("timeout", true, `mobile step ${kind} timed out`)
      }
      const output = await dispatch({
        targetDeviceId: device.deviceId,
        kind,
        params,
        runId: ctx.runId,
        stepId: ctx.stepId,
        workflowId: ctx.workflowId,
        timeoutMs: remainingMs,
        signal: ctx.signal,
      })
      return { output: { deviceId: device.deviceId, ...(output as Record<string, unknown>) } }
    } catch (error) {
      // A cancelled run must not silently walk the rest of the fleet, and a
      // device-side denial is an answer, not an outage — neither is retryable
      // somewhere else. Everything else (the device went offline between
      // selection and dispatch, the broker timed out) is worth the next
      // candidate rather than failing a step an idle phone could have run.
      if (ctx.signal?.aborted || !(error instanceof RemoteStepExecutionError) || !error.retryable) {
        throw error
      }
      lastError = error
      ctx.log(
        "warn",
        `Device ${device.deviceId} could not run ${kind}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`no paired device could run ${kind}`)
}

export const runMobileCamera = (ctx: StepExecutionContext, deps?: MobileProxyDeps) =>
  runMobileStep(ctx, "action.mobile.camera", "camera", deps)
export const runMobileScanBarcode = (ctx: StepExecutionContext, deps?: MobileProxyDeps) =>
  runMobileStep(ctx, "action.mobile.scanBarcode", "barcode-scan", deps)
export const runMobileLocation = (ctx: StepExecutionContext, deps?: MobileProxyDeps) =>
  runMobileStep(ctx, "action.mobile.location", "geolocation", deps)
export const runMobileShare = (ctx: StepExecutionContext, deps?: MobileProxyDeps) =>
  runMobileStep(ctx, "action.mobile.share", "share-sheet", deps)
export const runMobileNotify = (ctx: StepExecutionContext, deps?: MobileProxyDeps) =>
  runMobileStep(ctx, "action.mobile.notify", "push-display", deps)
