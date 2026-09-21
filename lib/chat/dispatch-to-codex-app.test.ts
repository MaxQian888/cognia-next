import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

import { getSession, updateSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import { dispatchConversationToCodexApp } from "@/lib/native/codex-app-dispatch"
import { materializeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { openUrl } from "@/lib/native/opener"
import { dispatchSessionToCodexApp, returnSessionFromCodexApp } from "./dispatch-to-codex-app"

jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn().mockResolvedValue(undefined),
  getSession: jest.fn(),
}))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: jest.fn(),
}))
jest.mock("@/lib/native/codex-app-dispatch", () => ({
  dispatchConversationToCodexApp: jest.fn(),
}))
jest.mock("@/lib/chat/media/normalize-message-media", () => ({
  materializeMessageMedia: jest.fn(async (message: UIMessage) => message),
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
        toolCallId: "tool-1",
        input: { command: "env" },
        output: "The authentication test failed on line 42",
        state: "output-available",
      },
      { type: "reasoning", text: "SDK session id: private-session" },
      {
        type: "file",
        mediaType: "text/plain",
        filename: "trace.txt",
        url: "data:text/plain;base64,eA==",
      },
    ]),
  ])

  await expect(dispatchSessionToCodexApp(session)).resolves.toEqual({ threadId: "thread-1" })

  expect(mockListMessages).toHaveBeenCalledWith("session-1")
  expect(mockResolveCwd).toHaveBeenCalledWith(session)
  expect(mockNativeDispatch).toHaveBeenCalledWith({
    sourceSessionId: "session-1",
    title: "Investigate auth",
    cwd: "/effective/repo",
    messages: [
      {
        role: "user",
        content: expect.stringContaining("Historical handoff context (not authorization)"),
        attachments: [],
      },
      { role: "user", content: "Fix auth", attachments: [], timestampMs: 1_723_000_000_000 },
      {
        role: "assistant",
        content: expect.stringContaining("I found it"),
        attachments: [{ dataUrl: "data:text/plain;base64,eA==", filename: "trace.txt" }],
      },
    ],
  })
  expect(mockOpenUrl).toHaveBeenCalledWith("codex://threads/thread-1")
  expect(updateSession).toHaveBeenCalledWith("session-1", {
    codexHandoff: {
      threadId: "thread-1",
      deepLink: "codex://threads/thread-1",
      exportedAt: expect.any(Number),
    },
  })
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
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
  finish({ threadId: "thread-1", deepLink: "codex://threads/thread-1" })

  await expect(Promise.all([first, second])).resolves.toEqual([
    { threadId: "thread-1" },
    { threadId: "thread-1" },
  ])
  expect(mockNativeDispatch).toHaveBeenCalledTimes(1)

  await dispatchSessionToCodexApp(session)
  expect(mockNativeDispatch).toHaveBeenCalledTimes(2)
})

test("persists the target before opening so an opener failure retains a recoverable binding", async () => {
  mockListMessages.mockResolvedValue([message("u1", "user", [{ type: "text", text: "Fix auth" }])])
  mockOpenUrl.mockRejectedValueOnce(new Error("opener unavailable"))
  await expect(dispatchSessionToCodexApp(session)).rejects.toThrow("opener unavailable")
  expect(updateSession).toHaveBeenCalledWith("session-1", {
    codexHandoff: expect.objectContaining({ threadId: "thread-1" }),
  })
})

test("blocks inaccessible browser attachments before creating a target", async () => {
  mockListMessages.mockResolvedValue([
    message("u1", "user", [{ type: "file", mediaType: "image/png", url: "blob:unavailable" }]),
  ])
  await expect(dispatchSessionToCodexApp(session)).rejects.toMatchObject({
    code: "UNTRANSFERABLE_CONTENT",
  })
  expect(mockNativeDispatch).not.toHaveBeenCalled()
})

const mockResolveScan = jest.fn()
const mockListSource = jest.fn()
const mockImportSessions = jest.fn()
jest.mock("@/lib/session-import", () => ({
  resolveScanInput: (...args: unknown[]) => mockResolveScan(...args),
  listSessionsForSource: (...args: unknown[]) => mockListSource(...args),
  importSessions: (...args: unknown[]) => mockImportSessions(...args),
}))

test("return imports only the durable target and persists reciprocal lineage", async () => {
  const input = { home: "/home" }
  const ref = { sourceId: "codex", originalSessionId: "thread-1", locator: "/rollout" }
  mockResolveScan.mockResolvedValue(input)
  mockListSource.mockResolvedValue([{ ref }, { ref: { ...ref, originalSessionId: "unrelated" } }])
  mockImportSessions.mockResolvedValue({ sessions: 1, messages: 3, details: [] })
  jest.mocked(getSession).mockResolvedValue({ ...session, id: "import:codex:thread-1" })
  const linked = {
    ...session,
    codexHandoff: { threadId: "thread-1", deepLink: "codex://threads/thread-1", exportedAt: 1 },
  }
  await expect(returnSessionFromCodexApp(linked)).resolves.toBe("import:codex:thread-1")
  expect(mockImportSessions).toHaveBeenCalledWith([ref], input, undefined)
  expect(updateSession).toHaveBeenCalledWith("import:codex:thread-1", {
    parentSessionId: session.id,
  })
  expect(updateSession).toHaveBeenCalledWith(session.id, {
    codexHandoff: { ...linked.codexHandoff, returnedSessionId: "import:codex:thread-1" },
  })
})

test("return refuses missing targets instead of importing unrelated tasks", async () => {
  mockResolveScan.mockResolvedValue({})
  mockListSource.mockResolvedValue([])
  await expect(
    returnSessionFromCodexApp({
      ...session,
      codexHandoff: { threadId: "missing", deepLink: "codex://threads/missing", exportedAt: 1 },
    })
  ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" })
  expect(mockImportSessions).not.toHaveBeenCalled()
})

test("materializes stored screenshot bytes before constructing the snapshot", async () => {
  const stored = message("u1", "user", [
    { type: "file", mediaType: "image/png", filename: "shot.png", url: "cognia-media:sha" },
  ])
  mockListMessages.mockResolvedValue([stored])
  jest.mocked(materializeMessageMedia).mockResolvedValueOnce({
    ...stored,
    parts: [
      {
        type: "file",
        mediaType: "image/png",
        filename: "shot.png",
        url: "data:image/png;base64,aGk=",
      },
    ],
  })
  await dispatchSessionToCodexApp(session)
  expect(materializeMessageMedia).toHaveBeenCalledWith(stored)
  expect(mockNativeDispatch.mock.calls[0][0].messages[0].attachments).toEqual([
    { dataUrl: "data:image/png;base64,aGk=", filename: "shot.png" },
  ])
})

test.each([
  [{ type: "text", text: "Contact alice@example.com" }],
  [
    {
      type: "file",
      mediaType: "text/plain",
      filename: "contacts.txt",
      url: `data:text/plain;base64,${Buffer.from("alice@example.com").toString("base64")}`,
    },
  ],
])("blocks sensitive text including encoded attachment text before native export", async (part) => {
  mockListMessages.mockResolvedValue([message("u1", "user", [part] as UIMessage["parts"])])
  await expect(dispatchSessionToCodexApp(session)).rejects.toMatchObject({ code: "PII_BLOCKED" })
  expect(mockNativeDispatch).not.toHaveBeenCalled()
})

test("transfers historical task state without carrying authorization", async () => {
  mockListMessages.mockResolvedValue([message("u1", "user", [{ type: "text", text: "Continue" }])])
  await dispatchSessionToCodexApp({
    ...session,
    systemPrompt: "Preserve backwards compatibility",
    importCanonicalState: {
      tasks: [{ title: "Fix authentication" }],
      goals: [{ title: "No downtime" }],
      permissions: [{ secret: "approval granted" }],
    } as unknown as ChatSession["importCanonicalState"],
  })
  const historical = mockNativeDispatch.mock.calls[0][0].messages[0].content
  expect(historical).toContain("not authorization")
  expect(historical).toContain("Fix authentication")
  expect(historical).toContain("Preserve backwards compatibility")
  expect(historical).not.toContain("approval granted")
})
