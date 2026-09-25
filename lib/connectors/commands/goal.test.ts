import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { ConversationDeliveryTarget, NormalizedInboundEvent } from "@/types/connectors/event"
import type { RunGoalLoopInput } from "@/lib/scheduler/executors/goal-headless-runner"
import type { ConnectorGoalDriverArgs } from "./goal"

// Keep the heavy transitive graph (scheduler runner, slash actions, settings
// store) out of the test — every collaborator is injected below.
jest.mock("@/lib/scheduler/executors/goal-headless-runner", () => ({
  runGoalLoopHeadless: jest.fn(),
}))
jest.mock("@/lib/slash-commands/actions/goal", () => ({
  dispatchGoalSubcommand: jest.fn(),
}))
jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn(),
}))
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn(async () => undefined),
}))
jest.mock("@/lib/connectors/ai-loop/safe-send-prompt", () => ({
  safeSendPrompt: jest.fn(async () => ({ text: "safe" })),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: jest.fn(() => true),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
}))
jest.mock("@/lib/goal/runtime", () => {
  // Real class so `instanceof` holds inside the module under test; a single
  // stable getOpenGoalForSession mock so tests can configure the default path.
  class GoalImBlocked extends Error {
    conversationKey: string
    adapterId: string
    constructor(ck: string, ad: string) {
      super("blocked")
      this.name = "GoalImBlocked"
      this.conversationKey = ck
      this.adapterId = ad
    }
  }
  const getOpenGoalForSession = jest.fn()
  return { GoalImBlocked, getGoalRuntime: () => ({ getOpenGoalForSession }) }
})

import {
  handleGoalCommand,
  startConnectorGoalDriver,
  __isConnectorGoalDriverRunningForTesting,
  __resetConnectorGoalDriversForTesting,
  __testing__,
} from "./goal"
import { GoalImBlocked, getGoalRuntime } from "@/lib/goal/runtime"
import { dispatchGoalSubcommand } from "@/lib/slash-commands/actions/goal"
import { runGoalLoopHeadless } from "@/lib/scheduler/executors/goal-headless-runner"
import { safeSendPrompt } from "@/lib/connectors/ai-loop/safe-send-prompt"
import { appendAudit } from "@/lib/connectors/audit"
import { hasNoLeakingPii } from "@cognia/redact"
import { CONNECTOR_TURN_TIMEOUT_MS } from "@/lib/connectors/hitl/tool-approval"

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeEvent(): NormalizedInboundEvent {
  return {
    adapterId: "tg",
    platform: "telegram",
    conversationKey: "ck",
    conversationRef: { channelId: "c1" },
    channel: { kind: "group", id: "c1" },
    sender: { id: "p-1", remoteUserId: "u-1" },
    messageId: "m-1",
    timestamp: 7,
  } as unknown as NormalizedInboundEvent
}

function driverArgs(over: Partial<ConnectorGoalDriverArgs> = {}): ConnectorGoalDriverArgs {
  return {
    adapterId: "tg",
    conversationKey: "ck",
    conversationRef: { channelId: "c1" } as unknown as ConnectorGoalDriverArgs["conversationRef"],
    sessionId: "s1",
    goalId: "g1",
    appSettings: null,
    ...over,
  }
}

beforeEach(() => {
  __resetConnectorGoalDriversForTesting()
  ;(dispatchGoalSubcommand as jest.Mock).mockReset()
  ;(runGoalLoopHeadless as jest.Mock).mockReset()
  ;(getGoalRuntime().getOpenGoalForSession as jest.Mock).mockReset()
  jest.mocked(hasNoLeakingPii).mockReset().mockReturnValue(true)
  jest.mocked(safeSendPrompt).mockClear()
  jest.mocked(appendAudit).mockClear()
})

describe("handleGoalCommand", () => {
  it("applies the command, replies, and starts a driver for an active goal", async () => {
    const reply = jest.fn().mockResolvedValue(undefined)
    const startDriver = jest.fn()
    const dispatch = jest.fn().mockResolvedValue({ system: "🎯 Goal active" })
    const getOpenGoal = jest.fn().mockResolvedValue({ id: "g1", status: "active" })
    const ensureSession = jest.fn().mockResolvedValue({ id: "s1" })

    await handleGoalCommand({
      event: fakeEvent(),
      arg: "write a haiku",
      ensureSession,
      reply,
      deps: { dispatch, getOpenGoal, startDriver, appSettings: null },
    })

    // Synthetic slash context carries only what the goal action reads.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ args: "write a haiku", activeSessionId: "s1", chatStatus: "idle" })
    )
    expect(reply).toHaveBeenCalledWith("🎯 Goal active", "applied")
    expect(startDriver).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", goalId: "g1", adapterId: "tg" })
    )
  })

  it("names the /goal sender and the message's delivery target for approval cards", async () => {
    const startDriver = jest.fn()

    await handleGoalCommand({
      event: fakeEvent(),
      arg: "ship it",
      ensureSession: async () => ({ id: "s1" }) as never,
      reply: jest.fn().mockResolvedValue(undefined),
      deps: {
        dispatch: jest.fn().mockResolvedValue({ system: "ok" }),
        getOpenGoal: jest.fn().mockResolvedValue({ id: "g1", status: "active" }),
        startDriver,
        appSettings: null,
      },
    })

    expect(startDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        initiatorUserId: "u-1",
        deliveryTarget: {
          address: {
            conversationKey: "ck",
            platform: "telegram",
            adapterId: "tg",
            scopeKind: "group",
            containerId: "c1",
          },
          conversationRef: { channelId: "c1" },
          sourceMessageId: "m-1",
          refreshedAt: 7,
        },
      })
    )
  })

  it("maps GoalImBlocked to the localized denied reply and starts no driver", async () => {
    const reply = jest.fn().mockResolvedValue(undefined)
    const startDriver = jest.fn()
    const getOpenGoal = jest.fn()
    const dispatch = jest.fn().mockRejectedValue(new GoalImBlocked("ck", "tg"))

    await handleGoalCommand({
      event: fakeEvent(),
      arg: "do it",
      ensureSession: async () => ({ id: "s1" }) as never,
      reply,
      deps: { dispatch, getOpenGoal, startDriver },
    })

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Goal driving isn't enabled"),
      "denied",
      {
        reason: "goal_im_blocked",
      }
    )
    expect(startDriver).not.toHaveBeenCalled()
    expect(getOpenGoal).not.toHaveBeenCalled()
  })

  it("does not start a driver when the resulting goal is not active", async () => {
    const reply = jest.fn().mockResolvedValue(undefined)
    const startDriver = jest.fn()
    const dispatch = jest.fn().mockResolvedValue({ system: "Goal paused." })
    const getOpenGoal = jest.fn().mockResolvedValue({ id: "g1", status: "paused" })

    await handleGoalCommand({
      event: fakeEvent(),
      arg: "pause",
      ensureSession: async () => ({ id: "s1" }) as never,
      reply,
      deps: { dispatch, getOpenGoal, startDriver },
    })

    expect(reply).toHaveBeenCalledWith("Goal paused.", "applied")
    expect(startDriver).not.toHaveBeenCalled()
  })

  it("uses the real default collaborators when deps are omitted", async () => {
    ;(dispatchGoalSubcommand as jest.Mock).mockResolvedValue({ system: "🎯 active" })
    // Never resolves → the default driver stays registered without posting.
    ;(runGoalLoopHeadless as jest.Mock).mockReturnValue(new Promise(() => {}))
    const openGoal = getGoalRuntime().getOpenGoalForSession as jest.Mock
    openGoal.mockResolvedValue({ id: "g1", status: "active" })
    const reply = jest.fn().mockResolvedValue(undefined)

    await handleGoalCommand({
      event: fakeEvent(),
      arg: "do it",
      ensureSession: async () => ({ id: "s1" }) as never,
      reply,
      // no deps → exercises the `?? real` fallbacks (dispatch / getOpenGoal /
      // startDriver / appSettings).
    })

    expect(dispatchGoalSubcommand).toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith("🎯 active", "applied")
    expect(openGoal).toHaveBeenCalledWith("s1")
    // Default startDriver = real startConnectorGoalDriver → registered.
    expect(__isConnectorGoalDriverRunningForTesting("g1")).toBe(true)
  })

  it("builds an inert slash context (composer callbacks are no-ops)", () => {
    const ctx = __testing__.makeInertSlashContext("hi there", "s1")
    expect(ctx.activeSessionId).toBe("s1")
    expect(ctx.args).toBe("hi there")
    expect(ctx.chatStatus).toBe("idle")
    // The composer callbacks are inert by design — invoking them is a no-op.
    expect(() => {
      ctx.startNewSession()
      ctx.openSettings("goals" as never)
      ctx.setPermissionMode(null)
      ctx.pushSystemMessage("x")
    }).not.toThrow()
  })

  it("falls back to a usage hint when the slash action returns null", async () => {
    const reply = jest.fn().mockResolvedValue(undefined)
    const dispatch = jest.fn().mockResolvedValue(null)
    const getOpenGoal = jest.fn().mockResolvedValue(undefined)

    await handleGoalCommand({
      event: fakeEvent(),
      arg: "",
      ensureSession: async () => ({ id: "s1" }) as never,
      reply,
      deps: { dispatch, getOpenGoal, startDriver: jest.fn() },
    })

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Usage"), "applied")
  })
})

describe("startConnectorGoalDriver", () => {
  it("is idempotent — one live driver per goalId", () => {
    const run = jest.fn(() => new Promise(() => {})) // never resolves
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue: jest.fn() })
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue: jest.fn() })
    expect(run).toHaveBeenCalledTimes(1)
    expect(__isConnectorGoalDriverRunningForTesting("g1")).toBe(true)
  })

  it("posts each non-blank turn, then a terminal status line, then cleans up", async () => {
    const enqueue = jest.fn().mockResolvedValue({})
    const run = jest.fn(
      async (opts: { onTurn: (t: string, i: number, g: unknown) => Promise<void> }) => {
        await opts.onTurn("turn one", 1, {})
        await opts.onTurn("   ", 2, {}) // blank → skipped
        return { status: "completed", turns: 2 }
      }
    )
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue })
    await tick()
    await tick()

    const texts = enqueue.mock.calls.map((c) => c[0].request.segments[0].text)
    expect(texts).toContain("turn one")
    expect(texts.some((t: string) => t.includes("completed"))).toBe(true)
    expect(texts).not.toContain("   ")
    expect(__isConnectorGoalDriverRunningForTesting("g1")).toBe(false)
  })

  it("injects the connector PII-gated sender into every headless turn", async () => {
    const run = jest.fn(
      async (opts: {
        sendTurn: (
          sessionId: string,
          prompt: string,
          options: object,
          captureOptions: object
        ) => Promise<unknown>
      }) => {
        await opts.sendTurn("s1", "prompt", {}, { signal: new AbortController().signal })
        return { status: "active", turns: 0, error: "held" }
      }
    )
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue: jest.fn() })
    await tick()
    await tick()

    expect(safeSendPrompt).toHaveBeenCalledWith(
      "s1",
      "prompt",
      {},
      expect.objectContaining({ adapterId: "tg", conversationKey: "ck" })
    )
  })

  it("drives the loop with no workspace and pacing on, like the conversation's other turns", () => {
    const run = jest.fn(() => new Promise(() => {})) // never resolves
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue: jest.fn() })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        goalId: "g1",
        workspace: "none",
        pacing: { enabled: true },
      })
    )
  })

  it("fails closed and audits when generated output contains PII", async () => {
    jest.mocked(hasNoLeakingPii).mockReturnValue(false)
    const enqueue = jest.fn()
    const run = jest.fn(async (opts: { onTurn: (text: string) => Promise<void> }) => {
      await opts.onTurn("jane@example.com")
      return { status: "active", turns: 1 }
    })

    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue })
    await tick()
    await tick()

    expect(enqueue).not.toHaveBeenCalled()
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "pii_blocked", conversationKey: "ck" })
    )
  })

  it("posts no terminal line for a non-terminal (held/paused) result", async () => {
    const enqueue = jest.fn().mockResolvedValue({})
    const run = jest.fn(
      async (opts: { onTurn: (t: string, i: number, g: unknown) => Promise<void> }) => {
        await opts.onTurn("t1", 1, {})
        return { status: "active", turns: 1, error: "held" }
      }
    )
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue })
    await tick()
    await tick()

    const texts = enqueue.mock.calls.map((c) => c[0].request.segments[0].text)
    expect(texts).toEqual(["t1"])
  })

  it("says so when the goal paused for approval, naming each tool once", async () => {
    const enqueue = jest.fn().mockResolvedValue({})
    const run = jest.fn(async () => ({
      status: "paused",
      turns: 1,
      exit: "needs_approval",
      error: "needs approval: Edit, Bash",
      needsApproval: [
        { requestId: "r1", toolName: "Edit", at: 1, reason: "x" },
        { requestId: "r2", toolName: "Bash", at: 2, reason: "x" },
        { requestId: "r3", toolName: "Edit", at: 3, reason: "x" },
      ],
    }))
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue })
    await tick()
    await tick()

    const texts = enqueue.mock.calls.map((c) => c[0].request.segments[0].text)
    expect(texts).toEqual([
      "⏸️ 目标已暂停:工具需要授权 (Edit, Bash),发送 /goal resume 重新请求 / " +
        "Goal paused — tools need approval: Edit, Bash. Send /goal resume to ask again.",
    ])
  })

  it("posts nothing for a pause that is not about approval", async () => {
    const enqueue = jest.fn().mockResolvedValue({})
    const run = jest.fn(async () => ({
      status: "paused",
      turns: 3,
      exit: "judge_failed_too_many",
    }))
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue })
    await tick()
    await tick()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("swallows a driver failure and clears the running registry", async () => {
    const run = jest.fn().mockRejectedValue(new Error("boom"))
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue: jest.fn() })
    await tick()
    await tick()
    expect(__isConnectorGoalDriverRunningForTesting("g1")).toBe(false)
  })
})

describe("startConnectorGoalDriver — IM tool approvals", () => {
  const request = {
    type: "permission_request",
    sessionId: "s1",
    requestId: "req-1",
    toolUseID: "tu-1",
    toolName: "Bash",
    input: {},
  } as unknown as PermissionRequestEvent
  const deliveryTarget = {
    address: {
      conversationKey: "ck",
      platform: "telegram",
      adapterId: "tg",
      scopeKind: "group",
      containerId: "c1",
    },
    conversationRef: { channelId: "c1" },
    sourceMessageId: "m-1",
    refreshedAt: 7,
  } as unknown as ConversationDeliveryTarget

  /** Start a driver whose run never ends, and hand back what it gave the runner. */
  function startCapturing(deps: Parameters<typeof startConnectorGoalDriver>[1] = {}) {
    const run = jest.fn((_input: RunGoalLoopInput) => new Promise<never>(() => {}))
    startConnectorGoalDriver(driverArgs({ initiatorUserId: "u-1", deliveryTarget }), {
      run: run as never,
      enqueue: jest.fn(),
      ...deps,
    })
    return run.mock.calls[0][0]
  }

  it("gives each turn room for a human approval, like an ordinary IM turn", () => {
    const input = startCapturing()
    expect(input.perTurnTimeoutMs).toBe(CONNECTOR_TURN_TIMEOUT_MS)
    expect(input.onPermissionRequest).toEqual(expect.any(Function))
  })

  it("asks the conversation through the IM approval card", async () => {
    const imResponder = jest.fn(async () => ({ decision: "allow" as const }))
    const makeResponder = jest.fn(() => imResponder)
    const readOverride = jest.fn(async () => ({ approvalMode: "prompt" }) as never)
    const signal = new AbortController().signal
    const unattended = jest.fn()

    const input = startCapturing({ makeResponder, readOverride, signal })
    const decision = await input.onPermissionRequest!(request, unattended)

    expect(readOverride).toHaveBeenCalledWith("ck")
    expect(makeResponder).toHaveBeenCalledWith({
      sessionId: "s1",
      adapterId: "tg",
      conversationKey: "ck",
      conversationRef: { channelId: "c1" },
      deliveryTarget,
      initiatorUserId: "u-1",
      approvalMode: "prompt",
      signal,
      // A card nobody answers falls back to the runner's unattended denial.
      onUnanswered: unattended,
    })
    expect(imResponder).toHaveBeenCalledWith(request)
    expect(decision).toEqual({ decision: "allow" })
    // The human decided; the unattended fallback was not consulted.
    expect(unattended).not.toHaveBeenCalled()
  })

  it("reads the approval mode fresh for each request, so /mode applies mid-goal", async () => {
    const makeResponder = jest.fn(() => async () => ({ decision: "allow" as const }))
    const readOverride = jest
      .fn()
      .mockResolvedValueOnce({ approvalMode: "yolo" })
      .mockResolvedValueOnce({ approvalMode: "prompt" })

    const input = startCapturing({ makeResponder, readOverride })
    await input.onPermissionRequest!(request, jest.fn())
    await input.onPermissionRequest!(request, jest.fn())

    expect(makeResponder.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ approvalMode: "yolo" }),
      expect.objectContaining({ approvalMode: "prompt" }),
    ])
  })

  it("asks when the conversation has no override or it cannot be read", async () => {
    const makeResponder = jest.fn(() => async () => ({ decision: "deny" as const }))
    const readOverride = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("dexie down"))

    const input = startCapturing({ makeResponder, readOverride })
    await input.onPermissionRequest!(request, jest.fn())
    await input.onPermissionRequest!(request, jest.fn())

    for (const call of makeResponder.mock.calls) {
      expect((call as unknown[])[0]).toEqual(expect.objectContaining({ approvalMode: undefined }))
    }
  })

  it("scopes the card to operators when the /goal sender is unknown", async () => {
    const makeResponder = jest.fn(() => async () => ({ decision: "allow" as const }))
    const run = jest.fn((_input: RunGoalLoopInput) => new Promise<never>(() => {}))
    startConnectorGoalDriver(driverArgs(), {
      run: run as never,
      enqueue: jest.fn(),
      makeResponder,
      readOverride: jest.fn(async () => undefined),
    })

    await run.mock.calls[0][0].onPermissionRequest!(request, jest.fn())
    const ctx = (makeResponder.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(ctx).not.toHaveProperty("initiatorUserId")
    expect(ctx).not.toHaveProperty("deliveryTarget")
  })
})
