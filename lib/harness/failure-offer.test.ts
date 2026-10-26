import { DEFAULT_HARNESS_EVOLUTION_SETTINGS } from "./settings"
import {
  HARNESS_FAILURE_CODES,
  decideFailureOffer,
  failureOfferDismissKey,
  isHarnessFailure,
  lastUserRequest,
  runOfSession,
  taskDraftFromFailedTurn,
  type FailureOfferInput,
} from "./failure-offer"

const HOUR = 60 * 60_000
const NOW = 1000 * HOUR

function input(over: Partial<FailureOfferInput> = {}): FailureOfferInput {
  return {
    settings: {
      ...DEFAULT_HARNESS_EVOLUTION_SETTINGS,
      enabled: true,
      startMode: "failure-triggered",
    },
    diagnostic: { code: "budgetExhausted" },
    agent: { id: "agent-1" },
    prompt: "Summarise the CSV files into report.md",
    runs: [],
    sessionId: "sess-1",
    now: NOW,
    ...over,
  }
}

describe("isHarnessFailure", () => {
  it("accepts conduct failures only", () => {
    expect(isHarnessFailure({ code: "budgetExhausted" })).toBe(true)
    expect(isHarnessFailure({ code: "dispatchRejectedCycle" })).toBe(true)
    expect(isHarnessFailure({ code: "rateLimited" })).toBe(false)
    expect(isHarnessFailure({ code: "sidecarExited" })).toBe(false)
    expect(isHarnessFailure(null)).toBe(false)
    expect(HARNESS_FAILURE_CODES.has("unauthorized")).toBe(false)
  })
})

describe("decideFailureOffer", () => {
  it("offers in failure-triggered mode and enqueues in background mode", () => {
    expect(decideFailureOffer(input())).toEqual({ kind: "offer" })
    expect(
      decideFailureOffer(
        input({
          settings: { ...input().settings, startMode: "background" },
        })
      )
    ).toEqual({ kind: "enqueue" })
  })

  it("says why it stays quiet", () => {
    const reason = (over: Partial<FailureOfferInput>) => {
      const d = decideFailureOffer(input(over))
      return d.kind === "none" ? d.reason : d.kind
    }
    expect(reason({ settings: { ...input().settings, enabled: false } })).toBe("off")
    expect(reason({ settings: { ...input().settings, startMode: "manual" } })).toBe("off")
    expect(reason({ diagnostic: { code: "rateLimited" } })).toBe("not-harness-failure")
    expect(reason({ diagnostic: null })).toBe("not-harness-failure")
    expect(reason({ agent: { id: "a", runtime: { kind: "codex" } as never } })).toBe(
      "unsupported-agent"
    )
    expect(reason({ agent: null })).toBe("unsupported-agent")
    expect(reason({ prompt: "  hi " })).toBe("no-prompt")
    expect(
      reason({
        runs: [
          {
            trigger: "failure-triggered",
            createdAt: NOW - HOUR,
            sessionId: "sess-1",
            status: "probing",
          },
        ],
      })
    ).toBe("already-running")
    expect(reason({ dismissedAt: NOW - HOUR })).toBe("dismissed")
    expect(reason({ dismissedAt: NOW - 7 * HOUR })).toBe("offer")
    expect(
      reason({
        runs: [
          {
            trigger: "background",
            createdAt: NOW - 2 * HOUR,
            sessionId: "other",
            status: "completed",
          },
        ],
      })
    ).toBe("cooldown")
    // Manual runs, failed runs of this conversation and old runs do not hold it back.
    expect(
      reason({
        runs: [
          { trigger: "manual", createdAt: NOW - HOUR, sessionId: "other", status: "completed" },
          {
            trigger: "failure-triggered",
            createdAt: NOW - 9 * HOUR,
            sessionId: "sess-1",
            status: "failed",
          },
        ],
      })
    ).toBe("offer")
  })
})

describe("runOfSession", () => {
  it("finds the conversation's newest run", () => {
    const runs = [
      { id: "a", sessionId: "s", createdAt: 1 },
      { id: "b", sessionId: "s", createdAt: 3 },
      { id: "c", sessionId: "t", createdAt: 9 },
    ]
    expect(runOfSession(runs, "s")?.id).toBe("b")
    expect(runOfSession(runs, "u")).toBeUndefined()
  })
})

describe("task drafts", () => {
  it("replays the request in the conversation's repository, or as text", () => {
    const long = `${"x".repeat(100)}\nmore`
    expect(
      taskDraftFromFailedTurn({
        sessionId: "s",
        messageId: "m",
        prompt: `\n  Fix the parser  \nDetails`,
        workingDirectory: "/repo",
        projectId: "p",
      })
    ).toEqual({
      title: "Fix the parser",
      prompt: `\n  Fix the parser  \nDetails`,
      isolation: "git",
      git: { sourceRoot: "/repo", projectId: "p" },
      checks: [],
      source: { kind: "session", sessionId: "s", messageId: "m" },
    })
    const text = taskDraftFromFailedTurn({ sessionId: "s", prompt: long, workingDirectory: null })
    expect(text).toMatchObject({ isolation: "none", source: { kind: "session", sessionId: "s" } })
    expect(text.git).toBeUndefined()
    expect(text.title).toHaveLength(80)
    expect(text.title.endsWith("…")).toBe(true)
  })

  it("finds the last user request with text", () => {
    const messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "2", role: "assistant", parts: [{ type: "text", text: "reply" }] },
      { id: "3", role: "user", parts: [{ type: "file" }] },
    ]
    const textOf = (parts: { type: string; text?: string }[]) =>
      parts.map((p) => p.text ?? "").join("")
    expect(lastUserRequest(messages, textOf)).toEqual({ id: "1", text: "first" })
    expect(lastUserRequest([], textOf)).toBeNull()
  })

  it("keys dismissals per agent", () => {
    expect(failureOfferDismissKey("a")).not.toBe(failureOfferDismissKey("b"))
  })
})
