/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const mockGetCurrentPosition = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({
  kind: "ok",
  value: { latitude: 1, longitude: 2, accuracy: 3, timestamp: 4 },
}))
jest.mock("@/lib/capacitor/geolocation", () => ({
  getCurrentPosition: (...a: unknown[]) => mockGetCurrentPosition(...a),
}))
const mockPickPhoto = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({
  kind: "captured",
  base64: "QUJD",
  format: "jpeg",
}))
jest.mock("@/lib/capacitor/camera", () => ({
  pickPhoto: (...a: unknown[]) => mockPickPhoto(...a),
}))
const mockScan = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({
  kind: "scanned",
  raw: "QR-VALUE",
}))
jest.mock("@/lib/capacitor/barcode", () => ({
  scan: (...a: unknown[]) => mockScan(...a),
}))
const mockShare = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({
  kind: "shared",
  activityType: "copy",
}))
jest.mock("@/lib/capacitor/share", () => ({
  share: (...a: unknown[]) => mockShare(...a),
}))
const mockSchedule = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({
  kind: "ok",
  value: [17],
}))
jest.mock("@/lib/capacitor/local-notifications", () => ({
  schedule: (...a: unknown[]) => mockSchedule(...a),
}))

import { installRemoteStepServer, MOBILE_STEP_EXECUTORS } from "./remote-step-server"
import {
  STEP_EXECUTE_CHANNEL,
  type RemoteStepRequest,
  type RemoteStepResult,
} from "@/lib/workflow/runtime/remote-step-broker"

function makeHarness(
  deviceId = "dev-7",
  options: {
    executors?: Record<string, (params: Record<string, unknown>) => Promise<RemoteStepResult>>
    persistResult?: () => Promise<void>
    recoverInterrupted?: () => Promise<number>
  } = {}
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const receiptStatuses = new Map<string, "executing" | "result-pending" | "acknowledged">()
  let handler: ((frame: RemoteStepRequest) => void) | null = null
  const transport = {
    call: jest.fn(async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args: args ?? {} })
      return { ok: true }
    }),
    subscribe: <T>(event: string, h: (payload: T) => void) => {
      expect(event).toBe(STEP_EXECUTE_CHANNEL)
      handler = h as unknown as (frame: RemoteStepRequest) => void
      return () => {
        handler = null
      }
    },
  }
  const receipts = {
    begin: jest.fn(async ({ requestId }: { requestId: string }) => {
      const status = receiptStatuses.get(requestId)
      if (status) return { execute: false as const, status }
      receiptStatuses.set(requestId, "executing")
      return { execute: true as const, receipt: {} as never }
    }),
    persistResult: jest.fn(
      options.persistResult ??
        (async (requestId: string, chunks: Array<Record<string, unknown>>) => {
          receiptStatuses.set(requestId, "result-pending")
          for (const args of chunks) calls.push({ name: "workflow_step_result", args })
        })
    ),
    recoverInterrupted: jest.fn(options.recoverInterrupted ?? (async () => 0)),
    vacuum: jest.fn(async () => 0),
  }
  const off = installRemoteStepServer({
    transport,
    getDeviceId: () => deviceId,
    executors: options.executors,
    receipts: receipts as never,
  })
  const deliver = (frame: Partial<RemoteStepRequest>) => {
    handler?.({
      requestId: "rst_1",
      targetDeviceId: "dev-7",
      kind: "action.mobile.location",
      params: {},
      runId: "run_1",
      stepId: "n_1",
      workflowId: "wf_1",
      issuedAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      ...frame,
    })
  }
  return { transport, calls, deliver, off, receipts, receiptStatuses }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function parseResult(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const chunks = calls.filter((c) => c.name === "workflow_step_result")
  const json = chunks
    .sort((a, b) => (a.args.seq as number) - (b.args.seq as number))
    .map((c) => c.args.chunk as string)
    .join("")
  return JSON.parse(json) as { ok: boolean; output?: unknown; code?: string }
}

beforeEach(() => jest.clearAllMocks())

describe("installRemoteStepServer", () => {
  it("installs with the production receipt store before a device is paired", async () => {
    const unsubscribe = jest.fn()
    const transport = {
      call: jest.fn(),
      subscribe: jest.fn(() => unsubscribe),
    }

    const off = installRemoteStepServer({ transport, getDeviceId: () => undefined })
    await flush()
    off()

    expect(transport.subscribe).toHaveBeenCalledWith(STEP_EXECUTE_CHANNEL, expect.any(Function))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("recovers interrupted work and vacuums tombstones at idle startup", async () => {
    const { receipts, off } = makeHarness()

    await flush()

    expect(receipts.recoverInterrupted).toHaveBeenCalledWith(
      "dev-7",
      expect.any(Function),
      expect.any(Number)
    )
    expect(receipts.vacuum).toHaveBeenCalledWith(expect.any(Number))
    off()
  })

  it("retries recovery after a startup failure before executing a replay", async () => {
    const recoverInterrupted = jest
      .fn<Promise<number>, []>()
      .mockRejectedValueOnce(new Error("database opening"))
      .mockResolvedValueOnce(0)
    const { deliver, receipts, calls, off } = makeHarness("dev-7", { recoverInterrupted })

    await flush()
    deliver({ requestId: "rst-after-recovery" })
    await flush()

    expect(receipts.recoverInterrupted).toHaveBeenCalledTimes(2)
    expect(calls.some((call) => call.args.requestId === "rst-after-recovery")).toBe(true)
    off()
  })

  it("executes a location step addressed to this device and responds", async () => {
    const { calls, deliver, off } = makeHarness()
    deliver({ kind: "action.mobile.location", params: { enableHighAccuracy: true } })
    await flush()
    expect(mockGetCurrentPosition).toHaveBeenCalledWith({ enableHighAccuracy: true })
    const result = parseResult(calls)
    expect(result).toEqual({
      ok: true,
      output: { latitude: 1, longitude: 2, accuracy: 3, timestamp: 4 },
    })
    expect(calls[0].args.requestId).toBe("rst_1")
    off()
  })

  it("ignores frames addressed to other devices", async () => {
    const { calls, deliver, off } = makeHarness()
    deliver({ targetDeviceId: "dev-OTHER" })
    await flush()
    expect(calls).toHaveLength(0)
    off()
  })

  it("drops duplicate and stale replayed frames", async () => {
    const { calls, deliver, off } = makeHarness()
    deliver({ requestId: "rst_dup" })
    await flush()
    deliver({ requestId: "rst_dup" })
    deliver({ requestId: "rst_stale", timeoutAt: Date.now() - 1 })
    await flush()
    expect(calls.filter((c) => c.args.requestId === "rst_dup").length).toBeGreaterThan(0)
    expect(calls.some((c) => c.args.requestId === "rst_stale")).toBe(false)
    // Only one execution happened.
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1)
    off()
  })

  it("recovers a previous-process execution as interrupted before replay", async () => {
    const { calls, deliver, off, receipts, receiptStatuses } = makeHarness()
    receiptStatuses.set("rst-crashed", "executing")
    receipts.recoverInterrupted.mockImplementationOnce(async (_deviceId, makeChunks) => {
      const chunks = makeChunks("rst-crashed", {
        ok: false,
        code: "interrupted",
        message: "device restarted",
      })
      receiptStatuses.set("rst-crashed", "result-pending")
      for (const args of chunks) calls.push({ name: "workflow_step_result", args })
      return 1
    })

    deliver({ requestId: "rst-crashed", kind: "action.mobile.camera" })
    await flush()

    expect(mockPickPhoto).not.toHaveBeenCalled()
    expect(parseResult(calls)).toMatchObject({ ok: false, code: "interrupted" })
    off()
  })

  it("answers busy while another step is in flight", async () => {
    let release: (v: unknown) => void = () => undefined
    mockGetCurrentPosition.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    )
    const { calls, deliver, off } = makeHarness()
    deliver({ requestId: "rst_slow" })
    await flush()
    deliver({ requestId: "rst_second" })
    await flush()
    const busy = calls.filter((c) => c.args.requestId === "rst_second")
    expect(JSON.parse(busy.map((c) => c.args.chunk as string).join(""))).toMatchObject({
      ok: false,
      code: "busy",
    })
    release({ kind: "ok", value: { latitude: 0, longitude: 0, accuracy: 0, timestamp: 0 } })
    await flush()
    off()
  })

  it("answers unsupported for unknown kinds", async () => {
    const { calls, deliver, off } = makeHarness()
    deliver({ kind: "action.mobile.teleport" })
    await flush()
    expect(parseResult(calls)).toMatchObject({ ok: false, code: "unsupported" })
    off()
  })

  it("maps outcome façade failures to structured codes", async () => {
    mockPickPhoto.mockResolvedValueOnce({ kind: "permission_denied" })
    const { calls, deliver, off } = makeHarness()
    deliver({ kind: "action.mobile.camera" })
    await flush()
    expect(parseResult(calls)).toMatchObject({ ok: false, code: "permission_denied" })
    off()
  })

  it("covers every device outcome and validates camera output", async () => {
    mockPickPhoto.mockResolvedValueOnce({ kind: "captured", format: "jpeg" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.camera"]({})).resolves.toMatchObject({
      ok: false,
      code: "error",
    })

    mockPickPhoto.mockResolvedValueOnce({ kind: "cancelled" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.camera"]({})).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
    })

    mockPickPhoto.mockResolvedValueOnce({ kind: "unsupported" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.camera"]({})).resolves.toMatchObject({
      ok: false,
      code: "unsupported",
    })

    mockPickPhoto.mockResolvedValueOnce({ kind: "native_error", message: "camera failed" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.camera"]({})).resolves.toMatchObject({
      ok: false,
      code: "error",
      message: "camera failed",
    })
  })

  it("executes share and notification facilities with validated params", async () => {
    await expect(
      MOBILE_STEP_EXECUTORS["action.mobile.share"]({
        title: "Title",
        text: "Body",
        url: "https://example.com",
      })
    ).resolves.toEqual({ ok: true, output: { activityType: "copy" } })
    expect(mockShare).toHaveBeenCalledWith({
      title: "Title",
      text: "Body",
      url: "https://example.com",
    })

    await expect(MOBILE_STEP_EXECUTORS["action.mobile.notify"]({})).resolves.toMatchObject({
      ok: false,
      code: "error",
    })
    await expect(
      MOBILE_STEP_EXECUTORS["action.mobile.notify"]({ title: "Ready", body: "Done" })
    ).resolves.toEqual({ ok: true, output: { notificationIds: [17] } })
    expect(mockSchedule).toHaveBeenCalledWith([
      expect.objectContaining({ title: "Ready", body: "Done" }),
    ])

    mockSchedule.mockResolvedValueOnce({ kind: "permission_denied" })
    await expect(
      MOBILE_STEP_EXECUTORS["action.mobile.notify"]({ title: "Blocked" })
    ).resolves.toMatchObject({ ok: false, code: "permission_denied" })
  })

  it("applies facility defaults and maps non-camera failures", async () => {
    mockScan.mockResolvedValueOnce({ kind: "cancelled" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.scanBarcode"]({})).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
    })
    expect(mockScan).toHaveBeenCalledWith({})

    mockGetCurrentPosition.mockResolvedValueOnce({ kind: "unsupported" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.location"]({})).resolves.toMatchObject({
      ok: false,
      code: "unsupported",
    })
    expect(mockGetCurrentPosition).toHaveBeenCalledWith({ enableHighAccuracy: false })

    mockShare.mockResolvedValueOnce({ kind: "shared" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.share"]({})).resolves.toEqual({
      ok: true,
      output: { activityType: null },
    })
    expect(mockShare).toHaveBeenCalledWith({ title: undefined, text: undefined, url: undefined })

    mockShare.mockResolvedValueOnce({ kind: "native_error" })
    await expect(MOBILE_STEP_EXECUTORS["action.mobile.share"]({})).resolves.toMatchObject({
      ok: false,
      code: "error",
      message: "device execution failed",
    })

    await MOBILE_STEP_EXECUTORS["action.mobile.camera"]({ quality: 90, width: 640 })
    expect(mockPickPhoto).toHaveBeenLastCalledWith({
      source: "camera",
      quality: 90,
      width: 640,
      resultType: "base64",
    })

    await MOBILE_STEP_EXECUTORS["action.mobile.notify"]({ title: "No body", body: 42 })
    expect(mockSchedule).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: "No body", body: "" }),
    ])
  })

  it("turns thrown executors into durable error results", async () => {
    const { calls, deliver, off } = makeHarness("dev-7", {
      executors: {
        "action.mobile.location": jest.fn().mockRejectedValue(new Error("native crash")),
      },
    })

    deliver({})
    await flush()

    expect(parseResult(calls)).toMatchObject({ ok: false, code: "error" })
    off()
  })

  it("keeps the server usable after durable result persistence fails", async () => {
    const persistResult = jest.fn().mockRejectedValue(new Error("disk full"))
    const { deliver, off, receipts } = makeHarness("dev-7", { persistResult })

    deliver({ requestId: "rst-persist-fail" })
    await flush()

    expect(receipts.persistResult).toHaveBeenCalledTimes(1)
    off()
  })

  it("chunks large camera captures across multiple RPC calls", async () => {
    mockPickPhoto.mockResolvedValueOnce({
      kind: "captured",
      base64: "A".repeat(100_000),
      format: "jpeg",
    })
    const { calls, deliver, off } = makeHarness()
    deliver({ kind: "action.mobile.camera" })
    await flush()
    const chunks = calls.filter((c) => c.name === "workflow_step_result")
    expect(chunks.length).toBeGreaterThan(1)
    expect(parseResult(calls)).toMatchObject({ ok: true })
    off()
  })

  it("scans barcodes with the requested formats", async () => {
    const { calls, deliver, off } = makeHarness()
    deliver({ kind: "action.mobile.scanBarcode", params: { formats: ["QR_CODE", 42] } })
    await flush()
    expect(mockScan).toHaveBeenCalledWith({ formats: ["QR_CODE"] })
    expect(parseResult(calls)).toEqual({ ok: true, output: { raw: "QR-VALUE" } })
    off()
  })
})
