/** @jest-environment jsdom */
import { createPluginAdapter } from "./plugin-adapter"
import type { CatalogEntry } from "../catalog-types"

const INFO = {
  pluginId: "acme.tool",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
  changelog: "faster",
  breaking: false,
}

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: null as readonly CatalogEntry[] | null,
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    assetId: "acme.tool",
    kind: "plugin",
    executor: "plugin-runtime",
    version: "2.0.0",
    channel: "stable",
    criticality: "routine",
    releasedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("check", () => {
  it("projects a marketplace update into a candidate", async () => {
    const adapter = createPluginAdapter({ checkForUpdates: async () => [INFO] })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate).toMatchObject({
      assetId: "acme.tool",
      targetVersion: "2.0.0",
      executor: "plugin-runtime",
      source: "marketplace",
    })
  })

  it("marks a build the catalog has never seen as unsigned", async () => {
    const adapter = createPluginAdapter({ checkForUpdates: async () => [INFO] })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.provenance).toBe("unsigned")
  })

  it("marks a catalog-listed build as verified", async () => {
    const adapter = createPluginAdapter({ checkForUpdates: async () => [INFO] })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [catalogEntry()] })
    expect(candidate.provenance).toBe("verified")
  })

  it("never offers a revoked version, even though the marketplace still lists it", async () => {
    const adapter = createPluginAdapter({ checkForUpdates: async () => [INFO] })
    const found = await adapter.check({
      ...CONTEXT,
      catalog: [catalogEntry({ revoked: true })],
    })
    expect(found).toEqual([])
  })

  it("honors a blocklist entry covering every version", async () => {
    const adapter = createPluginAdapter({ checkForUpdates: async () => [INFO] })
    const found = await adapter.check({
      ...CONTEXT,
      catalog: [catalogEntry({ version: "*", revoked: true })],
    })
    expect(found).toEqual([])
  })

  it("flags a version that widens permissions", async () => {
    const adapter = createPluginAdapter({
      checkForUpdates: async () => [INFO],
      permissionsExpanded: async () => true,
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.permissionsExpanded).toBe(true)
  })

  it("carries the breaking flag through as a compatibility fact", async () => {
    const adapter = createPluginAdapter({
      checkForUpdates: async () => [{ ...INFO, breaking: true }],
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.compatibility?.breaking).toBe(true)
  })
})

describe("apply", () => {
  it("delegates to the existing plugin installer", async () => {
    const updated: string[] = []
    const adapter = createPluginAdapter({
      checkForUpdates: async () => [INFO],
      update: async (id) => {
        updated.push(id)
        return { success: true }
      },
    })
    const [candidate] = await adapter.check(CONTEXT)
    const result = await adapter.apply(candidate, { consented: true })
    expect(updated).toEqual(["acme.tool"])
    expect(result.state).toBe("verified")
  })

  it("waits for a restart when the runtime asks for one", async () => {
    const adapter = createPluginAdapter({
      checkForUpdates: async () => [INFO],
      update: async () => ({ success: true, requiresRestart: true }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("awaiting-restart")
  })

  it("reports a refusal as a failure with a recovery action", async () => {
    const adapter = createPluginAdapter({
      checkForUpdates: async () => [INFO],
      update: async () => ({ success: false, error: "vscode extension" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    const result = await adapter.apply(candidate, { consented: true })
    expect(result.state).toBe("failed")
    expect(result.failure?.recoveryActionKey).toBe("openPluginSettings")
  })
})
