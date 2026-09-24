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
const mockParseSessions = jest.fn()
const mockApplyImported = jest.fn()
const mockGetDb = jest.fn()
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockGetDb() }))
jest.mock("@/lib/session-import", () => ({
  resolveScanInput: (...args: unknown[]) => mockResolveScan(...args),
  listSessionsForSource: (...args: unknown[]) => mockListSource(...args),
  parseSessions: (...args: unknown[]) => mockParseSessions(...args),
}))
jest.mock("@/lib/data/import-registry", () => ({
  applyImported: (...args: unknown[]) => mockApplyImported(...args),
}))

function setupReturn() {
  const linked: ChatSession = {
    ...session,
    codexHandoff: {
      threadId: "thread-1",
      deepLink: "codex://threads/thread-1",
      exportedAt: 1,
    },
  }
  const rows = new Map<string, ChatSession>([[session.id, linked]])
  const input = { home: "/home" }
  const ref = { sourceId: "codex", originalSessionId: "thread-1", locator: "/rollout" }
  const conversation = {
    session: { ...session, id: "import:codex:thread-1", importOwnership: "source-mirror" as const },
    messages: [
      {
        ...message("m1", "user", [{ type: "text", text: "Original Codex history" }]),
        sessionId: "import:codex:thread-1",
        createdAt: 1,
      },
    ],
  }
  mockResolveScan.mockResolvedValue(input)
  mockListSource.mockResolvedValue([{ ref }, { ref: { ...ref, originalSessionId: "unrelated" } }])
  mockParseSessions.mockResolvedValue([conversation])
  jest.mocked(getSession).mockImplementation(async (id) => rows.get(id))
  mockGetDb.mockReturnValue({
    sessions: { get: async (id: string) => rows.get(id) },
    transaction: async (_mode: string, _table: unknown, operation: () => Promise<unknown>) =>
      operation(),
  })
  mockApplyImported.mockImplementation(async (conversations: Array<{ session: ChatSession }>) => {
    for (const incoming of conversations) rows.set(incoming.session.id, incoming.session)
    return { sessions: conversations.length, messages: 1 }
  })
  return { linked, rows, input, ref, conversation }
}

test("return persists the actual immutable snapshot id and reciprocal lineage", async () => {
  const { linked, rows, ref, input } = setupReturn()
  const id = await returnSessionFromCodexApp(linked)
  expect(id).toMatch(/^import:codex:thread-1:handoff:[a-f0-9]{64}$/)
  expect(mockParseSessions).toHaveBeenCalledWith([ref], input, undefined)
  expect(rows.get(id)?.parentSessionId).toBe(session.id)
  expect(updateSession).toHaveBeenCalledWith(session.id, {
    codexHandoff: { ...linked.codexHandoff, returnedSessionId: id },
  })
})

test("repeated same snapshot preserves local continuation and does not reimport it", async () => {
  const { linked, rows } = setupReturn()
  const id = await returnSessionFromCodexApp(linked)
  const continued = {
    ...rows.get(id)!,
    importOwnership: "cognia-owned" as const,
    importFrozen: true,
    title: "Locally continued",
  }
  rows.set(id, continued)
  mockApplyImported.mockClear()
  expect(await returnSessionFromCodexApp(linked)).toBe(id)
  expect(mockApplyImported).not.toHaveBeenCalled()
  expect(rows.get(id)).toBe(continued)
})

test("returned snapshots cannot inherit native runtime continuation authority", async () => {
  const { linked, conversation, rows } = setupReturn()
  mockParseSessions.mockResolvedValueOnce([
    {
      ...conversation,
      session: {
        ...conversation.session,
        importOwnership: "native-bound",
        importRuntimeBinding: { nativeSessionId: "thread-1", presetId: "codex" },
        sdkSessionId: "thread-1",
        externalAgentSession: { agentId: "codex", sessionId: "thread-1" },
      },
    },
  ])
  const id = await returnSessionFromCodexApp(linked)
  expect(rows.get(id)).toMatchObject({ importFrozen: true, importOwnership: "cognia-owned" })
  expect(rows.get(id)?.importRuntimeBinding).toBeUndefined()
  expect(rows.get(id)?.sdkSessionId).toBeUndefined()
  expect(rows.get(id)?.externalAgentSession).toBeUndefined()
})

test("source pointer comparison and write run inside the same transaction", async () => {
  const { linked, rows } = setupReturn()
  let active = false
  const table = {
    get: jest.fn(async (id: string) => {
      expect(active).toBe(true)
      return rows.get(id)
    }),
  }
  const transaction = jest.fn(async (_mode, _table, operation) => {
    active = true
    try {
      return await operation()
    } finally {
      active = false
    }
  })
  mockGetDb.mockReturnValue({ sessions: table, transaction })
  jest.mocked(updateSession).mockImplementationOnce(async () => {
    expect(active).toBe(true)
  })
  await returnSessionFromCodexApp(linked)
  expect(transaction).toHaveBeenCalledWith("rw", table, expect.any(Function))
  expect(table.get).toHaveBeenCalledWith(linked.id)
  expect(updateSession).toHaveBeenCalledTimes(1)
})

test("parse-time fallback dates do not turn a retry into a new snapshot", async () => {
  const { linked, conversation } = setupReturn()
  const first = await returnSessionFromCodexApp(linked)
  mockApplyImported.mockClear()
  mockParseSessions.mockResolvedValue([
    {
      ...conversation,
      session: { ...conversation.session, createdAt: 12345, updatedAt: 67890 },
      messages: conversation.messages.map((message) => ({ ...message, createdAt: 98765 })),
    },
  ])
  expect(await returnSessionFromCodexApp(linked)).toBe(first)
  expect(mockApplyImported).not.toHaveBeenCalled()
})

test("a newer outbound binding established during parsing is never overwritten", async () => {
  const { linked, rows, conversation } = setupReturn()
  mockParseSessions.mockImplementationOnce(async () => {
    rows.set(linked.id, {
      ...linked,
      codexHandoff: {
        threadId: "newer-target",
        deepLink: "codex://threads/newer-target",
        exportedAt: 2,
      },
    })
    return [conversation]
  })
  const id = await returnSessionFromCodexApp(linked)
  expect(rows.has(id)).toBe(true)
  expect(updateSession).not.toHaveBeenCalled()
  expect(rows.get(linked.id)?.codexHandoff?.threadId).toBe("newer-target")
})

test("a failed persistence never reports a returned task or advances the source pointer", async () => {
  const { linked } = setupReturn()
  mockApplyImported.mockResolvedValueOnce({ sessions: 0, messages: 0 })
  await expect(returnSessionFromCodexApp(linked)).rejects.toMatchObject({
    code: "TARGET_NOT_FOUND",
  })
  expect(updateSession).not.toHaveBeenCalled()
})

test("changed Codex history forks when a previously returned task was continued locally", async () => {
  const { linked, rows, conversation } = setupReturn()
  const oldId = await returnSessionFromCodexApp(linked)
  const continued = {
    ...rows.get(oldId)!,
    importOwnership: "cognia-owned" as const,
    importFrozen: true,
  }
  rows.set(oldId, continued)
  // The old mutable importer ID may also be frozen by a previous app version.
  rows.set(conversation.session.id, { ...conversation.session, importFrozen: true })
  mockParseSessions.mockResolvedValue([
    {
      ...conversation,
      messages: [
        ...conversation.messages,
        {
          ...message("m2", "assistant", [{ type: "text", text: "New Codex result" }]),
          sessionId: conversation.session.id,
          createdAt: 2,
        },
      ],
    },
  ])
  const newId = await returnSessionFromCodexApp(linked)
  expect(newId).not.toBe(oldId)
  expect(rows.get(oldId)).toBe(continued)
  expect(mockApplyImported.mock.calls.at(-1)?.[0][0].messages.at(-1).parts[0].text).toBe(
    "New Codex result"
  )
  expect(updateSession).toHaveBeenLastCalledWith(session.id, {
    codexHandoff: { ...linked.codexHandoff, returnedSessionId: newId },
  })
})

test("return remaps graph child sessions and message ownership to the same snapshot", async () => {
  const { linked, conversation, rows } = setupReturn()
  const childId = "import:codex:child"
  mockParseSessions.mockResolvedValue([
    conversation,
    {
      session: {
        ...conversation.session,
        id: childId,
        parentSessionId: conversation.session.id,
        surfaceBinding: { kind: "session", sessionId: conversation.session.id },
        attachedChild: {
          parentSessionId: conversation.session.id,
          lifecycleOwnerSessionId: conversation.session.id,
          context: { mode: "none" },
          workspace: "shared",
          status: "completed",
          createdAt: 1,
        },
      },
      messages: [{ ...conversation.messages[0], sessionId: childId }],
    },
  ])
  const id = await returnSessionFromCodexApp(linked)
  const child = [...rows.values()].find((row) => row.id.startsWith(childId))!
  expect(child.parentSessionId).toBe(id)
  expect(child.importGraphRootId).toBe(id)
  expect(child.surfaceBinding).toEqual({ kind: "session", sessionId: id })
  expect(child.attachedChild?.lifecycleOwnerSessionId).toBe(id)
  expect(child.attachedChild?.parentSessionId).toBe(id)
})

test("parse failure never returns an older frozen conversation as success", async () => {
  const { linked } = setupReturn()
  mockParseSessions.mockResolvedValue([])
  await expect(returnSessionFromCodexApp(linked)).rejects.toMatchObject({
    code: "TARGET_NOT_FOUND",
  })
  expect(mockApplyImported).not.toHaveBeenCalled()
  expect(updateSession).not.toHaveBeenCalled()
})

test("return refuses missing targets instead of importing unrelated tasks", async () => {
  const { linked } = setupReturn()
  mockListSource.mockResolvedValue([])
  await expect(returnSessionFromCodexApp(linked)).rejects.toMatchObject({
    code: "TARGET_NOT_FOUND",
  })
  expect(mockApplyImported).not.toHaveBeenCalled()
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
