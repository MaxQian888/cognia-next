import type { ChangesetEntry, Evidence, Release } from "./evidence"
import {
  assetPlatform,
  formatDate,
  formatMonth,
  freshness,
  bumpCounts,
  groupChangelog,
  isInstallerAsset,
  latestRelease,
  releaseState,
} from "./evidence"

const RELEASES_URL = "https://github.com/MaxQian888/cognia-next/releases"

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    readAt: "2026-07-26T10:00:00.000Z",
    lastGoodReadAt: "2026-07-26T10:00:00.000Z",
    errors: [],
    repo: { stars: 52, license: "AGPL-3.0", description: null },
    contributors: 3,
    releases: [],
    changesets: [],
    ...overrides,
  }
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    tagName: "v0.2.0",
    name: "v0.2.0",
    prerelease: false,
    publishedAt: "2026-07-20T00:00:00.000Z",
    htmlUrl: "https://github.com/MaxQian888/cognia-next/releases/tag/v0.2.0",
    body: null,
    assets: [],
    ...overrides,
  }
}

describe("assetPlatform", () => {
  it("recognises macOS installers", () => {
    expect(assetPlatform("Cognia_0.2.0_universal.dmg")).toBe("macos")
    expect(assetPlatform("Cognia.app.tar.gz")).toBe("macos")
  })

  it("recognises Windows installers", () => {
    expect(assetPlatform("Cognia_0.2.0_x64_en-US.msi")).toBe("windows")
    expect(assetPlatform("Cognia-setup.exe")).toBe("windows")
  })

  it("recognises Linux installers", () => {
    expect(assetPlatform("cognia_0.2.0_amd64.AppImage")).toBe("linux")
    expect(assetPlatform("cognia_0.2.0_amd64.deb")).toBe("linux")
  })

  it("matches the macOS updater bundle before any generic tarball rule", () => {
    // `.app.tar.gz` ends in `.tar.gz`; a naive archive rule would call it Linux.
    expect(assetPlatform("Cognia.app.tar.gz")).toBe("macos")
  })

  it("returns null when the name does not identify a platform", () => {
    expect(assetPlatform("latest.json")).toBeNull()
    expect(assetPlatform("source-code.zip")).toBeNull()
  })
})

describe("isInstallerAsset", () => {
  it("excludes signatures, checksums and the update manifest", () => {
    expect(isInstallerAsset("Cognia.app.tar.gz.sig")).toBe(false)
    expect(isInstallerAsset("latest.json")).toBe(false)
    expect(isInstallerAsset("Cognia.dmg.sha256")).toBe(false)
  })

  it("keeps real installers", () => {
    expect(isInstallerAsset("Cognia_0.2.0_universal.dmg")).toBe(true)
  })
})

describe("latestRelease", () => {
  it("returns null when nothing has been published", () => {
    expect(latestRelease(evidence())).toBeNull()
  })

  it("ignores prereleases", () => {
    expect(latestRelease(evidence({ releases: [release({ prerelease: true })] }))).toBeNull()
  })

  it("picks the most recently published release regardless of array order", () => {
    const older = release({ tagName: "v0.1.0", publishedAt: "2026-06-01T00:00:00.000Z" })
    const newer = release({ tagName: "v0.3.0", publishedAt: "2026-07-01T00:00:00.000Z" })
    expect(latestRelease(evidence({ releases: [older, newer] }))?.tagName).toBe("v0.3.0")
  })
})

describe("releaseState", () => {
  it("degrades to no-release when nothing is published — the current reality", () => {
    const state = releaseState(evidence(), RELEASES_URL)
    expect(state.hasRelease).toBe(false)
    expect(state.version).toBeNull()
    expect(state.htmlUrl).toBe(RELEASES_URL)
    expect(state.byPlatform).toEqual({ macos: [], windows: [], linux: [] })
  })

  it("groups installers by platform", () => {
    const state = releaseState(
      evidence({
        releases: [
          release({
            assets: [
              { name: "Cognia_0.2.0_universal.dmg", url: "u1", size: 1 },
              { name: "Cognia_0.2.0_x64.msi", url: "u2", size: 2 },
              { name: "cognia_0.2.0_amd64.AppImage", url: "u3", size: 3 },
            ],
          }),
        ],
      }),
      RELEASES_URL
    )
    expect(state.hasRelease).toBe(true)
    expect(state.version).toBe("v0.2.0")
    expect(state.byPlatform.macos.map((a) => a.name)).toEqual(["Cognia_0.2.0_universal.dmg"])
    expect(state.byPlatform.windows).toHaveLength(1)
    expect(state.byPlatform.linux).toHaveLength(1)
  })

  it("drops signatures and manifests from the platform lists", () => {
    const state = releaseState(
      evidence({
        releases: [
          release({
            assets: [
              { name: "Cognia.app.tar.gz", url: "u1", size: 1 },
              { name: "Cognia.app.tar.gz.sig", url: "u2", size: 2 },
              { name: "latest.json", url: "u3", size: 3 },
            ],
          }),
        ],
      }),
      RELEASES_URL
    )
    expect(state.byPlatform.macos.map((a) => a.name)).toEqual(["Cognia.app.tar.gz"])
  })

  it("treats a tagged release with no recognisable installer as no release", () => {
    // A tag alone must not turn the CTA into a download button that leads
    // somewhere with nothing to download.
    const state = releaseState(
      evidence({ releases: [release({ assets: [{ name: "notes.txt", url: "u", size: 1 }] })] }),
      RELEASES_URL
    )
    expect(state.hasRelease).toBe(false)
  })
})

describe("groupChangelog", () => {
  const entries: ChangesetEntry[] = [
    { id: "a", bump: "minor", summary: "A", date: "2026-07-02T00:00:00.000Z" },
    { id: "b", bump: "patch", summary: "B", date: "2026-06-15T00:00:00.000Z" },
    { id: "c", bump: "major", summary: "C", date: "2026-07-20T00:00:00.000Z" },
    { id: "d", bump: "patch", summary: "D", date: null },
  ]

  it("groups by month, newest month first", () => {
    expect(groupChangelog(entries).map((g) => g.key)).toEqual(["2026-07", "2026-06", "undated"])
  })

  it("sorts entries inside a month newest first", () => {
    const july = groupChangelog(entries).find((g) => g.key === "2026-07")
    expect(july?.entries.map((e) => e.id)).toEqual(["c", "a"])
  })

  it("keeps undated entries rather than dropping them", () => {
    const undated = groupChangelog(entries).find((g) => g.key === "undated")
    expect(undated?.entries.map((e) => e.id)).toEqual(["d"])
  })

  it("returns nothing for an empty feed", () => {
    expect(groupChangelog([])).toEqual([])
  })
})

describe("bumpCounts", () => {
  it("counts each severity", () => {
    const entries: ChangesetEntry[] = [
      { id: "a", bump: "minor", summary: "A", date: null },
      { id: "b", bump: "patch", summary: "B", date: null },
      { id: "c", bump: "patch", summary: "C", date: null },
      { id: "d", bump: "major", summary: "D", date: null },
    ]
    expect(bumpCounts(entries)).toEqual({ major: 1, minor: 1, patch: 2 })
  })

  it("keeps every key at zero for an empty feed, so the bar has a stable shape", () => {
    expect(bumpCounts([])).toEqual({ major: 0, minor: 0, patch: 0 })
  })

  it("skips an unrecognised bump rather than inventing a severity for it", () => {
    const entries = [
      { id: "a", bump: "patch", summary: "A", date: null },
      { id: "b", bump: "nonsense", summary: "B", date: null },
    ] as unknown as ChangesetEntry[]
    expect(bumpCounts(entries)).toEqual({ major: 0, minor: 0, patch: 1 })
  })
})

describe("freshness", () => {
  it("reports the read time when every source succeeded", () => {
    expect(freshness(evidence())).toEqual({ date: "2026-07-26T10:00:00.000Z", stale: false })
  })

  it("falls back to the last good read when a source failed", () => {
    const result = freshness(
      evidence({
        errors: ["repo: 403 rate limited"],
        readAt: "2026-07-27T10:00:00.000Z",
        lastGoodReadAt: "2026-07-26T10:00:00.000Z",
      })
    )
    expect(result).toEqual({ date: "2026-07-26T10:00:00.000Z", stale: true })
  })

  it("reports no date rather than a wrong one when nothing has ever succeeded", () => {
    expect(freshness(evidence({ errors: ["repo: offline"], lastGoodReadAt: null }))).toEqual({
      date: null,
      stale: true,
    })
  })
})

describe("date formatting", () => {
  it("renders an ISO date as a verifiable calendar day", () => {
    expect(formatDate("2026-07-26T10:00:00.000Z")).toBe("2026-07-26")
  })

  it("renders an em dash rather than Invalid Date", () => {
    expect(formatDate(null)).toBe("—")
    expect(formatDate("not a date")).toBe("—")
  })

  it("labels months per locale", () => {
    expect(formatMonth("2026-07", "en")).toBe("July 2026")
    expect(formatMonth("2026-07", "zh")).toBe("2026 年 7 月")
  })

  it("labels the undated bucket per locale", () => {
    expect(formatMonth("undated", "en")).toBe("Undated")
    expect(formatMonth("undated", "zh")).toBe("无日期")
  })

  it("passes a malformed key through instead of inventing a month", () => {
    expect(formatMonth("garbage", "en")).toBe("garbage")
  })
})
