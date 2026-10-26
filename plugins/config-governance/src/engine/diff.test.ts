import type { Finding } from "../model"
import { applyHunks, buildHunks, renderHunk, StaleHunkError } from "./diff"

const TEXT = [
  "# Rules",
  "- You MUST run tests.",
  "- Think step by step.",
  "- token=[REDACTED]",
].join("\n")

function finding(partial: Partial<Finding> & Pick<Finding, "id" | "action">): Finding {
  return {
    group: "dated-text",
    pattern: "p",
    location: { surfaceKey: "a", startLine: 2, endLine: 2 },
    evidence: "e",
    reason: "r",
    confidence: "high",
    sources: ["judge"],
    ...partial,
  }
}

const surfaces = new Map([
  ["a", { text: TEXT.replace("[REDACTED]", "abc123"), redacted: TEXT }],
  ["b", { text: "# Skill\n\n- existing\n\n", redacted: "# Skill\n\n- existing\n\n" }],
])

describe("buildHunks", () => {
  it("cuts remove, rewrite and add hunks for confident edits only", () => {
    const { hunks } = buildHunks(
      [
        finding({
          id: "rm",
          action: "remove",
          location: { surfaceKey: "a", startLine: 3, endLine: 3 },
        }),
        finding({ id: "rw", action: "rewrite", replacement: "- Run the tests." }),
        finding({ id: "low", action: "remove", confidence: "low" }),
        finding({ id: "flag", action: "flag" }),
      ],
      surfaces
    )
    expect(hunks.map((hunk) => [hunk.findingId, hunk.before, hunk.after])).toEqual([
      ["rw", ["- You MUST run tests."], ["- Run the tests."]],
      ["rm", ["- Think step by step."], []],
    ])
  })

  it("withholds a text write over a redacted line but still allows removing it", () => {
    const location = { surfaceKey: "a", startLine: 4, endLine: 4 }
    const { hunks, withheld } = buildHunks(
      [
        finding({ id: "rw", action: "rewrite", replacement: "x", location }),
        finding({ id: "rm", action: "remove", location, confidence: "medium" }),
      ],
      surfaces
    )
    expect(withheld).toEqual(
      expect.arrayContaining([{ findingId: "rw", reason: "redacted-region" }])
    )
    expect(hunks.map((hunk) => [hunk.findingId, hunk.before])).toEqual([["rm", ["- token=abc123"]]])
  })

  it("moves as two hunks and needs a destination", () => {
    const { hunks, withheld } = buildHunks(
      [
        finding({
          id: "mv",
          action: "move",
          moveTo: "b",
          location: { surfaceKey: "a", startLine: 3, endLine: 3 },
        }),
        finding({
          id: "lost",
          action: "move",
          moveTo: "zzz",
          location: { surfaceKey: "a", startLine: 2, endLine: 2 },
        }),
      ],
      surfaces
    )
    expect(withheld).toEqual([{ findingId: "lost", reason: "missing-destination" }])
    expect(hunks).toEqual([
      expect.objectContaining({
        findingId: "mv",
        surfaceKey: "a",
        before: ["- Think step by step."],
        after: [],
      }),
      expect.objectContaining({
        findingId: "mv",
        surfaceKey: "b",
        startLine: 4,
        endLine: 3,
        after: ["", "- Think step by step."],
      }),
    ])
  })

  it("lets the more confident of two overlapping hunks win", () => {
    const { hunks, withheld } = buildHunks(
      [
        finding({ id: "med", action: "remove", confidence: "medium" }),
        finding({ id: "high", action: "rewrite", replacement: "- ok" }),
      ],
      surfaces
    )
    expect(hunks.map((hunk) => hunk.findingId)).toEqual(["high"])
    expect(withheld).toEqual([{ findingId: "med", reason: "overlap" }])
  })

  it("marks proposed-only hunks", () => {
    const { hunks } = buildHunks(
      [finding({ id: "c", action: "remove", proposedOnly: true })],
      surfaces
    )
    expect(hunks[0]!.proposedOnly).toBe(true)
  })
})

describe("applyHunks", () => {
  it("applies bottom-up and refuses text that changed", () => {
    const original = surfaces.get("a")!.text
    const { hunks } = buildHunks(
      [
        finding({ id: "rw", action: "rewrite", replacement: "- Run the tests.\n- Then lint." }),
        finding({
          id: "rm",
          action: "remove",
          location: { surfaceKey: "a", startLine: 3, endLine: 3 },
        }),
      ],
      surfaces
    )
    expect(applyHunks(original, hunks)).toBe(
      "# Rules\n- Run the tests.\n- Then lint.\n- token=abc123"
    )
    expect(() => applyHunks(original.replace("MUST", "must"), hunks)).toThrow(StaleHunkError)
  })

  it("inserts an add hunk after its line", () => {
    const { hunks } = buildHunks(
      [finding({ id: "add", action: "add", replacement: "- Added." })],
      surfaces
    )
    expect(applyHunks(surfaces.get("a")!.text, hunks).split("\n")[2]).toBe("- Added.")
  })
})

describe("renderHunk", () => {
  const hunk = {
    findingId: "x",
    surfaceKey: "a",
    startLine: 2,
    endLine: 2,
    before: ["old"],
    after: ["new"],
    proposedOnly: false,
  }

  it("renders without context when no text is given", () => {
    expect(renderHunk(hunk)).toEqual([
      { kind: "removed", line: 2, text: "old" },
      { kind: "added", line: 2, text: "new" },
    ])
  })

  it("adds context lines around it from the text", () => {
    const lines = renderHunk(hunk, "a\nold\nc\nd", 1)
    expect(lines.map((line) => line.kind)).toEqual(["context", "removed", "added", "context"])
  })
})
