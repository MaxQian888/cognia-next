import type { Loop } from "@/types/loop"
import { LOOP_TRAILER_DIRECTIVE, renderLoopIterationMessage } from "./prompts"

function buildLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "lp_1",
    sessionId: "ses_a",
    mode: "self_paced",
    rawPrompt: "summarize new commits",
    safePrompt: "summarize new commits",
    redactionMapEnc: "",
    isSlashCommand: false,
    status: "active",
    iterations: 0,
    tokensUsed: 0,
    generationId: "gen-1",
    config: {
      maxIterations: 100,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    parseFailureCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("LOOP_TRAILER_DIRECTIVE", () => {
  it("demands the single-line JSON trailer with delay bounds", () => {
    expect(LOOP_TRAILER_DIRECTIVE).toContain('{"continue": true, "delaySeconds": <60-3600>')
    expect(LOOP_TRAILER_DIRECTIVE).toContain('{"continue": false')
  })

  it("carries the no-false-completion clause", () => {
    expect(LOOP_TRAILER_DIRECTIVE).toMatch(/Do NOT declare completion unless it is literally true/)
    expect(LOOP_TRAILER_DIRECTIVE).toMatch(/never end the loop just to escape it/)
  })
})

describe("renderLoopIterationMessage", () => {
  it("frames the safe prompt with a 1-indexed iteration counter", () => {
    const out = renderLoopIterationMessage(buildLoop({ iterations: 4 }))
    expect(out).toContain("[Loop iteration 5 of 100]")
    expect(out).toContain("summarize new commits")
    expect(out).toContain(LOOP_TRAILER_DIRECTIVE)
  })

  it("uses the redacted prompt, never the raw one", () => {
    const out = renderLoopIterationMessage(
      buildLoop({ rawPrompt: "ping bob@x.com", safePrompt: "ping <EMAIL_001>" })
    )
    expect(out).toContain("<EMAIL_001>")
    expect(out).not.toContain("bob@x.com")
  })
})
