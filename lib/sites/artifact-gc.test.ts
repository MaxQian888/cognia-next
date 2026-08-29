import {
  collectUnreferencedSiteArtifacts,
  pinnedSiteArtifactDigests,
  type SiteArtifactGcDeps,
} from "./artifact-gc"
import type { SiteDeploymentRow, SiteOperationRow, SiteVersionRow } from "@/types/sites"

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const INPUT = { now: NOW, keepDays: 30, keepReadyVersionsPerSite: 2 }
const OLD = NOW - 400 * DAY

function version(overrides: Partial<SiteVersionRow> & Pick<SiteVersionRow, "id">): SiteVersionRow {
  return {
    siteId: "site_1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "abc", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-01-01",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    artifactDigest: `d-${overrides.id}`,
    artifactSize: 1000,
    artifactFileCount: 3,
    createdAt: OLD,
    completedAt: OLD,
    ...overrides,
  }
}

function deployment(
  overrides: Partial<SiteDeploymentRow> & Pick<SiteDeploymentRow, "id" | "versionId">
): SiteDeploymentRow {
  return {
    siteId: "site_1",
    environmentRevisionId: "env_1",
    status: "active",
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  }
}

function operation(status: SiteOperationRow["status"]): SiteOperationRow {
  return {
    id: `op-${status}`,
    siteId: "site_1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: `k-${status}`,
    inputDigest: "d",
    status,
    attemptCount: 1,
    createdAt: OLD,
    updatedAt: OLD,
  }
}

describe("pinnedSiteArtifactDigests", () => {
  it("keeps the version a live deployment is serving", () => {
    const versions = [version({ id: "v1", sequence: 1 }), version({ id: "v2", sequence: 2 })]
    const { referenced, collectable } = pinnedSiteArtifactDigests(
      versions,
      [deployment({ id: "dep", versionId: "v1" })],
      [],
      { ...INPUT, keepReadyVersionsPerSite: 0 }
    )
    expect(referenced.has("d-v1")).toBe(true)
    expect(collectable.map((row) => row.id)).toEqual(["v2"])
  })

  it("keeps the newest superseded deployment, which is the rollback target", () => {
    // Deleting it turns "roll back" into "rebuild and hope".
    const versions = [
      version({ id: "v1", sequence: 1 }),
      version({ id: "v2", sequence: 2 }),
      version({ id: "v3", sequence: 3 }),
    ]
    const { referenced } = pinnedSiteArtifactDigests(
      versions,
      [
        deployment({ id: "d1", versionId: "v1", status: "superseded", updatedAt: OLD }),
        deployment({ id: "d2", versionId: "v2", status: "superseded", updatedAt: OLD + 10 }),
        deployment({ id: "d3", versionId: "v3", status: "active" }),
      ],
      [],
      { ...INPUT, keepReadyVersionsPerSite: 0 }
    )
    expect(referenced.has("d-v2")).toBe(true)
    expect(referenced.has("d-v1")).toBe(false)
  })

  it.each(["queued", "running", "waiting-reconcile"] as const)(
    "keeps every artifact of a Site with a %s operation",
    (status) => {
      // Coarse on purpose: `recoverInterruptedOperations` replays from
      // `inputPayload`, and guessing which version it lands on is a way to be
      // wrong while a build is in flight.
      const versions = [version({ id: "v1" }), version({ id: "v2", sequence: 2 })]
      const { referenced, collectable } = pinnedSiteArtifactDigests(
        versions,
        [],
        [operation(status)],
        { ...INPUT, keepReadyVersionsPerSite: 0 }
      )
      expect([...referenced].sort()).toEqual(["d-v1", "d-v2"])
      expect(collectable).toEqual([])
    }
  )

  it("does not pin for a Site whose operations have all finished", () => {
    const { collectable } = pinnedSiteArtifactDigests(
      [version({ id: "v1" })],
      [],
      [operation("succeeded"), operation("failed"), operation("cancelled")],
      { ...INPUT, keepReadyVersionsPerSite: 0 }
    )
    expect(collectable.map((row) => row.id)).toEqual(["v1"])
  })

  it("keeps the newest N ready versions as the rollback window", () => {
    const versions = [1, 2, 3, 4].map((sequence) => version({ id: `v${sequence}`, sequence }))
    const { recent, collectable } = pinnedSiteArtifactDigests(versions, [], [], INPUT)
    expect([...recent].sort()).toEqual(["d-v3", "d-v4"])
    expect(collectable.map((row) => row.id).sort()).toEqual(["v1", "v2"])
  })

  it("keeps anything inside the age window regardless of sequence", () => {
    const versions = [
      version({ id: "old", sequence: 1 }),
      version({ id: "fresh", sequence: 2, createdAt: NOW - DAY, completedAt: NOW - DAY }),
    ]
    const { recent } = pinnedSiteArtifactDigests(versions, [], [], {
      ...INPUT,
      keepReadyVersionsPerSite: 0,
    })
    expect(recent.has("d-fresh")).toBe(true)
    expect(recent.has("d-old")).toBe(false)
  })

  it("never re-collects a version whose bytes are already gone", () => {
    const { collectable } = pinnedSiteArtifactDigests(
      [version({ id: "v1", artifactCollectedAt: NOW - DAY })],
      [],
      [],
      { ...INPUT, keepReadyVersionsPerSite: 0 }
    )
    expect(collectable).toEqual([])
  })

  it("ignores versions that never produced an artifact", () => {
    const { collectable } = pinnedSiteArtifactDigests(
      [version({ id: "v1", status: "failed", artifactDigest: undefined })],
      [],
      [],
      { ...INPUT, keepReadyVersionsPerSite: 0 }
    )
    expect(collectable).toEqual([])
  })
})

describe("collectUnreferencedSiteArtifacts", () => {
  function deps(overrides: Partial<SiteArtifactGcDeps> = {}) {
    const deleteArtifacts = jest.fn(async (digests: readonly string[]) => digests.length)
    const markCollected = jest.fn(async () => undefined)
    const base = {
      listProjects: jest.fn(async () => [{ id: "site_1" }]),
      listVersions: jest.fn(async () => [
        version({ id: "v1", sequence: 1 }),
        version({ id: "v2", sequence: 2 }),
      ]),
      listDeployments: jest.fn(async () => []),
      listOperations: jest.fn(async () => []),
      listDigests: jest.fn(async () => ["d-v1", "d-v2"]),
      deleteArtifacts,
      markCollected,
      ...overrides,
    } as unknown as SiteArtifactGcDeps
    return { deps: base, deleteArtifacts, markCollected }
  }

  it("deletes the unreferenced archives and marks their versions collected", async () => {
    const { deps: d, deleteArtifacts, markCollected } = deps()
    const report = await collectUnreferencedSiteArtifacts(
      { ...INPUT, keepReadyVersionsPerSite: 1 },
      d
    )
    expect(deleteArtifacts).toHaveBeenCalledWith(["d-v1"])
    expect(markCollected).toHaveBeenCalledWith("v1", NOW)
    expect(report.deletedDigests).toEqual(["d-v1"])
    expect(report.bytesFreed).toBe(1000)
    expect(report.retainedRecent).toBe(1)
    expect(report.scanned).toBe(2)
  })

  it("counts every scanned digest exactly once across the three buckets", async () => {
    const { deps: d } = deps({
      listDeployments: jest.fn(async () => [deployment({ id: "dep", versionId: "v2" })]),
    })
    const report = await collectUnreferencedSiteArtifacts(
      { ...INPUT, keepReadyVersionsPerSite: 0 },
      d
    )
    expect(report.deletedDigests.length + report.retainedReferenced + report.retainedRecent).toBe(
      report.scanned
    )
  })

  it("does not delete a digest another Site still pins", async () => {
    // Artifacts are content-addressed: two Sites that built byte-identical
    // output share one row.
    const { deps: d, deleteArtifacts } = deps({
      listProjects: jest.fn(async () => [{ id: "site_1" }, { id: "site_2" }]),
      listVersions: jest.fn(async (siteId: string) =>
        siteId === "site_1"
          ? [version({ id: "v1", sequence: 1 })]
          : [version({ id: "v9", siteId: "site_2", sequence: 1, artifactDigest: "d-v1" })]
      ),
      listOperations: jest.fn(async (siteId: string) =>
        siteId === "site_2" ? [operation("running")] : []
      ),
      listDigests: jest.fn(async () => ["d-v1"]),
    } as unknown as Partial<SiteArtifactGcDeps>)
    const report = await collectUnreferencedSiteArtifacts(
      { ...INPUT, keepReadyVersionsPerSite: 0 },
      d
    )
    expect(deleteArtifacts).not.toHaveBeenCalled()
    expect(report.retainedReferenced).toBe(1)
  })

  it("touches nothing when everything is pinned", async () => {
    const {
      deps: d,
      deleteArtifacts,
      markCollected,
    } = deps({
      listOperations: jest.fn(async () => [operation("running")]),
    })
    const report = await collectUnreferencedSiteArtifacts(INPUT, d)
    expect(deleteArtifacts).not.toHaveBeenCalled()
    expect(markCollected).not.toHaveBeenCalled()
    expect(report.bytesFreed).toBe(0)
  })
})
