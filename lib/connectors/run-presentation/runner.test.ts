/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  areExecutionRunPresentationsFrozen,
  heartbeatExecutionRunBinding,
  projectExecutionRunBinding,
  resolveCapabilityAwareFallbackDeliveryMode,
  resolveFallbackDeliveryMode,
  shouldDeliverFallbackUpdate,
  waitForExecutionRunPresentationFreeze,
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
import type { PlatformAdapter } from "@/types/connectors/adapter"

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

describe("execution run presentation projection", () => {
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
      { ...binding, platformMessageId: "message-1" },
      { ...snapshot, kind: "workflow", status: "completed", revision: 3 },
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
    expect(serialized).not.toContain("token=secret")
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
      latestSnapshot: snapshot,
      startedAt: 1,
      updatedAt: 2,
    })
    await createExecutionRunBinding({
      ...binding,
      adapterId: adapter.id,
      platformMessageId: "message-heartbeat",
      lastProjectedRevision: snapshot.revision,
    })

    const heartbeat = heartbeatExecutionRunBinding(binding.id)
    await updateStarted
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
