/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { runMobileCamera, runMobileStep, selectTargetDevice } from "./mobile"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { StepExecutionContext } from "@/types/workflow/visual"

function device(overrides: Partial<PairedDeviceRow>): PairedDeviceRow {
  return {
    deviceId: "dev-1",
    label: "Phone",
    platform: "ios",
    pubkey: "pk",
    appVersion: "1.0.0",
    pairedAt: 1,
    lastSeenAt: 1,
    capabilities: ["camera", "geolocation"],
    ...overrides,
    allowRemoteTerminal: overrides.allowRemoteTerminal ?? false,
  }
}

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run_m",
    workflowId: "wf_m",
    stepId: "n_m",
    params,
    upstream: {},
    trigger: { workflowId: "wf_m", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: async () => undefined,
  } as unknown as StepExecutionContext
}

describe("selectTargetDevice", () => {
  it("prefers the freshest eligible device", async () => {
    const rows = [
      device({ deviceId: "old", lastSeenAt: 10 }),
      device({ deviceId: "fresh", lastSeenAt: 99 }),
      device({ deviceId: "revoked", lastSeenAt: 200, revokedAt: 5 }),
      device({ deviceId: "paused", lastSeenAt: 300, pausedAt: 5 }),
      device({ deviceId: "no-cap", lastSeenAt: 400, capabilities: ["biometric"] }),
    ]
    const picked = await selectTargetDevice("camera", undefined, { listDevices: async () => rows })
    expect(picked.deviceId).toBe("fresh")
  })

  it("honors a pinned device and validates its eligibility", async () => {
    const rows = [device({ deviceId: "a" }), device({ deviceId: "b", capabilities: [] })]
    const picked = await selectTargetDevice("camera", "a", { listDevices: async () => rows })
    expect(picked.deviceId).toBe("a")
    await expect(
      selectTargetDevice("camera", "b", { listDevices: async () => rows })
    ).rejects.toThrow(/not eligible/)
    await expect(
      selectTargetDevice("camera", "ghost", { listDevices: async () => rows })
    ).rejects.toThrow(/not found/)
  })

  it("fails with a capability-naming error when no device qualifies", async () => {
    await expect(
      selectTargetDevice("camera", undefined, { listDevices: async () => [] })
    ).rejects.toThrow(/no paired device reports the 'camera' capability/)
  })
})

describe("runMobileStep", () => {
  it("strips routing params, dispatches, and wraps the device output", async () => {
    const dispatch = jest.fn(async () => ({ format: "jpeg", base64: "QUJD" }))
    const result = await runMobileCamera(
      makeCtx({ quality: 50, deviceId: "dev-1", timeoutMs: 9_000 }),
      { listDevices: async () => [device({})], dispatch: dispatch as never }
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: "dev-1",
        kind: "action.mobile.camera",
        params: { quality: 50 },
        timeoutMs: 9_000,
        runId: "run_m",
        stepId: "n_m",
      })
    )
    expect(result.output).toEqual({ deviceId: "dev-1", format: "jpeg", base64: "QUJD" })
  })

  it("uses the default timeout when unset", async () => {
    const dispatch = jest.fn(async () => ({}))
    await runMobileStep(makeCtx({}), "action.mobile.location", "geolocation", {
      listDevices: async () => [device({})],
      dispatch: dispatch as never,
    })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120_000 }))
  })

  it("propagates broker failures", async () => {
    const dispatch = jest.fn(async () => {
      throw new Error("remote step failed on device: user cancelled (cancelled)")
    })
    await expect(
      runMobileStep(makeCtx({}), "action.mobile.camera", "camera", {
        listDevices: async () => [device({})],
        dispatch: dispatch as never,
      })
    ).rejects.toThrow(/user cancelled/)
  })
})
