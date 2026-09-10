import { createLarkRunPresentationDriver, buildLarkRunFallbackSegment } from "./lark-driver"
import type { RunPresentationRef, RunProjectionSnapshot } from "@/types/execution/run"

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
    expect(JSON.stringify(calls[2].body)).toContain("2 queued turns")
    expect(JSON.stringify(calls[2].body)).toContain("src/release.ts")
    expect(JSON.stringify(calls[2].body)).not.toContain("│")
    expect(typeof (calls[3].body as { element: unknown }).element).toBe("string")
    expect(JSON.parse((calls[3].body as { element: string }).element)).toEqual(
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
    expect(JSON.stringify(calls[0].body)).not.toContain('\\"tag\\":\\"action\\"')
    const initialCard = JSON.parse((calls[0].body as { data: string }).data)
    expect(initialCard.body.elements[0]).toMatchObject({
      tag: "collapsible_panel",
      expanded: true,
      header: {
        title: { tag: "plain_text", content: "Nodes and activity" },
      },
      elements: [expect.objectContaining({ tag: "markdown", element_id: "run_summary" })],
    })
    const finalCard = JSON.parse((calls[4].body as { card: { data: string } }).card.data) as {
      config: { streaming_mode: boolean }
    }
    expect(finalCard.config.streaming_mode).toBe(false)
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
  const card = JSON.parse(calls[0].body.data!)
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
