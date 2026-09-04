/** @jest-environment jsdom */
import { createDesktopAdapter, desktopTarget, macReleaseUrl } from "./desktop-adapter"
import type { CatalogEntry } from "../catalog-types"

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: null as readonly CatalogEntry[] | null,
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    version: "2.0.0",
    channel: "stable",
    criticality: "routine",
    releasedAt: "2026-01-01T00:00:00Z",
    target: "windows",
    ...overrides,
  }
}

describe("desktopTarget", () => {
  it("maps OS families onto catalog targets", () => {
    expect(desktopTarget("macos")).toBe("darwin")
    expect(desktopTarget("windows")).toBe("windows")
    expect(desktopTarget("linux")).toBe("linux")
    expect(desktopTarget("ios")).toBe("unknown")
  })
})

describe("check", () => {
  it("is unsupported off the desktop shell", () => {
    const adapter = createDesktopAdapter({ isTauri: () => false })
    expect(adapter.isSupported()).toBe(false)
  })

  it("prefers the catalog, which carries criticality", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => {
        throw new Error("should not be reached")
      },
    })
    const [candidate] = await adapter.check({
      ...CONTEXT,
      catalog: [entry({ criticality: "critical" })],
    })
    expect(candidate).toMatchObject({
      targetVersion: "2.0.0",
      criticality: "critical",
      source: "catalog",
    })
  })

  it("falls back to the Tauri endpoint when the catalog has nothing", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "1.5.0", body: "notes" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate).toMatchObject({ targetVersion: "1.5.0", source: "tauri-endpoint" })
  })

  it("reports nothing when both sources are empty", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      checkForUpdate: async () => null,
    })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("hands macOS off to a signed download instead of installing in place", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "macos",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "1.5.0" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.action).toBe("open-store")
    expect(candidate.externalUrl).toBe(macReleaseUrl("1.5.0"))
  })

  it("leaves Windows on the in-app path", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "1.5.0" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.action).toBeUndefined()
  })
})

describe("apply", () => {
  const candidate = {
    assetId: "app",
    kind: "desktop" as const,
    executor: "tauri" as const,
    currentVersion: "1.0.0",
    targetVersion: "1.5.0",
    channel: "stable" as const,
    criticality: "routine" as const,
    source: "catalog" as const,
    provenance: "verified" as const,
  }

  it("opens the release page for a macOS handoff", async () => {
    const opened: string[] = []
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "macos",
      openExternal: async (url) => {
        opened.push(url)
      },
    })
    const result = await adapter.apply(
      { ...candidate, action: "open-store", externalUrl: "https://example.test/dmg" },
      { consented: true }
    )
    expect(result.state).toBe("awaiting-store")
    expect(opened).toEqual(["https://example.test/dmg"])
  })

  it("refuses a handoff with no download URL instead of opening nothing", async () => {
    const adapter = createDesktopAdapter({ isTauri: () => true, osFamily: () => "macos" })
    const result = await adapter.apply({ ...candidate, action: "open-store" }, { consented: true })
    expect(result.state).toBe("failed")
    expect(result.failure?.code).toBe("no_download_url")
  })

  it("downloads only, without installing, when consent has not been given", async () => {
    let installed = false
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      downloadUpdate: async () => "downloaded",
      downloadAndInstallUpdate: async () => {
        installed = true
        return "relaunching"
      },
      installUpdate: async () => "installed",
    })
    const result = await adapter.apply(candidate, { consented: false })
    expect(result.state).toBe("awaiting-consent")
    expect(installed).toBe(false)
  })

  it("lands in awaiting-restart after a consented install", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      downloadAndInstallUpdate: async () => "relaunching",
      downloadUpdate: async () => "downloaded",
      installUpdate: async () => "installed",
    })
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("awaiting-restart")
  })

  it("returns to current when the release vanished mid-flight", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      downloadAndInstallUpdate: async () => "noLongerAvailable",
      downloadUpdate: async () => "noLongerAvailable",
      installUpdate: async () => "noLongerAvailable",
    })
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("current")
  })
})
