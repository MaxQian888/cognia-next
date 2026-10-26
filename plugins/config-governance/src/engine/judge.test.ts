import type { PluginAgentConfigSurface } from "@cognia/plugin-sdk"

import { buildJudgeRequest, destinationAliases, MAX_LINE_DATES, parseJudgement } from "./judge"

const surface: PluginAgentConfigSurface = {
  key: "instruction-file:/repo/CLAUDE.md",
  source: "instruction-file",
  kind: "instructions",
  name: "CLAUDE.md",
  builtIn: false,
  modified: false,
  edit: "source",
  loadOrder: 0,
  layer: "project",
} as unknown as PluginAgentConfigSurface

const TEXT = [
  "# Rules",
  "- You MUST run tests.",
  "- Think step by step.",
  "- Use `lib/gone.ts`.",
].join("\n")

describe("buildJudgeRequest", () => {
  it("carries the target, surface, leads, evidence, facts, dates, destinations and numbered text", () => {
    const dates = new Map(
      Array.from({ length: MAX_LINE_DATES + 5 }, (_, i) => [i + 1, "2026-01-01"] as const)
    )
    const request = buildJudgeRequest({
      surface,
      text: TEXT,
      targetModel: "claude-opus-5-5",
      signals: [
        {
          signal: "pressure-language",
          group: "dated-text",
          startLine: 2,
          endLine: 2,
          evidence: "MUST",
        },
      ],
      references: [{ kind: "path", value: "lib/gone.ts", line: 4, status: "missing" }],
      lineDates: dates,
      facts: {
        instructions: {
          enabled: true,
          mode: "layered",
          fileNames: [],
          includeGlobal: true,
          maxFileBytes: 1,
          loadProjectAgents: true,
        },
        hooksAvailable: true,
        hooks: [
          {
            scope: "project",
            event: "PreToolUse",
            matcher: "Bash",
            type: "command",
            label: "guard.sh",
          },
        ],
        permissionRules: [
          { origin: "claude-project", tool: "Bash", pattern: "rm -rf *", verdict: "deny" },
        ],
        mcpServers: [],
        skills: { total: 0, enabled: 0, builtIn: 0 },
      },
      destinations: [{ key: "agent-file:/Users/someone/.claude/agents/x.md", name: "x" }],
    })
    expect(request).toContain("Target model: claude-opus-5-5")
    expect(request).toContain("layer: project")
    expect(request).toContain('L2: pressure-language — "MUST"')
    expect(request).toContain("L4: path lib/gone.ts → missing")
    expect(request).toContain("hook PreToolUse [Bash] → command guard.sh")
    expect(request).toContain("permission deny Bash(rm -rf *)")
    expect(request).toContain("D1 — x")
    expect(request).not.toContain("/Users/someone")
    expect(request).toContain("2| - You MUST run tests.")
    expect(request.match(/: 2026-01-01/g)).toHaveLength(MAX_LINE_DATES)
  })

  it("says when nothing is known", () => {
    const request = buildJudgeRequest({
      surface,
      text: "x",
      targetModel: "m",
      signals: [],
      references: [],
      destinations: [],
    })
    expect(request).toContain("(not available)")
    expect(request).not.toContain("Last change per line")
  })
})

describe("parseJudgement", () => {
  const destinations = destinationAliases([{ key: "skill:x", name: "x" }])

  it("keeps findings whose pattern, lines and evidence check out", () => {
    const answer = JSON.stringify({
      findings: [
        {
          pattern: "pressure-language",
          startLine: 2,
          endLine: 2,
          evidence: "You MUST run tests.",
          reason: "Shouted.",
          confidence: "high",
          action: "rewrite",
          replacement: "- Run the tests.",
        },
        {
          pattern: "thinking-scaffold",
          startLine: 3,
          evidence: "Think step by step.",
          reason: "Adaptive thinking.",
          confidence: "medium",
          action: "remove",
        },
      ],
    })
    expect(parseJudgement(answer, TEXT, destinations)).toEqual([
      expect.objectContaining({
        pattern: "pressure-language",
        group: "dated-text",
        action: "rewrite",
        replacement: "- Run the tests.",
      }),
      expect.objectContaining({
        pattern: "thinking-scaffold",
        startLine: 3,
        endLine: 3,
        action: "remove",
      }),
    ])
  })

  it("drops unknown patterns, bad lines and evidence that is not on the lines", () => {
    const answer = JSON.stringify({
      findings: [
        {
          pattern: "made-up",
          startLine: 2,
          evidence: "MUST",
          reason: "r",
          confidence: "high",
          action: "remove",
        },
        {
          pattern: "fossil",
          startLine: 9,
          evidence: "x",
          reason: "r",
          confidence: "high",
          action: "remove",
        },
        {
          pattern: "fossil",
          startLine: 3,
          endLine: 2,
          evidence: "Think",
          reason: "r",
          confidence: "high",
          action: "remove",
        },
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "not there",
          reason: "r",
          confidence: "high",
          action: "remove",
        },
      ],
    })
    expect(parseJudgement(answer, TEXT, destinations)).toEqual([])
  })

  it("turns unusable edits and low confidence into flags", () => {
    const answer = JSON.stringify({
      findings: [
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "MUST",
          reason: "r",
          confidence: "high",
          action: "rewrite",
        },
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "MUST",
          reason: "r",
          confidence: "high",
          action: "move",
          moveTo: "skill:x",
        },
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "MUST",
          reason: "r",
          confidence: "low",
          action: "remove",
        },
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "MUST",
          reason: "",
          confidence: "high",
          action: "remove",
        },
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "MUST",
          reason: "r",
          confidence: "high",
          action: "move",
          moveTo: "D1",
        },
      ],
    })
    const parsed = parseJudgement(answer, TEXT, destinations)
    expect(parsed.map((finding) => [finding.action, finding.confidence])).toEqual([
      ["flag", "high"],
      ["flag", "high"],
      ["flag", "low"],
      ["flag", "low"],
      ["move", "high"],
    ])
    expect(parsed[4]!.moveTo).toBe("skill:x")
  })

  it("throws when there is no JSON object", () => {
    expect(() => parseJudgement("nope", TEXT, destinations)).toThrow(/JSON/)
  })
})
