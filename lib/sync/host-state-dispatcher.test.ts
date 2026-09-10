/**
 * The Agent RPC HostState dispatcher, in isolation from the ledger.
 *
 * `host-state-service.test.ts` drives the whole service over Dexie. This file
 * pins one gate on the dispatcher itself, with the database mocked away, so
 * the pin holds even while the shared suite's encrypted-store fixture is in
 * flux.
 */

const getSessionMock = jest.fn(async (id: string) => ({
  id,
  title: "t",
  createdAt: 1,
  updatedAt: 1,
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getSessionMock(id),
}))

const buildSendOptionsMock = jest.fn(async () => ({ model: "sonnet" }))
jest.mock("@/hooks/chat/claude-chat-send-options", () => ({
  buildSendOptions: (...args: unknown[]) =>
    (buildSendOptionsMock as (...a: unknown[]) => unknown)(...args),
}))

const sendPromptMock = jest.fn(async () => undefined)
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...args: unknown[]) => (sendPromptMock as (...a: unknown[]) => unknown)(...args),
}))

const runtimeRefMock = jest.fn((): { kind: string; agentId?: string; configId?: string } => ({
  kind: "builtin",
}))
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  runtimeRefForSession: () => runtimeRefMock(),
}))

jest.mock("@/lib/work-submission/host-adapter", () => ({
  acceptHostStateChatTurn: jest.fn(async () => null),
  bindHostStateChatTurnContext: jest.fn(async () => false),
  claimHostStateChatTurnForDispatch: jest.fn(async () => "legacy"),
  markHostStateChatTurnStarted: jest.fn(async () => false),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

import { createAgentRpcHostStateDispatcher } from "./host-state-service"

function enqueue(sessionId: string) {
  return {
    accountId: "acct",
    targetId: "target",
    actionId: "action-1",
    sessionId,
    action: { kind: "message.enqueue", messageId: "m-1", text: "hi", attachments: [] },
  } as never
}

beforeEach(() => {
  buildSendOptionsMock.mockClear()
  sendPromptMock.mockClear()
  runtimeRefMock.mockReturnValue({ kind: "builtin" })
})

it("dispatches a built-in session through buildSendOptions and sendPrompt", async () => {
  await createAgentRpcHostStateDispatcher()(enqueue("s-builtin"))
  expect(buildSendOptionsMock).toHaveBeenCalledTimes(1)
  expect(sendPromptMock).toHaveBeenCalledWith(
    "s-builtin",
    "hi",
    { model: "sonnet" },
    { commandId: "action-1" }
  )
})

it("refuses a session whose runtime pick is an external agent before building options", async () => {
  // The chat controller checks `runtimeRefForSession(...).kind === "builtin"`
  // before it enqueues. An attached client does not run the controller, so
  // the dispatcher must apply the same gate: otherwise `buildSendOptions`
  // stamps the host's composer runtime (Codex here) onto `agent_send`, and the
  // sidecar's dispatcher throws on `runtimeAdapter: "external"`.
  runtimeRefMock.mockReturnValue({ kind: "external", agentId: "codex" })
  await expect(createAgentRpcHostStateDispatcher()(enqueue("s-external"))).rejects.toThrow(
    "host_state_runtime_not_builtin:external"
  )
  expect(buildSendOptionsMock).not.toHaveBeenCalled()
  expect(sendPromptMock).not.toHaveBeenCalled()
})

it("refuses a host-owned (remote) runtime pick the same way", async () => {
  runtimeRefMock.mockReturnValue({ kind: "host", configId: "cfg-1" })
  await expect(createAgentRpcHostStateDispatcher()(enqueue("s-host"))).rejects.toThrow(
    "host_state_runtime_not_builtin:host"
  )
  expect(sendPromptMock).not.toHaveBeenCalled()
})
