import { projectExecutionRunBinding } from "./runner"
import type {
  ExecutionRunBinding,
  RunPresentationDriver,
  RunProjectionSnapshot,
} from "@/types/execution/run"

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
    const deliverFallback = jest.fn(async () => ({ platformMessageId: "fallback-1" }))

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
      deliverFallback: jest.fn(async () => ({ platformMessageId: "fallback-pending" })),
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
      { ...snapshot, summary: "Contact private.person@example.com" },
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
    expect(received?.summary).toContain("hidden")
  })
})
