import { evaluateAutoDecision, type AutoModeConfig } from "./auto-mode"
import { __resetJudgeCache } from "./command-judge"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { Ruleset } from "./ruleset"

function client(response: string): LlmClient & { complete: jest.Mock } {
  const complete = jest.fn(async () => response)
  return { complete } as unknown as LlmClient & { complete: jest.Mock }
}

const RULES_ONLY: AutoModeConfig = { enabled: true, mode: "rules", denyOnHighRisk: true }
const WITH_MODEL: AutoModeConfig = { enabled: true, mode: "rules+model", denyOnHighRisk: true }

beforeEach(() => __resetJudgeCache())

describe("evaluateAutoDecision", () => {
  it("asks when auto-mode is disabled", async () => {
    const d = await evaluateAutoDecision({
      command: "ls",
      config: { enabled: false, mode: "rules", denyOnHighRisk: true },
    })
    expect(d.decision).toBe("ask")
    expect(d.source).toBe("default")
  })

  it("auto-allows a safe command from rules, without the model", async () => {
    const c = client('{"safe":true,"risk":"low","reason":"x"}')
    const d = await evaluateAutoDecision({ command: "git status", config: WITH_MODEL, client: c })
    expect(d.decision).toBe("allow")
    expect(d.source).toBe("rule")
    expect(c.complete).not.toHaveBeenCalled()
  })

  it("auto-denies a catastrophic command from rules, without the model", async () => {
    const c = client('{"safe":true,"risk":"low","reason":"x"}')
    const d = await evaluateAutoDecision({ command: "rm -rf /", config: WITH_MODEL, client: c })
    expect(d.decision).toBe("deny")
    expect(d.source).toBe("rule")
    expect(c.complete).not.toHaveBeenCalled()
  })

  it("asks on an uncertain command in rules-only mode (no client call)", async () => {
    const c = client('{"safe":true,"risk":"low","reason":"x"}')
    const d = await evaluateAutoDecision({ command: "git push", config: RULES_ONLY, client: c })
    expect(d.decision).toBe("ask")
    expect(c.complete).not.toHaveBeenCalled()
  })

  it("consults the model on an uncertain command and allows when safe+low", async () => {
    const c = client('{"safe":true,"risk":"low","reason":"just a push to a feature branch"}')
    const d = await evaluateAutoDecision({ command: "git push", config: WITH_MODEL, client: c })
    expect(d.decision).toBe("allow")
    expect(d.source).toBe("model")
    expect(c.complete).toHaveBeenCalledTimes(1)
  })

  it("denies on high risk when denyOnHighRisk is set", async () => {
    const c = client('{"safe":false,"risk":"high","reason":"force pushes to main"}')
    const d = await evaluateAutoDecision({
      command: "git push --force",
      config: WITH_MODEL,
      client: c,
    })
    expect(d.decision).toBe("deny")
    expect(d.source).toBe("model")
    expect(d.risk).toBe("high")
  })

  it("asks on high risk when denyOnHighRisk is off", async () => {
    const c = client('{"safe":false,"risk":"high","reason":"risky"}')
    const d = await evaluateAutoDecision({
      command: "git push --force",
      config: { enabled: true, mode: "rules+model", denyOnHighRisk: false },
      client: c,
    })
    expect(d.decision).toBe("ask")
    expect(d.source).toBe("model")
  })

  it("asks (medium) when the model is unsure", async () => {
    const c = client('{"safe":false,"risk":"medium","reason":"writes files"}')
    const d = await evaluateAutoDecision({ command: "git push", config: WITH_MODEL, client: c })
    expect(d.decision).toBe("ask")
    expect(d.source).toBe("model")
  })

  it("falls back to ask when the model returns null", async () => {
    const c = client("garbage")
    const d = await evaluateAutoDecision({ command: "git push", config: WITH_MODEL, client: c })
    expect(d.decision).toBe("ask")
    expect(d.source).toBe("rule")
  })

  it("falls back to ask when model mode is on but no client is available", async () => {
    const d = await evaluateAutoDecision({ command: "git push", config: WITH_MODEL, client: null })
    expect(d.decision).toBe("ask")
  })

  it("honours an explicit user allow rule over the classifier", async () => {
    const rules: Ruleset[] = [{ Bash: { "git push*": "allow" } }]
    const d = await evaluateAutoDecision({
      command: "git push origin main",
      config: RULES_ONLY,
      rules,
    })
    expect(d.decision).toBe("allow")
    expect(d.source).toBe("user-rule")
  })

  it("honours an explicit user deny rule over a safe classifier verdict", async () => {
    const rules: Ruleset[] = [{ Bash: { ls: "deny" } }]
    const d = await evaluateAutoDecision({ command: "ls -la", config: RULES_ONLY, rules })
    expect(d.decision).toBe("deny")
    expect(d.source).toBe("user-rule")
  })

  it("allows an empty command", async () => {
    const d = await evaluateAutoDecision({ command: "   ", config: RULES_ONLY })
    expect(d.decision).toBe("allow")
  })
})
