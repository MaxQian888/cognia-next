/** @jest-environment jsdom */
import { executeIslandAction, type IslandActionDeps } from "./actions"
import type { IslandActionIntent, IslandRowProjection, IslandState } from "./types"

const respond = jest.fn<Promise<boolean>, [string, "allow" | "deny"]>()
const questionRespond = jest.fn<Promise<boolean>, [string, number[][]]>()
const questionReject = jest.fn<Promise<boolean>, [string]>()
const sendMessage = jest.fn<Promise<string | null>, [string, string]>()
const interrupt = jest.fn()
const focusTerminal = jest.fn<Promise<boolean>, [string, string]>()
const revealTranscript = jest.fn<Promise<boolean>, [string | null | undefined]>()

jest.mock("@/lib/tauri/fleet", () => ({
  fleetPermissionRespond: (...args: [string, "allow" | "deny"]) => respond(...args),
  fleetQuestionRespond: (...args: [string, number[][]]) => questionRespond(...args),
  fleetQuestionReject: (...args: [string]) => questionReject(...args),
  fleetOpencodeSendMessage: (...args: [string, string]) => sendMessage(...args),
  fleetInterruptSession: (...args: unknown[]) => interrupt(...args),
  fleetFocusTerminal: (...args: [string, string]) => focusTerminal(...args),
  fleetRevealTranscript: (...args: [string | null | undefined]) => revealTranscript(...args),
}))

function row(over: Partial<IslandRowProjection> = {}): IslandRowProjection {
  return {
    id: "external:opencode:oc",
    source: "external",
    owner: { kind: "external", agent: "opencode", sessionId: "oc", transcriptPath: "/t.jsonl" },
    agent: "opencode",
    status: "blocked",
    priority: 0,
    title: "proj",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
    capabilities: {
      openOwner: false,
      permissionDecision: true,
      questionResponse: true,
      reply: true,
      interrupt: true,
      focusTerminal: true,
      openTranscript: true,
      dismissStale: false,
      detail: true,
    },
    permission: { requestId: "p1", toolName: "Bash", requestedAt: 0 },
    question: { requestId: "q1", requestedAt: 0, questions: [] },
    stale: false,
    ...over,
  }
}

function state(rows: IslandRowProjection[] = [row()], revision = 5): IslandState {
  return {
    epoch: 1,
    revision,
    generatedAt: 0,
    activeCount: rows.length,
    attentionCount: rows.length,
    detailVisibility: "click-to-reveal",
    rows,
  }
}

function deps(): IslandActionDeps {
  return { navigate: jest.fn(), dismissStale: jest.fn(async () => true) }
}

function intent(over: Partial<IslandActionIntent> & { kind: string }): IslandActionIntent {
  return {
    requestId: "req",
    revision: 5,
    rowId: "external:opencode:oc",
    ...over,
  } as IslandActionIntent
}

beforeEach(() => jest.clearAllMocks())

describe("executeIslandAction validation", () => {
  it("rejects an intent built against a revision the main window has not reached", async () => {
    const result = await executeIslandAction(
      intent({ kind: "interrupt", revision: 99 }),
      state(),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "staleRevision", revision: 5 })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it("rejects an intent for a row that has left the projection", async () => {
    const result = await executeIslandAction(
      intent({ kind: "interrupt", rowId: "gone" }),
      state(),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "unknownRow" })
  })

  it("rejects an action the row never advertised", async () => {
    const noInterrupt = row({
      capabilities: { ...row().capabilities, interrupt: false },
    })
    const result = await executeIslandAction(
      intent({ kind: "interrupt" }),
      state([noInterrupt]),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "notPermitted" })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it("rejects a decision for a request that has since been replaced", async () => {
    const result = await executeIslandAction(
      intent({ kind: "permission-decision", permissionRequestId: "old", behavior: "allow" }),
      state(),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "requestChanged" })
    expect(respond).not.toHaveBeenCalled()
  })
})

describe("executeIslandAction execution", () => {
  it("answers a permission and reports completion", async () => {
    respond.mockResolvedValue(true)
    const result = await executeIslandAction(
      intent({ kind: "permission-decision", permissionRequestId: "p1", behavior: "deny" }),
      state(),
      deps()
    )
    expect(respond).toHaveBeenCalledWith("p1", "deny")
    expect(result).toMatchObject({ outcome: "completed", requestId: "req", revision: 5 })
  })

  it("reports a failure when the underlying call says no", async () => {
    respond.mockResolvedValue(false)
    const result = await executeIslandAction(
      intent({ kind: "permission-decision", permissionRequestId: "p1", behavior: "allow" }),
      state(),
      deps()
    )
    expect(result).toMatchObject({ outcome: "failed", reason: "callFailed" })
  })

  it("passes the refusal reason through from an interrupt", async () => {
    interrupt.mockResolvedValue({ ok: false, reason: "interrupt_not_running" })
    const result = await executeIslandAction(intent({ kind: "interrupt" }), state(), deps())
    expect(result).toMatchObject({ outcome: "failed", reason: "interrupt_not_running" })
  })

  it("answers a question with the user's selections", async () => {
    questionRespond.mockResolvedValue(true)
    const result = await executeIslandAction(
      intent({ kind: "question-response", questionRequestId: "q1", selections: [[0, 2]] }),
      state(),
      deps()
    )
    expect(questionRespond).toHaveBeenCalledWith("q1", [[0, 2]])
    expect(result.outcome).toBe("completed")
  })

  it("rejects a question rejection for a replaced request", async () => {
    const result = await executeIslandAction(
      intent({ kind: "question-reject", questionRequestId: "other" }),
      state(),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "requestChanged" })
    expect(questionReject).not.toHaveBeenCalled()
  })

  it("refuses an empty reply before it reaches the agent", async () => {
    const result = await executeIslandAction(
      intent({ kind: "reply", text: "   " }),
      state(),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "emptyInput" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("sends a trimmed reply to the owning session", async () => {
    sendMessage.mockResolvedValue("m1")
    const result = await executeIslandAction(
      intent({ kind: "reply", text: "  hello  " }),
      state(),
      deps()
    )
    expect(sendMessage).toHaveBeenCalledWith("oc", "hello")
    expect(result.outcome).toBe("completed")
  })

  it("focuses the terminal and reveals the transcript for an external owner", async () => {
    focusTerminal.mockResolvedValue(true)
    revealTranscript.mockResolvedValue(true)
    expect(
      (await executeIslandAction(intent({ kind: "focus-terminal" }), state(), deps())).outcome
    ).toBe("completed")
    expect(focusTerminal).toHaveBeenCalledWith("opencode", "oc")
    expect(
      (await executeIslandAction(intent({ kind: "open-transcript" }), state(), deps())).outcome
    ).toBe("completed")
    expect(revealTranscript).toHaveBeenCalledWith("/t.jsonl")
  })

  it("navigates to the owner route and refuses when there is none", async () => {
    const chatRow = row({
      id: "chat:c1",
      source: "chat",
      owner: { kind: "chat", sessionId: "c1" },
      capabilities: { ...row().capabilities, openOwner: true },
    })
    const d = deps()
    const result = await executeIslandAction(
      intent({ kind: "open-owner", rowId: "chat:c1" }),
      state([chatRow]),
      d
    )
    expect(d.navigate).toHaveBeenCalledWith("/")
    expect(result.outcome).toBe("completed")

    // An external agent's owner is a terminal, so `openOwner` is never true and
    // the intent is refused rather than routed somewhere arbitrary.
    const refused = await executeIslandAction(intent({ kind: "open-owner" }), state(), deps())
    expect(refused).toMatchObject({ outcome: "rejected", reason: "notPermitted" })
  })

  it("clears a stale row through the injected dismisser", async () => {
    const stale = row({ stale: true, capabilities: { ...row().capabilities, dismissStale: true } })
    const d = deps()
    const result = await executeIslandAction(intent({ kind: "dismiss-stale" }), state([stale]), d)
    expect(d.dismissStale).toHaveBeenCalled()
    expect(result.outcome).toBe("completed")
  })
})
