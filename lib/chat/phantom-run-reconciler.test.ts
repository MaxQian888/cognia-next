/** @jest-environment jsdom */

import type { UIMessage } from "ai"

import {
  PHANTOM_RUN_APPROVAL_REASON,
  installPhantomRunGuard,
  reconcileSessionRun,
  type PhantomRunDeps,
  type PhantomRunStore,
} from "./phantom-run-reconciler"
import { useChatStore } from "@/stores/chat/chat-store"
import type { PendingApproval } from "@cognia/agent-config-types"

const store = useChatStore as unknown as PhantomRunStore

const openTurn: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "tool-Read", toolCallId: "t1", state: "output-available", input: {}, output: "x" },
      { type: "tool-Read", toolCallId: "t2", state: "input-available", input: {} },
    ],
  },
] as UIMessage[]

function deps(overrides: Partial<PhantomRunDeps> = {}): PhantomRunDeps & {
  commitMessages: jest.Mock
} {
  return {
    hasLocalRunHandle: () => false,
    probeHostRun: async () => null,
    commitMessages: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as PhantomRunDeps & { commitMessages: jest.Mock }
}

function restoreStreaming(sessionId = "s1") {
  const chat = useChatStore.getState()
  chat.replaceSessionMessages(sessionId, openTurn)
  chat.setSessionStatus(sessionId, "streaming")
}

const slice = (sessionId = "s1") => useChatStore.getState().sessions[sessionId]!

beforeEach(() => {
  useChatStore.getState().clear()
})

describe("reconcileSessionRun", () => {
  it("settles a restored streaming session with no live run: idle, tools closed, persisted", async () => {
    restoreStreaming()
    const d = deps()
    await expect(reconcileSessionRun("s1", d, store)).resolves.toBe("settled")
    expect(slice().status).toBe("idle")
    expect(slice().runTiming.startedAt).toBeNull()
    const parts = slice().messages[1].parts as Array<{ state: string }>
    expect(parts.map((part) => part.state)).toEqual(["output-available", "output-error"])
    expect(d.commitMessages).toHaveBeenCalledWith("s1", [slice().messages[1]])
  })

  it("settles a session whose Host reports the run unknown", async () => {
    restoreStreaming()
    await expect(
      reconcileSessionRun("s1", deps({ probeHostRun: async () => "unknown" }), store)
    ).resolves.toBe("settled")
    expect(slice().status).toBe("idle")
  })

  it("settles a session whose Host reports the run gone, and when the probe throws", async () => {
    restoreStreaming()
    await reconcileSessionRun("s1", deps({ probeHostRun: async () => "gone" }), store)
    expect(slice().status).toBe("idle")
    restoreStreaming("s2")
    await reconcileSessionRun(
      "s2",
      deps({
        probeHostRun: async () => {
          throw new Error("offline")
        },
      }),
      store
    )
    expect(slice("s2").status).toBe("idle")
  })

  it("keeps a Host run that is still alive running, untouched", async () => {
    restoreStreaming()
    const startedAt = slice().runTiming.startedAt
    const d = deps({ probeHostRun: async () => "alive" })
    await expect(reconcileSessionRun("s1", d, store)).resolves.toBe("live")
    expect(slice().status).toBe("streaming")
    expect(slice().runTiming.startedAt).toBe(startedAt)
    expect((slice().messages[1].parts[1] as { state: string }).state).toBe("input-available")
    expect(d.commitMessages).not.toHaveBeenCalled()
  })

  it("never second-guesses a turn this realm holds a handle for", async () => {
    restoreStreaming()
    const probe = jest.fn()
    await expect(
      reconcileSessionRun("s1", deps({ hasLocalRunHandle: () => true, probeHostRun: probe }), store)
    ).resolves.toBe("live")
    expect(probe).not.toHaveBeenCalled()
    expect(slice().status).toBe("streaming")
  })

  it("keeps a session waiting on an approval that is still answerable here", async () => {
    useChatStore.getState().pushApproval({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      input: {},
    } as unknown as PendingApproval)
    await expect(reconcileSessionRun("s1", deps(), store)).resolves.toBe("live")
    expect(slice().status).toBe("awaiting_approval")
  })

  it("does not settle when the run gained a handle while the Host was being asked", async () => {
    restoreStreaming()
    let live = false
    const d = deps({
      hasLocalRunHandle: () => live,
      probeHostRun: async () => {
        live = true
        return "unknown"
      },
    })
    await expect(reconcileSessionRun("s1", d, store)).resolves.toBe("live")
    expect(slice().status).toBe("streaming")
  })

  it("leaves a NEW turn that started after the observed episode for its own check", async () => {
    restoreStreaming()
    const observed = slice().runTiming.startedAt
    useChatStore.getState().setSessionStatus("s1", "idle")
    useChatStore.getState().setSessionStatus("s1", "streaming", { startedAt: (observed ?? 0) - 5 })
    await expect(reconcileSessionRun("s1", deps(), store, observed)).resolves.toBe("not-busy")
    expect(slice().status).toBe("streaming")
  })

  it("is a no-op for an idle session", async () => {
    useChatStore.getState().replaceSessionMessages("s1", openTurn)
    const d = deps()
    await expect(reconcileSessionRun("s1", d, store)).resolves.toBe("not-busy")
    expect(d.commitMessages).not.toHaveBeenCalled()
  })

  it("still settles when the transcript write fails", async () => {
    restoreStreaming()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const d = deps()
    d.commitMessages.mockRejectedValueOnce(new Error("disk"))
    await reconcileSessionRun("s1", d, store)
    expect(slice().status).toBe("idle")
    warn.mockRestore()
  })
})

describe("installPhantomRunGuard", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  async function settleTimers(ms: number) {
    await jest.advanceTimersByTimeAsync(ms)
  }

  it("settles a session that turns busy with nothing running it, after the grace", async () => {
    const dispose = installPhantomRunGuard({ deps: deps(), store, graceMs: 1_000 })
    restoreStreaming()
    await settleTimers(999)
    expect(slice().status).toBe("streaming")
    await settleTimers(1)
    expect(slice().status).toBe("idle")
    dispose()
  })

  it("checks sessions that were already busy when it was installed", async () => {
    restoreStreaming()
    const dispose = installPhantomRunGuard({ deps: deps(), store, graceMs: 10 })
    await settleTimers(10)
    expect(slice().status).toBe("idle")
    dispose()
  })

  it("leaves a live Host run streaming, and an approval pause is not a new episode", async () => {
    const probe = jest.fn(async () => "alive" as const)
    const dispose = installPhantomRunGuard({
      deps: deps({ probeHostRun: probe }),
      store,
      graceMs: 10,
    })
    restoreStreaming()
    await settleTimers(10)
    expect(slice().status).toBe("streaming")
    expect(probe).toHaveBeenCalledTimes(1)
    useChatStore.getState().pushApproval({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      input: {},
    } as unknown as PendingApproval)
    useChatStore.getState().clearApproval("r1", "s1")
    await settleTimers(10)
    expect(probe).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("treats an already-interrupted approval as no handle, and settles", async () => {
    const dispose = installPhantomRunGuard({
      deps: deps({ hasLocalRunHandle: () => false }),
      store,
      graceMs: 10,
    })
    // An approval already marked interrupted is not a live handle.
    useChatStore.getState().pushApproval({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      input: {},
    } as unknown as PendingApproval)
    useChatStore.getState().markApprovalInterrupted("r1", "s1", "x")
    useChatStore.getState().setSessionStatus("s1", "awaiting_approval")
    await settleTimers(10)
    expect(slice().status).toBe("idle")
    expect(slice().pendingApprovals[0]?.status).toBe("interrupted")
    expect(PHANTOM_RUN_APPROVAL_REASON).toBeTruthy()
    dispose()
  })

  it("stops checking once disposed", async () => {
    const dispose = installPhantomRunGuard({ deps: deps(), store, graceMs: 10 })
    restoreStreaming()
    dispose()
    await settleTimers(50)
    expect(slice().status).toBe("streaming")
  })
})
