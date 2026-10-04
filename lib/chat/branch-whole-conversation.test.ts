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
  rowToUIMessage: (row: { id: string }) => msg(row.id),
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

const detectHostProfile = jest.fn(() => "desktop")
jest.mock("@/lib/platform/capabilities", () => ({ detectHostProfile: () => detectHostProfile() }))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: () => false }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: {} }))
const readCompleteSessionHistory = jest.fn()
const getSessionHistoryMode = jest.fn((): string | null => null)
jest.mock("@/lib/sync/session-history", () => ({
  readCompleteSessionHistory: (...args: unknown[]) => readCompleteSessionHistory(...args),
  getSessionHistoryMode: () => getSessionHistoryMode(),
}))

import { branchWholeConversation } from "./branch-whole-conversation"

const msg = (id: string) => ({ id, role: "user", parts: [] }) as unknown as UIMessage

beforeEach(() => {
  jest.clearAllMocks()
  detectHostProfile.mockReturnValue("desktop")
  getSessionHistoryMode.mockReturnValue(null)
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
    workingSetPolicy: "current",
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

test("branches the complete host snapshot instead of the locally mirrored tail", async () => {
  detectHostProfile.mockReturnValue("cloud-companion")
  storeState.sessions.remote = { messages: [msg("tail")], activeBranchByGroup: { stale: "tail" } }
  const snapshot = {
    session: { id: "remote", activeBranchByGroup: { current: "tail" } },
    messages: [{ id: "older" }, { id: "tail" }],
    assertCurrent: jest.fn(),
  }
  readCompleteSessionHistory.mockResolvedValueOnce(snapshot)
  await branchWholeConversation("remote")
  expect(selectVisibleMessages).toHaveBeenCalledWith([msg("older"), msg("tail")], {
    current: "tail",
  })
  expect(branchSessionAtMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      visibleMessages: [msg("older"), msg("tail")],
      sourceSnapshot: snapshot,
    })
  )
  expect(listMessages).not.toHaveBeenCalled()
})

test("does not silently branch the recent tail when complete host history fails", async () => {
  detectHostProfile.mockReturnValue("mobile-companion")
  storeState.sessions.remote = { messages: [msg("tail")], activeBranchByGroup: {} }
  readCompleteSessionHistory.mockRejectedValueOnce(new Error("incomplete history"))
  await expect(branchWholeConversation("remote")).rejects.toThrow("incomplete history")
  expect(branchSessionAtMessage).not.toHaveBeenCalled()
})

test("keeps browser-owned conversations local when absent from the host", async () => {
  detectHostProfile.mockReturnValue("cloud-companion")
  storeState.sessions.local = { messages: [msg("local")], activeBranchByGroup: {} }
  readCompleteSessionHistory.mockResolvedValueOnce(null)
  await branchWholeConversation("local")
  expect(branchSessionAtMessage).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "local" })
  )
})

test("does not substitute a stale mirror when a known host session has disappeared", async () => {
  detectHostProfile.mockReturnValue("cloud-companion")
  getSessionHistoryMode.mockReturnValue("timeline")
  storeState.sessions.remote = { messages: [msg("tail")], activeBranchByGroup: {} }
  readCompleteSessionHistory.mockResolvedValueOnce(null)
  await expect(branchWholeConversation("remote")).rejects.toThrow("authoritative session history")
  expect(branchSessionAtMessage).not.toHaveBeenCalled()
})
