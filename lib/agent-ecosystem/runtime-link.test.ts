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
    ["opencode", "opencode-server"],
  ])("keeps %s resolving to the preset VENDOR_RUNTIME produced (%s)", (vendor, presetId) => {
    expect(primaryPresetIdForMigrationVendor(vendor)).toBe(presetId)
  })

  it("returns every preset an ecosystem can launch", () => {
    expect(presetIdsForEcosystem("codex")).toEqual(["codex", "codex-app-server"])
    expect(presetIdsForEcosystem("opencode")).toEqual([
      "opencode-server",
      "opencode-acp",
      "opencode-remote",
      "opencode-v2-preview",
    ])
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
