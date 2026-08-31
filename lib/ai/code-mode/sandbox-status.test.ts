const mockCall = jest.fn()
const mockUpdateAvailability = jest.fn()
jest.mock("@/lib/tauri", () => ({ transport: { call: (...a: unknown[]) => mockCall(...a) } }))
jest.mock("@/lib/sandbox/runtime-availability", () => ({
  updateOsSandboxAvailability: (...a: unknown[]) => mockUpdateAvailability(...a),
}))

import {
  __resetCodeSandboxStatus,
  codeSandboxStatus,
  refreshCodeSandboxStatus,
} from "./sandbox-status"

beforeEach(() => {
  mockCall.mockReset()
  mockUpdateAvailability.mockReset()
  __resetCodeSandboxStatus()
})

describe("codeSandboxStatus", () => {
  it("uses the ACTIVE confinement probe, not the cheap availability one", async () => {
    mockCall.mockResolvedValue({ confined: true, backend: "linux-bwrap", detail: "ok" })
    await codeSandboxStatus()
    // The cheap `sandbox_health_probe` reports a present-but-broken backend as
    // available; only `sandbox_health_check` proves confinement is enforced.
    expect(mockCall).toHaveBeenCalledWith("sandbox_health_check")
  })

  it("reports confinement when the probe confirms it", async () => {
    mockCall.mockResolvedValue({ confined: true, backend: "macos-sandbox-exec", detail: "ok" })
    await expect(codeSandboxStatus()).resolves.toEqual({
      confined: true,
      backend: "macos-sandbox-exec",
      detail: "ok",
    })
    expect(mockUpdateAvailability).toHaveBeenCalledWith({
      confined: true,
      backend: "macos-sandbox-exec",
      detail: "ok",
    })
  })

  it("reports a present-but-broken backend as unconfined", async () => {
    mockCall.mockResolvedValue({
      confined: false,
      backend: "linux-bwrap",
      detail: "profile rejected",
    })
    await expect(codeSandboxStatus()).resolves.toMatchObject({ confined: false })
  })

  it("treats only an exact true as confined", async () => {
    mockCall.mockResolvedValue({ confined: "yes", backend: "x" })
    await expect(codeSandboxStatus()).resolves.toMatchObject({ confined: false })
  })

  // Web and mobile have no such command; an IPC failure is the fail-closed
  // answer, not an unknown one.
  it("reports unconfined when the host has no such command", async () => {
    mockCall.mockRejectedValue(new Error("command not found"))
    await expect(codeSandboxStatus()).resolves.toEqual({
      confined: false,
      backend: "",
      detail: "command not found",
    })
    expect(mockUpdateAvailability).toHaveBeenCalledWith({
      confined: false,
      backend: "",
      detail: "command not found",
    })
  })

  it("handles an empty probe payload", async () => {
    mockCall.mockResolvedValue(undefined)
    await expect(codeSandboxStatus()).resolves.toEqual({ confined: false, backend: "", detail: "" })
  })

  it("probes once per app session", async () => {
    mockCall.mockResolvedValue({ confined: true })
    await Promise.all([codeSandboxStatus(), codeSandboxStatus(), codeSandboxStatus()])
    expect(mockCall).toHaveBeenCalledTimes(1)
  })
})

describe("refreshCodeSandboxStatus", () => {
  it("re-runs the probe and replaces the cached answer", async () => {
    mockCall.mockResolvedValueOnce({ confined: false, detail: "not installed" })
    await expect(codeSandboxStatus()).resolves.toMatchObject({ confined: false })

    mockCall.mockResolvedValueOnce({ confined: true, backend: "linux-bwrap" })
    await expect(refreshCodeSandboxStatus()).resolves.toMatchObject({ confined: true })
    await expect(codeSandboxStatus()).resolves.toMatchObject({ confined: true })
    expect(mockCall).toHaveBeenCalledTimes(2)
  })
})
