import type { UIMessage } from "ai"

const branchSessionAtMessage = jest.fn(async (params: { sourceId: string }) => ({
  id: `branch-of-${params.sourceId}`,
}))
jest.mock("@/lib/chat/branch-session", () => ({
  branchSessionAtMessage: (params: { sourceId: string }) => branchSessionAtMessage(params),
}))
const listMessages = jest.fn(async (_id: string): Promise<UIMessage[]> => [])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: string) => listMessages(id),
}))
const getSession = jest.fn(async (_id: string): Promise<unknown> => undefined)
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getSession(id),
}))

interface Slice {
  messages: UIMessage[]
  activeBranchByGroup: Record<string, string>
}
let storeState: {
  sessions: Record<string, Slice>
  activeSessionId: string | null
  messages: UIMessage[]
  activeBranchByGroup: Record<string, string>
}
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => storeState },
}))
// Identity projection: which thread was chosen is what these tests pin; the
// branch-winner resolution is `selectVisibleMessages`'s own suite.
const selectVisibleMessages = jest.fn(
  (messages: UIMessage[], _branches: Record<string, string>) => messages
)
jest.mock("@/stores/chat/chat-store", () => ({
  selectVisibleMessages: (messages: UIMessage[], branches: Record<string, string>) =>
    selectVisibleMessages(messages, branches),
}))

import { branchWholeConversation } from "./branch-whole-conversation"

const msg = (id: string) => ({ id, role: "user", parts: [] }) as unknown as UIMessage

beforeEach(() => {
  jest.clearAllMocks()
  storeState = { sessions: {}, activeSessionId: null, messages: [], activeBranchByGroup: {} }
})

test("branches the live slice's visible thread at its last message", async () => {
  storeState.sessions["s-1"] = {
    messages: [msg("m1"), msg("m2")],
    activeBranchByGroup: { g: "m2" },
  }
  await expect(branchWholeConversation("s-1")).resolves.toEqual({ id: "branch-of-s-1" })
  expect(selectVisibleMessages).toHaveBeenCalledWith([msg("m1"), msg("m2")], { g: "m2" })
  expect(branchSessionAtMessage).toHaveBeenCalledWith({
    sourceId: "s-1",
    visibleMessages: [msg("m1"), msg("m2")],
    messageId: "m2",
    mode: "direct",
  })
  expect(listMessages).not.toHaveBeenCalled()
})

test("uses the focused projection for the open conversation without a slice", async () => {
  storeState.activeSessionId = "s-1"
  storeState.messages = [msg("m1")]
  await branchWholeConversation("s-1")
  expect(branchSessionAtMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1" }))
})

test("reads a never-opened row from storage with its persisted branch selection", async () => {
  listMessages.mockResolvedValueOnce([msg("a"), msg("b")])
  getSession.mockResolvedValueOnce({ id: "s-2", activeBranchByGroup: { g: "b" } })
  await branchWholeConversation("s-2")
  expect(selectVisibleMessages).toHaveBeenCalledWith([msg("a"), msg("b")], { g: "b" })
  expect(branchSessionAtMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: "b" }))
})

test("falls back to storage when the slice exists but holds no messages yet", async () => {
  storeState.sessions["s-3"] = { messages: [], activeBranchByGroup: {} }
  listMessages.mockResolvedValueOnce([msg("x")])
  await branchWholeConversation("s-3")
  expect(listMessages).toHaveBeenCalledWith("s-3")
  expect(branchSessionAtMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: "x" }))
})

test("resolves null when there is nothing to branch", async () => {
  await expect(branchWholeConversation("empty")).resolves.toBeNull()
  expect(branchSessionAtMessage).not.toHaveBeenCalled()
})

test("lets the branch writer's refusal through", async () => {
  storeState.sessions["s-4"] = { messages: [msg("m")], activeBranchByGroup: {} }
  branchSessionAtMessage.mockRejectedValueOnce(new Error("locked"))
  await expect(branchWholeConversation("s-4")).rejects.toThrow("locked")
})
