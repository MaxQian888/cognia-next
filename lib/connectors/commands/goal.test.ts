import type { NormalizedInboundEvent } from "@/types/connectors/event"
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
  isConnectorGoalDriverRunning,
  __resetConnectorGoalDriversForTesting,
  __testing__,
} from "./goal"
import { GoalImBlocked, getGoalRuntime } from "@/lib/goal/runtime"
import { dispatchGoalSubcommand } from "@/lib/slash-commands/actions/goal"
import { runGoalLoopHeadless } from "@/lib/scheduler/executors/goal-headless-runner"
import { safeSendPrompt } from "@/lib/connectors/ai-loop/safe-send-prompt"
import { appendAudit } from "@/lib/connectors/audit"
import { hasNoLeakingPii } from "@cognia/redact"

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeEvent(): NormalizedInboundEvent {
  return {
    adapterId: "tg",
    conversationKey: "ck",
    conversationRef: { channelId: "c1" },
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
    expect(isConnectorGoalDriverRunning("g1")).toBe(true)
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
    expect(isConnectorGoalDriverRunning("g1")).toBe(true)
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
    expect(isConnectorGoalDriverRunning("g1")).toBe(false)
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

  it("swallows a driver failure and clears the running registry", async () => {
    const run = jest.fn().mockRejectedValue(new Error("boom"))
    startConnectorGoalDriver(driverArgs(), { run: run as never, enqueue: jest.fn() })
    await tick()
    await tick()
    expect(isConnectorGoalDriverRunning("g1")).toBe(false)
  })
})
