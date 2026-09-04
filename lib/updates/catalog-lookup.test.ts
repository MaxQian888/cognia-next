import {
  bestCandidate,
  compareVersions,
  isNewerVersion,
  isRevokedRelease,
  releaseProvenance,
  visibleChannels,
} from "./catalog-lookup"
import type { CatalogEntry } from "./catalog-types"

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    version: "1.1.0",
    channel: "stable",
    criticality: "routine",
    releasedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1)
  })

  it("pads a short version", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0)
  })

  it("ignores a leading v", () => {
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0)
  })

  it("ranks a release above its own prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1)
  })

  it("treats a missing current version as always newer", () => {
    expect(isNewerVersion("0.0.1", null)).toBe(true)
  })
})

describe("visibleChannels", () => {
  it("keeps a stable device on stable only", () => {
    expect(visibleChannels("stable")).toEqual(["stable"])
  })

  it("lets beta see stable too", () => {
    expect(visibleChannels("beta")).toEqual(["stable", "beta"])
  })
})

describe("bestCandidate", () => {
  const options = {
    kind: "desktop" as const,
    assetId: "app",
    executor: "tauri" as const,
    currentVersion: "1.0.0",
    channel: "stable" as const,
  }

  it("returns null when the catalog is unavailable", () => {
    expect(bestCandidate(null, options)).toBeNull()
  })

  it("picks the highest eligible version", () => {
    const found = bestCandidate([entry({ version: "1.1.0" }), entry({ version: "1.3.0" })], options)
    expect(found?.targetVersion).toBe("1.3.0")
  })

  it("never picks a revoked release, even when it is the newest", () => {
    const found = bestCandidate(
      [entry({ version: "1.1.0" }), entry({ version: "2.0.0", revoked: true })],
      options
    )
    expect(found?.targetVersion).toBe("1.1.0")
  })

  it("hides a beta release from a stable device", () => {
    expect(bestCandidate([entry({ version: "2.0.0", channel: "beta" })], options)).toBeNull()
  })

  it("filters by platform target when both sides declare one", () => {
    const entries = [entry({ version: "2.0.0", target: "windows" })]
    expect(bestCandidate(entries, { ...options, target: "darwin" })).toBeNull()
    expect(bestCandidate(entries, { ...options, target: "windows" })?.targetVersion).toBe("2.0.0")
  })

  it("refuses a candidate whose minimum host version is not met", () => {
    const entries = [entry({ version: "2.0.0", compatibility: { minAppVersion: "3.0.0" } })]
    expect(bestCandidate(entries, { ...options, appVersion: "1.0.0" })).toBeNull()
  })

  it("refuses a candidate pinned above the running host line", () => {
    const entries = [entry({ version: "2.0.0", compatibility: { maxAppVersion: "1.5.0" } })]
    expect(bestCandidate(entries, { ...options, appVersion: "2.0.0" })).toBeNull()
  })

  it("never offers a version the device already runs", () => {
    expect(bestCandidate([entry({ version: "1.0.0" })], options)).toBeNull()
  })

  it("carries criticality and notes through", () => {
    const found = bestCandidate(
      [entry({ version: "1.2.0", criticality: "critical", releaseNotes: "fixes a leak" })],
      options
    )
    expect(found?.criticality).toBe("critical")
    expect(found?.releaseNotes).toBe("fixes a leak")
    expect(found?.provenance).toBe("verified")
  })
})

describe("revocation and provenance", () => {
  const entries = [
    entry({ kind: "plugin", assetId: "acme.tool", version: "2.0.0", revoked: true }),
    entry({ kind: "plugin", assetId: "acme.tool", version: "1.0.0" }),
    entry({ kind: "plugin", assetId: "evil.pkg", version: "*", revoked: true }),
  ]

  it("spots a pulled version", () => {
    expect(isRevokedRelease(entries, "plugin", "acme.tool", "2.0.0")).toBe(true)
    expect(isRevokedRelease(entries, "plugin", "acme.tool", "1.0.0")).toBe(false)
  })

  it("supports blocklisting every version of a publisher's asset", () => {
    expect(isRevokedRelease(entries, "plugin", "evil.pkg", "9.9.9")).toBe(true)
  })

  it("reports a build the catalog has never seen as unsigned", () => {
    expect(releaseProvenance(entries, "plugin", "acme.tool", "3.0.0")).toBe("unsigned")
  })

  it("reports a known build as verified and a pulled one as revoked", () => {
    expect(releaseProvenance(entries, "plugin", "acme.tool", "1.0.0")).toBe("verified")
    expect(releaseProvenance(entries, "plugin", "acme.tool", "2.0.0")).toBe("revoked")
  })

  it("treats an unavailable catalog as unsigned, never as verified", () => {
    expect(releaseProvenance(null, "plugin", "acme.tool", "1.0.0")).toBe("unsigned")
  })
})
