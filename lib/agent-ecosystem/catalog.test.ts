import {
  AGENT_ECOSYSTEMS,
  configRootKeyForMigrationVendor,
  findEcosystemById,
  findEcosystemByMigrationVendor,
  findEcosystemByRuntimeId,
  findEcosystemBySessionSource,
  primaryRuntimeIdForMigrationVendor,
  probeRootKeysForMigrationVendor,
  subagentSourceIdForMigrationVendor,
} from "./catalog"

describe("lookups", () => {
  it("finds an ecosystem by its own id", () => {
    expect(findEcosystemById("codex")?.migrationVendor).toBe("codex")
  })

  it("finds an ecosystem by any of its runtime ids", () => {
    expect(findEcosystemByRuntimeId("codex-app-server")?.id).toBe("codex")
    expect(findEcosystemByRuntimeId("opencode-remote")?.id).toBe("opencode")
  })

  it("finds an ecosystem by session source", () => {
    expect(findEcosystemBySessionSource("cline")?.id).toBe("cline")
  })

  it("finds an ecosystem by migration vendor", () => {
    expect(findEcosystemByMigrationVendor("pi")?.id).toBe("pi")
  })

  it.each(["nope", "", "CODEX"])("returns undefined for %p rather than throwing", (id) => {
    expect(findEcosystemById(id)).toBeUndefined()
    expect(findEcosystemByRuntimeId(id)).toBeUndefined()
    expect(findEcosystemBySessionSource(id)).toBeUndefined()
    expect(findEcosystemByMigrationVendor(id)).toBeUndefined()
  })
})

describe("migration vendor accessors", () => {
  it("puts Codex's ACP adapter first so the preset stays the one VENDOR_RUNTIME produced", () => {
    expect(primaryRuntimeIdForMigrationVendor("codex")).toBe("codex-acp")
  })

  it("orders OpenCode's probe roots data-dir first, preserving the old fallback", () => {
    expect(probeRootKeysForMigrationVendor("opencode")).toEqual([
      "opencodeDataDir",
      "opencodeConfigDir",
    ])
  })

  it("points OpenCode's config scans at the config dir, not the data dir", () => {
    // These two split. Reading agents/commands out of the data directory would
    // find nothing and report it as "this vendor has none".
    expect(configRootKeyForMigrationVendor("opencode")).toBe("opencodeConfigDir")
  })

  it("spells Codex's subagent importer id the way the registry does", () => {
    expect(subagentSourceIdForMigrationVendor("codex")).toBe("codex-cli")
  })

  it("answers null for an unknown vendor instead of guessing", () => {
    expect(primaryRuntimeIdForMigrationVendor("nope")).toBeNull()
    expect(configRootKeyForMigrationVendor("nope")).toBeNull()
    expect(subagentSourceIdForMigrationVendor("nope")).toBeNull()
    expect(probeRootKeysForMigrationVendor("nope")).toEqual([])
  })
})

it("keeps history-only ecosystems free of a launchable runtime", () => {
  for (const id of ["cline", "continue-dev", "aider"]) {
    expect(findEcosystemById(id)?.runtimeIds).toEqual([])
  }
})

it("keeps every row's arrays free of duplicates", () => {
  for (const entry of AGENT_ECOSYSTEMS) {
    expect(new Set(entry.runtimeIds).size).toBe(entry.runtimeIds.length)
    expect(new Set(entry.sessionSourceIds).size).toBe(entry.sessionSourceIds.length)
    expect(new Set(entry.vendorRootKeys).size).toBe(entry.vendorRootKeys.length)
  }
})
