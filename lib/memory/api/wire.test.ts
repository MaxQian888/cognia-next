import { toMemoryWireRow } from "./wire"
import type { Memory } from "@/types/memory/memory"

const ROW: Memory = {
  id: "m1",
  scope: "character",
  characterId: "c1",
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
      importance: 7,
      tags: ["tooling"],
      pinned: true,
      provenance: "external",
      createdAt: 1,
      updatedAt: 2,
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
})
