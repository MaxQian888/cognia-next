import { createLarkRunPresentationDriver } from "./lark-driver"
import type { RunProjectionSnapshot } from "@/types/execution/run"

const topicTarget = {
  adapterId: "lark-1",
  conversationKey: "opaque-topic-key",
  sourceMessageId: "om-anchor",
  deliveryTarget: {
    address: {
      conversationKey: "opaque-topic-key",
      platform: "lark" as const,
      adapterId: "lark-1",
      scopeKind: "thread" as const,
      containerId: "chat-1",
      topicId: "thread-1",
    },
    conversationRef: {
      platform: "lark" as const,
      adapterId: "lark-1",
      channelId: "chat-1",
      threadId: "thread-1",
      threadRootMessageId: "om-anchor",
    },
    sourceMessageId: "om-anchor",
    refreshedAt: 1,
  },
}

const snapshot = (
  revision: number,
  status: RunProjectionSnapshot["status"] = "running"
): RunProjectionSnapshot => ({
  runId: "run-1",
  kind: "workflow",
  title: "Release workflow",
  status,
  revision,
  startedAt: 1,
  updatedAt: revision + 1,
  progress: { completed: 1, total: 2, ratio: 0.5, trustworthy: true },
  activeSteps: [{ id: "build", title: "Build", status: "in_progress" }],
  recentSteps: [],
  pendingSteps: [],
  pendingStepCount: 1,
  connectorQueueDepth: 2,
  elapsedMs: 1_000,
  artifacts: [],
  allowedActions: status === "running" ? ["stop", "pause"] : [],
})

describe("Lark run presentation driver", () => {
  it("creates, sends, and updates a CardKit 2.0 entity with monotonic sequences", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const driver = createLarkRunPresentationDriver(async (method, path, body) => {
      calls.push({ method, path, body })
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-1" } }
      if (path.startsWith("/im/v1/messages")) return { data: { message_id: "msg-1" } }
      return { data: {} }
    })

    const ref = await driver.open(topicTarget, snapshot(1))
    const updated = await driver.update(ref, snapshot(2))
    await driver.finish(updated, snapshot(3, "completed"))

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/cardkit/v1/cards"],
      ["POST", "/im/v1/messages/om-anchor/reply"],
      ["PUT", "/cardkit/v1/cards/card-1/elements/run_summary/content"],
      ["PUT", "/cardkit/v1/cards/card-1/elements/run_actions"],
      ["PUT", "/cardkit/v1/cards/card-1"],
    ])
    expect(calls[1].body).toEqual(
      expect.objectContaining({ reply_in_thread: true, uuid: expect.any(String) })
    )
    expect(calls[0].body).toEqual(expect.objectContaining({ uuid: expect.any(String) }))
    expect((calls[2].body as { sequence: number }).sequence).toBe(1)
    expect((calls[3].body as { sequence: number }).sequence).toBe(2)
    expect((calls[4].body as { sequence: number }).sequence).toBe(3)
    expect(JSON.stringify(calls[2].body)).toContain("Queue depth: 2")
    expect(ref.platformMessageId).toBe("msg-1")
    expect(updated.opaqueState?.lastAcknowledgedSequence).toBe(2)
    expect(updated.opaqueState?.elementIds).toEqual({
      summary: "run_summary",
      actions: "run_actions",
    })
  })

  it("trims oversized card bodies below the CardKit 30KB limit", async () => {
    let createdData = ""
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") {
        createdData = (body as { data: string }).data
        return { data: { card_id: "card-1" } }
      }
      return { data: { message_id: "msg-1" } }
    })
    const large = snapshot(1)
    large.summary = "x".repeat(50_000)

    await driver.open(topicTarget, large)

    expect(new TextEncoder().encode(createdData).byteLength).toBeLessThanOrEqual(30_000)
    expect(createdData).toContain("truncated")
  })

  it("uses full replacement when the action component structure changes", async () => {
    const paths: string[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      paths.push(path)
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-structure" } }
      if (path.startsWith("/im/v1/messages")) return { data: { message_id: "msg-structure" } }
      return { data: {} }
    })
    const opened = await driver.open(topicTarget, snapshot(1))

    await driver.update(opened, { ...snapshot(2), allowedActions: [] })

    expect(paths.at(-1)).toBe("/cardkit/v1/cards/card-structure")
    expect(paths.filter((path) => path.includes("/elements/"))).toHaveLength(0)
  })

  it("checkpoints the card entity and resumes without creating a duplicate", async () => {
    const calls: string[] = []
    const checkpoints: Array<{ opaqueState?: Record<string, unknown> }> = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      calls.push(path)
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-checkpoint" } }
      return { data: { message_id: "message-checkpoint" } }
    })
    const first = await driver.open(topicTarget, snapshot(1), {
      checkpoint: async (ref) => {
        checkpoints.push(ref)
      },
    })

    await driver.open(topicTarget, snapshot(1), { previousRef: first })

    expect(calls.filter((path) => path === "/cardkit/v1/cards")).toHaveLength(1)
    expect(checkpoints[0]?.opaqueState?.pendingCreate).toEqual(
      expect.objectContaining({ uuid: expect.any(String) })
    )
    expect(checkpoints.some((ref) => ref.opaqueState?.cardId === "card-checkpoint")).toBe(true)
  })

  it("reuses the same deterministic creation UUID after an ambiguous create response", async () => {
    const createUuids: string[] = []
    let first = true
    let pendingRef: { opaqueState?: Record<string, unknown> } | undefined
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") {
        createUuids.push((body as { uuid: string }).uuid)
        if (first) {
          first = false
          throw new Error("connection reset after create")
        }
        return { data: { card_id: "card-reconciled" } }
      }
      return { data: { message_id: "message-reconciled" } }
    })

    await expect(
      driver.open(topicTarget, snapshot(1), {
        checkpoint: async (ref) => {
          pendingRef = ref
        },
      })
    ).rejects.toThrow("connection reset")
    await driver.open(topicTarget, snapshot(1), {
      previousRef: pendingRef,
      checkpoint: async () => undefined,
    })

    expect(createUuids).toHaveLength(2)
    expect(createUuids[1]).toBe(createUuids[0])
  })

  it("checkpoints and reuses the same sequence and UUID across an ambiguous retry", async () => {
    const updates: Array<{ sequence: number; uuid: string }> = []
    const checkpoints: Array<Record<string, unknown>> = []
    let updateAttempt = 0
    const driver = createLarkRunPresentationDriver(
      async (_method, path, body) => {
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-retry" } }
        if (path.includes("/elements/")) {
          updates.push(body as { sequence: number; uuid: string })
          updateAttempt += 1
          if (updateAttempt === 1) throw new Error("connection reset after send")
        }
        return { data: { message_id: "msg-retry" } }
      },
      { sleep: async () => undefined }
    )
    const opened = await driver.open(topicTarget, snapshot(1))

    const updated = await driver.update(opened, snapshot(2), {
      checkpoint: async (ref) => {
        checkpoints.push(ref.opaqueState ?? {})
      },
    })

    expect(updates).toHaveLength(3)
    expect(updates[1]).toEqual(updates[0])
    expect(checkpoints[0]?.pendingMutation).toEqual(
      expect.objectContaining({ sequence: 1, uuid: updates[0].uuid, operation: "stream_summary" })
    )
    expect(updated.opaqueState?.pendingMutation).toBeUndefined()
  })

  it("retries interaction conflict 200810 before degrading", async () => {
    let conflicts = 0
    const sleep = jest.fn(async () => undefined)
    const driver = createLarkRunPresentationDriver(
      async (_method, path) => {
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-conflict" } }
        if (path.includes("/elements/") && conflicts++ === 0) throw { code: 200810 }
        return { data: { message_id: "msg-conflict" } }
      },
      { sleep }
    )
    const opened = await driver.open(topicTarget, snapshot(1))

    await expect(driver.update(opened, snapshot(2))).resolves.toBeDefined()
    expect(sleep).toHaveBeenCalledWith(150)
  })

  it("keeps mutation UUIDs unique for long execution run identifiers", async () => {
    const uuids: string[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-long" } }
      if (path.startsWith("/im/v1/messages")) return { data: { message_id: "msg-long" } }
      uuids.push((body as { uuid: string }).uuid)
      return { data: {} }
    })
    const long = snapshot(1)
    long.runId = `execution:agent:${"session".repeat(20)}:${"message".repeat(20)}`
    const opened = await driver.open(topicTarget, long)
    const next = { ...long, revision: 2 }

    await driver.update(opened, next)

    expect(new Set(uuids).size).toBe(2)
    expect(uuids.every((uuid) => uuid.length <= 64)).toBe(true)
  })

  it("declares follow-up bubbles unsupported until Feishu exposes a durable server API", () => {
    const driver = createLarkRunPresentationDriver(async () => ({ data: {} }))
    expect(driver.capabilities.followUpBubbles).toBe(false)
  })
})
