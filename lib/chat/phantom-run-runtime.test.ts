/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { waitFor } from "@testing-library/react"

import {
  createEmptyHostStateSession,
  sessionStateChannel,
  type HostStateTurnStatus,
} from "@cognia/agent-config-types/host-state"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { acquireChatLease, __resetChatLeasesForTesting } from "@/lib/execution/chat-lease"
import { ExecutionBroker, __resetExecutionBrokerForTesting } from "@/lib/execution/broker"
import { listMessages } from "@/lib/db/messages"
import { useChatStore } from "@/stores/chat/chat-store"

import {
  createPhantomRunDeps,
  installDefaultPhantomRunGuard,
  probeHostStateRun,
} from "./phantom-run-runtime"

jest.mock("@/lib/claude/ipc", () => ({
  interruptSession: jest.fn().mockResolvedValue(undefined),
}))

const TARGET = "target-1"

async function putHostTurn(sessionId: string, turn: HostStateTurnStatus) {
  const channel = sessionStateChannel(TARGET, sessionId)
  await getDb().hostStateChannels.put({
    channel,
    hostId: "host-1",
    hostGeneration: 1,
    hostSeq: 1,
    revision: 1,
    digest: "d",
    state: { ...createEmptyHostStateSession(channel, sessionId), turn },
    updatedAt: 1,
  })
}

async function putPendingIntent(sessionId: string, kind: string, status = "pending") {
  const channel = sessionStateChannel(TARGET, sessionId)
  const row: MobileOutboundJobRow = {
    id: `${sessionId}-${kind}`,
    accountId: "acct",
    targetId: TARGET,
    command: "host_state_submit",
    payload: { actions: [{ action: { kind } }] },
    status: status as MobileOutboundJobRow["status"],
    attempts: 0,
    createdAt: 1,
    nextAttemptAt: 1,
    idempotencyKey: `${sessionId}-${kind}`,
    protocol: "host-state",
    channel,
  }
  await getDb().mobileOutboundQueue.put(row)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetChatLeasesForTesting()
  __resetExecutionBrokerForTesting(new ExecutionBroker({ limits: { "ai-turn": 3 } }))
  useChatStore.getState().clear()
})

afterEach(() => {
  __resetChatLeasesForTesting()
  __resetExecutionBrokerForTesting()
})

describe("probeHostStateRun", () => {
  it("is null for a session no Host owns", async () => {
    await expect(probeHostStateRun("local")).resolves.toBeNull()
  })

  it.each(["queued", "running", "awaiting-decision", "stopping"] as const)(
    "reports a Host turn that is %s as alive",
    async (turn) => {
      await putHostTurn("s1", turn)
      await expect(probeHostStateRun("s1")).resolves.toBe("alive")
    }
  )

  it.each(["idle", "completed", "aborted", "retryable-error", "fatal-error"] as const)(
    "reports a Host turn that is %s as gone",
    async (turn) => {
      await putHostTurn("s1", turn)
      await expect(probeHostStateRun("s1")).resolves.toBe("gone")
    }
  )

  it("counts this device's unconfirmed send as a turn the Host will run", async () => {
    await putHostTurn("s1", "idle")
    await putPendingIntent("s1", "message.enqueue")
    await expect(probeHostStateRun("s1")).resolves.toBe("alive")
  })

  it("does not count a pending draft sync or abort as a run", async () => {
    await putHostTurn("s1", "idle")
    await putPendingIntent("s1", "draft.replace")
    await putPendingIntent("s1", "turn.abort")
    await expect(probeHostStateRun("s1")).resolves.toBe("gone")
    await putPendingIntent("s2", "draft.replace")
    await expect(probeHostStateRun("s2")).resolves.toBe("unknown")
  })

  it("ignores intents that already left the outbox", async () => {
    await putHostTurn("s1", "idle")
    await putPendingIntent("s1", "message.enqueue", "sent")
    await expect(probeHostStateRun("s1")).resolves.toBe("gone")
  })
})

describe("createPhantomRunDeps", () => {
  it("reads a held broker lease as a live local run", async () => {
    const deps = await createPhantomRunDeps()
    expect(deps.hasLocalRunHandle("s1")).toBe(false)
    await acquireChatLease({ sessionId: "s1", label: "chat" })
    expect(deps.hasLocalRunHandle("s1")).toBe(true)
  })

  it("writes closures as a partial transcript write", async () => {
    const deps = await createPhantomRunDeps()
    await deps.commitMessages("s1", [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ])
    await expect(listMessages("s1")).resolves.toEqual([
      expect.objectContaining({ id: "a1", role: "assistant" }),
    ])
    await expect(deps.commitMessages("s1", [])).resolves.toBeUndefined()
  })
})

describe("installDefaultPhantomRunGuard", () => {
  it("settles a session that went busy with nothing running it", async () => {
    const dispose = installDefaultPhantomRunGuard({ graceMs: 10 })
    // Flipped before or after the async install: the install scan and the
    // subscription both see it.
    useChatStore.getState().setSessionStatus("phantom", "streaming")
    await waitFor(() => expect(useChatStore.getState().sessions.phantom?.status).toBe("idle"))
    dispose()
  })

  it("can be disposed before it finished installing", async () => {
    const dispose = installDefaultPhantomRunGuard()
    dispose()
    useChatStore.getState().setSessionStatus("s1", "streaming")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useChatStore.getState().sessions.s1?.status).toBe("streaming")
  })
})
