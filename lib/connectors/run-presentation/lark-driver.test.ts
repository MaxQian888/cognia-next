import { createLarkRunPresentationDriver, buildLarkRunFallbackSegment } from "./lark-driver"
import { __resetLarkCotSupportCacheForTesting } from "./lark-cot"
import type { LarkCotEvent } from "./lark-cot"
import type {
  RunPresentationRef,
  RunPresentationTarget,
  RunProjectionSnapshot,
} from "@/types/execution/run"

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

const directTarget = {
  ...topicTarget,
  conversationKey: "opaque-direct-key",
  sourceMessageId: "om-user-anchor",
  deliveryTarget: {
    ...topicTarget.deliveryTarget,
    address: {
      ...topicTarget.deliveryTarget.address,
      conversationKey: "opaque-direct-key",
      scopeKind: "private" as const,
      topicId: undefined,
    },
    conversationRef: {
      platform: "lark" as const,
      adapterId: "lark-1",
      channelId: "chat-1",
    },
    sourceMessageId: "om-user-anchor",
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
  activities: [
    {
      id: "tool:read",
      kind: "tool",
      category: "read",
      status: "completed",
      label: "Read",
      target: { kind: "workspace_path", label: "src/release.ts" },
      startedAt: 10,
      endedAt: 20,
    },
    {
      id: "step:build",
      kind: "step",
      category: "status",
      status: status === "completed" ? "completed" : "running",
      label: "Build",
      startedAt: 21,
      ...(status === "completed" ? { endedAt: 30 } : {}),
    },
  ],
  activityCount: 4,
  omittedActivityCount: 2,
})

describe("Lark run presentation driver", () => {
  it("refreshes thread text controls when a run waits for authorization", async () => {
    const paths: string[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      paths.push(path)
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-controls" } }
      return { data: { message_id: "message-controls" } }
    })
    const opened = await driver.open(topicTarget, snapshot(1))
    const waiting = await driver.update(opened, {
      ...snapshot(2, "waiting"),
      allowedActions: ["approve", "deny"],
      pendingInterrupt: { id: "permission-1", title: "Permission" },
    })
    expect(waiting.opaqueState?.followUpControl).toMatchObject({
      platformMessageId: "message-controls",
      revision: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ action: "approve", localizedContent: "批准" }),
        expect.objectContaining({ action: "deny", localizedContent: "拒绝" }),
      ]),
    })
    expect(paths.some((path) => path.endsWith("/push_follow_up"))).toBe(false)
  })

  it("creates, sends, and updates a CardKit 2.0 entity with monotonic sequences", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const driver = createLarkRunPresentationDriver(async (method, path, body) => {
      calls.push({ method, path, body })
      if (path === "/im/v1/message_cot?receive_id_type=chat_id") {
        return { data: { cot_id: "cot-1", message_id: "om-cot-1" } }
      }
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-1" } }
      if (path.startsWith("/im/v1/messages")) return { data: { message_id: "msg-1" } }
      return { data: {} }
    })

    const ref = await driver.open(topicTarget, snapshot(1))
    const updated = await driver.update(ref, snapshot(2))
    await driver.finish(updated, snapshot(3, "completed"))

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/im/v1/message_cot?receive_id_type=chat_id"],
      ["PUT", "/im/v1/message_cot"],
      ["POST", "/cardkit/v1/cards"],
      ["POST", "/im/v1/messages/om-anchor/reply"],
      ["PUT", "/cardkit/v1/cards/card-1/elements/run_summary/content"],
      ["PUT", "/cardkit/v1/cards/card-1/elements/run_actions"],
      ["PUT", "/im/v1/message_cot"],
      ["PUT", "/cardkit/v1/cards/card-1"],
    ])
    expect(calls[1].body).toEqual(
      expect.objectContaining({ cot_id: "cot-1", message_id: "om-cot-1" })
    )
    expect(calls[3].body).toEqual(
      expect.objectContaining({ reply_in_thread: true, uuid: expect.any(String) })
    )
    expect(calls[2].body).toEqual(expect.objectContaining({ uuid: expect.any(String) }))
    expect((calls[4].body as { sequence: number }).sequence).toBe(1)
    expect((calls[5].body as { sequence: number }).sequence).toBe(2)
    expect((calls[7].body as { sequence: number }).sequence).toBe(3)
    // With a live COT the timeline rows live in that message; the card keeps
    // the summary element (same id) plus a pointer line.
    expect(JSON.stringify(calls[4].body)).toContain("Process shown in the thinking timeline above")
    expect(JSON.stringify(calls[4].body)).not.toContain("│")
    expect(JSON.stringify(calls[1].body)).toContain("src/release.ts")
    expect(typeof (calls[5].body as { element: unknown }).element).toBe("string")
    expect(JSON.parse((calls[5].body as { element: string }).element)).toEqual(
      expect.objectContaining({
        tag: "column_set",
        element_id: "run_actions",
        columns: expect.arrayContaining([
          expect.objectContaining({
            tag: "column",
            elements: [expect.objectContaining({ tag: "button" })],
          }),
        ]),
      })
    )
    expect(JSON.stringify(calls[2].body)).not.toContain('\\"tag\\":\\"action\\"')
    const initialCard = JSON.parse((calls[2].body as { data: string }).data)
    expect(initialCard.body.elements[0]).toMatchObject({
      tag: "markdown",
      element_id: "run_summary",
    })
    expect(JSON.stringify(initialCard)).not.toContain("collapsible_panel")
    const finalCard = JSON.parse((calls[7].body as { card: { data: string } }).card.data) as {
      config: { streaming_mode: boolean }
    }
    expect(finalCard.config.streaming_mode).toBe(false)
    expect(ref.platformMessageId).toBe("msg-1")
    expect(updated.opaqueState?.lastAcknowledgedSequence).toBe(2)
    expect(updated.opaqueState?.elementIds).toEqual({
      summary: "run_summary",
      actions: "run_actions",
    })
    expect(updated.opaqueState?.cot).toEqual(
      expect.objectContaining({ status: "active", cotId: "cot-1", messageId: "om-cot-1" })
    )
    expect(updated.opaqueState?.presentedCot).toBe(true)
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
    large.activities = Array.from({ length: 300 }, (_, index) => ({
      id: `activity-${index}`,
      kind: "step" as const,
      category: "status" as const,
      status: "completed" as const,
      label: `${index}-${"x".repeat(500)}`,
      startedAt: index,
      endedAt: index,
    }))
    large.activityCount = 300
    large.omittedActivityCount = 288

    await driver.open(topicTarget, large)

    expect(new TextEncoder().encode(createdData).byteLength).toBeLessThanOrEqual(30_000)
    expect(createdData).toContain("288 earlier activities hidden")
    expect(createdData).not.toContain("299-")
  })

  it("never places raw run ids or caller-provided URLs in CardKit callbacks", async () => {
    let createdData = ""
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") {
        createdData = (body as { data: string }).data
        return { data: { card_id: "card-safe" } }
      }
      return { data: { message_id: "message-safe" } }
    })

    await driver.open(topicTarget, {
      ...snapshot(1),
      runId: "13800138000",
      detailsUrl: "https://example.com/private?token=secret",
      pendingInterrupt: {
        id: "13800138000",
        title: "Approve private operation",
      },
      allowedActions: ["stop", "open_details"],
    })

    expect(createdData).not.toContain("13800138000")
    expect(createdData).not.toContain("Approve private operation")
    expect(createdData).not.toContain("token=secret")
    expect(createdData).toContain("opaque-")
    expect(createdData).not.toContain("/agent-runs?run=")
  })

  it("opens details on the configured web client and ignores snapshot URLs", async () => {
    let createdData = ""
    const driver = createLarkRunPresentationDriver(
      async (_method, path, body) => {
        if (path === "/cardkit/v1/cards") {
          createdData = (body as { data: string }).data
          return { data: { card_id: "card-link" } }
        }
        return { data: { message_id: "message-link" } }
      },
      { webEntryBaseUrl: "http://127.0.0.1:3000" }
    )
    await driver.open(topicTarget, {
      ...snapshot(1),
      detailsUrl: "https://untrusted.example/?token=secret",
      allowedActions: ["open_details"],
    })
    expect(createdData).toContain("http://127.0.0.1:3000/agent-runs?run=run-1")
    expect(createdData).not.toContain("untrusted.example")
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
    expect(
      checkpoints.find((ref) => ref.opaqueState?.pendingCreate)?.opaqueState?.pendingCreate
    ).toEqual(expect.objectContaining({ uuid: expect.any(String) }))
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
    expect(checkpoints.find((c) => c.pendingMutation)?.pendingMutation).toEqual(
      expect.objectContaining({ sequence: 1, uuid: updates[0].uuid, operation: "stream_summary" })
    )
    expect(updated.opaqueState?.pendingMutation).toBeUndefined()
  })

  it("discards pre-safety persisted mutations instead of replaying their body", async () => {
    const mutationBodies: unknown[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-legacy" } }
      if (path.includes("/elements/")) mutationBodies.push(body)
      return { data: { message_id: "msg-legacy" } }
    })
    const opened = await driver.open(topicTarget, snapshot(1))
    const poisoned: RunPresentationRef = {
      ...opened,
      opaqueState: {
        ...opened.opaqueState,
        pendingMutation: {
          sequence: 1,
          uuid: "00000000-0000-5000-a000-000000000001",
          operation: "stream_summary",
          method: "PUT",
          path: "/cardkit/v1/cards/card-legacy/elements/run_summary/content",
          body: {
            content: "curl https://example.com/private?token=secret user@example.com",
            sequence: 1,
            uuid: "00000000-0000-5000-a000-000000000001",
          },
        },
      },
    }

    await driver.update(poisoned, snapshot(2))

    const payload = JSON.stringify(mutationBodies)
    expect(payload).not.toContain("curl")
    expect(payload).not.toContain("token=secret")
    expect(payload).not.toContain("user@example.com")
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
    const driver = createLarkRunPresentationDriver(
      async (_method, path, body) => {
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-long" } }
        if (path.startsWith("/im/v1/messages")) return { data: { message_id: "msg-long" } }
        uuids.push((body as { uuid: string }).uuid)
        return { data: {} }
      },
      // This test counts every non-card/non-message body for its uuid — COT
      // payloads have none, so it keeps the feature off.
      { cot: false }
    )
    const long = snapshot(1)
    long.runId = `execution:agent:${"session".repeat(20)}:${"message".repeat(20)}`
    const opened = await driver.open(topicTarget, long)
    const next = { ...long, revision: 2 }

    await driver.update(opened, next)

    expect(new Set(uuids).size).toBe(2)
    expect(uuids.every((uuid) => uuid.length <= 64)).toBe(true)
  })

  it("pushes localized follow-up controls only for a direct-chat progress message", async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      calls.push({ path, body: body as { data?: string } })
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-direct" } }
      if (path === "/im/v1/messages?receive_id_type=chat_id") {
        return { data: { message_id: "om-bot-progress" } }
      }
      return { data: {} }
    })

    const opened = await driver.open(directTarget, snapshot(1))
    const followUp = calls.find((call) => call.path.endsWith("/push_follow_up"))

    expect(followUp?.path).toBe("/im/v1/messages/om-bot-progress/push_follow_up")
    expect(followUp?.body).toEqual({
      follow_ups: expect.arrayContaining([
        expect.objectContaining({
          content: "Stop",
          i18n_contents: expect.arrayContaining([
            { language: "zh_cn", content: "停止" },
            { language: "en_us", content: "Stop" },
          ]),
        }),
        expect.objectContaining({ content: "View status" }),
      ]),
    })
    expect(opened.opaqueState?.followUpControl).toEqual(
      expect.objectContaining({
        platformMessageId: "om-bot-progress",
        items: expect.arrayContaining([expect.objectContaining({ action: "stop" })]),
      })
    )
  })

  it("does not call the P2P-only follow-up API for group topics", async () => {
    const paths: string[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      paths.push(path)
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-topic" } }
      return { data: { message_id: "om-topic-progress" } }
    })

    await driver.open(topicTarget, snapshot(1))
    expect(paths.some((path) => path.endsWith("/push_follow_up"))).toBe(false)
  })

  it("treats 230008 as reconciliation evidence for an ambiguous follow-up retry", async () => {
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-existing" } }
      if (path === "/im/v1/messages?receive_id_type=chat_id") {
        return { data: { message_id: "om-existing" } }
      }
      if (path.endsWith("/push_follow_up")) throw { code: 230008 }
      return { data: {} }
    })

    await expect(driver.open(directTarget, snapshot(1))).resolves.toEqual(
      expect.objectContaining({ platformMessageId: "om-existing" })
    )
  })

  it("reuses a durable pending follow-up registration after an ambiguous response", async () => {
    let followUpAttempts = 0
    const checkpoints: RunPresentationRef[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-pending" } }
      if (path === "/im/v1/messages?receive_id_type=chat_id") {
        return { data: { message_id: "om-pending" } }
      }
      if (path.endsWith("/push_follow_up")) {
        followUpAttempts += 1
        if (followUpAttempts === 1) throw new Error("connection reset after write")
        throw { code: 230008 }
      }
      return { data: {} }
    })

    const first = await driver.open(directTarget, snapshot(1), {
      checkpoint: async (ref) => {
        checkpoints.push(ref)
      },
    })
    expect(first.opaqueState?.pendingFollowUpControl).toBeDefined()

    const recovered = await driver.open(directTarget, snapshot(1), { previousRef: first })
    expect(followUpAttempts).toBe(2)
    expect(recovered.opaqueState?.pendingFollowUpControl).toBeUndefined()
    expect(recovered.opaqueState?.followUpFallbackReason).toBeUndefined()
    expect(recovered.opaqueState?.followUpControl).toEqual(
      expect.objectContaining({ platformMessageId: "om-pending" })
    )
    expect(checkpoints.some((ref) => ref.opaqueState?.pendingFollowUpControl)).toBe(true)
  })

  it("declares platform follow-up support with scope resolved by the delivery target", () => {
    const driver = createLarkRunPresentationDriver(async () => ({ data: {} }))
    expect(driver.capabilities.followUpBubbles).toBe(true)
  })
})

describe("status reactions", () => {
  it("acknowledges once, replaces status, and removes only the bot's previous reaction", async () => {
    let reactionNumber = 0
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const driver = createLarkRunPresentationDriver(
      async (method, path, body) => {
        calls.push({ method, path, body })
        if (path.endsWith("/reactions") && method === "POST")
          return { data: { reaction_id: `r${++reactionNumber}` } }
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-1" } }
        return { data: { message_id: "om-card" } }
      },
      { statusReactions: true }
    )
    let ref = await driver.open(topicTarget, snapshot(1))
    ref = await driver.update(ref, snapshot(2))
    ref = await driver.update(ref, snapshot(3))
    ref = await driver.finish(ref, snapshot(4, "failed"))
    const reactions = calls.filter((c) => c.path.includes("/reactions"))
    expect(reactions.map((c) => c.method)).toEqual(["POST", "POST", "DELETE", "POST", "DELETE"])
    expect(reactions.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { reaction_type: { emoji_type: "Get" } },
      { reaction_type: { emoji_type: "OnIt" } },
      { reaction_type: { emoji_type: "ERROR" } },
    ])
    expect(ref.opaqueState?.statusReaction).toEqual({ id: "r3", emoji: "ERROR" })
  })
  it("still sends the card when reaction permission is missing", async () => {
    const driver = createLarkRunPresentationDriver(
      async (_method, path) => {
        if (path.endsWith("/reactions")) throw new Error("scope missing")
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-1" } }
        return { data: { message_id: "om-card" } }
      },
      { statusReactions: true }
    )
    expect((await driver.open(topicTarget, snapshot(1))).platformMessageId).toBe("om-card")
  })
})

it("refreshes the entire card on a waiting transition even when actions stay the same", async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const driver = createLarkRunPresentationDriver(
    async (_method, path, body) => {
      calls.push({ path, body: body as { data?: string } })
      return path === "/cardkit/v1/cards"
        ? { data: { card_id: "waiting-card" } }
        : { data: { message_id: "om-card" } }
    },
    { statusReactions: false }
  )
  const ref = await driver.open(topicTarget, snapshot(1))
  await driver.update(ref, {
    ...snapshot(2, "waiting"),
    allowedActions: snapshot(1).allowedActions,
    pendingInterrupt: { id: "review", title: "Confirm deployment" },
  })
  const update = calls.find((c) => c.path === "/cardkit/v1/cards/waiting-card")
  expect(update).toBeDefined()
  const card = JSON.parse((update!.body as { card: { data: string } }).card.data)
  expect(card.header.template).toBe("orange")
  expect(JSON.stringify(card)).toContain("Waiting for review")
  expect(JSON.stringify(card)).toContain("Your action is needed")
  expect(JSON.stringify(card)).not.toContain("Confirm deployment")
})

it("shows elapsed time and truthful progress in the streaming body", async () => {
  let created = ""
  const driver = createLarkRunPresentationDriver(
    async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") {
        created = (body as { data: string }).data
        return { data: { card_id: "progress-card" } }
      }
      return { data: { message_id: "om-card" } }
    },
    { statusReactions: false }
  )
  await driver.open(topicTarget, { ...snapshot(1), elapsedMs: 65000 })
  expect(created).toContain("65s")
  expect(created).toContain("50%")
  expect(created).toContain("■")
})

it("renders real branch dependencies and only replaces the graph when its state changes", async () => {
  const calls: Array<{ path: string; body: { data?: string } }> = []
  const driver = createLarkRunPresentationDriver(
    async (_, path, body) => {
      calls.push({ path, body: body as { data?: string } })
      return { data: { card_id: "graph-card", message_id: "graph-message" } }
    },
    { webEntryBaseUrl: "http://localhost:3000" }
  )
  const value: RunProjectionSnapshot = {
    ...snapshot(1),
    allowedActions: ["open_details"],
    workflowGraph: {
      workflowId: "wf-1",
      sourceRunId: "source-1",
      nodes: ["read", "left", "right"].map((id) => ({ id, title: id, status: "pending" })),
      edges: [
        { source: "read", target: "left" },
        { source: "read", target: "right" },
      ],
    },
  }
  let ref = await driver.open(topicTarget, value)
  const card = JSON.parse(calls.find((call) => call.path === "/cardkit/v1/cards")!.body.data!)
  expect(JSON.stringify(card)).toContain("1 → 2 · 1 → 3")
  expect(JSON.stringify(card)).not.toContain("2 → 3")
  expect(JSON.stringify(card)).toContain(
    "http://localhost:3000/workflows/run?id=wf-1&runId=source-1"
  )
  expect(
    card.body.elements.find(
      (e: { tag: string; expanded?: boolean }) => e.tag === "collapsible_panel"
    ).expanded
  ).toBe(false)
  calls.length = 0
  ref = await driver.update(ref, { ...value, revision: 2, elapsedMs: 5000 })
  expect(calls.some((call) => call.path === "/cardkit/v1/cards/graph-card")).toBe(false)
  calls.length = 0
  await driver.update(ref, {
    ...value,
    revision: 3,
    workflowGraph: {
      ...value.workflowGraph!,
      nodes: value.workflowGraph!.nodes.map((node) => ({ ...node, status: "completed" })),
    },
  })
  expect(calls[0].path).toBe("/cardkit/v1/cards/graph-card")
})

it("never streams heartbeats into a waiting card with streaming mode closed", async () => {
  const paths: string[] = []
  const driver = createLarkRunPresentationDriver(async (_, path) => {
    paths.push(path)
    return { data: { card_id: "wait-card", message_id: "message" } }
  })
  let ref = await driver.open(topicTarget, snapshot(1))
  ref = await driver.update(ref, snapshot(2, "waiting"))
  paths.length = 0
  await driver.update(ref, snapshot(2, "waiting"))
  expect(paths).toEqual(["/cardkit/v1/cards/wait-card"])
})
it("repairs a closed-stream operation on the existing card without schema downgrade", async () => {
  const paths: string[] = []
  const driver = createLarkRunPresentationDriver(async (_, path) => {
    paths.push(path)
    if (path.endsWith("/content")) throw { code: 300309 }
    return { data: { card_id: "closed-card", message_id: "message" } }
  })
  const ref = await driver.open(topicTarget, snapshot(1))
  await driver.update(ref, snapshot(2))
  expect(paths).toContain("/cardkit/v1/cards/closed-card")
  expect(paths.filter((path) => path === "/cardkit/v1/cards")).toHaveLength(1)
  expect(JSON.stringify(buildLarkRunFallbackSegment(snapshot(3)))).toContain('"schema":"2.0"')
  expect(JSON.stringify(buildLarkRunFallbackSegment(snapshot(3)))).not.toContain('"tag":"action"')
})

describe("Lark COT presentation", () => {
  beforeEach(() => __resetLarkCotSupportCacheForTesting())
  afterEach(() => __resetLarkCotSupportCacheForTesting())

  interface CotCall {
    method: string
    path: string
    body: unknown
  }

  const cotAwareMock =
    (calls: CotCall[], onCotWrite?: (events: LarkCotEvent[]) => void) =>
    async (method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown) => {
      calls.push({ method, path, body })
      if (path === "/im/v1/message_cot?receive_id_type=chat_id") {
        return { data: { cot_id: "cot-1", message_id: "om-cot-1" } }
      }
      if (path === "/im/v1/message_cot" && method === "PUT") {
        onCotWrite?.((body as { events: LarkCotEvent[] }).events)
        return { data: {} }
      }
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-cot" } }
      if (path.endsWith("/reactions")) return { data: { reaction_id: "r1" } }
      return { data: { message_id: "msg-cot" } }
    }

  it("creates the COT message before the card and persists the handle", async () => {
    const calls: CotCall[] = []
    const driver = createLarkRunPresentationDriver(cotAwareMock(calls), {
      statusReactions: true,
      sleep: async () => undefined,
      now: () => 1_000,
    })

    const ref = await driver.open(topicTarget, snapshot(1))

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/im/v1/messages/om-anchor/reactions"],
      ["POST", "/im/v1/message_cot?receive_id_type=chat_id"],
      ["PUT", "/im/v1/message_cot"],
      ["POST", "/cardkit/v1/cards"],
      ["POST", "/im/v1/messages/om-anchor/reply"],
    ])
    expect(calls[1].body).toEqual({ receive_id: "chat-1", origin_message_id: "om-anchor" })
    expect(calls[2].body).toEqual(
      expect.objectContaining({ cot_id: "cot-1", message_id: "om-cot-1" })
    )
    const events = (calls[2].body as { events: LarkCotEvent[] }).events
    expect(events.map((event) => event.event_type)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
    ])
    expect(ref.opaqueState?.cot).toEqual(
      expect.objectContaining({
        status: "active",
        cotId: "cot-1",
        messageId: "om-cot-1",
        projection: expect.objectContaining({ version: 1, started: true }),
      })
    )
    expect(ref.opaqueState?.presentedCot).toBe(true)
    const card = JSON.parse((calls[3].body as { data: string }).data)
    expect(card.body.elements[0]).toMatchObject({
      tag: "markdown",
      element_id: "run_summary",
    })
    expect(JSON.stringify(card)).toContain("Process shown in the thinking timeline above")
    expect(JSON.stringify(card)).not.toContain("collapsible_panel")
  })

  it("opens the card alone when message_cot is unsupported and skips the probe next time", async () => {
    const calls: CotCall[] = []
    const driver = createLarkRunPresentationDriver(
      async (method, path, body) => {
        calls.push({ method, path, body })
        if (path.includes("message_cot")) throw { status: 404, message: "not found" }
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-noc" } }
        return { data: { message_id: "msg-noc" } }
      },
      { sleep: async () => undefined }
    )

    const ref = await driver.open(topicTarget, snapshot(1))

    expect(ref.platformMessageId).toBe("msg-noc")
    expect(ref.opaqueState?.cot).toEqual({ status: "disabled", reason: "unsupported" })
    expect(calls.some((call) => call.path.includes("message_cot"))).toBe(true)
    const card = JSON.parse(
      (calls.find((call) => call.path === "/cardkit/v1/cards")!.body as { data: string }).data
    )
    expect(JSON.stringify(card)).toContain("collapsible_panel")
    expect(JSON.stringify(card)).toContain("src/release.ts")

    // A fresh driver on the same adapter does not re-probe a known-unsupported
    // deployment — the second open goes straight to the card.
    calls.length = 0
    const secondDriver = createLarkRunPresentationDriver(
      async (method, path, body) => {
        calls.push({ method, path, body })
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-noc-2" } }
        return { data: { message_id: "msg-noc-2" } }
      },
      { sleep: async () => undefined }
    )
    const second = await secondDriver.open(topicTarget, snapshot(1))
    expect(calls.some((call) => call.path.includes("message_cot"))).toBe(false)
    expect(second.opaqueState?.cot).toEqual({ status: "disabled", reason: "unsupported" })
    expect(second.platformMessageId).toBe("msg-noc-2")
  })

  it("writes only the new diff on update and persists the advanced projection", async () => {
    const calls: CotCall[] = []
    const writes: LarkCotEvent[][] = []
    const driver = createLarkRunPresentationDriver(
      cotAwareMock(calls, (events) => writes.push(events)),
      { sleep: async () => undefined }
    )
    const ref = await driver.open(topicTarget, snapshot(1))

    const next = snapshot(2)
    next.activities = [
      ...next.activities!,
      {
        id: "tool:bash",
        kind: "tool" as const,
        category: "command" as const,
        status: "running" as const,
        label: "Bash",
        startedAt: 30,
      },
    ]
    const updated = await driver.update(ref, next)

    expect(writes).toHaveLength(2)
    expect(writes[1].map((event) => event.event_type)).toEqual(["TOOL_CALL_START"])
    expect(JSON.parse(writes[1][0].content)).toEqual(
      expect.objectContaining({ toolCallId: "tool:bash", toolCallName: "Bash", icon: "bash" })
    )
    const cot = updated.opaqueState?.cot as {
      status: string
      projection: { openTools: string[] }
    }
    expect(cot.status).toBe("active")
    expect(cot.projection.openTools).toContain("tool:bash")
  })

  it("writes RUN_ERROR then completes with reason=error for a failed run", async () => {
    const calls: CotCall[] = []
    const writes: LarkCotEvent[] = []
    const driver = createLarkRunPresentationDriver(
      cotAwareMock(calls, (events) => writes.push(...events)),
      { sleep: async () => undefined }
    )
    const ref = await driver.open(topicTarget, snapshot(1))

    await driver.finish(ref, snapshot(3, "failed"))

    const terminal = writes.map((event) => event.event_type)
    expect(terminal.slice(-3)).toEqual(["REASONING_MESSAGE_END", "REASONING_END", "RUN_ERROR"])
    const runError = writes.at(-1)!
    expect(JSON.parse(runError.content)).toEqual({
      message: "Task failed",
      code: "RUN_FAILED",
    })
    const complete = calls.find((call) => call.path.includes("message_cot/complete"))
    expect(complete).toBeDefined()
    expect(complete!.method).toBe("POST")
    expect(complete!.path).toBe(
      "/im/v1/message_cot/complete/cot-1?message_id=om-cot-1&reason=error"
    )
    // The completion is ordered after the terminal write.
    const lastWrite = calls.map((call) => call.path).lastIndexOf("/im/v1/message_cot")
    expect(calls.indexOf(complete!)).toBeGreaterThan(lastWrite)
  })

  it("disables COT after a failed write and restores the in-card timeline via replace_card", async () => {
    const calls: CotCall[] = []
    let cotWriteAttempts = 0
    const driver = createLarkRunPresentationDriver(
      async (method, path, body) => {
        calls.push({ method, path, body })
        if (path === "/im/v1/message_cot?receive_id_type=chat_id") {
          return { data: { cot_id: "cot-1", message_id: "om-cot-1" } }
        }
        if (path === "/im/v1/message_cot" && method === "PUT") {
          cotWriteAttempts += 1
          if (cotWriteAttempts > 1) throw { code: 99991400 }
          return { data: {} }
        }
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-cot" } }
        return { data: { message_id: "msg-cot" } }
      },
      { sleep: async () => undefined }
    )
    const ref = await driver.open(topicTarget, snapshot(1))

    const next = snapshot(2)
    next.activities = [
      ...next.activities!,
      {
        id: "tool:bash",
        kind: "tool" as const,
        category: "command" as const,
        status: "running" as const,
        label: "Bash",
        startedAt: 30,
      },
    ]
    const updated = await driver.update(ref, next)

    // One transient strike (after the single retry) disables COT for the run.
    expect(cotWriteAttempts).toBe(3)
    expect(updated.opaqueState?.cot).toEqual({ status: "disabled", reason: "write_failed" })
    const replace = calls.find(
      (call) => call.method === "PUT" && call.path === "/cardkit/v1/cards/card-cot"
    )
    expect(replace).toBeDefined()
    const card = JSON.parse((replace!.body as { card: { data: string } }).card.data)
    expect(
      card.body.elements.some((element: { tag: string }) => element.tag === "collapsible_panel")
    ).toBe(true)
    expect(JSON.stringify(card)).toContain("src/release.ts")
    expect(updated.opaqueState?.presentedCot).toBe(false)

    // The next update is a plain stream_summary again — no more COT calls.
    calls.length = 0
    await driver.update(updated, snapshot(3))
    expect(calls.some((call) => call.path.includes("message_cot"))).toBe(false)
    expect(calls.map((call) => call.path)).toContain(
      "/cardkit/v1/cards/card-cot/elements/run_summary/content"
    )
  })

  it("skips COT on a topic target without a reply anchor", async () => {
    const calls: string[] = []
    const checkpoints: RunPresentationRef[] = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      calls.push(path)
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-noanchor" } }
      return { data: { message_id: "msg-noanchor" } }
    })
    const noAnchorTarget: RunPresentationTarget = {
      adapterId: "lark-1",
      conversationKey: "opaque-topic-key",
      deliveryTarget: {
        ...topicTarget.deliveryTarget,
        sourceMessageId: undefined,
      },
    }

    // The card itself also cannot send without an anchor — the COT skip must
    // still have been checkpointed before the failure surfaced.
    await expect(
      driver.open(noAnchorTarget, snapshot(1), {
        checkpoint: async (ref) => {
          checkpoints.push(ref)
        },
      })
    ).rejects.toThrow("reply anchor")
    expect(calls.some((path) => path.includes("message_cot"))).toBe(false)
    expect(
      checkpoints.some(
        (ref) =>
          (ref.opaqueState?.cot as { reason?: string } | undefined)?.reason === "no_topic_anchor"
      )
    ).toBe(true)
  })

  it("sends zero message_cot requests when the cot option is off", async () => {
    const calls: string[] = []
    const driver = createLarkRunPresentationDriver(
      async (_method, path) => {
        calls.push(path)
        if (path === "/cardkit/v1/cards") return { data: { card_id: "card-plain" } }
        return { data: { message_id: "msg-plain" } }
      },
      { cot: false, sleep: async () => undefined }
    )

    const ref = await driver.open(topicTarget, snapshot(1))
    const updated = await driver.update(ref, snapshot(2))
    await driver.finish(updated, snapshot(3, "completed"))

    expect(calls.some((path) => path.includes("message_cot"))).toBe(false)
    expect(ref.opaqueState?.cot).toBeUndefined()
    expect(ref.opaqueState?.presentedCot).toBe(false)
  })
})
