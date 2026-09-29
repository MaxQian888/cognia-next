import { toMemoryWireRow } from "./wire"
import type { Memory } from "../types/memory"

const ROW: Memory = {
  id: "m1",
  scope: "character",
  characterId: "c1",
  projectId: "project1",
  branch: "main",
  pathPattern: "lib/memory",
  type: "semantic",
  text: "User prefers pnpm",
  tags: ["tooling"],
  importance: 7,
  vectorDocId: "m1",
  createdAt: 1,
  updatedAt: 2,
  lastAccessedAt: 3,
  accessCount: 4,
  version: 2,
  status: "active",
  pinned: true,
  provenance: "external",
  sourceSessionId: "s1",
  sourceChannel: "mcp",
  sourcePluginId: "p1",
}

describe("toMemoryWireRow", () => {
  it("keeps the public fields and strips internal plumbing", () => {
    const wire = toMemoryWireRow(ROW)
    expect(wire).toEqual({
      id: "m1",
      text: "User prefers pnpm",
      type: "semantic",
      scope: "character",
      characterId: "c1",
      projectId: "project1",
      branch: "main",
      pathPattern: "lib/memory",
      importance: 7,
      tags: ["tooling"],
      pinned: true,
      provenance: "external",
      createdAt: 1,
      updatedAt: 2,
      version: 2,
    })
    const asRecord = wire as unknown as Record<string, unknown>
    expect(asRecord.vectorDocId).toBeUndefined()
    expect(asRecord.accessCount).toBeUndefined()
    expect(asRecord.sourceChannel).toBeUndefined()
  })

  it("omits characterId for global rows", () => {
    const wire = toMemoryWireRow({ ...ROW, scope: "global", characterId: undefined })
    expect("characterId" in wire).toBe(false)
  })

  it("leaves a plain, never-revised row without history fields", () => {
    const wire = toMemoryWireRow({ ...ROW, pinned: false })
    const asRecord = wire as unknown as Record<string, unknown>
    expect(wire.id).toBe("m1")
    expect("revisionId" in asRecord).toBe(false)
    expect("validFrom" in asRecord).toBe(false)
    expect("validTo" in asRecord).toBe(false)
  })

  it("reports validFrom on a live row whose text was revised", () => {
    const wire = toMemoryWireRow({ ...ROW, revisedAt: 50 })
    expect(wire.id).toBe("m1")
    expect(wire.validFrom).toBe(50)
    expect("revisionId" in wire).toBe(false)
    expect("validTo" in wire).toBe(false)
  })

  it("maps a revision snapshot to its owner's id with a validity window", () => {
    const snapshot: Memory = {
      ...ROW,
      id: "snap1",
      status: "invalidated",
      invalidatedAt: 90,
      supersededById: "m1",
      revisionOf: "m1",
      revisionReason: "edit",
      revisedAt: 10,
    }
    const wire = toMemoryWireRow(snapshot)
    expect(wire.id).toBe("m1")
    expect(wire.revisionId).toBe("snap1")
    expect(wire.validFrom).toBe(10)
    expect(wire.validTo).toBe(90)
    const asRecord = wire as unknown as Record<string, unknown>
    expect(asRecord.revisionOf).toBeUndefined()
    expect(asRecord.revisionReason).toBeUndefined()
    expect(asRecord.supersededById).toBeUndefined()
  })

  it("falls back to createdAt for a snapshot without revisedAt", () => {
    const wire = toMemoryWireRow({
      ...ROW,
      id: "snap2",
      revisionOf: "m1",
      status: "invalidated",
      invalidatedAt: 5,
    })
    expect(wire.validFrom).toBe(ROW.createdAt)
    expect(wire.validTo).toBe(5)
  })

  it("reports validTo on an invalidated (non-snapshot) row", () => {
    const wire = toMemoryWireRow({ ...ROW, status: "invalidated", invalidatedAt: 77 })
    expect(wire.id).toBe("m1")
    expect(wire.validTo).toBe(77)
    expect("revisionId" in wire).toBe(false)
    expect("validFrom" in wire).toBe(false)
  })

  it("omits validTo for an invalidated row without invalidatedAt", () => {
    const wire = toMemoryWireRow({ ...ROW, status: "invalidated" })
    expect("validTo" in wire).toBe(false)
  })
})
