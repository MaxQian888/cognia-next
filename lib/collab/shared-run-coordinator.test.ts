jest.mock("@/lib/db/schema", () => {
  const db = { name: "cognia-account-test" }
  return { getDb: jest.fn(() => db) }
})
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn().mockResolvedValue(undefined) }))
jest.mock("./shared-chat-sync", () => ({
  syncSharedSession: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("./shared-chat-conversion", () => ({
  resolveSharedAttachmentParts: jest.fn(async (_client, _org, _session, parts) => parts),
  uploadMessageAttachments: jest.fn().mockResolvedValue({
    parts: [{ type: "file", url: "cognia://shared-attachment/a" }],
    attachmentIds: ["a"],
  }),
}))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/db/shared-run-journal", () => {
  const rows = new Map()
  return {
    putSharedRunJournal: jest.fn(async (id, journal) => {
      rows.set(id, structuredClone(journal))
    }),
    getSharedRunJournal: jest.fn(async (id) => rows.get(id)),
    deleteSharedRunJournal: jest.fn(async (id) => {
      rows.delete(id)
    }),
    putSharedSendJournal: jest.fn(async (id, send) => {
      rows.set(`send:${id}`, structuredClone(send))
    }),
    getSharedSendJournal: jest.fn(async (id) => rows.get(`send:${id}`)),
    deleteSharedSendJournal: jest.fn(async (id) => {
      rows.delete(`send:${id}`)
    }),
    __clear: () => rows.clear(),
  }
})
jest.mock("./runtime-client", () => ({ resolveCurrentCollabContext: jest.fn() }))

import { CollabError } from "./client"
import {
  canAutomaticallyDrainSharedQueue,
  beginSharedSessionRun,
  finishSharedSessionRun,
  resetSharedRunCoordinatorForTesting,
  sharedRequestTranscript,
  sharedMessageSendContent,
  sharedAssistantParts,
  recoverSharedSessionRun,
  sendSharedSessionMessage,
  suspendSharedSessionRuns,
  publishSharedSessionRun,
  authorizeSharedSessionApproval,
} from "./shared-run-coordinator"

const session = {
  id: "local-session",
  collaboration: {
    orgId: "org",
    workspaceId: "workspace",
    sessionId: "shared-session",
    status: "active" as const,
    lastSequence: 0,
    syncCursor: 0,
    policyRevision: 1,
  },
}

function context(client: Record<string, jest.Mock>) {
  return async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
}

beforeEach(() => {
  jest.requireMock("@/lib/db/schema").getDb.mockReturnValue({ name: "cognia-account-test" })
  jest.requireMock("@/lib/db/shared-run-journal").__clear()
  jest.mocked(jest.requireMock("@/lib/db/messages").listMessages).mockResolvedValue([])
})
afterEach(() => resetSharedRunCoordinatorForTesting())

it("acquires a bound lease, publishes lifecycle events, and releases it", async () => {
  const client = {
    health: jest.fn().mockResolvedValue({ features: ["shared-chat-execution-v2"] }),
    enqueueSessionRunInput: jest.fn().mockResolvedValue({ id: "queued" }),
    claimSessionRunQueue: jest.fn().mockResolvedValue({
      lease: { id: "lease" },
      token: "secret",
      item: { requestedByUserId: "requester", payload: { contextSequence: 1 } },
    }),
    appendSessionEvent: jest.fn().mockResolvedValue({}),
    appendSessionRunEvent: jest.fn().mockResolvedValue({}),
    heartbeatSessionRunLease: jest.fn().mockResolvedValue({}),
    releaseSessionRunLease: jest.fn().mockResolvedValue({}),
  }
  const result = await beginSharedSessionRun(
    session,
    "run",
    { messageId: "message" },
    {
      resolveContext: context(client),
      getDeviceId: async () => "device",
      setInterval: (() => 42) as never,
    }
  )
  expect(result.kind).toBe("acquired")
  expect(client.appendSessionEvent).not.toHaveBeenCalled()
  expect(client.appendSessionRunEvent).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "run",
    "secret",
    expect.objectContaining({ kind: "run.started" })
  )
  await finishSharedSessionRun("local-session", "completed")
  expect(client.appendSessionRunEvent).toHaveBeenLastCalledWith(
    "org",
    "shared-session",
    "run",
    "secret",
    expect.objectContaining({ kind: "run.completed" })
  )
  expect(client.releaseSessionRunLease).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "lease",
    "released"
  )
})

it("queues input instead of executing when another lease is active", async () => {
  const client = {
    health: jest.fn().mockResolvedValue({ features: ["shared-chat-execution-v2"] }),
    claimSessionRunQueue: jest.fn().mockRejectedValue(new CollabError(409, "conflict")),
    enqueueSessionRunInput: jest.fn().mockResolvedValue({ id: "queued" }),
  }
  const result = await beginSharedSessionRun(
    session,
    "run",
    { messageId: "message" },
    {
      resolveContext: context(client),
      getDeviceId: async () => "device",
    }
  )
  expect(result).toEqual({ kind: "queued", queueItemId: "queued" })
  expect(client.enqueueSessionRunInput).toHaveBeenCalledWith("org", "shared-session", {
    payload: { messageId: "message" },
    operationId: "run-queue:run",
  })
})

it("fails closed when a shared session has no authenticated collaboration context", async () => {
  await expect(
    beginSharedSessionRun(session, "run", {}, { resolveContext: async () => null })
  ).rejects.toThrow("connection is unavailable")
})

it("rejects older servers before enqueuing an AI request", async () => {
  const client = {
    health: jest.fn().mockResolvedValue({ features: ["shared-chat"] }),
    enqueueSessionRunInput: jest.fn(),
  }
  await expect(
    beginSharedSessionRun(
      session,
      "run",
      { messageId: "message" },
      { resolveContext: context(client), getDeviceId: async () => "device" }
    )
  ).rejects.toThrow("upgrade required")
  expect(client.enqueueSessionRunInput).not.toHaveBeenCalled()
})

it("retries finalization without dropping the lease after a publication failure", async () => {
  const client = {
    health: jest.fn().mockResolvedValue({ features: ["shared-chat-execution-v2"] }),
    enqueueSessionRunInput: jest.fn().mockResolvedValue({ id: "queued" }),
    claimSessionRunQueue: jest.fn().mockResolvedValue({
      lease: { id: "lease" },
      token: "secret",
      item: { requestedByUserId: "user", payload: {} },
    }),
    appendSessionRunEvent: jest.fn().mockResolvedValue({}),
    heartbeatSessionRunLease: jest.fn(),
    releaseSessionRunLease: jest
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({}),
  }
  await beginSharedSessionRun(
    session,
    "run",
    { messageId: "message" },
    {
      resolveContext: context(client),
      getDeviceId: async () => "device",
      setInterval: (() => 42) as never,
    }
  )
  await expect(finishSharedSessionRun(session.id, "failed")).rejects.toThrow("network")
  await finishSharedSessionRun(session.id, "failed")
  expect(client.releaseSessionRunLease).toHaveBeenCalledTimes(2)
})

it("preserves inline images and extracted documents in queued requests", () => {
  expect(
    sharedMessageSendContent([
      { type: "file", text: "document" },
      { type: "file", url: "data:image/png;base64,YQ==" },
    ])
  ).toEqual([
    { type: "text", text: "document" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
  ])
  expect(() => sharedMessageSendContent([{ type: "file", url: "file:///private" }])).toThrow(
    "unavailable"
  )
})

it("replays only the queued event boundary, ignoring later edits and later messages", async () => {
  const client = {
    listSessionEvents: jest.fn().mockResolvedValue([
      {
        sequence: 1,
        sessionId: "s",
        kind: "message.created",
        payload: { messageId: "m", role: "user", parts: [{ type: "text", text: "original" }] },
      },
      {
        sequence: 2,
        sessionId: "s",
        kind: "message.corrected",
        payload: { targetMessageId: "m", parts: [{ type: "text", text: "later" }] },
      },
    ]),
  }
  const content = await sharedRequestTranscript(client as never, "org", "s", 1)
  expect(JSON.stringify(content)).toContain("original")
  expect(JSON.stringify(content)).not.toContain("later")
})

it("shares tool status while removing credentials and private tool input", () => {
  const parts = sharedAssistantParts([
    {
      type: "tool-read",
      toolCallId: "call",
      state: "output-available",
      input: { password: "private" },
      output: { apiKey: "opaque-secret", result: "ok" },
    },
  ])
  expect(JSON.stringify(parts)).not.toContain("opaque-secret")
  expect(JSON.stringify(parts)).not.toContain("private")
  expect(JSON.stringify(parts)).toContain("ok")
})

it("persists claim credentials before the request and reuses them after a lost response", async () => {
  const client = {
    health: jest.fn().mockResolvedValue({ features: ["shared-chat-execution-v2"] }),
    enqueueSessionRunInput: jest.fn().mockResolvedValue({ id: "queued" }),
    claimSessionRunQueue: jest
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue({
        lease: { id: "lease" },
        token: "secret",
        item: { requestedByUserId: "user", payload: {} },
      }),
    appendSessionRunEvent: jest.fn().mockResolvedValue({}),
    heartbeatSessionRunLease: jest.fn(),
    releaseSessionRunLease: jest.fn(),
  }
  const deps = {
    resolveContext: context(client),
    getDeviceId: async () => "device",
    setInterval: (() => 42) as never,
  }
  await expect(
    beginSharedSessionRun(session, "run", { messageId: "message" }, deps)
  ).rejects.toThrow("lost response")
  await beginSharedSessionRun(session, "run", { messageId: "message" }, deps)
  expect(client.claimSessionRunQueue.mock.calls[0][2].token).toBe(
    client.claimSessionRunQueue.mock.calls[1][2].token
  )
})

it("recovers partial durable assistant output before hydration and finalizes without executing tools", async () => {
  const client = {
    baseUrl: "https://collab.test",
    getActiveSessionRunLease: jest
      .fn()
      .mockResolvedValue({ id: "lease", runId: "run", holderDeviceId: "device" }),
    appendSessionRunEvent: jest.fn().mockResolvedValue({}),
    releaseSessionRunLease: jest.fn().mockResolvedValue({}),
  }
  const ctx = { orgId: "org", userId: "user", localAccountId: "local", client }
  jest.requireMock("./runtime-client").resolveCurrentCollabContext.mockResolvedValue(ctx)
  await jest
    .requireMock("@/lib/db/shared-run-journal")
    .putSharedRunJournal(JSON.stringify([client.baseUrl, "org", "local", "user", session.id]), {
      runId: "run",
      leaseId: "lease",
      token: "secret",
      deviceId: "device",
      baselineMessageIds: [],
    })
  jest
    .requireMock("@/lib/db/messages")
    .listMessages.mockResolvedValue([
      { id: "assistant", role: "assistant", parts: [{ type: "text", text: "partial response" }] },
    ])
  await recoverSharedSessionRun(session)
  expect(client.appendSessionRunEvent).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "run",
    "secret",
    expect.objectContaining({
      kind: "message.corrected",
      payload: {
        targetMessageId: "assistant",
        parts: [{ type: "text", text: "partial response" }],
      },
    })
  )
  expect(client.releaseSessionRunLease).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "lease",
    "failed"
  )
})

function fullClient() {
  return {
    baseUrl: "https://collab.test",
    health: jest.fn().mockResolvedValue({ features: ["shared-chat-execution-v2"] }),
    enqueueSessionRunInput: jest.fn().mockResolvedValue({ id: "queued" }),
    claimSessionRunQueue: jest.fn().mockResolvedValue({
      lease: { id: "lease" },
      token: "secret",
      item: { requestedByUserId: "user", payload: {} },
    }),
    appendSessionRunEvent: jest.fn().mockResolvedValue({}),
    appendSessionEvent: jest.fn().mockResolvedValue({ id: "event" }),
    heartbeatSessionRunLease: jest.fn().mockResolvedValue({}),
    releaseSessionRunLease: jest.fn().mockResolvedValue({}),
    getSharedSession: jest.fn().mockResolvedValue({ id: "shared-session" }),
    commitSessionAttachment: jest.fn().mockResolvedValue({}),
    getActiveSessionRunLease: jest.fn().mockResolvedValue(null),
  }
}
function useContext(client: unknown) {
  jest.requireMock("./runtime-client").resolveCurrentCollabContext.mockResolvedValue({
    orgId: "org",
    userId: "user",
    localAccountId: "local",
    client,
  })
}

it("retains the durable send identity and uploaded attachment on uncertain response", async () => {
  const client = fullClient()
  useContext(client)
  client.appendSessionEvent.mockRejectedValueOnce(new Error("offline"))
  const message = { id: "message", parts: [{ type: "file", url: "data:image/png;base64,YQ==" }] }
  await expect(sendSharedSessionMessage(session, message)).rejects.toThrow("offline")
  await sendSharedSessionMessage(session, { ...message, id: "new-id-after-reload" })
  const first = client.appendSessionEvent.mock.calls[0][2]
  expect(client.appendSessionEvent.mock.calls[1][2]).toEqual(first)
  expect(first.payload.messageId).toBe("message")
  expect(client.commitSessionAttachment).toHaveBeenCalledWith("org", "shared-session", "a", "event")
})

it("sends ordinary text without claiming or executing AI", async () => {
  const client = fullClient()
  useContext(client)
  await sendSharedSessionMessage(session, {
    id: "m",
    parts: [{ type: "text", text: "hello" }],
    createdAt: 1,
  })
  expect(client.claimSessionRunQueue).not.toHaveBeenCalled()
  expect(client.appendSessionEvent).toHaveBeenCalledTimes(1)
})

it("rejects a send on a different endpoint and preserves its local draft", async () => {
  const client = fullClient()
  useContext(client)
  await expect(
    sendSharedSessionMessage(
      { ...session, collaboration: { ...session.collaboration, endpoint: "https://other.test" } },
      { id: "m", parts: [] }
    )
  ).rejects.toThrow("unavailable")
  expect(client.appendSessionEvent).not.toHaveBeenCalled()
})

it("fences local output and interrupts the executor when the heartbeat fails", async () => {
  const client = fullClient()
  client.heartbeatSessionRunLease.mockRejectedValue(new Error("revoked"))
  const timers: Array<() => void> = []
  const cancel = jest.fn()
  const result = await beginSharedSessionRun(
    session,
    "run",
    { messageId: "message", queueItemId: "queued", takeover: true },
    {
      resolveContext: context(client as never),
      getDeviceId: async () => "device",
      setInterval: ((fn: () => void) => {
        timers.push(fn)
        return timers.length
      }) as never,
      clearInterval: cancel as never,
    }
  )
  const lost = jest.fn()
  if (result.kind === "acquired") result.setLeaseLostHandler(lost)
  timers[1]()
  await Promise.resolve()
  await Promise.resolve()
  expect(lost).toHaveBeenCalledTimes(1)
  await finishSharedSessionRun(session.id, "cancelled")
  expect(client.releaseSessionRunLease).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalled()
})

it("keeps only one publication for unchanged assistant output and fences account teardown", async () => {
  const client = fullClient()
  await beginSharedSessionRun(
    session,
    "run",
    { messageId: "message" },
    {
      resolveContext: context(client as never),
      getDeviceId: async () => "device",
      setInterval: (() => 1) as never,
    }
  )
  jest
    .requireMock("@/lib/db/messages")
    .listMessages.mockResolvedValue([
      { id: "a", role: "assistant", createdAt: 1, parts: [{ type: "text", text: "hi" }] },
    ])
  await publishSharedSessionRun(session.id)
  await publishSharedSessionRun(session.id)
  expect(client.appendSessionRunEvent).toHaveBeenCalledTimes(3)
  suspendSharedSessionRuns()
  await publishSharedSessionRun(session.id)
  expect(client.appendSessionRunEvent).toHaveBeenCalledTimes(3)
})

it("recovers an expired claim by releasing only its own lease without replaying tools", async () => {
  const client = fullClient()
  useContext(client)
  const ref = JSON.stringify([client.baseUrl, "org", "local", "user", session.id])
  await jest.requireMock("@/lib/db/shared-run-journal").putSharedRunJournal(ref, {
    runId: "r",
    leaseId: "old",
    token: "secret",
    deviceId: "d",
    baselineMessageIds: [],
    terminalStatus: "completed",
  })
  await recoverSharedSessionRun(session)
  expect(client.releaseSessionRunLease).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "old",
    "released"
  )
  expect(client.appendSessionRunEvent).not.toHaveBeenCalled()
})

it("keeps private sessions independent and rejects unavailable shared identity", async () => {
  expect(await beginSharedSessionRun({ id: "private" }, "r", {})).toEqual({ kind: "private" })
  const client = fullClient()
  await expect(
    beginSharedSessionRun(
      session,
      "r",
      {},
      { resolveContext: context(client as never), getDeviceId: async () => null }
    )
  ).rejects.toThrow("identity")
  await expect(
    beginSharedSessionRun(
      session,
      "r",
      {},
      { resolveContext: context(client as never), getDeviceId: async () => "d" }
    )
  ).rejects.toThrow("messageId")
})

it.each([
  [0, [], "boundary"],
  [1, [], "incomplete"],
  [
    2,
    [{ sessionId: "shared-session", sequence: 2, kind: "run.started", payload: {} }],
    "sequence gap",
  ],
  [1, [{ sessionId: "other", sequence: 1, kind: "run.started", payload: {} }], "sequence gap"],
  [
    1,
    [{ sessionId: "shared-session", sequence: 2, kind: "run.started", payload: {} }],
    "boundary is unavailable",
  ],
])("fails closed on unavailable context boundary %s", async (boundary, events, error) => {
  await expect(
    sharedRequestTranscript(
      { listSessionEvents: jest.fn().mockResolvedValue(events) } as never,
      "org",
      "shared-session",
      boundary as number
    )
  ).rejects.toThrow(String(error))
})

it("replays corrections, redactions and shareable tool results in authoritative order", async () => {
  const rows = [
    ["message.created", { messageId: "m", role: "user", parts: [{ type: "text", text: "old" }] }],
    ["message.corrected", { targetMessageId: "m", parts: [{ type: "text", text: "changed" }] }],
    ["message.corrected", { targetMessageId: "missing", parts: [] }],
    [
      "message.created",
      { messageId: "removed", role: "user", parts: [{ type: "text", text: "private-deleted" }] },
    ],
    ["message.redacted", { targetMessageId: "removed" }],
    [
      "message.created",
      {
        messageId: "a",
        role: "assistant",
        parts: [
          { type: "text", text: "answer" },
          { type: "dynamic-tool", output: "result" },
          { type: "reasoning", text: "private-reasoning" },
        ],
      },
    ],
  ].map(([kind, payload], index) => ({ sequence: index + 1, sessionId: "s", kind, payload }))
  const client = {
    listSessionEvents: jest
      .fn()
      .mockResolvedValueOnce(rows.slice(0, 3))
      .mockResolvedValueOnce(rows.slice(3)),
  }
  const transcript = JSON.stringify(await sharedRequestTranscript(client as never, "org", "s", 6))
  expect(transcript).toContain("changed")
  expect(transcript).toContain("answer")
  expect(transcript).toContain("result")
  expect(transcript).not.toContain("private-")
})

it("supports documents while rejecting unsupported or missing user parts", () => {
  expect(
    sharedMessageSendContent([{ type: "file", url: "data:application/pdf;base64,YQ==" }])
  ).toEqual([
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "YQ==" } },
  ])
  expect(() => sharedMessageSendContent([{ type: "file" }])).toThrow("unavailable")
  expect(() => sharedMessageSendContent([{ type: "unknown" }])).toThrow("Unsupported")
  expect(
    sharedAssistantParts([
      { type: "reasoning", text: "hidden" },
      { type: "dynamic-tool", toolName: "read", state: "output-error", errorText: "failed" },
    ])
  ).toEqual([
    {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "",
      state: "output-error",
      input: {},
      errorText: "failed",
    },
  ])
})

it("does not recover absent, mismatched-account, or unaccepted claim intents", async () => {
  const client = fullClient()
  useContext(client)
  await recoverSharedSessionRun({ id: "private" })
  await recoverSharedSessionRun(session)
  await recoverSharedSessionRun({
    ...session,
    collaboration: { ...session.collaboration, endpoint: "https://other.test" },
  })
  jest.requireMock("./runtime-client").resolveCurrentCollabContext.mockResolvedValueOnce(null)
  await recoverSharedSessionRun(session)
  const ref = JSON.stringify([client.baseUrl, "org", "local", "user", session.id])
  await jest.requireMock("@/lib/db/shared-run-journal").putSharedRunJournal(ref, {
    runId: "r",
    leaseId: "",
    token: "secret",
    deviceId: "d",
    baselineMessageIds: [],
  })
  await recoverSharedSessionRun(session)
  expect(client.releaseSessionRunLease).not.toHaveBeenCalled()
})

it("reconciles a successful claim whose response was lost and marks it failed without model replay", async () => {
  const client = fullClient()
  useContext(client)
  client.getActiveSessionRunLease.mockResolvedValue({
    id: "lease",
    runId: "r",
    holderDeviceId: "d",
  } as never)
  const ref = JSON.stringify([client.baseUrl, "org", "local", "user", session.id])
  await jest.requireMock("@/lib/db/shared-run-journal").putSharedRunJournal(ref, {
    runId: "r",
    leaseId: "",
    token: "secret",
    deviceId: "d",
    baselineMessageIds: [],
  })
  await recoverSharedSessionRun(session)
  expect(client.releaseSessionRunLease).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "lease",
    "failed"
  )
})

it("refuses a second run while an older durable claim requires recovery", async () => {
  const client = fullClient()
  const deps = {
    resolveContext: context(client as never),
    getDeviceId: async () => "device",
    setInterval: (() => 1) as never,
  }
  await beginSharedSessionRun(session, "first", { messageId: "m" }, deps)
  await expect(
    beginSharedSessionRun(session, "second", { messageId: "m", requestId: "second-request" }, deps)
  ).rejects.toThrow("requires recovery")
  await recoverSharedSessionRun(session)
  expect(client.claimSessionRunQueue).toHaveBeenCalledTimes(1)
})

it("releases the claim if run start publication fails", async () => {
  const client = fullClient()
  client.appendSessionRunEvent.mockRejectedValueOnce(new Error("publication failed"))
  await expect(
    beginSharedSessionRun(
      session,
      "run",
      { messageId: "m" },
      { resolveContext: context(client as never), getDeviceId: async () => "d" }
    )
  ).rejects.toThrow("publication failed")
  expect(client.releaseSessionRunLease).toHaveBeenCalledWith(
    "org",
    "shared-session",
    "lease",
    "failed"
  )
})

it("serializes racing terminal signals and preserves the first accepted outcome", async () => {
  const client = fullClient()
  await beginSharedSessionRun(
    session,
    "run",
    { messageId: "m" },
    {
      resolveContext: context(client as never),
      getDeviceId: async () => "d",
      setInterval: (() => 1) as never,
    }
  )
  await Promise.all([
    finishSharedSessionRun(session.id, "cancelled"),
    finishSharedSessionRun(session.id, "completed"),
  ])
  expect(
    client.appendSessionRunEvent.mock.calls.filter((call) => call[4].kind !== "run.started")
  ).toEqual([
    expect.arrayContaining([expect.objectContaining({ payload: { status: "cancelled" } })]),
  ])
  await finishSharedSessionRun(session.id, "completed")
})

it("publishes server approval requests from production polling and revalidates permission before delivering", async () => {
  const client = fullClient()
  const remote = {
    id: "approval",
    sessionId: "shared-session",
    runId: "run",
    action: "Read",
    status: "approved",
    risk: "ordinary",
    requestedByUserId: "user",
    expiresAt: Date.now() + 100000,
    createdAt: 1,
    revision: 2,
  }
  Object.assign(client, {
    createSessionApproval: jest.fn().mockResolvedValue(remote),
    listSessionApprovals: jest.fn().mockResolvedValue([remote]),
    resolveSessionApproval: jest.fn(),
  })
  const result = await beginSharedSessionRun(
    session,
    "run",
    { messageId: "m" },
    {
      resolveContext: context(client as never),
      getDeviceId: async () => "d",
      setInterval: (() => 1) as never,
    }
  )
  const { useChatStore } = await import("@/stores/chat")
  useChatStore.getState().openSession(session.id)
  const approval = {
    sessionId: session.id,
    requestId: "local-approval",
    toolUseID: "tool",
    toolName: "Read",
    input: {},
  }
  useChatStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [session.id]: { ...state.sessions[session.id], pendingApprovals: [approval] },
    },
  }))
  const delivery = jest.fn(async (local, decision) => {
    expect(await authorizeSharedSessionApproval(local, decision)).toBe("allow")
  })
  if (result.kind === "acquired") result.setApprovalDecisionHandler(delivery)
  await publishSharedSessionRun(session.id)
  expect(
    (client as typeof client & { createSessionApproval: jest.Mock }).createSessionApproval
  ).toHaveBeenCalled()
  expect(delivery).toHaveBeenCalledWith(approval, "allow")
  expect(client.heartbeatSessionRunLease).toHaveBeenCalled()
  useChatStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [session.id]: { ...state.sessions[session.id], pendingApprovals: [] },
    },
  }))
})

it("keeps private approvals unchanged and refuses shared decisions without an active lease", async () => {
  const approval = {
    sessionId: "private",
    requestId: "r",
    toolUseID: "t",
    toolName: "Read",
    input: {},
  }
  expect(await authorizeSharedSessionApproval(approval, "allow_always")).toBe("allow_always")
  jest.requireMock("@/lib/db/sessions").getSession.mockResolvedValueOnce(session)
  await expect(
    authorizeSharedSessionApproval({ ...approval, sessionId: session.id }, "allow")
  ).rejects.toThrow("no active lease")
})

it("pins claim secrets to the issuing database and aborts on an account switch", async () => {
  const client = fullClient()
  const schema = jest.requireMock("@/lib/db/schema")
  const issuingDb = schema.getDb()
  const journals = jest.requireMock("@/lib/db/shared-run-journal")
  const original = journals.putSharedRunJournal.getMockImplementation()
  journals.putSharedRunJournal.mockImplementationOnce(async (...args: unknown[]) => {
    await original(...args)
    schema.getDb.mockReturnValue({ name: "cognia-account-other" })
  })
  await expect(
    beginSharedSessionRun(
      session,
      "run",
      { messageId: "m" },
      { resolveContext: context(client as never), getDeviceId: async () => "d" }
    )
  ).rejects.toThrow("account changed")
  expect(journals.putSharedRunJournal.mock.calls.at(-1)[2]).toBe(issuingDb)
  expect(client.claimSessionRunQueue).not.toHaveBeenCalled()
})

describe("designated idle executor queue wakeup", () => {
  const start = {
    sessionId: "shared",
    sequence: 1,
    kind: "run.started",
    actor: { id: "run-a" },
    payload: { deviceId: "device-a", executorUserId: "user-a" },
  }
  const complete = {
    sessionId: "shared",
    sequence: 2,
    kind: "run.completed",
    actor: { id: "run-a" },
    payload: {},
  }
  const queued = {
    sessionId: "shared",
    sequence: 3,
    kind: "run.queued",
    actor: { id: "user-b" },
    payload: {},
  }
  const eligibility = (events: unknown[], device = "device-a", user = "user-a") =>
    canAutomaticallyDrainSharedQueue(
      {
        orgId: "org",
        userId: user,
        client: {
          listSessionEvents: jest.fn().mockResolvedValue(events),
        },
      } as never,
      "shared",
      3,
      device
    )

  it("wakes the last successful device for another participant's queue event", async () => {
    expect(await eligibility([start, complete, queued])).toBe(true)
    expect(await eligibility([start, complete, queued], "device-b", "user-b")).toBe(false)
    expect(await eligibility([start, complete, queued], "device-a", "user-b")).toBe(false)
  })
  it("never automatically takes over a failed, unfinished, or replaced executor", async () => {
    expect(await eligibility([start, { ...complete, kind: "run.failed" }, queued])).toBe(false)
    expect(await eligibility([start, { ...complete, kind: "run.paused" }, queued])).toBe(false)
    expect(
      await eligibility([
        start,
        complete,
        { ...queued, kind: "run.started", actor: { id: "run-b" } },
      ])
    ).toBe(false)
    expect(
      await eligibility([start, { ...complete, actor: { id: "different-run" } }, queued])
    ).toBe(false)
  })
  it("rejects incomplete, foreign, or invalid cursor history", async () => {
    expect(await eligibility([start, queued])).toBe(false)
    expect(await eligibility([{ ...start, sessionId: "foreign" }])).toBe(false)
    expect(await eligibility([])).toBe(false)
    expect(await eligibility([start, complete, queued], "")).toBe(false)
  })
})
