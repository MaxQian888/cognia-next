import type { PendingApproval } from "@cognia/agent-config-types"

const hostRespond = jest.fn(async () => undefined)
const companionRespond = jest.fn(async () => undefined)
jest.mock("@/lib/chat/room/runner-host", () => ({
  getHostRoomRunner: () => ({ respondToApproval: hostRespond }),
  getCompanionRoomProjector: () => ({ runner: { respondToApproval: companionRespond } }),
}))
const shell = { companion: false }
jest.mock("@/lib/chat/room/shell", () => ({ isCompanionShell: () => shell.companion }))

import { subSessionId } from "@/lib/claude/team-session-id"
import { routeChatApprovalDecision } from "./approval-routing"

function approval(sessionId: string): PendingApproval {
  return { sessionId, requestId: "r", toolUseID: "t", toolName: "Bash", input: {} }
}

beforeEach(() => {
  shell.companion = false
})

describe("routeChatApprovalDecision", () => {
  it("answers an ordinary conversation's ask through the chat runtime", async () => {
    const direct = jest.fn(async () => undefined)
    await routeChatApprovalDecision(approval("chat-1"), "allow_always", direct)
    expect(direct).toHaveBeenCalledWith(approval("chat-1"), "allow_always")
    expect(hostRespond).not.toHaveBeenCalled()
  })

  it("answers a room member's ask through the host's room runner", async () => {
    const direct = jest.fn(async () => undefined)
    const member = approval(subSessionId("team-1", "char-1", "turn-1"))
    await routeChatApprovalDecision(member, "deny", direct)
    expect(hostRespond).toHaveBeenCalledWith(member, "deny")
    expect(direct).not.toHaveBeenCalled()
  })

  it("forwards a room member's ask to the host from a companion shell", async () => {
    shell.companion = true
    const member = approval(subSessionId("team-1", "char-1", "turn-1"))
    await routeChatApprovalDecision(member, "allow", jest.fn())
    expect(companionRespond).toHaveBeenCalledWith(member, "allow")
    expect(hostRespond).not.toHaveBeenCalled()
  })

  it("propagates a failed delivery so the caller keeps the ask pending", async () => {
    const direct = jest.fn(async () => {
      throw new Error("sidecar unavailable")
    })
    await expect(routeChatApprovalDecision(approval("chat-1"), "allow", direct)).rejects.toThrow(
      "sidecar unavailable"
    )
  })
})
