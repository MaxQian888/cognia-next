import { routeDelegation } from "./delegation-router"
import type { ExternalAgentDelegationResult } from "@/types/agent/external-agent"

const NO_MATCH: ExternalAgentDelegationResult = {
  shouldDelegate: false,
  reason: "No matching delegation rule",
  reasonCode: "external_unavailable",
}

const MATCH: ExternalAgentDelegationResult = {
  shouldDelegate: true,
  targetAgentId: "agent-7",
  matchedRule: {
    id: "rule-1",
    name: "Code tasks → Claude Code",
    condition: "keyword",
    matcher: "refactor",
    targetAgentId: "agent-7",
    priority: 10,
    enabled: true,
  },
  reason: "Matched rule: Code tasks → Claude Code",
  reasonCode: "ok",
}

describe("routeDelegation", () => {
  it("returns shouldDelegate=false with the raw prompt when no rule matches", () => {
    const decision = routeDelegation({ prompt: "hello" }, { checkDelegation: () => NO_MATCH })
    expect(decision.shouldDelegate).toBe(false)
    expect(decision.filteredPrompt).toBe("hello")
    expect(decision.reasonCode).toBe("external_unavailable")
  })

  it("treats a match without a targetAgentId as no-delegation (defensive)", () => {
    const decision = routeDelegation(
      { prompt: "x" },
      { checkDelegation: () => ({ shouldDelegate: true, reasonCode: "ok" }) }
    )
    expect(decision.shouldDelegate).toBe(false)
  })

  it("surfaces the matched rule id + name on delegation", () => {
    const decision = routeDelegation(
      { prompt: "please refactor this" },
      { checkDelegation: () => MATCH }
    )
    expect(decision.shouldDelegate).toBe(true)
    expect(decision.targetAgentId).toBe("agent-7")
    expect(decision.matchedRuleId).toBe("rule-1")
    expect(decision.matchedRuleName).toBe("Code tasks → Claude Code")
  })

  it("passes the prompt through verbatim when no redactor is supplied", () => {
    const decision = routeDelegation(
      { prompt: "email me at a@b.com" },
      { checkDelegation: () => MATCH }
    )
    expect(decision.filteredPrompt).toBe("email me at a@b.com")
    expect(decision.redactionMap).toBeUndefined()
  })

  it("redacts the prompt and retains the map when a redactor is supplied", () => {
    const decision = routeDelegation(
      { prompt: "ping a@b.com" },
      {
        checkDelegation: () => MATCH,
        redact: (text) => ({
          redacted: text.replace("a@b.com", "[[EMAIL_1]]"),
          map: {
            "[[EMAIL_1]]": { placeholder: "[[EMAIL_1]]", original: "a@b.com", kind: "email" },
          },
        }),
      }
    )
    expect(decision.filteredPrompt).toBe("ping [[EMAIL_1]]")
    expect(decision.redactionMap?.["[[EMAIL_1]]"]?.original).toBe("a@b.com")
  })

  it("omits the redaction map when the redactor finds nothing", () => {
    const decision = routeDelegation(
      { prompt: "no pii here" },
      {
        checkDelegation: () => MATCH,
        redact: (text) => ({ redacted: text, map: {} }),
      }
    )
    expect(decision.filteredPrompt).toBe("no pii here")
    expect(decision.redactionMap).toBeUndefined()
  })

  it("forwards the context to the matcher", () => {
    const checkDelegation = jest.fn(() => NO_MATCH)
    routeDelegation({ prompt: "x", context: { sessionId: "s1" } }, { checkDelegation })
    expect(checkDelegation).toHaveBeenCalledWith("x", { sessionId: "s1" })
  })
})
