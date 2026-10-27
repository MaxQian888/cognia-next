/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import Dexie from "dexie"
import { createSlackRunPresentationDriver } from "./slack-driver"

import {
  areExecutionRunPresentationsFrozen,
  heartbeatExecutionRunBinding,
  projectExecutionRunBinding,
  resolveCapabilityAwareFallbackDeliveryMode,
  resolveFallbackDeliveryMode,
  shouldDeliverFallbackUpdate,
  waitForExecutionRunPresentationFreeze,
  startExecutionRunPresentationRunner,
  __resetExecutionRunPresentationRunnerForTesting,
} from "./runner"
import type {
  ExecutionRunBinding,
  RunPresentationDriver,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  createExecutionRunBinding,
  getExecutionRunBinding,
} from "@/lib/db/execution-runs"
import {
  __resetLifecycleForTesting,
  registerRunningAdapter,
  unregisterRunningAdapter,
} from "@/lib/connectors/lifecycle"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import {
  startOutboundRunner,
  __resetAdapterRuntimeStateForTesting,
} from "@/lib/connectors/outbound-runner"

const binding: ExecutionRunBinding = {
  id: "binding-1",
  runId: "run-1",
  adapterId: "lark-1",
  conversationKey: "lark:lark-1:chat-1",
  status: "active",
  deliveryMode: "native",
  lastProjectedRevision: 0,
  createdAt: 1,
  updatedAt: 1,
}

const snapshot: RunProjectionSnapshot = {
  runId: "run-1",
  kind: "agent-turn",
  title: "Agent run",
  status: "running",
  revision: 2,
  startedAt: 1,
  updatedAt: 2,
  progress: { completed: 0, total: 1, trustworthy: false },
  activeSteps: [],
  recentSteps: [],
  pendingSteps: [],
  pendingStepCount: 1,
  elapsedMs: 1_000,
  artifacts: [],
  allowedActions: ["stop"],
}

const qqGroupBinding: ExecutionRunBinding = {
  ...binding,
  adapterId: "qq-1",
  conversationKey: "onebot:qq-1:g:group-1",
  deliveryMode: "append",
  deliveryTarget: {
    refreshedAt: 1,
    address: {
      platform: "onebot",
      adapterId: "qq-1",
      conversationKey: "onebot:qq-1:g:group-1",
      scopeKind: "group",
      containerId: "group-1",
    },
    conversationRef: { platform: "onebot", adapterId: "qq-1", chatKey: "g:group-1" },
  },
}

describe("QQ group Agent status presentation", () => {
  it("keeps short turns quiet and leaves the authoritative final answer independent", () => {
    expect(shouldDeliverFallbackUpdate(qqGroupBinding, snapshot, "append", 2_001)).toBe(false)
    expect(
      shouldDeliverFallbackUpdate(
        qqGroupBinding,
        { ...snapshot, status: "completed" },
        "append",
        2_001
      )
    ).toBe(false)
    expect(shouldDeliverFallbackUpdate(qqGroupBinding, snapshot, "append", 8_001)).toBe(true)
    const sent = {
      ...qqGroupBinding,
      lastProjectedRevision: 2,
      presentationState: { lastAppendAt: 8_001 },
    }
    expect(shouldDeliverFallbackUpdate(sent, snapshot, "append", 38_000)).toBe(false)
    expect(shouldDeliverFallbackUpdate(sent, snapshot, "append", 38_001)).toBe(true)
  })

  it.each(["waiting", "paused", "recovery_required", "failed", "cancelled"] as const)(
    "does not hide %s during the grace period",
    (status) => {
      expect(
        shouldDeliverFallbackUpdate(qqGroupBinding, { ...snapshot, status }, "append", 2_001)
      ).toBe(true)
    }
  )

  it("does not hide a pending approval or the transition back to running", () => {
    expect(
      shouldDeliverFallbackUpdate(
        { ...qqGroupBinding, lastProjectedRevision: 1, presentationState: { lastAppendAt: 2_000 } },
        {
          ...snapshot,
          pendingInterrupt: { id: "approval-1", title: "Approve" },
        },
        "append",
        2_001
      )
    ).toBe(true)
    expect(
      shouldDeliverFallbackUpdate(
        {
          ...qqGroupBinding,
          presentationState: { lastProjectedStatus: "waiting", lastAppendAt: 2_000 },
        },
        snapshot,
        "append",
        2_001
      )
    ).toBe(true)
  })

  it("preserves private, other-platform and workflow presentation", () => {
    const privateBinding = {
      ...qqGroupBinding,
      deliveryTarget: {
        ...qqGroupBinding.deliveryTarget!,
        address: { ...qqGroupBinding.deliveryTarget!.address, scopeKind: "private" as const },
      },
    }
    expect(shouldDeliverFallbackUpdate(privateBinding, snapshot, "append", 2_001)).toBe(true)
    expect(shouldDeliverFallbackUpdate(binding, snapshot, "append", 2_001)).toBe(true)
    expect(
      shouldDeliverFallbackUpdate(
        qqGroupBinding,
        { ...snapshot, kind: "workflow", status: "completed" },
        "append",
        2_001
      )
    ).toBe(true)
  })

  it("heartbeats a long quiet turn without new revisions and freezes without a completion notice", async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetLifecycleForTesting()
    const realNow = Date.now.bind(Date)
    const startedAt = realNow()
    let offset = 0
    const clock = jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset)
    const running = { ...snapshot, startedAt }
    const controller = new AbortController()
    let deliveredCount = 0
    const send = jest.fn(async () => ({
      ok: true as const,
      platformMessageId: `qq-progress-${++deliveredCount}`,
    }))
    const adapter = {
      id: qqGroupBinding.adapterId,
      meta: {
        type: "onebot",
        displayName: "QQ",
        version: "1",
        capabilities: [],
        transportModes: [],
        configSchema: {},
      },
      send,
    } as unknown as PlatformAdapter
    const runner = startOutboundRunner({
      adapters: new Map([[adapter.id, adapter]]),
      signal: controller.signal,
      pollIntervalMs: 1,
      now: () => Date.now(),
      jitter: () => 0,
    })
    try {
      await createExecutionRun({
        id: running.runId,
        kind: "agent-turn",
        sourceId: "qq-heartbeat",
        title: "QQ test",
        status: "running",
        currentRevision: running.revision,
        latestSnapshot: running,
        startedAt: running.startedAt,
        updatedAt: Date.now(),
      })
      await createExecutionRunBinding({ ...qqGroupBinding, sourceMessageId: "qq-input" })
      startExecutionRunPresentationRunner()
      for (let i = 0; i < 200; i++) {
        if (
          (await getExecutionRunBinding(qqGroupBinding.id))?.lastProjectedRevision ===
          running.revision
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect((await getExecutionRunBinding(qqGroupBinding.id))?.lastProjectedRevision).toBe(
        running.revision
      )
      await heartbeatExecutionRunBinding(qqGroupBinding.id)
      expect(await getDb().outboundQueue.count()).toBe(0)
      const deliverHeartbeat = async (count: number) => {
        const pending = heartbeatExecutionRunBinding(qqGroupBinding.id)
        let jobs: OutboundJobRow[] = []
        for (let i = 0; i < 200; i++) {
          jobs = await getDb().outboundQueue.toArray()
          if (jobs.length === count) break
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(jobs).toHaveLength(count)
        const newest = jobs.sort((a, b) => b.createdAt - a.createdAt)[0]
        expect(newest.request).toMatchObject({
          replyTo: { messageId: "qq-input" },
          segments: [{ type: "markdown" }],
        })
        await pending
        expect(send).toHaveBeenCalledTimes(count)
      }
      offset = 9_000
      await deliverHeartbeat(1)
      offset = 10_000
      await heartbeatExecutionRunBinding(qqGroupBinding.id)
      expect(await getDb().outboundQueue.count()).toBe(1)
      offset = 39_000
      await deliverHeartbeat(2)
      const completed = {
        ...running,
        status: "completed" as const,
        revision: 3,
        endedAt: Date.now(),
      }
      await getDb().executionRuns.update(running.runId, {
        status: "completed",
        currentRevision: 3,
        latestSnapshot: completed,
        endedAt: Date.now(),
      })
      await expect(waitForExecutionRunPresentationFreeze(running.runId, 1_000)).resolves.toBe(true)
      expect((await getExecutionRunBinding(qqGroupBinding.id))?.status).toBe("finished")
      expect(await getDb().outboundQueue.count()).toBe(2)
    } finally {
      controller.abort()
      await runner
      clock.mockRestore()
      __resetExecutionRunPresentationRunnerForTesting()
      __resetAdapterRuntimeStateForTesting()
      await getDb().delete()
      __resetDbForTesting()
    }
  })
})

describe("run presentation refresh scheduling", () => {
  afterEach(() => {
    __resetExecutionRunPresentationRunnerForTesting()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it.each(["waiting", "completed"] as const)(
    "does not delay %s behind a coalesced progress refresh",
    async (status) => {
      jest.useFakeTimers()
      let next!: (
        rows: Array<{ binding: ExecutionRunBinding; snapshot: RunProjectionSnapshot }>
      ) => void
      jest.spyOn(Dexie, "liveQuery").mockReturnValue({
        subscribe: (observer: { next: typeof next }) => {
          next = observer.next
          return { unsubscribe: jest.fn() }
        },
      } as unknown as ReturnType<typeof Dexie.liveQuery>)
      const read = jest.spyOn(getDb().executionRunBindings, "get").mockResolvedValue(undefined)
      startExecutionRunPresentationRunner()
      const projectedBinding = { ...binding, lastProjectedRevision: 1 }
      next([{ binding: projectedBinding, snapshot }])
      await jest.advanceTimersByTimeAsync(100)
      expect(read).not.toHaveBeenCalled()
      next([{ binding: projectedBinding, snapshot: { ...snapshot, revision: 3, status } }])
      await jest.advanceTimersByTimeAsync(1)
      expect(read).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(2_000)
      expect(read).toHaveBeenCalledTimes(1)
    }
  )
})

describe("execution run presentation projection", () => {
  it.each([
    { native: true, runLocale: "zh-CN", expectedLocale: "zh-CN" },
    { native: true, runLocale: undefined, expectedLocale: "en" },
    { native: false, runLocale: "zh-CN", expectedLocale: "zh-CN" },
    { native: false, runLocale: undefined, expectedLocale: "en" },
  ])(
    "projects locale $expectedLocale from run locale $runLocale with native delivery $native",
    async ({ native, runLocale, expectedLocale }) => {
      const driver: RunPresentationDriver = {
        capabilities: { interactiveControls: true },
        open: jest.fn(async () => ({ platformMessageId: "localized-message" })),
        update: jest.fn(),
        finish: jest.fn(),
      }
      const deliverFallback = jest.fn(async () => ({
        ref: { platformMessageId: "localized-fallback" },
        deliveryMode: "card-edit" as const,
        delivered: true,
      }))

      await projectExecutionRunBinding(
        { ...binding, locale: "en" },
        { ...snapshot, locale: runLocale },
        {
          resolveDriver: () => driver,
          deliverFallback,
          saveBinding: jest.fn(async () => undefined),
          recordDegraded: jest.fn(),
          nativeEnabled: () => native,
        }
      )

      if (native) {
        expect(driver.open).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ locale: expectedLocale }),
          expect.anything()
        )
        expect(deliverFallback).not.toHaveBeenCalled()
      } else {
        expect(deliverFallback).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ locale: expectedLocale })
        )
        expect(driver.open).not.toHaveBeenCalled()
      }
    }
  )

  it("falls back to the command channel when no replyable Slack message exists", async () => {
    const request = jest.fn()
    const driver = createSlackRunPresentationDriver(request)
    const open = jest.spyOn(driver, "open")
    const deliveryTarget = {
      refreshedAt: 1,
      address: {
        platform: "slack" as const,
        adapterId: "slack-1",
        conversationKey: "slack:slack-1:channel-1",
        scopeKind: "group" as const,
        containerId: "channel-1",
      },
      conversationRef: { platform: "slack" as const, adapterId: "slack-1", channelId: "channel-1" },
    }
    const commandBinding = { ...binding, adapterId: "slack-1", deliveryTarget }
    const deliverFallback = jest.fn(async (_binding: ExecutionRunBinding) => ({
      ref: { platformMessageId: "fallback-command" },
      deliveryMode: "append" as const,
      delivered: true,
    }))
    await projectExecutionRunBinding(commandBinding, snapshot, {
      resolveDriver: () => driver,
      deliverFallback,
      saveBinding: async () => undefined,
      recordDegraded: jest.fn(),
      nativeEnabled: () => true,
    })
    expect(open.mock.calls[0][0].sourceMessageId).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    expect(deliverFallback.mock.calls[0][0]).toEqual(expect.objectContaining({ deliveryTarget }))
  })

  it("commits the cursor only after a native projection succeeds", async () => {
    const saved: ExecutionRunBinding[] = []
    const driver: RunPresentationDriver = {
      capabilities: {
        nativeStreaming: true,
        partialUpdate: true,
        messageEdit: true,
        interactiveControls: true,
      },
      open: jest.fn(async () => ({
        platformMessageId: "message-1",
        opaqueState: { cardId: "card-1", sequence: 0 },
      })),
      update: jest.fn(),
      finish: jest.fn(),
    }

    const projected = await projectExecutionRunBinding(binding, snapshot, {
      resolveDriver: () => driver,
      deliverFallback: jest.fn(),
      saveBinding: async (row) => void saved.push(row),
      recordDegraded: jest.fn(),
      nativeEnabled: () => true,
    })

    expect(driver.open).toHaveBeenCalled()
    expect(projected).toMatchObject({
      platformMessageId: "message-1",
      presentationState: { cardId: "card-1", sequence: 0 },
      lastProjectedRevision: 2,
    })
    expect(saved).toHaveLength(1)
  })

  it("records native failure and commits only the successful fallback", async () => {
    const recordDegraded = jest.fn()
    const driver: RunPresentationDriver = {
      capabilities: {
        nativeStreaming: true,
        partialUpdate: true,
        messageEdit: true,
        interactiveControls: true,
      },
      open: jest.fn(async () => {
        throw new Error("card expired")
      }),
      update: jest.fn(),
      finish: jest.fn(),
    }
    const deliverFallback = jest.fn(async () => ({
      ref: { platformMessageId: "fallback-1" },
      deliveryMode: "card-edit" as const,
      delivered: true,
    }))

    const projected = await projectExecutionRunBinding(binding, snapshot, {
      resolveDriver: () => driver,
      deliverFallback,
      saveBinding: async () => undefined,
      recordDegraded,
      nativeEnabled: () => true,
    })

    expect(recordDegraded).toHaveBeenCalledWith(binding, "card expired")
    expect(deliverFallback).toHaveBeenCalled()
    expect(projected).toMatchObject({
      status: "degraded",
      deliveryMode: "card-edit",
      platformMessageId: "fallback-1",
      lastProjectedRevision: 2,
    })
  })

  it("preserves a pending native mutation checkpoint when degrading to fallback", async () => {
    const saved: ExecutionRunBinding[] = []
    const recordDegraded = jest.fn()
    const pendingMutation = { sequence: 4, uuid: "mutation-4", operation: "stream_summary" }
    const driver: RunPresentationDriver = {
      capabilities: { interactiveControls: true },
      open: jest.fn(async (_target, _snapshot, options) => {
        await options?.checkpoint?.({ opaqueState: { pendingMutation } })
        throw new Error("ambiguous mutation")
      }),
      update: jest.fn(),
      finish: jest.fn(),
    }

    const projected = await projectExecutionRunBinding(binding, snapshot, {
      resolveDriver: () => driver,
      deliverFallback: jest.fn(async () => ({
        ref: { platformMessageId: "fallback-pending" },
        deliveryMode: "card-edit" as const,
        delivered: true,
      })),
      saveBinding: async (row) => void saved.push(row),
      recordDegraded,
      nativeEnabled: () => true,
    })

    expect(recordDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ presentationState: { pendingMutation } }),
      "ambiguous mutation"
    )
    expect(projected.presentationState).toEqual({ pendingMutation })
    expect(saved.some((row) => row.presentationState?.pendingMutation)).toBe(true)
  })

  it("freezes an agent card without duplicating the authoritative final reply", async () => {
    const driver: RunPresentationDriver = {
      capabilities: {
        nativeStreaming: true,
        partialUpdate: false,
        messageEdit: true,
        interactiveControls: true,
      },
      open: jest.fn(),
      update: jest.fn(),
      finish: jest.fn(async (ref) => ref),
    }
    const deliverMilestone = jest.fn(async () => undefined)
    const terminalBinding = { ...binding, platformMessageId: "message-1" }
    const terminalSnapshot: RunProjectionSnapshot = {
      ...snapshot,
      status: "completed",
      revision: 3,
      summary: "Done",
      allowedActions: ["open_details"],
    }

    await projectExecutionRunBinding(terminalBinding, terminalSnapshot, {
      resolveDriver: () => driver,
      deliverFallback: jest.fn(),
      deliverMilestone,
      saveBinding: jest.fn(async () => undefined),
      recordDegraded: jest.fn(),
      nativeEnabled: () => true,
    })

    expect(driver.finish).toHaveBeenCalledTimes(1)
    expect(deliverMilestone).not.toHaveBeenCalled()
  })

  it("emits one normal terminal summary for a workflow after freezing its card", async () => {
    const driver: RunPresentationDriver = {
      capabilities: { interactiveControls: true },
      open: jest.fn(),
      update: jest.fn(),
      finish: jest.fn(async (ref) => ref),
    }
    const deliverMilestone = jest.fn(async () => undefined)

    await projectExecutionRunBinding(
      { ...binding, platformMessageId: "message-1", locale: "en" },
      { ...snapshot, kind: "workflow", status: "completed", revision: 3, locale: "zh-CN" },
      {
        resolveDriver: () => driver,
        deliverFallback: jest.fn(),
        deliverMilestone,
        saveBinding: jest.fn(async () => undefined),
        recordDegraded: jest.fn(),
        nativeEnabled: () => true,
      }
    )

    expect(deliverMilestone).toHaveBeenCalledTimes(1)
    expect(deliverMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en" }),
      expect.objectContaining({ locale: "zh-CN" })
    )
    expect(driver.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locale: "zh-CN" }),
      expect.anything()
    )
  })

  it("does not project an already committed or disabled binding", async () => {
    const resolveDriver = jest.fn()
    const row = { ...binding, lastProjectedRevision: 2 }
    await expect(
      projectExecutionRunBinding(row, snapshot, {
        resolveDriver,
        deliverFallback: jest.fn(),
        saveBinding: jest.fn(),
        recordDegraded: jest.fn(),
        nativeEnabled: () => true,
      })
    ).resolves.toBe(row)
    expect(resolveDriver).not.toHaveBeenCalled()
  })

  it("replaces unsafe semantic text before it reaches a platform driver", async () => {
    let received: RunProjectionSnapshot | undefined
    const driver: RunPresentationDriver = {
      capabilities: {
        nativeStreaming: true,
        partialUpdate: true,
        messageEdit: true,
        interactiveControls: true,
      },
      open: jest.fn(async (_target, projected) => {
        received = projected
        return { platformMessageId: "safe" }
      }),
      update: jest.fn(),
      finish: jest.fn(),
    }
    const recordDegraded = jest.fn()
    await projectExecutionRunBinding(
      binding,
      {
        ...snapshot,
        summary: "Contact private.person@example.com",
        activities: [
          {
            id: "tool:mail",
            kind: "tool",
            category: "integration",
            status: "running",
            label: "Email private.person@example.com",
            target: { kind: "resource", label: "private.person@example.com" },
            startedAt: 1,
          },
        ],
        activityCount: 1,
        omittedActivityCount: 0,
      },
      {
        resolveDriver: () => driver,
        deliverFallback: jest.fn(),
        saveBinding: jest.fn(async () => undefined),
        recordDegraded,
        nativeEnabled: () => true,
      }
    )

    expect(recordDegraded).toHaveBeenCalledWith(binding, "pii_gate_blocked")
    expect(JSON.stringify(received)).not.toContain("private.person@example.com")
    expect(received?.summary).toBeUndefined()
    expect(received?.activities).toEqual([expect.objectContaining({ label: "Email <EMAIL_001>" })])
    expect(received?.activities?.[0]?.target).toBeUndefined()
  })

  it("hashes PII-shaped ids and discards caller-provided details URLs before every sink", async () => {
    let received: RunProjectionSnapshot | undefined
    const driver: RunPresentationDriver = {
      capabilities: { interactiveControls: true },
      open: jest.fn(async (_target, projected) => {
        received = projected
        return { platformMessageId: "safe" }
      }),
      update: jest.fn(),
      finish: jest.fn(),
    }
    const recordDegraded = jest.fn()

    await projectExecutionRunBinding(
      { ...binding, runId: "13800138000" },
      {
        ...snapshot,
        runId: "13800138000",
        detailsUrl: "https://example.com/private?token=secret",
        workflowGraph: {
          workflowId: "wf",
          sourceRunId: "source",
          nodes: [
            {
              id: "node",
              title: "private.person@example.com",
              status: "pending",
              detail: "secret graph payload",
            },
          ],
          edges: [],
        },
        activities: [
          {
            id: "private.person@example.com",
            kind: "tool",
            category: "integration",
            status: "running",
            label: "Tool",
            startedAt: 1,
          },
        ],
      },
      {
        resolveDriver: () => driver,
        deliverFallback: jest.fn(),
        saveBinding: jest.fn(async () => undefined),
        recordDegraded,
        nativeEnabled: () => true,
      }
    )

    const serialized = JSON.stringify(received)
    expect(recordDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "13800138000" }),
      "pii_gate_blocked"
    )
    expect(received?.runId).toMatch(/^opaque-/)
    expect(received?.activities?.[0]?.id).toMatch(/^opaque-/)
    expect(received?.detailsUrl).toBe(`/agent-runs?run=${received?.runId}`)
    expect(serialized).not.toContain("13800138000")
    expect(serialized).not.toContain("private.person@example.com")
    expect(serialized).not.toContain("secret graph payload")
    expect(serialized).not.toContain("token=secret")
  })

  it("preserves safe tool metadata and journal counts while sanitizing untrusted details", async () => {
    let received: RunProjectionSnapshot | undefined
    const driver: RunPresentationDriver = {
      capabilities: { interactiveControls: true },
      open: jest.fn(async (_target, projected) => {
        received = projected
        return { platformMessageId: "tool-metadata" }
      }),
      update: jest.fn(),
      finish: jest.fn(),
    }
    const recordDegraded = jest.fn()
    await projectExecutionRunBinding(
      binding,
      {
        ...snapshot,
        toolCount: 17,
        failedToolCount: 3,
        pendingInterrupt: {
          id: "tool-interrupt:long-run-id:request",
          requestId: "private.person@example.com",
          title: "Approval required",
        },
        activities: [
          {
            id: "tool:issue-list",
            kind: "tool",
            category: "integration",
            status: "failed",
            label: "List issues",
            toolName: "mcp__server__issue_list",
            approval: { requestId: "private.person@example.com", status: "denied" },
            failureReason: "Access denied for private.person@example.com",
            startedAt: 1,
            endedAt: 2,
            ...{ input: { token: "private-tool-argument" } },
          },
        ],
        activityCount: 17,
        omittedActivityCount: 16,
      },
      {
        resolveDriver: () => driver,
        deliverFallback: jest.fn(),
        saveBinding: jest.fn(async () => undefined),
        recordDegraded,
        nativeEnabled: () => true,
      }
    )

    expect(received).toMatchObject({ toolCount: 17, failedToolCount: 3 })
    expect(received?.pendingInterrupt?.requestId).toMatch(/^opaque-/)
    expect(received?.activities).toEqual([
      expect.objectContaining({
        toolName: "issue_list",
        approval: { requestId: expect.stringMatching(/^opaque-/), status: "denied" },
        failureReason: "Access denied for <EMAIL_001>",
      }),
    ])
    expect(recordDegraded).toHaveBeenCalledWith(binding, "pii_gate_blocked")
    expect(JSON.stringify(received)).not.toContain("private.person@example.com")
    expect(JSON.stringify(received)).not.toContain("private-tool-argument")
  })

  it("selects fallback delivery from real edit capability and append policy", () => {
    expect(resolveFallbackDeliveryMode({ canEdit: true, appendActivity: false })).toBe("card-edit")
    expect(resolveFallbackDeliveryMode({ canEdit: false, appendActivity: true })).toBe("append")
    expect(resolveFallbackDeliveryMode({ canEdit: false, appendActivity: false })).toBe(
      "final-only"
    )
  })

  it("honors explicit runtime capability denials over method presence", () => {
    expect(
      resolveCapabilityAwareFallbackDeliveryMode({
        hasEditMethod: true,
        messageEditing: false,
        appendActivity: true,
        appendFallback: false,
      })
    ).toBe("final-only")
    expect(
      resolveCapabilityAwareFallbackDeliveryMode({
        hasEditMethod: true,
        messageEditing: true,
        appendActivity: false,
        appendFallback: true,
      })
    ).toBe("card-edit")
  })

  it("limits append-only updates to critical states or one update per 30 seconds", () => {
    const appendBinding: ExecutionRunBinding = {
      ...binding,
      deliveryMode: "append",
      lastProjectedRevision: 1,
      presentationState: { lastAppendAt: 10_000 },
    }

    expect(shouldDeliverFallbackUpdate(appendBinding, snapshot, "append", 39_999)).toBe(false)
    expect(shouldDeliverFallbackUpdate(appendBinding, snapshot, "append", 40_000)).toBe(true)
    expect(
      shouldDeliverFallbackUpdate(
        appendBinding,
        { ...snapshot, status: "waiting" },
        "append",
        10_001
      )
    ).toBe(true)
    expect(shouldDeliverFallbackUpdate(appendBinding, snapshot, "final-only", 100_000)).toBe(false)
    expect(
      shouldDeliverFallbackUpdate(
        {
          ...appendBinding,
          presentationState: {
            lastAppendAt: 10_000,
            lastProjectedStatus: "waiting",
          },
        },
        snapshot,
        "append",
        10_001
      )
    ).toBe(true)
    expect(
      shouldDeliverFallbackUpdate(
        appendBinding,
        { ...snapshot, status: "completed" },
        "final-only",
        10_001
      )
    ).toBe(true)
  })

  it("recognizes only finished or disabled presentation bindings as frozen", () => {
    expect(
      areExecutionRunPresentationsFrozen([
        { ...binding, status: "finished" },
        { ...binding, id: "binding-2", status: "disabled" },
      ])
    ).toBe(true)
    expect(areExecutionRunPresentationsFrozen([{ ...binding, status: "degraded" }])).toBe(false)
  })

  it("disables and drains an in-flight terminal projection before a timeout returns", async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetLifecycleForTesting()
    let releaseFinish: () => void = () => undefined
    let markFinishStarted: () => void = () => undefined
    const finishStarted = new Promise<void>((resolve) => {
      markFinishStarted = resolve
    })
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve
    })
    const driver: RunPresentationDriver = {
      capabilities: {
        nativeStreaming: true,
        partialUpdate: true,
        messageEdit: true,
        interactiveControls: true,
      },
      open: jest.fn(),
      update: jest.fn(),
      finish: jest.fn(async (ref) => {
        markFinishStarted()
        await finishGate
        return ref
      }),
    }
    const adapter = {
      id: "lark-freeze",
      runPresentation: driver,
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformAdapter
    registerRunningAdapter(adapter.id, {
      adapter,
      abortController: new AbortController(),
      restart: jest.fn().mockResolvedValue(undefined),
    })
    const terminalSnapshot: RunProjectionSnapshot = {
      ...snapshot,
      status: "completed",
      revision: 3,
      updatedAt: 3,
      endedAt: 3,
      progress: { completed: 1, total: 1, ratio: 1, trustworthy: true },
      allowedActions: ["open_details"],
    }
    await createExecutionRun({
      id: terminalSnapshot.runId,
      kind: "agent-turn",
      sourceId: "freeze-timeout",
      title: "Agent run",
      status: "completed",
      currentRevision: terminalSnapshot.revision,
      latestSnapshot: terminalSnapshot,
      startedAt: 1,
      updatedAt: 3,
      endedAt: 3,
    })
    await createExecutionRunBinding({
      ...binding,
      adapterId: adapter.id,
      platformMessageId: "message-freeze",
    })

    const freeze = waitForExecutionRunPresentationFreeze(terminalSnapshot.runId, 25)
    await finishStarted
    await new Promise((resolve) => setTimeout(resolve, 35))
    let settled = false
    void freeze.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseFinish()
    await expect(freeze).resolves.toBe(false)
    expect((await getExecutionRunBinding(binding.id))?.status).toBe("disabled")
    unregisterRunningAdapter(adapter.id)
  })

  it("queues an append card as a notice into the run's own conversation (ADR-0239)", async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetLifecycleForTesting()
    await createExecutionRun({
      id: snapshot.runId,
      kind: "agent-turn",
      sourceId: "append-authorization",
      title: "Agent run",
      status: "running",
      currentRevision: snapshot.revision,
      latestSnapshot: snapshot,
      startedAt: 1,
      updatedAt: 2,
    })
    await createExecutionRunBinding({
      ...binding,
      deliveryMode: "append",
      lastProjectedRevision: snapshot.revision,
      deliveryTarget: {
        address: {
          conversationKey: binding.conversationKey,
          platform: "lark",
          adapterId: binding.adapterId,
          scopeKind: "private",
          containerId: "chat-1",
        },
        conversationRef: { platform: "lark", adapterId: binding.adapterId, channelId: "chat-1" },
        refreshedAt: 1,
      },
    })

    const heartbeat = heartbeatExecutionRunBinding(binding.id)
    let job: OutboundJobRow | undefined
    for (let i = 0; i < 200 && !job; i += 1) {
      job = (await getDb().outboundQueue.toArray())[0]
      if (!job) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(job).toMatchObject({
      conversationKey: binding.conversationKey,
      authorizedBy: { authority: "policy-default" },
    })
    // Let the card's delivery settle so the heartbeat finishes.
    await getDb().outboundQueue.update(job!.id, { status: "sent", platformMessageId: "m-1" })
    await heartbeat
  })

  it("registers heartbeat work before DB reads so freeze drains stale progress updates", async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetLifecycleForTesting()
    localStorage.removeItem("cognia-run-presentation-native-disabled")
    let releaseUpdate: () => void = () => undefined
    let markUpdateStarted: () => void = () => undefined
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve
    })
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve
    })
    const driver: RunPresentationDriver = {
      capabilities: {
        nativeStreaming: true,
        partialUpdate: true,
        messageEdit: true,
        interactiveControls: true,
      },
      open: jest.fn(),
      update: jest.fn(async (ref) => {
        markUpdateStarted()
        await updateGate
        return ref
      }),
      finish: jest.fn(),
    }
    const adapter = {
      id: "lark-heartbeat-freeze",
      runPresentation: driver,
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformAdapter
    registerRunningAdapter(adapter.id, {
      adapter,
      abortController: new AbortController(),
      restart: jest.fn().mockResolvedValue(undefined),
    })
    await createExecutionRun({
      id: snapshot.runId,
      kind: "agent-turn",
      sourceId: "heartbeat-freeze",
      title: "Agent run",
      status: "running",
      currentRevision: snapshot.revision,
      latestSnapshot: { ...snapshot, locale: "zh-CN" },
      startedAt: 1,
      updatedAt: 2,
    })
    await createExecutionRunBinding({
      ...binding,
      adapterId: adapter.id,
      platformMessageId: "message-heartbeat",
      lastProjectedRevision: snapshot.revision,
      locale: "en",
    })

    const heartbeat = heartbeatExecutionRunBinding(binding.id)
    await updateStarted
    expect(driver.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locale: "zh-CN" }),
      expect.anything()
    )
    const terminalSnapshot: RunProjectionSnapshot = {
      ...snapshot,
      status: "completed",
      revision: snapshot.revision + 1,
      endedAt: 3,
      updatedAt: 3,
      allowedActions: ["open_details"],
    }
    await getDb().executionRuns.update(snapshot.runId, {
      status: "completed",
      currentRevision: terminalSnapshot.revision,
      latestSnapshot: terminalSnapshot,
      endedAt: 3,
      updatedAt: 3,
    })
    const freeze = waitForExecutionRunPresentationFreeze(snapshot.runId, 0)
    let settled = false
    void freeze.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseUpdate()
    await heartbeat
    await expect(freeze).resolves.toBe(false)
    expect((await getExecutionRunBinding(binding.id))?.status).toBe("disabled")
    unregisterRunningAdapter(adapter.id)
  })
})
