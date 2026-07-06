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
import { dispatchRemoteStep } from "@/lib/workflow/runtime/remote-step-broker"
import { listPairedDevices } from "@/lib/db/paired-devices"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

/** Default wait for the device (human may need to point a camera): 120 s. */
const DEFAULT_STEP_TIMEOUT_MS = 120_000

export interface MobileProxyDeps {
  listDevices?: () => Promise<PairedDeviceRow[]>
  dispatch?: typeof dispatchRemoteStep
}

function eligible(row: PairedDeviceRow, capability: CapabilityId): boolean {
  if (row.revokedAt !== undefined || row.pausedAt !== undefined) return false
  return Array.isArray(row.capabilities) && row.capabilities.includes(capability)
}

/**
 * Resolve the target device for a capability. Pinned id wins (and is
 * validated); otherwise the most recently seen eligible device.
 */
export async function selectTargetDevice(
  capability: CapabilityId,
  pinnedDeviceId: string | undefined,
  deps: MobileProxyDeps = {}
): Promise<PairedDeviceRow> {
  const rows = await (deps.listDevices ?? listPairedDevices)()
  if (pinnedDeviceId) {
    const pinned = rows.find((r) => r.deviceId === pinnedDeviceId)
    if (!pinned) throw new Error(`paired device ${pinnedDeviceId} not found`)
    if (!eligible(pinned, capability)) {
      throw new Error(
        `paired device ${pinnedDeviceId} is not eligible (revoked/paused or missing '${capability}')`
      )
    }
    return pinned
  }
  const candidates = rows.filter((r) => eligible(r, capability))
  if (candidates.length === 0) {
    throw new Error(
      `no paired device reports the '${capability}' capability — pair a phone (and let it connect once) first`
    )
  }
  candidates.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  return candidates[0]
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

  const device = await selectTargetDevice(capability, pinned, deps)
  ctx.log("info", `Dispatching ${kind} to device ${device.deviceId} (${device.label})`)

  const output = await (deps.dispatch ?? dispatchRemoteStep)({
    targetDeviceId: device.deviceId,
    kind,
    params,
    runId: ctx.runId,
    stepId: ctx.stepId,
    workflowId: ctx.workflowId,
    timeoutMs,
    signal: ctx.signal,
  })

  return { output: { deviceId: device.deviceId, ...(output as Record<string, unknown>) } }
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
