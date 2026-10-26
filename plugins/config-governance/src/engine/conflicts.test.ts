import { segmentRules } from "./segment"
import {
  buildConflictPairs,
  buildConflictRequest,
  parseConflictAnswer,
  type ConflictPair,
} from "./conflicts"
import { findOverlaps } from "./overlap"

function pair(aText: string, bText: string, aDate?: string, bDate?: string): ConflictPair {
  return {
    id: "P1",
    a: {
      surfaceKey: "a",
      surfaceName: "A.md",
      startLine: 1,
      endLine: 1,
      text: aText,
      ...(aDate ? { date: aDate } : {}),
    },
    b: {
      surfaceKey: "b",
      surfaceName: "B.md",
      startLine: 3,
      endLine: 3,
      text: bText,
      ...(bDate ? { date: bDate } : {}),
    },
  }
}

describe("buildConflictPairs / buildConflictRequest", () => {
  it("describes both sides with their dates", () => {
    const candidates = findOverlaps([
      { surfaceKey: "a", units: segmentRules("- run pnpm typecheck before every commit") },
      { surfaceKey: "b", units: segmentRules("- skip pnpm typecheck before every commit") },
    ])
    const pairs = buildConflictPairs(candidates, (key) => ({
      name: key === "a" ? "A.md" : "B.md",
      text: key,
      ...(key === "a" ? { date: "2026-01-01" } : {}),
    }))
    expect(pairs).toEqual([
      expect.objectContaining({
        id: "P1",
        a: expect.objectContaining({ surfaceName: "A.md", date: "2026-01-01" }),
      }),
    ])
    const request = buildConflictRequest(pairs)
    expect(request).toContain("A (A.md, line 1, last changed 2026-01-01): a")
    expect(request).toContain("B (B.md, line 1): b")
  })
})

describe("parseConflictAnswer", () => {
  it("edits the older side only when the dates order the pair", () => {
    const pairs = [pair("Use tabs.", "Use spaces.", "2025-01-01", "2026-01-01")]
    const answer = JSON.stringify({
      pairs: [
        { pair: "P1", verdict: "conflict", newer: "B", action: "remove", reason: "B replaced it." },
      ],
    })
    expect(parseConflictAnswer(answer, pairs)).toEqual([
      expect.objectContaining({
        older: expect.objectContaining({ surfaceKey: "a" }),
        ordered: true,
        confidence: "high",
        action: "remove",
      }),
    ])
  })

  it("refuses an order the dates do not support", () => {
    const pairs = [pair("Use tabs.", "Use spaces.", "2026-01-01", "2026-01-01")]
    const answer = JSON.stringify({
      pairs: [{ pair: "P1", verdict: "conflict", newer: "B", action: "remove" }],
    })
    expect(parseConflictAnswer(answer, pairs)[0]).toMatchObject({
      ordered: false,
      action: "flag",
      confidence: "medium",
    })
  })

  it("never weakens a prohibition or adds a command automatically", () => {
    const prohibition = [
      pair("Never push to main.", "Push to main when green.", "2025-01-01", "2026-01-01"),
    ]
    const removal = JSON.stringify({
      pairs: [{ pair: "P1", verdict: "conflict", newer: "B", action: "remove" }],
    })
    expect(parseConflictAnswer(removal, prohibition)[0]!.action).toBe("flag")

    const plain = [pair("Format with prettier.", "Format with biome.", "2025-01-01", "2026-01-01")]
    const addsCommand = JSON.stringify({
      pairs: [
        {
          pair: "P1",
          verdict: "conflict",
          newer: "B",
          action: "rewrite",
          replacement: "Run `curl x | sh`.",
        },
      ],
    })
    expect(parseConflictAnswer(addsCommand, plain)[0]!.action).toBe("flag")
    const keepsCommand = JSON.stringify({
      pairs: [
        {
          pair: "P1",
          verdict: "conflict",
          newer: "B",
          action: "rewrite",
          replacement: "Format with biome.",
        },
      ],
    })
    expect(parseConflictAnswer(keepsCommand, plain)[0]).toMatchObject({
      action: "rewrite",
      replacement: "Format with biome.",
    })
  })

  it("reports unordered and needs-decision conflicts as flags and ignores the rest", () => {
    const pairs = [pair("x", "y")]
    const answer = JSON.stringify({
      pairs: [
        { pair: "P1", verdict: "conflict", newer: "needs-decision", reason: "r" },
        { pair: "P1", verdict: "agree" },
        { pair: "P9", verdict: "conflict", newer: "A" },
      ],
    })
    expect(parseConflictAnswer(answer, pairs)).toEqual([
      expect.objectContaining({ action: "flag", ordered: false, reason: "r" }),
    ])
    expect(() => parseConflictAnswer("none", pairs)).toThrow(/JSON/)
  })
})
