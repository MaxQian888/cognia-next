import type { RuleCheck } from "../adherence/checks"
import type { NormalizedToolCall } from "../adherence/events"
import {
  EnforcementEngine,
  MAX_TRACKED_SESSIONS,
  ruleLocation,
  toolResultText,
  validateRule,
  type EnforcementRule,
} from "./rules"

const ref = { surfaceKey: "k", surfaceName: "CLAUDE.md", startLine: 7, endLine: 7, text: "r" }

function rule(
  id: string,
  check: Partial<RuleCheck>,
  partial: Partial<EnforcementRule> = {}
): EnforcementRule {
  return {
    id,
    check: {
      id: `C-${id}`,
      kind: "forbid",
      trigger: { family: "shell", command: "^git push --force" },
      scope: "turn",
      summary: "s",
      rule: ref,
      ...check,
    },
    mode: "block",
    workspaceId: null,
    enabled: true,
    createdAt: 0,
    ...partial,
  }
}

const shell = (command: string): NormalizedToolCall => ({
  family: "shell",
  tool: "bash",
  command,
  paths: [],
})
const edit = (path: string): NormalizedToolCall => ({ family: "edit", tool: "edit", paths: [path] })

describe("EnforcementEngine", () => {
  it("blocks a forbidden call in block mode and reminds in remind mode", () => {
    const engine = new EnforcementEngine()
    engine.setRules([rule("a", {})])
    expect(engine.pre("s", null, shell("git push --force")).blockedBy?.id).toBe("a")
    expect(engine.pre("s", null, shell("git status")).blockedBy).toBeUndefined()
    engine.setRules([rule("a", {}, { mode: "remind" })])
    expect(engine.pre("s", null, shell("git push --force")).blockedBy).toBeUndefined()
    expect(engine.post("s", null, shell("git push --force")).reminders.map((r) => r.id)).toEqual([
      "a",
    ])
  })

  it("skips disabled, invalid and other-workspace rules", () => {
    const engine = new EnforcementEngine()
    engine.setRules([
      rule("off", {}, { enabled: false }),
      rule("bad", { trigger: { family: "shell", command: "(a+)+" } }),
      rule("ws", {}, { workspaceId: "w1" }),
    ])
    expect(engine.hasRules()).toBe(true)
    expect(engine.pre("s", "w2", shell("git push --force")).blockedBy).toBeUndefined()
    expect(engine.pre("s", "w1", shell("git push --force")).blockedBy?.id).toBe("ws")
  })

  it("blocks require-before until the expectation happened in the turn", () => {
    const engine = new EnforcementEngine()
    engine.setRules([
      rule("b", {
        kind: "require-before",
        trigger: { family: "shell", command: "^git commit" },
        expect: { family: "shell", command: "^pnpm test" },
      }),
    ])
    expect(engine.pre("s", null, shell("git commit -m x")).blockedBy?.id).toBe("b")
    expect(engine.pre("s", null, shell("pnpm test")).blockedBy).toBeUndefined()
    expect(engine.pre("s", null, shell("git commit -m x")).blockedBy).toBeUndefined()
    engine.onPrompt("s")
    expect(engine.pre("s", null, shell("git commit -m x")).blockedBy?.id).toBe("b")
  })

  it("reminds require-before in remind mode when the expectation is missing", () => {
    const engine = new EnforcementEngine()
    engine.setRules([
      rule(
        "b",
        {
          kind: "require-before",
          trigger: { family: "shell", command: "^git commit" },
          expect: { family: "shell", command: "^pnpm test" },
        },
        { mode: "remind" }
      ),
    ])
    engine.pre("s", null, shell("git commit"))
    expect(engine.post("s", null, shell("git commit")).reminders).toHaveLength(1)
    engine.pre("s", null, shell("pnpm test"))
    engine.post("s", null, shell("pnpm test"))
    engine.pre("s", null, shell("git commit"))
    expect(engine.post("s", null, shell("git commit")).reminders).toHaveLength(0)
  })

  it("reminds require-after once per opening, until the expectation closes it or the turn ends", () => {
    const engine = new EnforcementEngine()
    engine.setRules([
      rule("c", {
        kind: "require-after",
        trigger: { family: "edit" },
        expect: { family: "shell", command: "^pnpm test" },
      }),
    ])
    expect(engine.post("s", null, edit("a.ts")).reminders).toHaveLength(1)
    expect(engine.post("s", null, edit("b.ts")).reminders).toHaveLength(0)
    engine.post("s", null, shell("pnpm test"))
    expect(engine.post("s", null, edit("c.ts")).reminders).toHaveLength(1)
    engine.onPrompt("s")
    expect(engine.post("s", null, edit("d.ts")).reminders).toHaveLength(1)
    // `require-after` never blocks: the call it waits for has not happened yet.
    expect(engine.pre("s", null, edit("e.ts")).blockedBy).toBeUndefined()
  })

  it("tracks a bounded number of sessions and forgets them", () => {
    const engine = new EnforcementEngine()
    engine.setRules([
      rule("b", {
        kind: "require-before",
        trigger: { family: "shell", command: "^git commit" },
        expect: { family: "shell", command: "^pnpm test" },
      }),
    ])
    engine.pre("first", null, shell("pnpm test"))
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) engine.pre(`s${i}`, null, shell("ls"))
    expect(engine.pre("first", null, shell("git commit")).blockedBy?.id).toBe("b")
    engine.pre("x", null, shell("pnpm test"))
    engine.forget("x")
    expect(engine.pre("x", null, shell("git commit")).blockedBy?.id).toBe("b")
    engine.forget()
    engine.setRules([])
    expect(engine.hasRules()).toBe(false)
  })
})

describe("helpers", () => {
  it("formats the location and reads text results", () => {
    expect(ruleLocation(rule("a", {}))).toBe("CLAUDE.md:7")
    expect(toolResultText("x")).toBe("x")
    expect(
      toolResultText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\nb")
    expect(toolResultText({ content: [{ type: "text", text: "a" }] })).toBe("a")
    expect(toolResultText({ content: [{ type: "image", data: "x" }] })).toBeNull()
    expect(toolResultText({ ok: true })).toBeNull()
    expect(toolResultText([])).toBeNull()
  })

  it("validates rules", () => {
    expect(validateRule(rule("a", {}))).toBe(true)
    expect(validateRule(rule("a", { trigger: { family: "shell", command: "(" } }))).toBe(false)
    expect(validateRule(rule("a", { kind: "require-after" }))).toBe(false)
  })
})
