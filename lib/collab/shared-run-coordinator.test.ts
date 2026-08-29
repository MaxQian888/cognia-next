import { CollabError } from "./client"
import {
  beginSharedSessionRun,
  finishSharedSessionRun,
  resetSharedRunCoordinatorForTesting,
} from "./shared-run-coordinator"

const session = {
  id: "local-session",
  collaboration: {
    orgId: "org",
    workspaceId: "workspace",
    sessionId: "shared-session",
    status: "active" as const,
    lastSequence: 0,
    policyRevision: 1,
  },
}

function context(client: Record<string, jest.Mock>) {
  return async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
}

afterEach(() => resetSharedRunCoordinatorForTesting())

it("acquires a bound lease, publishes lifecycle events, and releases it", async () => {
  const client = {
    acquireSessionRunLease: jest.fn().mockResolvedValue({
      lease: { id: "lease" },
      token: "secret",
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
  expect(client.appendSessionEvent).toHaveBeenCalledWith(
    "org",
    "shared-session",
    expect.objectContaining({ kind: "message.created" })
  )
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
    acquireSessionRunLease: jest.fn().mockRejectedValue(new CollabError(409, "conflict")),
    enqueueSessionRunInput: jest.fn().mockResolvedValue({ id: "queued" }),
  }
  const result = await beginSharedSessionRun(
    session,
    "run",
    { content: "hello" },
    {
      resolveContext: context(client),
      getDeviceId: async () => "device",
    }
  )
  expect(result).toEqual({ kind: "queued", queueItemId: "queued" })
  expect(client.enqueueSessionRunInput).toHaveBeenCalledWith("org", "shared-session", {
    payload: { content: "hello" },
    operationId: "run-queue:run",
  })
})

it("fails closed when a shared session has no authenticated collaboration context", async () => {
  await expect(
    beginSharedSessionRun(session, "run", {}, { resolveContext: async () => null })
  ).rejects.toThrow("connection is unavailable")
})
