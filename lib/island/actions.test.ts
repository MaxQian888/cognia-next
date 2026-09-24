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

const acpRespond = jest.fn<Promise<boolean>, [string, "allow" | "deny"]>()
const acpQuestionRespond = jest.fn<Promise<boolean>, [string, number[][]]>()
const acpQuestionReject = jest.fn<Promise<boolean>, [string]>()
const acpSendMessage = jest.fn<Promise<boolean>, [string, string, string]>()
const acpInterrupt = jest.fn()

jest.mock("@/lib/tauri/fleet", () => ({
  fleetPermissionRespond: (...args: [string, "allow" | "deny"]) => respond(...args),
  fleetQuestionRespond: (...args: [string, number[][]]) => questionRespond(...args),
  fleetQuestionReject: (...args: [string]) => questionReject(...args),
  fleetOpencodeSendMessage: (...args: [string, string]) => sendMessage(...args),
  fleetInterruptSession: (...args: unknown[]) => interrupt(...args),
  fleetFocusTerminal: (...args: [string, string]) => focusTerminal(...args),
  fleetRevealTranscript: (...args: [string | null | undefined]) => revealTranscript(...args),
}))

jest.mock("@/lib/fleet/acp-fleet-projection", () => ({
  respondAcpFleetPermission: (...args: [string, "allow" | "deny"]) => acpRespond(...args),
  respondAcpFleetQuestion: (...args: [string, number[][]]) => acpQuestionRespond(...args),
  rejectAcpFleetQuestion: (...args: [string]) => acpQuestionReject(...args),
  sendAcpFleetMessage: (...args: [string, string, string]) => acpSendMessage(...args),
  interruptAcpFleetSession: (...args: [string, string]) => acpInterrupt(...args),
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
  it.each([
    ["permission-decision", "permissionDecision"],
    ["reply", "reply"],
    ["focus-terminal", "focusTerminal"],
    ["open-transcript", "openTranscript"],
    ["dismiss-stale", "dismissStale"],
  ] as const)("rejects %s after its capability is withdrawn", async (kind, capability) => {
    const changed = row({ capabilities: { ...row().capabilities, [capability]: false } })
    const result = await executeIslandAction(
      intent({ kind, text: "hello", permissionRequestId: "p1", behavior: "allow" }),
      state([changed]),
      deps()
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "notPermitted" })
    for (const transport of [respond, sendMessage, focusTerminal, revealTranscript]) {
      expect(transport).not.toHaveBeenCalled()
    }
  })

  it.each(["reply", "interrupt", "focus-terminal", "open-transcript"] as const)(
    "never sends %s to an external adapter for an internal owner",
    async (kind) => {
      const internal = row({ owner: { kind: "chat", sessionId: "chat-1" } })
      const result = await executeIslandAction(
        intent({ kind, text: "hello" }),
        state([internal]),
        deps()
      )
      expect(result).toMatchObject({ outcome: "rejected", reason: "notPermitted" })
      for (const transport of [sendMessage, interrupt, focusTerminal, revealTranscript]) {
        expect(transport).not.toHaveBeenCalled()
      }
    }
  )

  it.each(["question-response", "question-reject"] as const)(
    "rejects %s if its parked question disappeared",
    async (kind) => {
      const result = await executeIslandAction(
        intent({ kind, questionRequestId: "q1", selections: [[0]] }),
        state([row({ question: undefined })]),
        deps()
      )
      expect(result).toMatchObject({ outcome: "rejected", reason: "requestChanged" })
      expect(questionRespond).not.toHaveBeenCalled()
      expect(questionReject).not.toHaveBeenCalled()
    }
  )

  it("does not route an external owner even if a stale snapshot advertised navigation", async () => {
    const d = deps()
    const result = await executeIslandAction(
      intent({ kind: "open-owner" }),
      state([row({ capabilities: { ...row().capabilities, openOwner: true } })]),
      d
    )
    expect(result).toMatchObject({ outcome: "rejected", reason: "noRoute" })
    expect(d.navigate).not.toHaveBeenCalled()
  })
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

  it.each(["question-response", "question-reject"] as const)(
    "rejects %s when the current projection cannot answer the complete request",
    async (kind) => {
      const unavailable = row({
        capabilities: { ...row().capabilities, questionResponse: false },
      })
      const result = await executeIslandAction(
        intent({ kind, questionRequestId: "q1", selections: [[0]] }),
        state([unavailable]),
        deps()
      )
      expect(result).toMatchObject({ outcome: "rejected", reason: "notPermitted" })
      expect(questionRespond).not.toHaveBeenCalled()
      expect(questionReject).not.toHaveBeenCalled()
    }
  )
})

describe("executeIslandAction execution", () => {
  it.each([
    "question-response",
    "question-reject",
    "reply",
    "focus-terminal",
    "open-transcript",
    "dismiss-stale",
  ] as const)(
    "reports failed rather than completed when %s is refused by its adapter",
    async (kind) => {
      questionRespond.mockResolvedValue(false)
      questionReject.mockResolvedValue(false)
      sendMessage.mockResolvedValue(null)
      focusTerminal.mockResolvedValue(false)
      revealTranscript.mockResolvedValue(false)
      const d = { ...deps(), dismissStale: jest.fn(async () => false) }
      const result = await executeIslandAction(
        intent({ kind, questionRequestId: "q1", selections: [[0]], text: "hello" }),
        state([row({ capabilities: { ...row().capabilities, dismissStale: true } })]),
        d
      )
      expect(result).toMatchObject({ outcome: "failed", reason: "callFailed" })
    }
  )

  it("rejects a current question and interrupts its session when the adapters confirm", async () => {
    questionReject.mockResolvedValue(true)
    interrupt.mockResolvedValue({ ok: true })
    expect(
      await executeIslandAction(
        intent({ kind: "question-reject", questionRequestId: "q1" }),
        state(),
        deps()
      )
    ).toMatchObject({ outcome: "completed" })
    expect(questionReject).toHaveBeenCalledWith("q1")
    expect(
      await executeIslandAction(intent({ kind: "interrupt", revision: 4 }), state(), deps())
    ).toMatchObject({ outcome: "completed", revision: 5 })
    expect(interrupt).toHaveBeenCalledWith("opencode", "oc")
  })

  it("waits for the main window to become visible before acknowledging navigation", async () => {
    let finishFocus!: () => void
    const focusMainWindow = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFocus = resolve
        })
    )
    const d = { ...deps(), focusMainWindow }
    const completed = jest.fn()
    const current = row({
      owner: { kind: "chat", sessionId: "s" },
      capabilities: { ...row().capabilities, openOwner: true },
    })
    const result = executeIslandAction(intent({ kind: "open-owner" }), state([current]), d).then(
      completed
    )
    expect(d.navigate).toHaveBeenCalledWith("/", current.owner)
    expect(focusMainWindow).toHaveBeenCalledTimes(1)
    expect(completed).not.toHaveBeenCalled()
    finishFocus()
    await result
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }))
  })
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
    expect(d.navigate).toHaveBeenCalledWith("/", chatRow.owner)
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

describe("executeIslandAction ACP routing", () => {
  const acpOwner = {
    kind: "external",
    agent: "devin",
    sessionId: "ext-1",
    agentId: "agent-1",
    chatSessionId: "chat-9",
  } as const

  function acpRow(over: Partial<IslandRowProjection> = {}): IslandRowProjection {
    return row({
      id: "external:devin:ext-1",
      owner: acpOwner,
      agent: "devin",
      permission: { requestId: "p1", toolName: "Bash", requestedAt: 0 },
      question: {
        requestId: "q1",
        requestedAt: 0,
        questions: [{ question: "Pick", options: ["a", "b"], multiSelect: false }],
      },
      ...over,
    })
  }

  it("routes a permission decision to the manager, never to the Rust commands", async () => {
    acpRespond.mockResolvedValue(true)
    const result = await executeIslandAction(
      intent({
        kind: "permission-decision",
        rowId: "external:devin:ext-1",
        permissionRequestId: "p1",
        behavior: "deny",
      }),
      state([acpRow()]),
      deps()
    )
    expect(acpRespond).toHaveBeenCalledWith("p1", "deny")
    expect(respond).not.toHaveBeenCalled()
    expect(result.outcome).toBe("completed")
  })

  it("routes question answer and rejection to the manager", async () => {
    acpQuestionRespond.mockResolvedValue(true)
    acpQuestionReject.mockResolvedValue(true)
    const acpIntent = (kind: "question-response" | "question-reject") =>
      intent({ kind, rowId: "external:devin:ext-1", questionRequestId: "q1", selections: [[1]] })
    expect(
      (await executeIslandAction(acpIntent("question-response"), state([acpRow()]), deps())).outcome
    ).toBe("completed")
    expect(acpQuestionRespond).toHaveBeenCalledWith("q1", [[1]])
    expect(
      (await executeIslandAction(acpIntent("question-reject"), state([acpRow()]), deps())).outcome
    ).toBe("completed")
    expect(acpQuestionReject).toHaveBeenCalledWith("q1")
    expect(questionRespond).not.toHaveBeenCalled()
    expect(questionReject).not.toHaveBeenCalled()
  })

  it("sends a reply and an interrupt through the manager", async () => {
    acpSendMessage.mockResolvedValue(true)
    acpInterrupt.mockResolvedValue({ ok: true })
    const replyResult = await executeIslandAction(
      intent({ kind: "reply", rowId: "external:devin:ext-1", text: "  go on  " }),
      state([acpRow()]),
      deps()
    )
    expect(acpSendMessage).toHaveBeenCalledWith("agent-1", "ext-1", "go on")
    expect(sendMessage).not.toHaveBeenCalled()
    expect(replyResult.outcome).toBe("completed")

    const interruptResult = await executeIslandAction(
      intent({ kind: "interrupt", rowId: "external:devin:ext-1" }),
      state([acpRow()]),
      deps()
    )
    expect(acpInterrupt).toHaveBeenCalledWith("agent-1", "ext-1")
    expect(interrupt).not.toHaveBeenCalled()
    expect(interruptResult.outcome).toBe("completed")
  })

  it("surfaces a manager refusal as failed rather than completed", async () => {
    acpInterrupt.mockResolvedValue({ ok: false, reason: "callFailed" })
    const result = await executeIslandAction(
      intent({ kind: "interrupt", rowId: "external:devin:ext-1" }),
      state([acpRow()]),
      deps()
    )
    expect(result).toMatchObject({ outcome: "failed", reason: "callFailed" })
  })
})
