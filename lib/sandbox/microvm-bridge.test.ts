/**
 * ADR-0028 / T4 — microvm-bridge unit tests.
 */

import {
  __resetMicrovmBridgeForTesting,
  clearActiveSandboxTier,
  getActiveSandboxTier,
  getMicrovmExec,
  setActiveSandboxTier,
  setMicrovmExec,
  type MicrovmExec,
} from "./microvm-bridge"

afterEach(() => {
  __resetMicrovmBridgeForTesting()
})

describe("microvm exec registry", () => {
  it("starts with no registered impl", () => {
    expect(getMicrovmExec()).toBeNull()
  })

  it("setMicrovmExec stores and returns the impl", () => {
    const impl: MicrovmExec = jest.fn(async () => ({
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration: 0,
      timed_out: false,
    }))
    setMicrovmExec(impl)
    expect(getMicrovmExec()).toBe(impl)
  })

  it("setMicrovmExec(null) clears the impl", () => {
    setMicrovmExec(jest.fn() as unknown as MicrovmExec)
    setMicrovmExec(null)
    expect(getMicrovmExec()).toBeNull()
  })
})

describe("active sandbox tier", () => {
  it("defaults unknown sessions to 'os'", () => {
    expect(getActiveSandboxTier("unknown-session")).toBe("os")
    expect(getActiveSandboxTier(null)).toBe("os")
    expect(getActiveSandboxTier(undefined)).toBe("os")
  })

  it("setActiveSandboxTier stores per-session tier", () => {
    setActiveSandboxTier("session-a", "microvm")
    setActiveSandboxTier("session-b", "os")
    expect(getActiveSandboxTier("session-a")).toBe("microvm")
    expect(getActiveSandboxTier("session-b")).toBe("os")
  })

  it("setActiveSandboxTier ignores empty session ids", () => {
    setActiveSandboxTier(null, "microvm")
    setActiveSandboxTier(undefined, "microvm")
    expect(getActiveSandboxTier(null)).toBe("os")
  })

  it("clearActiveSandboxTier drops a session's entry", () => {
    setActiveSandboxTier("session-c", "microvm")
    expect(getActiveSandboxTier("session-c")).toBe("microvm")
    clearActiveSandboxTier("session-c")
    expect(getActiveSandboxTier("session-c")).toBe("os")
  })
})
