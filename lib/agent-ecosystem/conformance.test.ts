/**
 * Pins the catalog against every vocabulary it claims to map.
 *
 * This is the ratchet. The table is hand-written, so without this test it is
 * exactly the kind of second copy that drifts, which is the defect it was
 * built to end. Every assertion here failed at least once against a real bug
 * during the change that introduced this file.
 */

import { EMPTY_VENDOR_ROOTS } from "@/lib/agent-roots"
import { MIGRATION_VENDORS } from "@/lib/agent-migration/types"
import { EXTERNAL_AGENT_RUNTIMES } from "@/lib/ai/agent/external/runtime-catalog"
import { EXTERNAL_AGENT_PRESETS } from "@/lib/ai/agent/external/presets"
import { SUBAGENT_SOURCE_ADAPTERS } from "@/lib/claude/subagent-importers"
import { STATIC_SESSION_SOURCE_IDS } from "@/lib/session-import/registry"

import { AGENT_ECOSYSTEMS } from "./catalog"
import { presetIdsForEcosystem, primaryPresetIdForMigrationVendor } from "./runtime-link"

const PLUGIN_ECOSYSTEMS = ["cognia", "claude-code", "codex", "gemini-cli"]

describe("agent ecosystem catalog conformance", () => {
  it("has a non-empty table with unique ids", () => {
    expect(AGENT_ECOSYSTEMS.length).toBeGreaterThan(0)
    const ids = AGENT_ECOSYSTEMS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  describe("runtime ids", () => {
    const runtimeIds = new Set(EXTERNAL_AGENT_RUNTIMES.map((entry) => entry.runtimeId))

    it.each(AGENT_ECOSYSTEMS.filter((entry) => entry.runtimeIds.length > 0))(
      "$id names only catalogued runtimes",
      (entry) => {
        for (const runtimeId of entry.runtimeIds) expect(runtimeIds).toContain(runtimeId)
      }
    )

    it("claims every catalogued runtime exactly once", () => {
      const claimed = AGENT_ECOSYSTEMS.flatMap((entry) => entry.runtimeIds)
      expect(new Set(claimed).size).toBe(claimed.length)
      expect([...claimed].sort()).toEqual([...runtimeIds].sort())
    })

    it("resolves every runtime to at least one live preset", () => {
      // The bug this whole module exists for: `VENDOR_RUNTIME.pi` was "pi",
      // a runtime id, used where a preset id belonged.
      for (const entry of AGENT_ECOSYSTEMS) {
        if (entry.runtimeIds.length === 0) continue
        const presetIds = presetIdsForEcosystem(entry.id)
        expect(presetIds.length).toBeGreaterThan(0)
        for (const presetId of presetIds) {
          expect(Object.keys(EXTERNAL_AGENT_PRESETS)).toContain(presetId)
        }
      }
    })
  })

  describe("session sources", () => {
    it("names only static first-party sources", () => {
      for (const entry of AGENT_ECOSYSTEMS) {
        for (const sourceId of entry.sessionSourceIds) {
          expect(STATIC_SESSION_SOURCE_IDS).toContain(sourceId)
        }
      }
    })

    it("claims every static source exactly once", () => {
      const claimed = AGENT_ECOSYSTEMS.flatMap((entry) => entry.sessionSourceIds)
      expect(new Set(claimed).size).toBe(claimed.length)
      expect([...claimed].sort()).toEqual([...STATIC_SESSION_SOURCE_IDS].sort())
    })
  })

  describe("migration vendors", () => {
    it("names only real vendors, each claimed once", () => {
      const claimed = AGENT_ECOSYSTEMS.map((entry) => entry.migrationVendor).filter(
        (vendor): vendor is string => vendor !== null
      )
      expect(new Set(claimed).size).toBe(claimed.length)
      expect([...claimed].sort()).toEqual([...MIGRATION_VENDORS].sort())
    })

    it("resolves every vendor to a live preset id", () => {
      for (const vendor of MIGRATION_VENDORS) {
        const presetId = primaryPresetIdForMigrationVendor(vendor)
        expect(presetId).not.toBeNull()
        expect(Object.keys(EXTERNAL_AGENT_PRESETS)).toContain(presetId as string)
      }
    })

    it("gives every vendor a config root and at least one probe root", () => {
      for (const vendor of MIGRATION_VENDORS) {
        const entry = AGENT_ECOSYSTEMS.find((row) => row.migrationVendor === vendor)
        expect(entry?.configRootKey).toBeTruthy()
        expect(entry?.probeRootKeys.length ?? 0).toBeGreaterThan(0)
      }
    })
  })

  describe("vendor roots", () => {
    const rootKeys = Object.keys(EMPTY_VENDOR_ROOTS)

    it("names only real VendorRoots keys", () => {
      for (const entry of AGENT_ECOSYSTEMS) {
        for (const key of entry.vendorRootKeys) expect(rootKeys).toContain(key)
        if (entry.configRootKey) expect(rootKeys).toContain(entry.configRootKey)
        for (const key of entry.probeRootKeys) expect(rootKeys).toContain(key)
      }
    })

    it("keeps configRootKey and probeRootKeys inside the entry's own roots", () => {
      for (const entry of AGENT_ECOSYSTEMS) {
        if (entry.configRootKey) expect(entry.vendorRootKeys).toContain(entry.configRootKey)
        for (const key of entry.probeRootKeys) expect(entry.vendorRootKeys).toContain(key)
      }
    })

    it("claims every VendorRoots key exactly once", () => {
      const claimed = AGENT_ECOSYSTEMS.flatMap((entry) => entry.vendorRootKeys)
      expect(new Set(claimed).size).toBe(claimed.length)
      expect([...claimed].sort()).toEqual([...rootKeys].sort())
    })
  })

  it("names only real subagent importer ids", () => {
    const adapterIds = SUBAGENT_SOURCE_ADAPTERS.map((adapter) => adapter.id)
    for (const entry of AGENT_ECOSYSTEMS) {
      if (!entry.subagentSourceId) continue
      // Codex's importer is registered as `codex-cli`, not `codex`. That one
      // character used to live in a ternary inside `artifacts.ts`.
      expect(adapterIds).toContain(entry.subagentSourceId)
    }
  })

  it("names only real plugin ecosystems, and never the conversion target", () => {
    for (const entry of AGENT_ECOSYSTEMS) {
      if (!entry.pluginEcosystem) continue
      expect(PLUGIN_ECOSYSTEMS).toContain(entry.pluginEcosystem)
      expect(entry.pluginEcosystem).not.toBe("cognia")
    }
  })

  it("gives every migration vendor a label in both locales", async () => {
    const [en, zh] = await Promise.all([
      import("@/i18n/messages/en/agentMigration.json"),
      import("@/i18n/messages/zh-CN/agentMigration.json"),
    ])
    for (const vendor of MIGRATION_VENDORS) {
      expect((en.default as { vendors: Record<string, string> }).vendors[vendor]).toBeTruthy()
      expect((zh.default as { vendors: Record<string, string> }).vendors[vendor]).toBeTruthy()
    }
  })
})
