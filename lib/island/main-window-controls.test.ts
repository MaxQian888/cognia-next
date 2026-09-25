/** @jest-environment jsdom */

jest.mock("@/hooks/chat/chat-control-bridge", () => ({
  answerChatApproval: jest.fn(async () => true),
  stopChatTurn: jest.fn(async () => true),
}))
jest.mock("@/hooks/chat/chat-send-bridge", () => ({ sendChatMessage: jest.fn(() => true) }))
jest.mock("@/lib/ai/agent/team/gates/decide-pending-gate", () => ({
  decidePendingGate: jest.fn(() => true),
}))
jest.mock("@/lib/execution/run-control-dispatch", () => ({
  dispatchRunControl: jest.fn(async () => ({ accepted: true })),
}))
jest.mock("@/lib/platform/capabilities", () => ({ detectHostProfile: () => "desktop" }))
jest.mock("@/lib/execution/run-control", () => ({
  expireRunInterruptFromSource: jest.fn(async () => undefined),
}))

const chat = {
  sessions: {} as Record<string, { status: string; pendingApprovals: unknown[] }>,
  clearApproval: jest.fn(),
}
jest.mock("@/stores/chat/chat-store", () => ({ useChatStore: { getState: () => chat } }))
const gates = { gates: [] as unknown[] }
jest.mock("@/stores/agent/pending-gates-store", () => ({
  usePendingGatesStore: { getState: () => gates },
}))

import { answerChatApproval, stopChatTurn } from "@/hooks/chat/chat-control-bridge"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { decidePendingGate } from "@/lib/ai/agent/team/gates/decide-pending-gate"
import { expireRunInterruptFromSource } from "@/lib/execution/run-control"
import { dispatchRunControl } from "@/lib/execution/run-control-dispatch"
import {
  decideGate,
  decideRunApproval,
  dismissStaleRow,
  replyToConversation,
  respondToChatApproval,
  runControlReason,
  stopConversation,
} from "./main-window-controls"
import { NO_ISLAND_CAPABILITIES, type IslandRowProjection } from "./types"

const approval = { sessionId: "sub-1", requestId: "req", toolName: "Bash", status: "pending" }
const openGate = { key: { scope: "cost-budget", id: "daily" }, status: "open" }

beforeEach(() => {
  chat.sessions = { "chat-1": { status: "awaiting_approval", pendingApprovals: [approval] } }
  gates.gates = [openGate]
})

describe("respondToChatApproval", () => {
  it("answers the live approval the conversation holds", async () => {
    await expect(respondToChatApproval("chat-1", "req", "allow")).resolves.toBeNull()
    expect(answerChatApproval).toHaveBeenCalledWith(approval, "allow")
  })

  it("reports an ask that is gone or interrupted as no longer waiting", async () => {
    await expect(respondToChatApproval("chat-1", "other", "allow")).resolves.toBe("noLongerWaiting")
    chat.sessions["chat-1"].pendingApprovals = [{ ...approval, status: "interrupted" }]
    await expect(respondToChatApproval("chat-1", "req", "allow")).resolves.toBe("noLongerWaiting")
    await expect(respondToChatApproval("missing", "req", "allow")).resolves.toBe("noLongerWaiting")
    expect(answerChatApproval).not.toHaveBeenCalled()
  })

  it("refuses always-allow on an ask that forbids a standing rule", async () => {
    chat.sessions["chat-1"].pendingApprovals = [{ ...approval, suppressAlwaysAllowRule: true }]
    await expect(respondToChatApproval("chat-1", "req", "allow_always")).resolves.toBe(
      "notPermitted"
    )
  })

  it("fails when no runtime delivered it or delivery threw", async () => {
    ;(answerChatApproval as jest.Mock).mockResolvedValueOnce(false)
    await expect(respondToChatApproval("chat-1", "req", "deny")).resolves.toBe("callFailed")
    ;(answerChatApproval as jest.Mock).mockRejectedValueOnce(new Error("sidecar down"))
    await expect(respondToChatApproval("chat-1", "req", "deny")).resolves.toBe("callFailed")
  })
})

describe("decideGate", () => {
  it("settles an open gate through the shared helper", () => {
    expect(decideGate(openGate.key, true)).toBeNull()
    expect(decidePendingGate).toHaveBeenCalledWith(openGate, { outcome: "approve" })
    decideGate(openGate.key, false)
    expect(decidePendingGate).toHaveBeenLastCalledWith(openGate, { outcome: "reject" })
  })

  it("matches a gate by scope and id together, never by id alone", () => {
    gates.gates = [{ ...openGate, key: { scope: "agent-plan", id: "daily" } }, openGate]
    decideGate(openGate.key, true)
    expect(decidePendingGate).toHaveBeenLastCalledWith(openGate, { outcome: "approve" })
  })

  it("refuses a gate that is gone, restored, or had no waiter", () => {
    expect(decideGate({ scope: "cost-budget", id: "other" }, true)).toBe("noLongerWaiting")
    gates.gates = [{ ...openGate, status: "interrupted" }]
    expect(decideGate(openGate.key, true)).toBe("noLongerWaiting")
    gates.gates = [openGate]
    ;(decidePendingGate as jest.Mock).mockReturnValueOnce(false)
    expect(decideGate(openGate.key, true)).toBe("noLongerWaiting")
  })
})

describe("decideRunApproval", () => {
  it("presses approve or deny as the island, naming the exact approval", async () => {
    await expect(decideRunApproval("r", "i", false)).resolves.toBeNull()
    expect(dispatchRunControl).toHaveBeenCalledWith({
      runId: "r",
      action: "deny",
      surface: "island",
      hostProfile: "desktop",
      interruptId: "i",
    })
  })

  it("translates the control plane's refusal", async () => {
    ;(dispatchRunControl as jest.Mock).mockResolvedValueOnce({
      accepted: false,
      reason: "interrupt_resolved",
    })
    await expect(decideRunApproval("r", "i", true)).resolves.toBe("noLongerWaiting")
  })

  it.each([
    ["revision_conflict", "requestChanged"],
    ["run_not_found", "noLongerWaiting"],
    ["action_unavailable", "noLongerWaiting"],
    ["interrupt_not_found", "noLongerWaiting"],
    ["interrupt_expired", "noLongerWaiting"],
    ["forbidden", "notPermitted"],
    ["host_consent_required", "hostConsent"],
    ["source_rejected", "callFailed"],
    [undefined, "callFailed"],
  ] as const)("maps %s to %s", (reason, expected) => {
    expect(runControlReason(reason)).toBe(expected)
  })
})

describe("conversation controls", () => {
  it("stops only a turn that is still in flight", async () => {
    await expect(stopConversation("chat-1")).resolves.toBeNull()
    expect(stopChatTurn).toHaveBeenCalledWith("chat-1")
    chat.sessions["chat-1"].status = "idle"
    await expect(stopConversation("chat-1")).resolves.toBe("turnFinished")
    expect(stopChatTurn).toHaveBeenCalledTimes(1)
  })

  it("fails a stop no runtime could deliver", async () => {
    ;(stopChatTurn as jest.Mock).mockResolvedValueOnce(false)
    await expect(stopConversation("chat-1")).resolves.toBe("callFailed")
    ;(stopChatTurn as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    await expect(stopConversation("chat-1")).resolves.toBe("callFailed")
  })

  it("replies through the chat runtime's own send", () => {
    expect(replyToConversation("chat-1", "continue")).toBeNull()
    expect(sendChatMessage).toHaveBeenCalledWith("chat-1", "continue")
    ;(sendChatMessage as jest.Mock).mockReturnValueOnce(false)
    expect(replyToConversation("chat-1", "continue")).toBe("callFailed")
  })
})

describe("dismissStaleRow", () => {
  function stale(owner: IslandRowProjection["owner"]): IslandRowProjection {
    return {
      id: "x",
      source: owner.kind,
      owner,
      status: "stale",
      priority: 5,
      title: "t",
      summary: "",
      startedAt: 0,
      updatedAt: 0,
      capabilities: { ...NO_ISLAND_CAPABILITIES, dismissStale: true },
      stale: true,
    }
  }

  it("dismisses a restored gate through the shared helper, and only a restored one", async () => {
    gates.gates = [{ ...openGate, status: "interrupted" }]
    await expect(dismissStaleRow(stale({ kind: "gate", gateKey: openGate.key }))).resolves.toBe(
      true
    )
    expect(decidePendingGate).toHaveBeenCalledWith(gates.gates[0], { outcome: "dismiss" })
    gates.gates = [openGate]
    await expect(dismissStaleRow(stale({ kind: "gate", gateKey: openGate.key }))).resolves.toBe(
      false
    )
    await expect(
      dismissStaleRow({ ...stale({ kind: "gate", gateKey: openGate.key }), stale: false })
    ).resolves.toBe(false)
  })

  it("clears a chat approval and expires a run interrupt", async () => {
    await expect(
      dismissStaleRow(stale({ kind: "chat", sessionId: "chat-1", requestId: "req" }))
    ).resolves.toBe(true)
    expect(chat.clearApproval).toHaveBeenCalledWith("req", "chat-1")
    await expect(
      dismissStaleRow(stale({ kind: "run", runId: "r", interruptId: "i" }))
    ).resolves.toBe(true)
    expect(expireRunInterruptFromSource).toHaveBeenCalledWith("r", "i")
  })

  it("lets a failed interrupt expiry reject rather than claim it cleared", async () => {
    ;(expireRunInterruptFromSource as jest.Mock).mockRejectedValueOnce(new Error("source down"))
    await expect(
      dismissStaleRow(stale({ kind: "run", runId: "r", interruptId: "i" }))
    ).rejects.toThrow("source down")
  })

  it("has nothing to clear for a team, an external session, or an owner without its id", async () => {
    for (const owner of [
      { kind: "team", teamId: "t" },
      { kind: "external", agent: "codex", sessionId: "x" },
      { kind: "chat", sessionId: "chat-1" },
      { kind: "run", runId: "r" },
    ] as const) {
      await expect(dismissStaleRow(stale(owner))).resolves.toBe(false)
    }
  })
})
