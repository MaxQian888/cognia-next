/** @jest-environment jsdom */

import type { PendingApproval } from "@cognia/agent-config-types"

jest.mock("@/lib/chat/approval-routing", () => ({
  routeChatApprovalDecision: jest.fn(
    async (
      approval: PendingApproval,
      decision: string,
      direct: (a: PendingApproval, d: string) => Promise<void>
    ) => direct(approval, decision)
  ),
}))

import { routeChatApprovalDecision } from "@/lib/chat/approval-routing"
import {
  __resetChatControlBridgeForTesting,
  answerChatApproval,
  registerChatApprovalBridge,
  registerChatStopBridge,
  stopChatTurn,
} from "./chat-control-bridge"

const approval: PendingApproval = {
  sessionId: "chat-1",
  requestId: "r",
  toolUseID: "t",
  toolName: "Bash",
  input: {},
}

beforeEach(() => __resetChatControlBridgeForTesting())

describe("chat control bridge", () => {
  it("reports that nothing was delivered while no chat runtime is mounted", async () => {
    await expect(answerChatApproval(approval, "allow")).resolves.toBe(false)
    await expect(stopChatTurn("chat-1")).resolves.toBe(false)
    expect(routeChatApprovalDecision).not.toHaveBeenCalled()
  })

  it("routes an approval through the shared rule with the runtime's responder", async () => {
    const respond = jest.fn(async () => undefined)
    registerChatApprovalBridge(respond)
    await expect(answerChatApproval(approval, "allow_always")).resolves.toBe(true)
    expect(routeChatApprovalDecision).toHaveBeenCalledWith(approval, "allow_always", respond)
    expect(respond).toHaveBeenCalledWith(approval, "allow_always")
  })

  it("lets a failed delivery reject so the ask stays pending", async () => {
    registerChatApprovalBridge(async () => {
      throw new Error("sidecar unavailable")
    })
    await expect(answerChatApproval(approval, "deny")).rejects.toThrow("sidecar unavailable")
  })

  it("stops the named session and refuses an empty id", async () => {
    const stop = jest.fn(async () => undefined)
    registerChatStopBridge(stop)
    await expect(stopChatTurn("chat-1")).resolves.toBe(true)
    expect(stop).toHaveBeenCalledWith("chat-1")
    await expect(stopChatTurn("")).resolves.toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("keeps a newer registration when an older one unregisters late", async () => {
    const first = jest.fn(async () => undefined)
    const second = jest.fn(async () => undefined)
    const offFirst = registerChatStopBridge(first)
    const offSecond = registerChatStopBridge(second)
    offFirst()
    await stopChatTurn("chat-1")
    expect(second).toHaveBeenCalledWith("chat-1")
    expect(first).not.toHaveBeenCalled()
    offSecond()
    await expect(stopChatTurn("chat-1")).resolves.toBe(false)

    const respond = jest.fn(async () => undefined)
    const offApproval = registerChatApprovalBridge(respond)
    offApproval()
    await expect(answerChatApproval(approval, "allow")).resolves.toBe(false)
  })
})
