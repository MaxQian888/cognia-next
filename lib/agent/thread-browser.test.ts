const getSessionMock = jest.fn()
const listMessagesMock = jest.fn()
const branchMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}))
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
}))
jest.mock("@/lib/chat/branch-session", () => ({
  branchSessionAtMessage: (...args: unknown[]) => branchMock(...args),
}))

import { buildAgentThreadForest, promoteSubagentSession } from "./thread-browser"
import type { ChatSession } from "@cognia/agent-config-types"

const session = (id: string, patch: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: id,
    kind: "direct",
    createdAt: new Date(1),
    updatedAt: new Date(1),
    lastAccessedAt: new Date(1),
    ...patch,
  }) as ChatSession

it("groups nested hidden agent sessions beneath their primary task", () => {
  const forest = buildAgentThreadForest(
    [
      session("parent"),
      session("child", { kind: "subagent", parentSessionId: "parent" }),
      session("grandchild", { kind: "subagent", parentSessionId: "child" }),
    ],
    new Set(["grandchild"])
  )
  expect(forest).toHaveLength(1)
  expect(forest[0].children[0].children[0]).toEqual(
    expect.objectContaining({
      running: true,
      session: expect.objectContaining({ id: "grandchild" }),
    })
  )
})

it("promotes a completed child by snapshot and preserves source ownership", async () => {
  getSessionMock.mockResolvedValue(
    session("child", { kind: "subagent", parentSessionId: "parent" })
  )
  listMessagesMock.mockResolvedValue([{ id: "m1", role: "assistant", parts: [] }])
  branchMock.mockResolvedValue(session("promoted"))

  await expect(promoteSubagentSession("child", false)).resolves.toEqual(
    expect.objectContaining({ id: "promoted" })
  )
  expect(branchMock).toHaveBeenCalledWith(
    expect.objectContaining({ sourceId: "child", messageId: "m1", mode: "direct" })
  )
})

it("refuses promotion while the child is running", async () => {
  await expect(promoteSubagentSession("child", true)).rejects.toThrow(/running/)
  expect(branchMock).not.toHaveBeenCalled()
})
