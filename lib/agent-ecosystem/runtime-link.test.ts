import {
  displayNameForEcosystem,
  displayNameForMigrationVendor,
  presetIdsForEcosystem,
  presetIdsForMigrationVendor,
  presetIdsForSessionSource,
  primaryPresetIdForEcosystem,
  primaryPresetIdForMigrationVendor,
} from "./runtime-link"

describe("preset resolution", () => {
  it("resolves Pi to a real preset id", () => {
    // The regression this module was built for. `VENDOR_RUNTIME.pi` was "pi",
    // the runtime id, so nothing downstream resolved.
    expect(primaryPresetIdForMigrationVendor("pi")).toBe("pi-rpc")
  })

  it.each([
    ["claude-code", "claude-code"],
    ["codex", "codex"],
  ])("keeps %s resolving to the preset VENDOR_RUNTIME produced (%s)", (vendor, presetId) => {
    expect(primaryPresetIdForMigrationVendor(vendor)).toBe(presetId)
  })

  it("returns every preset an ecosystem can launch", () => {
    expect(presetIdsForEcosystem("codex")).toEqual(["codex", "codex-app-server"])
  })

  it("expands the DeepSeek runtime's three presets", () => {
    expect(presetIdsForEcosystem("deepseek-harness")).toHaveLength(3)
  })

  it("maps a session source to its ecosystem's presets", () => {
    expect(presetIdsForSessionSource("cursor")).toEqual(["cursor-cli"])
    expect(presetIdsForSessionSource("codex")).toEqual(["codex", "codex-app-server"])
  })

  it("returns an empty list for a history-only source rather than throwing", () => {
    expect(presetIdsForSessionSource("aider")).toEqual([])
    expect(presetIdsForSessionSource("cline")).toEqual([])
  })

  it("returns an empty list for an unknown source or ecosystem", () => {
    expect(presetIdsForSessionSource("nope")).toEqual([])
    expect(presetIdsForEcosystem("nope")).toEqual([])
    expect(presetIdsForMigrationVendor("nope")).toEqual([])
    expect(primaryPresetIdForEcosystem("nope")).toBeNull()
    expect(primaryPresetIdForMigrationVendor("nope")).toBeNull()
  })
})

describe("display names", () => {
  it("reads the name off the runtime catalog", () => {
    expect(displayNameForMigrationVendor("pi")).toBe("Pi (native RPC)")
    expect(displayNameForEcosystem("cursor")).toBe("Cursor Agent CLI")
  })

  it("answers null for a history-only ecosystem instead of a raw slug", () => {
    expect(displayNameForEcosystem("aider")).toBeNull()
    expect(displayNameForMigrationVendor("nope")).toBeNull()
  })
})

describe("current OpenCode runtime resolution", () => {
  it("connects migrated OpenCode agents through the current service preset", () => {
    expect(primaryPresetIdForMigrationVendor("opencode")).toBe("opencode-v2-service")
    expect(primaryPresetIdForEcosystem("opencode")).toBe("opencode-v2-service")
  })

  it("offers only executable OpenCode presets across ecosystem, migration, and session sources", () => {
    const expected = ["opencode-v2-service", "opencode-acp"]
    expect(presetIdsForEcosystem("opencode")).toEqual(expected)
    expect(presetIdsForMigrationVendor("opencode")).toEqual(expected)
    expect(presetIdsForSessionSource("opencode")).toEqual(expected)
  })

  it("labels OpenCode using the current service rather than the retired auto-spawn runtime", () => {
    expect(displayNameForMigrationVendor("opencode")).toBe("OpenCode V2")
    expect(displayNameForEcosystem("opencode")).toBe("OpenCode V2")
  })
})
