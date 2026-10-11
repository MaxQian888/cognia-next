/** @jest-environment jsdom */
const mockManage = jest.fn()
jest.mock("./manage", () => ({ manageMemory: (...args: unknown[]) => mockManage(...args) }))

const mockEnqueue = jest.fn()
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
}))

const mockMirror = jest.fn()
jest.mock("@/lib/memory/api/mirror-memory", () => ({
  applyMirroredMemoryCommand: (...args: unknown[]) => mockMirror(...args),
}))

const mockGate = jest.fn()
jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    hasNoLeakingPii: (text: string) => mockGate(text) ?? actual.hasNoLeakingPii(text),
  }
})

const mockRemoteActive = jest.fn()
const mockSubscribeRemote = jest.fn()
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => mockRemoteActive(),
  subscribeActiveRemoteTransport: (listener: () => void) => mockSubscribeRemote(listener),
}))

const mockSnapshot = jest.fn()
const mockSubscribeSnapshot = jest.fn()
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: () => mockSnapshot(),
  subscribeRuntimeSnapshot: (listener: () => void) => mockSubscribeSnapshot(listener),
}))

/** A paired companion target, as the boot providers publish it. */
function pairWithHost() {
  mockSnapshot.mockReturnValue({
    target: { id: "mobile-companion", kind: "companion", platform: "mobile", hostKind: "desktop" },
  })
}

import {
  isQueuedMemoryResult,
  memoryWriteAuthority,
  runMemoryCommand,
  subscribeMemoryWriteAuthority,
} from "./routed-manage"

beforeEach(() => {
  jest.clearAllMocks()
  mockGate.mockReturnValue(undefined)
  mockRemoteActive.mockReturnValue(false)
  mockSnapshot.mockReturnValue({ target: null })
  mockSubscribeSnapshot.mockReturnValue(() => {})
  mockManage.mockResolvedValue({ ok: true, memoryId: "m1" })
  mockEnqueue.mockResolvedValue({ id: "row" })
  mockMirror.mockResolvedValue({ ok: true })
  mockSubscribeRemote.mockReturnValue(() => {})
})

describe("memoryWriteAuthority", () => {
  it("is local for a host with no target (Tauri, headless)", () => {
    expect(memoryWriteAuthority()).toBe("local")
  })

  it("is local for a standalone phone or browser — there is no host to send to", () => {
    mockSnapshot.mockReturnValue({
      target: { id: "mobile-standalone", kind: "standalone", platform: "mobile" },
    })
    expect(memoryWriteAuthority()).toBe("local")
  })

  it("is the host for a paired phone or a browser paired to a headless host", () => {
    pairWithHost()
    expect(memoryWriteAuthority()).toBe("host")
  })

  it("is the host for a desktop driving a remote host", () => {
    mockRemoteActive.mockReturnValue(true)
    expect(memoryWriteAuthority()).toBe("host")
  })

  it("re-evaluates on remote-host switches and runtime-target changes", () => {
    const listener = jest.fn()
    const stopRemote = jest.fn()
    const stopSnapshot = jest.fn()
    mockSubscribeRemote.mockReturnValueOnce(stopRemote)
    mockSubscribeSnapshot.mockReturnValueOnce(stopSnapshot)
    const stop = subscribeMemoryWriteAuthority(listener)
    mockSubscribeRemote.mock.calls[0][0]()
    mockSubscribeSnapshot.mock.calls[0][0]()
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    expect(stopRemote).toHaveBeenCalled()
    expect(stopSnapshot).toHaveBeenCalled()
  })
})

describe("runMemoryCommand", () => {
  it("runs in-process when this process owns the store", async () => {
    const result = await runMemoryCommand({ kind: "pin", id: "m1", pinned: true })
    expect(result).toEqual({ ok: true, memoryId: "m1" })
    expect(isQueuedMemoryResult(result)).toBe(false)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("queues for the host and moves the mirror on a paired client", async () => {
    pairWithHost()
    const result = await runMemoryCommand(
      { kind: "restore", id: "m1" },
      { label: "Restore memory" }
    )
    expect(isQueuedMemoryResult(result)).toBe(true)
    expect(mockManage).not.toHaveBeenCalled()
    const queued = mockEnqueue.mock.calls[0][0]
    expect(queued).toMatchObject({
      command: "memory_mutate",
      payload: { command: { kind: "restore", id: "m1" } },
      label: "Restore memory",
    })
    expect(queued.payload.operationId).toEqual(queued.idempotencyKey)
    expect(mockMirror).toHaveBeenCalledWith({ kind: "restore", id: "m1" })
  })

  it("redacts text before it travels, so the mirror shows what the host keeps", async () => {
    await runMemoryCommand(
      { kind: "update", id: "m1", patch: { text: "  call me on 555-123-4567  " } },
      { authority: "host" }
    )
    const sent = mockEnqueue.mock.calls[0][0].payload.command
    expect(sent.patch.text).not.toContain("555-123-4567")
    expect(sent.patch.text).toBe(sent.patch.text.trim())
    expect(mockMirror).toHaveBeenCalledWith(sent)
  })

  it("says when the queued text was rewritten, and stays quiet when it was not", async () => {
    await expect(
      runMemoryCommand(
        { kind: "update", id: "m1", patch: { text: "mail bob@example.com" } },
        { authority: "host" }
      )
    ).resolves.toEqual({ ok: true, queued: true, piiRedacted: true })
    await expect(
      runMemoryCommand(
        { kind: "update", id: "m1", patch: { text: "likes tea" } },
        { authority: "host" }
      )
    ).resolves.toEqual({ ok: true, queued: true })
  })

  it("refuses text the gate would block without queueing anything", async () => {
    mockGate.mockReturnValueOnce(false)
    await expect(
      runMemoryCommand(
        { kind: "create", text: "still sensitive", type: "semantic", importance: 5, tags: [] },
        { authority: "host" }
      )
    ).resolves.toEqual({ ok: false, reason: "pii_blocked" })
    mockGate.mockReturnValueOnce(false)
    await expect(
      runMemoryCommand(
        { kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "merge", mergedText: "x" },
        { authority: "host" }
      )
    ).resolves.toEqual({ ok: false, reason: "pii_blocked" })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockMirror).not.toHaveBeenCalled()
  })

  it("surfaces a queue failure to the caller", async () => {
    mockEnqueue.mockRejectedValueOnce(new Error("no runtime target"))
    await expect(
      runMemoryCommand({ kind: "delete", id: "m1" }, { authority: "host" })
    ).rejects.toThrow("no runtime target")
    expect(mockMirror).not.toHaveBeenCalled()
  })
})
