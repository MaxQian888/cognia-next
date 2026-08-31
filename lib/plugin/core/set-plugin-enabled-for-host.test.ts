/**
 * @jest-environment jsdom
 */

const mockToggle = jest.fn()
const mockEnqueue = jest.fn()
const mockUpdate = jest.fn()
const mockIsCapacitor = jest.fn()
const mockHasWebCompanionTarget = jest.fn()
const mockRecordAnalytic = jest.fn()

jest.mock("./toggle-plugin-enabled", () => ({
  togglePluginEnabled: (...args: unknown[]) => mockToggle(...args),
}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ plugins: { update: (...args: unknown[]) => mockUpdate(...args) } }),
}))
jest.mock("@/lib/platform/detect", () => ({
  isCapacitor: () => mockIsCapacitor(),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => mockHasWebCompanionTarget(),
}))
jest.mock("@/lib/plugin/analytics/record", () => ({
  PLUGIN_ANALYTIC_KEYS: { enabled: "lifecycle.enabled", disabled: "lifecycle.disabled" },
  recordPluginAnalytic: (...args: unknown[]) => mockRecordAnalytic(...args),
}))

import { isMirroredPluginClient, setPluginEnabledForHost } from "./set-plugin-enabled-for-host"

beforeEach(() => {
  mockToggle.mockReset().mockResolvedValue({ ok: true })
  mockEnqueue.mockReset().mockResolvedValue(undefined)
  mockUpdate.mockReset().mockResolvedValue(1)
  mockIsCapacitor.mockReset().mockReturnValue(false)
  mockHasWebCompanionTarget.mockReset().mockReturnValue(false)
  mockRecordAnalytic.mockReset()
})

describe("isMirroredPluginClient", () => {
  it("is false on a desktop or standalone browser", () => {
    expect(isMirroredPluginClient()).toBe(false)
  })

  it("is true on Capacitor", () => {
    mockIsCapacitor.mockReturnValue(true)
    expect(isMirroredPluginClient()).toBe(true)
  })

  it("is true for a browser paired to a cognia-server", () => {
    mockHasWebCompanionTarget.mockReturnValue(true)
    expect(isMirroredPluginClient()).toBe(true)
  })
})

describe("setPluginEnabledForHost", () => {
  it("drives the local manager when this host owns the runtime", async () => {
    const result = await setPluginEnabledForHost("p1", true)
    expect(mockToggle).toHaveBeenCalledWith("p1", true, "manual")
    expect(result).toEqual({ ok: true, queued: false })
    // The authority must never queue a job for itself. `discover-inspector`
    // used to do exactly that on desktop.
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("forwards the caller's reason to the manager", async () => {
    await setPluginEnabledForHost("p1", false, "batch")
    expect(mockToggle).toHaveBeenCalledWith("p1", false, "batch")
  })

  it("propagates a manager failure without claiming it was queued", async () => {
    mockToggle.mockResolvedValue({ ok: false, error: "activate failed" })
    await expect(setPluginEnabledForHost("p1", true)).resolves.toEqual({
      ok: false,
      queued: false,
      error: "activate failed",
    })
  })

  it("writes the mirror row and queues the host command on a companion", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const result = await setPluginEnabledForHost("p1", true)
    expect(result).toEqual({ ok: true, queued: true })
    expect(mockUpdate).toHaveBeenCalledWith("p1", expect.objectContaining({ enabled: true }))
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "plugin_set_enabled",
        payload: { id: "p1", enabled: true },
      })
    )
    // A companion has no local runtime for the host's plugins, so calling the
    // manager there would silently do nothing.
    expect(mockToggle).not.toHaveBeenCalled()
  })

  it("labels the queued job machine-readably rather than with UI copy", async () => {
    mockHasWebCompanionTarget.mockReturnValue(true)
    await setPluginEnabledForHost("p1", false)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ label: "plugin_set_enabled:p1:disabled" })
    )
  })

  it("reports a queue failure instead of throwing at the switch", async () => {
    mockIsCapacitor.mockReturnValue(true)
    mockEnqueue.mockRejectedValue(new Error("queue full"))
    await expect(setPluginEnabledForHost("p1", true)).resolves.toEqual({
      ok: false,
      queued: true,
      error: "queue full",
    })
  })

  // `lib/db/plugin-analytics.ts` had zero importers, so nothing ever wrote a
  // row and Governance's Analytics view could only ever be empty. This is the
  // one place every enable/disable passes through.
  it("records the lifecycle transition for the analytics view", async () => {
    await setPluginEnabledForHost("p1", true)
    expect(mockRecordAnalytic).toHaveBeenCalledWith("p1", "lifecycle.enabled")
    await setPluginEnabledForHost("p1", false)
    expect(mockRecordAnalytic).toHaveBeenCalledWith("p1", "lifecycle.disabled")
  })

  it("records it on a companion too, where the host applies the change", async () => {
    mockIsCapacitor.mockReturnValue(true)
    await setPluginEnabledForHost("p1", true)
    expect(mockRecordAnalytic).toHaveBeenCalledWith("p1", "lifecycle.enabled")
  })
})
