import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

import { listMessages } from "@/lib/db/messages"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import { dispatchConversationToCodexApp } from "@/lib/native/codex-app-dispatch"
import { openUrl } from "@/lib/native/opener"
import { dispatchSessionToCodexApp } from "./dispatch-to-codex-app"

jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: jest.fn(),
}))
jest.mock("@/lib/native/codex-app-dispatch", () => ({
  dispatchConversationToCodexApp: jest.fn(),
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

const mockListMessages = listMessages as jest.MockedFunction<typeof listMessages>
const mockResolveCwd = resolveEffectiveCwdForSession as jest.MockedFunction<
  typeof resolveEffectiveCwdForSession
>
const mockNativeDispatch = dispatchConversationToCodexApp as jest.MockedFunction<
  typeof dispatchConversationToCodexApp
>
const mockOpenUrl = openUrl as jest.MockedFunction<typeof openUrl>

const session: ChatSession = {
  id: "session-1",
  title: "Investigate auth",
  kind: "direct",
  workingDir: "/session-override",
  createdAt: 0,
  updatedAt: 0,
}

function message(
  id: string,
  role: UIMessage["role"],
  parts: UIMessage["parts"],
  createdAt?: number
): UIMessage {
  return {
    id,
    role,
    parts,
    ...(createdAt === undefined ? {} : { metadata: { createdAt } }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCwd.mockResolvedValue("/effective/repo")
  mockNativeDispatch.mockResolvedValue({
    threadId: "thread-1",
    deepLink: "codex://threads/thread-1",
  })
  mockOpenUrl.mockResolvedValue(undefined)
})

test("dispatches a role-preserving snapshot and opens the imported Codex task", async () => {
  mockListMessages.mockResolvedValue([
    message("sys", "system", [{ type: "text", text: "private system prompt" }]),
    message("u1", "user", [{ type: "text", text: "Fix auth" }], 1_723_000_000_000),
    message("a1", "assistant", [
      { type: "text", text: "I found it" },
      {
        type: "tool-shell",
        input: { command: "env" },
        output: "OPENAI_API_KEY=secret",
        state: "output-available",
      },
      { type: "reasoning", text: "SDK session id: private-session" },
      { type: "file", mediaType: "text/plain", filename: "trace.txt", url: "data:,x" },
    ]),
  ])

  await expect(dispatchSessionToCodexApp(session)).resolves.toEqual({ threadId: "thread-1" })

  expect(mockListMessages).toHaveBeenCalledWith("session-1")
  expect(mockResolveCwd).toHaveBeenCalledWith(session)
  expect(mockNativeDispatch).toHaveBeenCalledWith({
    title: "Investigate auth",
    cwd: "/effective/repo",
    messages: [
      { role: "user", content: "Fix auth", timestampMs: 1_723_000_000_000 },
      {
        role: "assistant",
        content: "I found it\n[tool: shell]\n[reasoning]\n[attachment: trace.txt]",
      },
    ],
  })
  expect(mockOpenUrl).toHaveBeenCalledWith("codex://threads/thread-1")
})

test("rejects snapshots without a renderable user message", async () => {
  mockListMessages.mockResolvedValue([
    message("sys", "system", [{ type: "text", text: "secret" }]),
    message("a1", "assistant", [{ type: "text", text: "orphan answer" }]),
  ])

  await expect(dispatchSessionToCodexApp(session)).rejects.toMatchObject({
    code: "NO_USER_MESSAGE",
  })
  expect(mockNativeDispatch).not.toHaveBeenCalled()
})

test("requires an effective working directory", async () => {
  mockListMessages.mockResolvedValue([message("u1", "user", [{ type: "text", text: "Fix auth" }])])
  mockResolveCwd.mockResolvedValue(null)

  await expect(dispatchSessionToCodexApp(session)).rejects.toMatchObject({ code: "NO_CWD" })
  expect(mockNativeDispatch).not.toHaveBeenCalled()
})

test("deduplicates simultaneous clicks but allows a later snapshot", async () => {
  mockListMessages.mockResolvedValue([message("u1", "user", [{ type: "text", text: "Fix auth" }])])
  let finish!: (value: { threadId: string; deepLink: string }) => void
  mockNativeDispatch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))

  const first = dispatchSessionToCodexApp(session)
  const second = dispatchSessionToCodexApp(session)
  await Promise.resolve()
  await Promise.resolve()
  finish({ threadId: "thread-1", deepLink: "codex://threads/thread-1" })

  await expect(Promise.all([first, second])).resolves.toEqual([
    { threadId: "thread-1" },
    { threadId: "thread-1" },
  ])
  expect(mockNativeDispatch).toHaveBeenCalledTimes(1)

  await dispatchSessionToCodexApp(session)
  expect(mockNativeDispatch).toHaveBeenCalledTimes(2)
})
