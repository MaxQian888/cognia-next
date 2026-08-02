const call = jest.fn()
const subscribe = jest.fn(() => jest.fn())

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: (...args: unknown[]) => call(...(args as [])),
    subscribe: (...args: unknown[]) => subscribe(...(args as [])),
  },
}))

import {
  onRecordEvent,
  RECORD_EVENT_CHANNEL,
  recordDeleteBundle,
  recordInterrupt,
  recordListCaptureTargets,
  recordListRecoverable,
  recordLoadBundle,
  recordPause,
  recordPreflight,
  recordReadAsset,
  recordResume,
  recordStart,
  recordStatus,
  recordStop,
  recordUndoLast,
} from "./recorder-client"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"
const ASSET = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e02"

beforeEach(() => {
  call.mockReset().mockResolvedValue(undefined)
  subscribe.mockClear()
})

describe("command names", () => {
  it("matches the Rust `generate_handler!` registrations exactly", async () => {
    // A typo here is a runtime "Command not found" that no type-check catches,
    // so the names are asserted rather than trusted.
    await recordPreflight()
    await recordPause()
    await recordResume()
    await recordUndoLast()
    await recordStop()
    await recordInterrupt()
    await recordStatus()
    await recordListRecoverable()
    await recordListCaptureTargets()

    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "record_preflight",
      "record_pause",
      "record_resume",
      "record_undo_last",
      "record_stop",
      "record_interrupt",
      "record_status",
      "record_list_recoverable",
      "record_list_capture_targets",
    ])
  })

  it("has no `record_cancel` — ending a recording never destroys its bundle", async () => {
    const client = await import("./recorder-client")
    expect(Object.keys(client)).not.toContain("recordCancel")
  })
})

describe("argument shapes", () => {
  it("wraps the start payload under `args`, as the Tauri command expects", async () => {
    await recordStart({ recordingId: RECORDING, scope: { kind: "desktop" } })
    expect(call).toHaveBeenCalledWith("record_start", {
      args: { recordingId: RECORDING, scope: { kind: "desktop" } },
    })
  })

  it("passes a camelCase recording id to the bundle commands", async () => {
    await recordLoadBundle(RECORDING)
    expect(call).toHaveBeenCalledWith("record_load_bundle", { recordingId: RECORDING })

    await recordDeleteBundle(RECORDING)
    expect(call).toHaveBeenCalledWith("record_delete_bundle", { recordingId: RECORDING })
  })

  it("passes both ids when reading a frame", async () => {
    await recordReadAsset(RECORDING, ASSET)
    expect(call).toHaveBeenCalledWith("record_read_asset", {
      recordingId: RECORDING,
      assetId: ASSET,
    })
  })

  it("sends no payload for the parameterless commands", async () => {
    await recordStatus()
    expect(call).toHaveBeenCalledWith("record_status")
  })
})

describe("event subscription", () => {
  it("subscribes to the channel the Rust side emits on", () => {
    const handler = jest.fn()
    onRecordEvent(handler)
    expect(subscribe).toHaveBeenCalledWith(RECORD_EVENT_CHANNEL, handler)
    expect(RECORD_EVENT_CHANNEL).toBe("record:event")
  })

  it("returns the transport's unlisten function", () => {
    const unlisten = jest.fn()
    subscribe.mockReturnValueOnce(unlisten)
    expect(onRecordEvent(jest.fn())).toBe(unlisten)
  })
})

describe("results", () => {
  it("passes the native reply straight through", async () => {
    call.mockResolvedValueOnce({ ready: true, blockers: [] })
    await expect(recordPreflight()).resolves.toEqual({ ready: true, blockers: [] })
  })

  it("propagates a rejection rather than swallowing it", async () => {
    call.mockRejectedValueOnce(new Error("kill switch is active"))
    await expect(
      recordStart({ recordingId: RECORDING, scope: { kind: "desktop" } })
    ).rejects.toThrow("kill switch is active")
  })
})

describe("capture targets", () => {
  it("takes no arguments — it enumerates, it does not filter server-side", async () => {
    await recordListCaptureTargets()
    expect(call).toHaveBeenCalledWith("record_list_capture_targets")
  })
})
