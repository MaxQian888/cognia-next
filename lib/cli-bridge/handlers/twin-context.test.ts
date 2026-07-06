/**
 * Coverage for the `twin_context_get` renderer handler. The load-bearing
 * assertion: the projected result NEVER carries retrieved chunk content —
 * only titles + scores (the chunk `content` field is unredacted by design
 * and must not cross the CLI bridge).
 */

const getCharacterMock = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  getCharacter: (...args: unknown[]) => getCharacterMock(...args),
}))

const tryBuildTwinDepsMock = jest.fn()
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: (...args: unknown[]) => tryBuildTwinDepsMock(...args),
}))

const applyTwinContextMock = jest.fn()
jest.mock("@/lib/twin/runtime", () => ({
  applyTwinContext: (...args: unknown[]) => applyTwinContextMock(...args),
}))

import { twinContextGet } from "./twin-context"

beforeEach(() => {
  getCharacterMock.mockReset()
  tryBuildTwinDepsMock.mockReset()
  applyTwinContextMock.mockReset()
})

describe("twinContextGet", () => {
  it("validates message and characterId", async () => {
    expect((await twinContextGet({ characterId: "c1", message: "  " })).ok).toBe(false)
    expect((await twinContextGet({ message: "hi" })).ok).toBe(false)
  })

  it("returns ok with no applied context for a non-twin-bound character", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1" })
    const out = await twinContextGet({ characterId: "c1", message: "hi" })
    expect(out).toEqual({ ok: true, degraded: false, sources: [], styleSampleCount: 0 })
    expect(tryBuildTwinDepsMock).not.toHaveBeenCalled()
  })

  it("degrades honestly when the twin runtime is not configured", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "tw1" })
    tryBuildTwinDepsMock.mockResolvedValue(undefined)
    const out = await twinContextGet({ characterId: "c1", message: "hi" })
    expect(out.ok).toBe(true)
    expect(out.degraded).toBe(true)
    expect(out.degradedReason).toMatch(/not configured/)
  })

  it("projects the applied prompt + segments and strips chunk content", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "tw1" })
    tryBuildTwinDepsMock.mockResolvedValue({ embedding: {}, store: {} })
    applyTwinContextMock.mockResolvedValue({
      applied: {
        systemPrompt: "TWIN PROMPT",
        cacheSegments: { stable: "STABLE", dynamic: "DYNAMIC" },
      },
      degraded: false,
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "RAW SECRET CONTENT", sourceId: "s1" },
          score: 0.9,
          sourceTitle: "Doc A",
        },
        { chunk: { vectorDocId: "v2", content: "MORE RAW", sourceId: "s2" }, score: 0.5 },
      ],
      selectedStyleSamples: [{ id: "ss1" }, { id: "ss2" }],
    })

    const out = await twinContextGet({ characterId: "c1", message: "hi", sessionId: "sess1" })
    expect(applyTwinContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "hi", sessionId: "sess1" })
    )
    expect(out.applied).toEqual({
      systemPrompt: "TWIN PROMPT",
      stable: "STABLE",
      dynamic: "DYNAMIC",
    })
    expect(out.sources).toEqual([{ title: "Doc A", score: 0.9 }, { score: 0.5 }])
    expect(out.styleSampleCount).toBe(2)
    // PII red-line: no raw chunk content anywhere in the projection.
    expect(JSON.stringify(out)).not.toContain("RAW SECRET CONTENT")
  })

  it("collapses handler exceptions into ok:false", async () => {
    getCharacterMock.mockRejectedValue(new Error("dexie offline"))
    const out = await twinContextGet({ characterId: "c1", message: "hi" })
    expect(out).toMatchObject({ ok: false, error: "dexie offline" })
  })
})
