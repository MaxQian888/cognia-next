/** @jest-environment jsdom */
import {
  BROWSER_EXTENSION_ASSET_ID,
  createBrowserExtensionAdapter,
} from "./browser-extension-adapter"
import type { CatalogEntry } from "../catalog-types"

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    assetId: BROWSER_EXTENSION_ASSET_ID,
    kind: "browser-chrome",
    executor: "browser-store",
    version: "1.4.0",
    channel: "stable",
    criticality: "routine",
    releasedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: [entry()] as readonly CatalogEntry[],
}

describe("unpaired", () => {
  it("shows the store version with no local version claim", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => null,
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.currentVersion).toBeNull()
    expect(candidate.targetVersion).toBe("1.4.0")
  })

  it("reports nothing when the store has nothing published", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => null,
    })
    expect(await adapter.check({ ...CONTEXT, catalog: [] })).toEqual([])
  })
})

describe("paired", () => {
  it("offers a store link when a newer build is published but not yet fetched", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => ({ version: "1.2.0" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.action).toBe("open-store")
    expect(candidate.currentVersion).toBe("1.2.0")
  })

  it("offers a reload only once the browser has the new build", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => ({ version: "1.2.0", updatePending: true }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.action).toBe("reload-extension")
  })

  it("stays quiet when the paired version already matches the store", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => ({ version: "1.4.0" }),
    })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("still offers a reload when the browser signalled one with no catalog entry", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => ({ version: "1.4.0", updatePending: true }),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    expect(candidate.action).toBe("reload-extension")
  })
})

describe("apply", () => {
  const candidate = {
    assetId: BROWSER_EXTENSION_ASSET_ID,
    kind: "browser-chrome" as const,
    executor: "browser-store" as const,
    currentVersion: "1.2.0",
    targetVersion: "1.4.0",
    channel: "stable" as const,
    criticality: "routine" as const,
    source: "store" as const,
    provenance: "verified" as const,
  }

  it("asks the extension to reload itself", async () => {
    let asked = false
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => ({ version: "1.2.0", updatePending: true }),
      requestReload: async () => {
        asked = true
        return true
      },
    })
    const result = await adapter.apply(
      { ...candidate, action: "reload-extension" },
      { consented: true }
    )
    expect(asked).toBe(true)
    expect(result.state).toBe("awaiting-reload")
  })

  it("reports a refused reload rather than claiming success", async () => {
    const adapter = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => ({ version: "1.2.0", updatePending: true }),
      requestReload: async () => false,
    })
    const result = await adapter.apply(
      { ...candidate, action: "reload-extension" },
      { consented: true }
    )
    expect(result.state).toBe("failed")
    expect(result.failure?.code).toBe("reload_refused")
  })

  it("opens the right store for each browser", async () => {
    const openedChrome: string[] = []
    const chrome = createBrowserExtensionAdapter("browser-chrome", {
      pairedExtension: async () => null,
      openExternal: async (url) => {
        openedChrome.push(url)
      },
    })
    await chrome.apply(candidate, { consented: true })
    expect(openedChrome[0]).toContain("chromewebstore")

    const openedEdge: string[] = []
    const edge = createBrowserExtensionAdapter("browser-edge", {
      pairedExtension: async () => null,
      openExternal: async (url) => {
        openedEdge.push(url)
      },
    })
    await edge.apply({ ...candidate, kind: "browser-edge" }, { consented: true })
    expect(openedEdge[0]).toContain("microsoftedge")
  })
})
