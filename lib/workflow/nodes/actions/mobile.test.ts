/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { runMobileCamera, runMobileStep, selectTargetDevice, selectTargetDevices } from "./mobile"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { RemoteStepExecutionError } from "@/lib/workflow/runtime/remote-step-broker"

const NOW = 1_000_000
const now = () => NOW

function device(overrides: Partial<PairedDeviceRow>): PairedDeviceRow {
  return {
    deviceId: "dev-1",
    label: "Phone",
    platform: "ios",
    pubkey: "pk",
    appVersion: "1.0.0",
    pairedAt: 1,
    lastSeenAt: NOW,
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
      device({ deviceId: "old", lastSeenAt: NOW - 60_000 }),
      device({ deviceId: "fresh", lastSeenAt: NOW - 1_000 }),
      device({ deviceId: "revoked", lastSeenAt: NOW, revokedAt: 5 }),
      device({ deviceId: "paused", lastSeenAt: NOW, pausedAt: 5 }),
      device({ deviceId: "no-cap", lastSeenAt: NOW, capabilities: ["biometric"] }),
    ]
    const picked = await selectTargetDevice("camera", undefined, {
      listDevices: async () => rows,
      now,
    })
    expect(picked.deviceId).toBe("fresh")
  })

  it("skips a capable device that has not been seen in the liveness window", async () => {
    // The bug this closes: selection sorted on `lastSeenAt` but never checked
    // it, so a phone last seen three days ago won, absorbed the dispatch, and
    // blocked the run for 120s before failing — without trying anyone else.
    const rows = [
      device({ deviceId: "stale", lastSeenAt: NOW - 3 * 86_400_000 }),
      device({ deviceId: "live", lastSeenAt: NOW - 5_000 }),
    ]
    const picked = await selectTargetDevices("camera", undefined, {
      listDevices: async () => rows,
      now,
    })
    expect(picked.map((row) => row.deviceId)).toEqual(["live"])
  })

  it("distinguishes 'all offline' from 'never had the capability'", async () => {
    const stale = [device({ deviceId: "stale", lastSeenAt: NOW - 86_400_000 })]
    await expect(
      selectTargetDevice("camera", undefined, { listDevices: async () => stale, now })
    ).rejects.toThrow(/is offline/)
    await expect(
      selectTargetDevice("camera", undefined, { listDevices: async () => [], now })
    ).rejects.toThrow(/no paired device reports the 'camera' capability/)
  })

  it("honors a pinned device and validates its eligibility and liveness", async () => {
    const rows = [
      device({ deviceId: "a" }),
      device({ deviceId: "b", capabilities: [] }),
      device({ deviceId: "asleep", lastSeenAt: NOW - 86_400_000 }),
    ]
    const picked = await selectTargetDevice("camera", "a", { listDevices: async () => rows, now })
    expect(picked.deviceId).toBe("a")
    await expect(
      selectTargetDevice("camera", "b", { listDevices: async () => rows, now })
    ).rejects.toThrow(/not eligible/)
    await expect(
      selectTargetDevice("camera", "ghost", { listDevices: async () => rows, now })
    ).rejects.toThrow(/not found/)
    // A pinned device names one machine, so there is nowhere to fail over to —
    // saying it is stale beats a 120s wait that ends in a timeout.
    await expect(
      selectTargetDevice("camera", "asleep", { listDevices: async () => rows, now })
    ).rejects.toThrow(/not been seen recently/)
  })
})

describe("runMobileStep", () => {
  it("strips routing params, dispatches, and wraps the device output", async () => {
    const dispatch = jest.fn(async () => ({ format: "jpeg", base64: "QUJD" }))
    const result = await runMobileCamera(
      makeCtx({ quality: 50, deviceId: "dev-1", timeoutMs: 9_000 }),
      { listDevices: async () => [device({})], dispatch: dispatch as never, now }
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
      now,
    })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120_000 }))
  })

  it("does not shop a device-side denial around the rest of the fleet", async () => {
    // A cancel is the device's answer, not an outage. Retrying elsewhere would
    // put the same prompt on a second phone the user never touched.
    const dispatch = jest.fn(async () => {
      throw new RemoteStepExecutionError("cancelled", false, "user cancelled")
    })
    await expect(
      runMobileStep(makeCtx({}), "action.mobile.camera", "camera", {
        listDevices: async () => [device({ deviceId: "a" }), device({ deviceId: "b" })],
        dispatch: dispatch as never,
        now,
      })
    ).rejects.toThrow(/user cancelled/)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("fails over to the next live device when one drops mid-dispatch", async () => {
    // Liveness is a snapshot; a phone can go dark between selection and
    // dispatch. Failing the whole step then, with an idle capable phone
    // available, is the outcome this avoids.
    const dispatch = jest.fn(async ({ targetDeviceId }: { targetDeviceId: string }) => {
      if (targetDeviceId === "a") {
        throw new RemoteStepExecutionError("dispatch_failed", true, "device disconnected")
      }
      return { ok: true }
    })
    const result = await runMobileStep(makeCtx({}), "action.mobile.camera", "camera", {
      listDevices: async () => [
        device({ deviceId: "a", lastSeenAt: NOW }),
        device({ deviceId: "b", lastSeenAt: NOW - 1_000 }),
      ],
      dispatch: dispatch as never,
      now,
    })

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(result.output).toEqual({ deviceId: "b", ok: true })
  })

  it("surfaces the last failure when every candidate fails", async () => {
    const dispatch = jest.fn(async () => {
      throw new RemoteStepExecutionError("timeout", true, "remote step timed out")
    })
    await expect(
      runMobileStep(makeCtx({}), "action.mobile.camera", "camera", {
        listDevices: async () => [device({ deviceId: "a" }), device({ deviceId: "b" })],
        dispatch: dispatch as never,
        now,
      })
    ).rejects.toThrow(/timed out/)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it("stops walking candidates once the run is cancelled", async () => {
    const controller = new AbortController()
    const dispatch = jest.fn(async () => {
      controller.abort()
      throw new RemoteStepExecutionError("timeout", true, "remote step timed out")
    })
    const ctx = { ...makeCtx({}), signal: controller.signal } as StepExecutionContext
    await expect(
      runMobileStep(ctx, "action.mobile.camera", "camera", {
        listDevices: async () => [device({ deviceId: "a" }), device({ deviceId: "b" })],
        dispatch: dispatch as never,
        now,
      })
    ).rejects.toThrow(/timed out/)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("does not fail over after a device restart interrupted native UI", async () => {
    const dispatch = jest.fn(async () => {
      throw new RemoteStepExecutionError("interrupted", false, "device restarted")
    })
    await expect(
      runMobileStep(makeCtx({}), "action.mobile.camera", "camera", {
        listDevices: async () => [device({ deviceId: "a" }), device({ deviceId: "b" })],
        dispatch: dispatch as never,
        now,
      })
    ).rejects.toMatchObject({ code: "interrupted", retryable: false })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
