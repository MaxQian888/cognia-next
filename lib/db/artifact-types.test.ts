import {
  artifactDateMs,
  artifactFromRow,
  artifactRowFrom,
  artifactVersionFromRow,
  artifactVersionRowFrom,
  type ArtifactRow,
} from "./artifact-types"
import type { Artifact, ArtifactVersion } from "@/types/artifact/artifact"

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_1",
    sessionId: "s_1",
    projectId: "p_1",
    messageId: "m_1",
    type: "chart",
    title: "Quarterly revenue",
    content: "{}",
    language: "json",
    version: 3,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  }
}

describe("artifactDateMs", () => {
  it("accepts the three shapes a timestamp reaches this layer in", () => {
    const ms = Date.UTC(2026, 0, 1)
    expect(artifactDateMs(new Date(ms))).toBe(ms)
    expect(artifactDateMs(new Date(ms).toISOString())).toBe(ms)
    expect(artifactDateMs(ms)).toBe(ms)
  })

  it("returns 0 rather than NaN for absent or unparseable input", () => {
    // A row is sorted on `updatedAt`. NaN would make the comparator
    // non-deterministic and `new Date(NaN)` throws on `.toISOString()`, so an
    // artifact with a broken timestamp has to sort to the bottom, not corrupt
    // the list around it.
    expect(artifactDateMs(undefined)).toBe(0)
    expect(artifactDateMs("not a date")).toBe(0)
    expect(artifactDateMs(new Date("nope"))).toBe(0)
    expect(artifactDateMs(Number.NaN)).toBe(0)
  })
})

describe("artifact row conversion", () => {
  it("round-trips an artifact through the row shape", () => {
    const artifact = makeArtifact()
    const restored = artifactFromRow(artifactRowFrom(artifact))
    expect(restored).toEqual(artifact)
  })

  it("stores timestamps as numbers so IndexedDB can index them", () => {
    const row = artifactRowFrom(makeArtifact())
    expect(typeof row.createdAt).toBe("number")
    expect(typeof row.updatedAt).toBe("number")
  })

  it("flattens the one nested Date in metadata and restores it", () => {
    const lastAccessedAt = new Date("2026-03-04T05:06:07.000Z")
    const row = artifactRowFrom(
      makeArtifact({ metadata: { sourceOrigin: "tool", lastAccessedAt } })
    )
    expect(row.metadata?.lastAccessedAt).toBe(lastAccessedAt.getTime())
    expect(artifactFromRow(row).metadata?.lastAccessedAt).toEqual(lastAccessedAt)
  })

  it("leaves metadata without a timestamp untouched", () => {
    const row = artifactRowFrom(makeArtifact({ metadata: { chartType: "bar" } }))
    expect(row.metadata).toEqual({ chartType: "bar" })
    expect(artifactFromRow(row).metadata).toEqual({ chartType: "bar" })
  })

  it("survives the ISO strings a JSON backup round-trip leaves behind", () => {
    // A restored package hands back strings where the runtime type says Date.
    const fromBackup = makeArtifact({
      createdAt: "2026-01-01T00:00:00.000Z" as unknown as Date,
      updatedAt: "2026-02-01T00:00:00.000Z" as unknown as Date,
    })
    const restored = artifactFromRow(artifactRowFrom(fromBackup))
    expect(restored.createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"))
    expect(restored.updatedAt).toEqual(new Date("2026-02-01T00:00:00.000Z"))
  })

  it("keeps projectId so workspace isolation can partition the table", () => {
    expect(artifactRowFrom(makeArtifact()).projectId).toBe("p_1")
    const unscoped: ArtifactRow = artifactRowFrom(makeArtifact({ projectId: undefined }))
    expect(unscoped.projectId).toBeUndefined()
  })
})

describe("artifact version row conversion", () => {
  const version: ArtifactVersion = {
    id: "ver_1",
    artifactId: "art_1",
    title: "Quarterly revenue",
    content: "{}",
    version: 2,
    createdAt: new Date("2026-01-15T00:00:00.000Z"),
    changeDescription: "widened the y axis",
  }

  it("round-trips a version", () => {
    expect(artifactVersionFromRow(artifactVersionRowFrom(version))).toEqual(version)
  })

  it("inherits the parent artifact's project rather than inventing one", () => {
    expect(artifactVersionRowFrom(version, "p_1").projectId).toBe("p_1")
    expect(artifactVersionRowFrom(version).projectId).toBeUndefined()
  })
})
