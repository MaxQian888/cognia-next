/**
 * @jest-environment jsdom
 */

import { detectCli, satisfiesMinVersion } from "./detect-cli"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { tray: { warn: jest.fn() } },
}))

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  mockInvoke.mockReset()
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
})

describe("detectCli", () => {
  it("returns the detection result from the native command", async () => {
    mockInvoke.mockResolvedValueOnce({
      available: true,
      version: "cognia 0.1.0",
      path: "/usr/local/bin/cognia",
    })
    const result = await detectCli("cognia")
    expect(mockInvoke).toHaveBeenCalledWith("detect_binary", {
      name: "cognia",
      versionArg: null,
    })
    expect(result).toEqual({
      available: true,
      version: "cognia 0.1.0",
      path: "/usr/local/bin/cognia",
      error: null,
    })
  })

  it("forwards a custom version arg", async () => {
    mockInvoke.mockResolvedValueOnce({ available: true, version: "1.0" })
    await detectCli("node", "-v")
    expect(mockInvoke).toHaveBeenCalledWith("detect_binary", {
      name: "node",
      versionArg: "-v",
    })
  })

  it("short-circuits to available:false error:web outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    const result = await detectCli("cognia")
    expect(result).toEqual({ available: false, version: null, path: null, error: "web" })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("returns available:false when the IPC call throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc down"))
    const result = await detectCli("cognia")
    expect(result.available).toBe(false)
    expect(result.error).toContain("ipc down")
  })
})

describe("satisfiesMinVersion", () => {
  it("returns true when no constraint is given", () => {
    expect(satisfiesMinVersion("cognia 0.1.0")).toBe(true)
  })

  it("returns false when the binary is absent", () => {
    expect(satisfiesMinVersion(null, "0.1.0")).toBe(false)
  })

  it("accepts an equal version", () => {
    expect(satisfiesMinVersion("cognia 0.1.0", "0.1.0")).toBe(true)
  })

  it("accepts a higher version", () => {
    expect(satisfiesMinVersion("git version 2.43.0", "2.0.0")).toBe(true)
  })

  it("rejects a lower version", () => {
    expect(satisfiesMinVersion("cognia 0.1.0", "0.2.0")).toBe(false)
  })

  it("compares minor and patch correctly", () => {
    expect(satisfiesMinVersion("v1.2.3", "1.2.4")).toBe(false)
    expect(satisfiesMinVersion("v1.3.0", "1.2.9")).toBe(true)
  })

  it("is lenient (returns true) when the version string has no semver", () => {
    expect(satisfiesMinVersion("unknown build", "1.0.0")).toBe(true)
  })
})
