import type { HarnessToolRule } from "@cognia/agent-config-types/agent-harness"
import {
  MAX_TOOL_RULES,
  createToolRuleState,
  evaluatePreToolUse,
  hasPreToolRules,
  hasResultRules,
  parseHarnessToolRules,
  projectToolResult,
  toolMatches,
  toolResultText,
  validateHarnessToolRules,
} from "./tool-rules"

const rules: HarnessToolRule[] = [
  { id: "bash-cap", kind: "call-cap", tool: "Bash", maxCalls: 2, reason: "Stop retrying." },
  { id: "trim", kind: "trim-output", tool: "Read", maxChars: 500 },
  {
    id: "enoent",
    kind: "error-hint",
    tool: "*",
    patterns: ["ENOENT"],
    hint: "List the directory first.",
  },
  { id: "verify", kind: "verify-after-write", tool: "Write", reminder: "Re-open the file." },
]

describe("validateHarnessToolRules", () => {
  it("accepts a well-formed document and a bare array", () => {
    expect(validateHarnessToolRules({ version: 1, rules })).toEqual({ ok: true, rules })
    expect(validateHarnessToolRules(rules)).toEqual({ ok: true, rules })
  })

  it("rejects unknown kinds, fields, versions and top-level keys", () => {
    const result = validateHarnessToolRules({
      version: 2,
      extra: true,
      rules: [
        { id: "x", kind: "run-code", tool: "Bash" },
        { id: "y", kind: "trim-output", tool: "Read", maxChars: 900, code: "evil()" },
      ],
    })
    expect(result.ok).toBe(false)
    const errors = !result.ok ? result.errors.join("\n") : ""
    expect(errors).toMatch(/version must be 1/)
    expect(errors).toMatch(/unknown top-level key "extra"/)
    expect(errors).toMatch(/kind must be one of/)
    expect(errors).toMatch(/code is not a field of a trim-output rule/)
  })

  it("rejects duplicate ids, bad tool patterns and out-of-range numbers", () => {
    const result = validateHarnessToolRules([
      { id: "a", kind: "trim-output", tool: "Re ad", maxChars: 10 },
      { id: "a", kind: "call-cap", tool: "Bash", maxCalls: 0, reason: "r" },
      { id: "Bad Id", kind: "verify-after-write", tool: "Write", reminder: "" },
    ])
    const errors = !result.ok ? result.errors.join("\n") : ""
    expect(errors).toMatch(/"a" is used twice/)
    expect(errors).toMatch(/tool must be a tool name/)
    expect(errors).toMatch(/maxChars must be an integer from 500/)
    expect(errors).toMatch(/maxCalls must be an integer from 1/)
    expect(errors).toMatch(/id must match/)
    expect(errors).toMatch(/reminder must be a non-empty string/)
  })

  it("caps the number of rules and patterns", () => {
    const many = Array.from({ length: MAX_TOOL_RULES + 1 }, (_, i) => ({
      id: `r${i}`,
      kind: "trim-output",
      tool: "Read",
      maxChars: 1000,
    }))
    expect(validateHarnessToolRules(many).ok).toBe(false)
    const patterns = validateHarnessToolRules([
      { id: "h", kind: "error-hint", tool: "*", patterns: [], hint: "x" },
    ])
    expect(!patterns.ok && patterns.errors[0]).toMatch(/patterns must hold 1 to 8/)
  })
})

describe("parseHarnessToolRules", () => {
  it("treats an empty file as no rules and reports bad JSON", () => {
    expect(parseHarnessToolRules("  ")).toEqual({ ok: true, rules: [] })
    const bad = parseHarnessToolRules("{")
    expect(!bad.ok && bad.errors[0]).toMatch(/not valid JSON/)
  })
})

describe("toolMatches", () => {
  it.each([
    ["*", "Anything", true],
    ["mcp__*", "mcp__fs__read", true],
    ["mcp__*", "Read", false],
    ["Read", "Read", true],
    ["Read", "ReadMany", false],
  ])("%s vs %s", (pattern, tool, expected) => {
    expect(toolMatches(pattern, tool)).toBe(expected)
  })
})

describe("call caps", () => {
  it("denies at the gate once the executed count reaches the cap", () => {
    const state = createToolRuleState()
    expect(evaluatePreToolUse(rules, state, "Bash")).toEqual({ action: "allow" })
    projectToolResult(rules, state, "Bash", "ok", false)
    projectToolResult(rules, state, "Bash", "ok", false)
    const denied = evaluatePreToolUse(rules, state, "Bash")
    expect(denied).toMatchObject({ action: "deny", ruleId: "bash-cap" })
    expect(denied.action === "deny" && denied.reason).toMatch(/Stop retrying.*limited to 2/)
    expect(state.calls.get("bash-cap:Bash")).toBe(2)
  })

  it("withholds the result of a call that ran past its cap", () => {
    const state = createToolRuleState()
    projectToolResult(rules, state, "Bash", "1", false)
    projectToolResult(rules, state, "Bash", "2", false)
    const third = projectToolResult(rules, state, "Bash", [{ type: "image" }], false)
    expect(third).toEqual({
      changed: true,
      output: expect.stringMatching(/^\[harness rule bash-cap\] Result withheld\. Stop retrying\./),
      appliedRuleIds: ["bash-cap"],
    })
  })

  it("never touches tools a rule does not cover", () => {
    const state = createToolRuleState()
    for (let i = 0; i < 10; i++) {
      expect(evaluatePreToolUse(rules, state, "Read")).toEqual({ action: "allow" })
      projectToolResult(rules, state, "Read", "x", false)
    }
    expect(state.calls.size).toBe(0)
  })
})

describe("toolResultText", () => {
  it("reads strings and all-text content blocks only", () => {
    expect(toolResultText("x")).toBe("x")
    expect(
      toolResultText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\nb")
    expect(toolResultText({ content: [{ type: "text", text: "c" }] })).toBe("c")
    expect(toolResultText([{ type: "image", data: "…" }])).toBeNull()
    expect(toolResultText({ rows: 3 })).toBeNull()
    expect(toolResultText([])).toBeNull()
  })
})

describe("projectToolResult", () => {
  it("trims the middle of a long result and names the cut", () => {
    const body = `${"a".repeat(400)}${"m".repeat(2000)}${"z".repeat(400)}`
    const out = projectToolResult(rules, createToolRuleState(), "Read", body, false)
    expect(out.changed).toBe(true)
    expect(out.appliedRuleIds).toEqual(["trim"])
    expect(out.output.startsWith("a".repeat(300))).toBe(true)
    expect(out.output.endsWith("z".repeat(200))).toBe(true)
    expect(out.output).toMatch(/chars trimmed by harness rule trim/)
  })

  it("appends a hint to a matching error, case-insensitively", () => {
    const out = projectToolResult(
      rules,
      createToolRuleState(),
      "Bash",
      "enoent: no such file",
      true
    )
    expect(out.output).toBe(
      "enoent: no such file\n\n[harness hint enoent] List the directory first."
    )
    expect(
      projectToolResult(rules, createToolRuleState(), "Bash", "permission denied", true).changed
    ).toBe(false)
  })

  it("reminds after a successful write but not after a failed one", () => {
    expect(projectToolResult(rules, createToolRuleState(), "Write", "ok", false).output).toMatch(
      /\[harness reminder verify\] Re-open the file\.$/
    )
    expect(
      projectToolResult(rules, createToolRuleState(), "Write", "disk full", true).appliedRuleIds
    ).toEqual([])
  })

  it("adds no hint or reminder when the outcome is unknown, but still trims", () => {
    expect(
      projectToolResult(rules, createToolRuleState(), "Bash", "ENOENT: no such file", undefined)
        .changed
    ).toBe(false)
    expect(
      projectToolResult(rules, createToolRuleState(), "Write", "ok", undefined).appliedRuleIds
    ).toEqual([])
    const long = "x".repeat(3000)
    expect(
      projectToolResult(rules, createToolRuleState(), "Read", long, undefined).appliedRuleIds
    ).toEqual(["trim"])
  })

  it("never rewrites a non-text result", () => {
    expect(
      projectToolResult(rules, createToolRuleState(), "Read", [{ type: "image" }], false)
    ).toEqual({
      changed: false,
      output: "",
      appliedRuleIds: [],
    })
  })
})

describe("rule presence", () => {
  it("splits pre-call and result-side rules", () => {
    expect(hasPreToolRules(rules)).toBe(true)
    expect(hasResultRules(rules)).toBe(true)
    expect(hasPreToolRules([rules[1]])).toBe(false)
    expect(hasResultRules([rules[0]])).toBe(true)
    expect(hasResultRules([])).toBe(false)
    expect(hasPreToolRules(undefined)).toBe(false)
  })
})
