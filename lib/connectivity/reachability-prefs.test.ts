/**
 * @jest-environment jsdom
 */

const mockIsTauri = jest.fn(() => true)
const mockCall = jest.fn(async (..._args: unknown[]) => undefined as unknown)

jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => mockIsTauri(),
}))
jest.mock("@/lib/tauri", () => ({
  localTransport: { call: (...args: unknown[]) => mockCall(...args) },
  transport: {
    call: () => {
      throw new Error("Must use local IPC")
    },
  },
}))

import {
  DEFAULT_REACHABILITY_PREFS,
  loadReachabilityPrefs,
  patchReachabilityPrefs,
  saveReachabilityPrefs,
} from "./reachability-prefs"

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  mockCall.mockReset()
  mockCall.mockResolvedValue(undefined)
})

describe("loadReachabilityPrefs", () => {
  it("returns the saved config merged over the defaults", async () => {
    mockCall.mockResolvedValue({ serverEnabled: true, bindLoopbackOnly: false })

    await expect(loadReachabilityPrefs()).resolves.toEqual({
      ...DEFAULT_REACHABILITY_PREFS,
      serverEnabled: true,
      bindLoopbackOnly: false,
    })
    expect(mockCall).toHaveBeenCalledWith("companion_reachability_get")
  })

  it("reads as all-off off-desktop without calling the command", async () => {
    mockIsTauri.mockReturnValue(false)

    await expect(loadReachabilityPrefs()).resolves.toEqual(DEFAULT_REACHABILITY_PREFS)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("falls back to the defaults when the command throws", async () => {
    mockCall.mockRejectedValue(new Error("no data dir"))

    await expect(loadReachabilityPrefs()).resolves.toEqual(DEFAULT_REACHABILITY_PREFS)
  })
})

describe("the default preference", () => {
  it("binds loopback-only and enables nothing", () => {
    // Pins the fail-safe direction shared with `ReachabilityConfig::default()`:
    // a lost preference must never restore a wider binding than the user chose.
    expect(DEFAULT_REACHABILITY_PREFS.bindLoopbackOnly).toBe(true)
    expect(DEFAULT_REACHABILITY_PREFS.serverEnabled).toBe(false)
    expect(DEFAULT_REACHABILITY_PREFS.mdnsEnabled).toBe(false)
  })
})

describe("saveReachabilityPrefs", () => {
  it("sends the whole record under `config`", async () => {
    const prefs = {
      serverEnabled: true,
      port: 31337,
      bindLoopbackOnly: false,
      mdnsEnabled: true,
    }

    await expect(saveReachabilityPrefs(prefs)).resolves.toBe(true)
    expect(mockCall).toHaveBeenCalledWith("companion_reachability_set", { config: prefs })
  })

  it("reports false rather than throwing when the write fails", async () => {
    // The preference only takes effect at the next boot, so a dropped write
    // has no immediate symptom — the caller has to be able to see it.
    mockCall.mockRejectedValue(new Error("read-only fs"))

    await expect(saveReachabilityPrefs(DEFAULT_REACHABILITY_PREFS)).resolves.toBe(false)
  })

  it("reports false off-desktop", async () => {
    mockIsTauri.mockReturnValue(false)

    await expect(saveReachabilityPrefs(DEFAULT_REACHABILITY_PREFS)).resolves.toBe(false)
    expect(mockCall).not.toHaveBeenCalled()
  })
})

describe("patchReachabilityPrefs", () => {
  it("rejects a failed write so the control cannot report it as saved", async () => {
    mockCall
      .mockResolvedValueOnce(DEFAULT_REACHABILITY_PREFS)
      .mockRejectedValueOnce(new Error("read-only fs"))
    await expect(patchReachabilityPrefs({ mdnsEnabled: true })).rejects.toThrow("read-only fs")
  })

  it("does not overwrite the existing configuration when its read fails", async () => {
    mockCall.mockRejectedValue(new Error("read failed"))
    await expect(patchReachabilityPrefs({ mdnsEnabled: true })).rejects.toThrow("read failed")
    expect(mockCall).toHaveBeenCalledTimes(1)
    expect(mockCall).toHaveBeenCalledWith("companion_reachability_get")
  })

  it("preserves independent fields when two controls save concurrently", async () => {
    let stored = { ...DEFAULT_REACHABILITY_PREFS }
    mockCall.mockImplementation(async (name, args) => {
      if (name === "companion_reachability_get") return { ...stored }
      stored = (args as { config: typeof stored }).config
    })
    await Promise.all([
      patchReachabilityPrefs({ serverEnabled: true }),
      patchReachabilityPrefs({ mdnsEnabled: true }),
    ])
    expect(stored).toEqual({
      ...DEFAULT_REACHABILITY_PREFS,
      serverEnabled: true,
      mdnsEnabled: true,
    })
  })

  it("allows a later patch to succeed after an earlier write failed", async () => {
    mockCall
      .mockResolvedValueOnce(DEFAULT_REACHABILITY_PREFS)
      .mockRejectedValueOnce(new Error("write failed"))
    await expect(patchReachabilityPrefs({ serverEnabled: true })).rejects.toThrow("write failed")
    mockCall.mockResolvedValue(DEFAULT_REACHABILITY_PREFS)
    await expect(patchReachabilityPrefs({ mdnsEnabled: true })).resolves.toEqual({
      ...DEFAULT_REACHABILITY_PREFS,
      mdnsEnabled: true,
    })
  })
  it("merges onto the stored record instead of overwriting it", async () => {
    // The Rust side stores one record: writing only the changed key would
    // reset every other preference to its default.
    mockCall.mockImplementation(async (name: unknown) => {
      if (name === "companion_reachability_get") {
        return { serverEnabled: true, port: 31337, bindLoopbackOnly: false, mdnsEnabled: false }
      }
      return undefined
    })

    await expect(patchReachabilityPrefs({ mdnsEnabled: true })).resolves.toEqual({
      serverEnabled: true,
      port: 31337,
      bindLoopbackOnly: false,
      mdnsEnabled: true,
    })
    expect(mockCall).toHaveBeenCalledWith("companion_reachability_set", {
      config: {
        serverEnabled: true,
        port: 31337,
        bindLoopbackOnly: false,
        mdnsEnabled: true,
      },
    })
  })
})
