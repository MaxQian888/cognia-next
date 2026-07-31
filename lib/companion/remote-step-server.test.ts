/**
 * @jest-environment jsdom
 */
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

import { installRemoteStepServer } from "./remote-step-server"
import {
  STEP_EXECUTE_CHANNEL,
  type RemoteStepRequest,
} from "@/lib/workflow/runtime/remote-step-broker"

function makeHarness(deviceId = "dev-7") {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
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
  const off = installRemoteStepServer({ transport, getDeviceId: () => deviceId })
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
  return { transport, calls, deliver, off }
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
