import type { PerformanceHostAdapter } from "./host-adapter"
import {
  registerPerformanceHostAdapter,
  resetPerformanceHostAdapterForTesting,
} from "./host-adapter"
import { dispatchPerformanceHostCommand, isPerformanceHostCommand } from "./host-dispatch"

jest.mock("@/lib/platform/detect", () => ({ detectPlatform: () => "headless" }))

const adapter: jest.Mocked<PerformanceHostAdapter> = {
  open: jest.fn(),
  renew: jest.fn(),
  close: jest.fn(),
  snapshot: jest.fn(),
  readObservations: jest.fn(),
  stop: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  resetPerformanceHostAdapterForTesting()
  registerPerformanceHostAdapter(adapter)
})

afterEach(resetPerformanceHostAdapterForTesting)

it("recognizes only the selected-host lease contract", () => {
  expect(isPerformanceHostCommand("perf_open_lease")).toBe(true)
  expect(isPerformanceHostCommand("perf_system_details")).toBe(true)
  expect(isPerformanceHostCommand("perf_start_sampling")).toBe(false)
  expect(isPerformanceHostCommand("perf_reset_hotspots")).toBe(false)
})

it("reports unsupported Node-only capability gaps instead of empty evidence", async () => {
  await expect(
    dispatchPerformanceHostCommand("perf_hotspots", { callerDeviceId: "device" })
  ).rejects.toThrow(/unsupported: runtime\.dial9/)
  await expect(
    dispatchPerformanceHostCommand("perf_list_traces", { callerDeviceId: "device" })
  ).rejects.toThrow(/unsupported: host traces/)
  await expect(
    dispatchPerformanceHostCommand("perf_trace_open", {
      callerDeviceId: "device",
      traceId: "opaque",
    })
  ).rejects.toThrow(/unsupported: trace transfer/)
})

it("binds lease operations to the authenticated caller device", async () => {
  adapter.open.mockResolvedValue({ accepted: false, code: "unsupported", detail: "test" })
  await dispatchPerformanceHostCommand("perf_open_lease", {
    callerDeviceId: "verified-device",
    input: {
      clientId: "client",
      deviceId: "spoofed-device",
      targetId: "target",
      routingGeneration: 2,
      purpose: "live",
      requestedCadenceMs: 500,
    },
  })
  expect(adapter.open).toHaveBeenCalledWith(
    expect.objectContaining({ deviceId: "verified-device" })
  )

  await dispatchPerformanceHostCommand("perf_renew_lease", {
    callerDeviceId: "verified-device",
    leaseId: "lease-1",
  })
  expect(adapter.renew).toHaveBeenCalledWith("lease-1", "verified-device")
})

it("rejects missing caller identity and malformed cursors", async () => {
  await expect(
    dispatchPerformanceHostCommand("perf_close_lease", { leaseId: "lease" })
  ).rejects.toThrow(/callerDeviceId is required/)
  await expect(
    dispatchPerformanceHostCommand("perf_read_observations", {
      callerDeviceId: "device",
      leaseId: "lease",
      afterSequence: 1.5,
    })
  ).rejects.toThrow(/safe integer/)
})
