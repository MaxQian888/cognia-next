import {
  pnpmProbeCommand,
  probePnpmVirtualStore,
  readVirtualStoreState,
} from "./pnpm-virtual-store"

describe("pnpmProbeCommand", () => {
  it("quotes the resolved binary and labels each value", () => {
    const command = pnpmProbeCommand("/opt/my tools/pnpm")
    expect(command).toContain('"/opt/my tools/pnpm" config get virtualStoreType')
    expect(command).toContain("cognia-vst:")
    expect(command).toContain("cognia-egvs:")
  })

  it("falls back to the PATH name rather than emitting an unquotable path", () => {
    expect(pnpmProbeCommand('/tmp/we"ird/pnpm')).toContain('"pnpm" config get')
  })
})

describe("readVirtualStoreState", () => {
  it("reads the global virtual store as enabled", () => {
    expect(readVirtualStoreState("11.23.0", true, "cognia-vst:global\ncognia-egvs:undefined")).toBe(
      "enabled"
    )
  })

  it("accepts the legacy flag pnpm 11.23 replaced but kept working", () => {
    expect(readVirtualStoreState("11.24.1", true, "cognia-vst:undefined\ncognia-egvs:true")).toBe(
      "enabled"
    )
  })

  it("reports a new-enough pnpm with the setting off as available", () => {
    expect(readVirtualStoreState("11.23.0", true, "cognia-vst:project\ncognia-egvs:false")).toBe(
      "available"
    )
  })

  it("ignores pnpm's own chatter around the marked lines", () => {
    const noisy = [
      " WARN  Unsupported engine",
      "cognia-vst:global",
      "Update available! 11.23.0 -> 11.25.0",
      "cognia-egvs:undefined",
    ].join("\n")
    expect(readVirtualStoreState("11.23.0", true, noisy)).toBe("enabled")
  })

  it("reports an absent or too-old pnpm as unsupported", () => {
    expect(readVirtualStoreState(null, false, "")).toBe("unsupported")
    expect(readVirtualStoreState("11.18.0", false, "cognia-vst:global")).toBe("unsupported")
  })
})

describe("probePnpmVirtualStore", () => {
  const detected = { available: true, version: "11.23.0", path: "/usr/bin/pnpm" }

  it("never spawns the config read when pnpm is too old", async () => {
    const run = jest.fn()
    const state = await probePnpmVirtualStore("/repo", {
      detect: async () => ({ available: true, version: "11.18.0", path: "/usr/bin/pnpm" }),
      meetsMinimum: async () => false,
      run,
    })
    expect(state).toBe("unsupported")
    expect(run).not.toHaveBeenCalled()
  })

  it("runs the probe in the workspace root so a repository-level setting counts", async () => {
    const run = jest.fn(async () => "cognia-vst:global")
    const state = await probePnpmVirtualStore("/repo", {
      detect: async () => detected,
      meetsMinimum: async () => true,
      run,
    })
    expect(state).toBe("enabled")
    expect(run).toHaveBeenCalledWith(expect.stringContaining("virtualStoreType"), "/repo")
  })

  it("degrades to unknown instead of throwing when the probe fails", async () => {
    const state = await probePnpmVirtualStore("/repo", {
      detect: async () => detected,
      meetsMinimum: async () => true,
      run: async () => {
        throw new Error("no shell here")
      },
    })
    expect(state).toBe("unknown")
  })
})
