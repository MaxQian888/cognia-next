import { conflictFindings, findingId, rankFindings, surfaceFindings } from "./findings"
import type { Finding } from "../model"

const KEY = "instruction-file:/repo/CLAUDE.md"

describe("surfaceFindings", () => {
  it("merges a confirming signal into the judged finding", () => {
    const findings = surfaceFindings({
      surfaceKey: KEY,
      judgedByModel: true,
      judged: [
        {
          pattern: "pressure-language",
          group: "dated-text",
          startLine: 2,
          endLine: 2,
          evidence: "You MUST",
          reason: "r",
          confidence: "high",
          action: "rewrite",
          replacement: "x",
        },
      ],
      signals: [
        {
          signal: "pressure-language",
          group: "dated-text",
          startLine: 2,
          endLine: 2,
          evidence: "MUST",
        },
      ],
      references: [],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      sources: ["judge", "signal"],
      replacement: "x",
      id: findingId(KEY, "pressure-language", "You MUST"),
    })
  })

  it("drops signals the model looked at and kept, and keeps them as low flags without a judgment", () => {
    const signals = [
      {
        signal: "thinking-scaffold" as const,
        group: "dated-text" as const,
        startLine: 3,
        endLine: 3,
        evidence: "think step by step",
      },
    ]
    expect(
      surfaceFindings({ surfaceKey: KEY, judgedByModel: true, judged: [], signals, references: [] })
    ).toEqual([])
    expect(
      surfaceFindings({
        surfaceKey: KEY,
        judgedByModel: false,
        judged: [],
        signals,
        references: [],
      })
    ).toEqual([
      expect.objectContaining({
        pattern: "thinking-scaffold",
        confidence: "low",
        action: "flag",
        sources: ["signal"],
      }),
    ])
  })

  it("turns missing references into proposed-only stale facts and raises a judged one to high", () => {
    const missing = surfaceFindings({
      surfaceKey: KEY,
      judgedByModel: false,
      judged: [],
      signals: [],
      references: [
        { kind: "path", value: "lib/gone.ts", line: 4, status: "missing" },
        { kind: "path", value: "lib/here.ts", line: 5, status: "exists" },
      ],
    })
    expect(missing).toEqual([
      expect.objectContaining({
        pattern: "stale-fact",
        confidence: "high",
        action: "flag",
        proposedOnly: true,
        evidence: "lib/gone.ts",
      }),
    ])
    const judged = surfaceFindings({
      surfaceKey: KEY,
      judgedByModel: true,
      judged: [
        {
          pattern: "stale-fact",
          group: "brittle-config",
          startLine: 4,
          endLine: 4,
          evidence: "Use lib/gone.ts",
          reason: "r",
          confidence: "medium",
          action: "remove",
        },
      ],
      signals: [],
      references: [{ kind: "path", value: "lib/gone.ts", line: 4, status: "missing" }],
    })
    expect(judged).toEqual([
      expect.objectContaining({
        confidence: "high",
        proposedOnly: true,
        sources: ["judge", "references"],
      }),
    ])
  })

  it("reports Skill hygiene", () => {
    const findings = surfaceFindings({
      surfaceKey: "skill:a",
      judgedByModel: false,
      judged: [],
      signals: [],
      references: [],
      skill: { status: "enabled", origin: "user", usageCount: 0, validationErrorCount: 2 },
    })
    expect(findings.map((finding) => [finding.pattern, finding.confidence])).toEqual([
      ["invalid-skill", "high"],
      ["unused-skill", "low"],
    ])
  })
})

describe("conflictFindings", () => {
  it("anchors on the older side and relates the newer one", () => {
    const [finding] = conflictFindings([
      {
        older: { surfaceKey: "a", surfaceName: "A", startLine: 1, endLine: 1, text: "Use tabs." },
        newer: { surfaceKey: "b", surfaceName: "B", startLine: 2, endLine: 2, text: "Use spaces." },
        ordered: true,
        reason: "r",
        confidence: "high",
        action: "remove",
      },
    ])
    expect(finding).toMatchObject({
      pattern: "conflict",
      location: { surfaceKey: "a", startLine: 1 },
      related: [{ surfaceKey: "b", startLine: 2, endLine: 2 }],
      proposedOnly: true,
      action: "remove",
    })
  })
})

describe("rankFindings", () => {
  const base = (
    id: string,
    confidence: Finding["confidence"],
    group: Finding["group"],
    line = 1
  ): Finding => ({
    id,
    group,
    pattern: "p",
    location: { surfaceKey: "k", startLine: line },
    evidence: "e",
    reason: "",
    confidence,
    action: "flag",
    sources: ["signal"],
  })

  it("merges duplicates by id and orders by confidence, then group, then location", () => {
    const ranked = rankFindings([
      base("c", "low", "hygiene"),
      base("a", "medium", "dated-text"),
      { ...base("a", "high", "dated-text"), sources: ["judge"] },
      base("b", "high", "brittle-config", 9),
    ])
    expect(ranked.map((finding) => finding.id)).toEqual(["b", "a", "c"])
    expect(ranked[1]).toMatchObject({ confidence: "high", sources: ["signal", "judge"] })
  })
})
