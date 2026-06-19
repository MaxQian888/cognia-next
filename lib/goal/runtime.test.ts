import "fake-indexeddb/auto"
import type { AppSettings } from "@/lib/claude/types"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { listGoalEvents } from "@/lib/db/goals"
const onGoalTerminalMock = jest.fn().mockResolvedValue(undefined)
jest.mock("./completion-linkage", () => ({
  onGoalTerminal: (...a: unknown[]) => onGoalTerminalMock(...a),
  toGoalHookPayload: (g: unknown) => g,
}))

import {
  DEFAULT_GOAL_CONFIG,
  __resetGoalRuntimeForTesting,
  getGoalRuntime,
  resolveGoalConfig,
} from "./runtime"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
  onGoalTerminalMock.mockClear()
})

describe("resolveGoalConfig", () => {
  it("returns hard-coded defaults when AppSettings is null", () => {
    expect(resolveGoalConfig(null)).toEqual(DEFAULT_GOAL_CONFIG)
  })

  it("uses AppSettings.goals values when present", () => {
    const settings = { goals: { maxTurns: 50, timeoutMs: 60_000 } } as unknown as AppSettings
    const out = resolveGoalConfig(settings)
    expect(out.maxTurns).toBe(50)
    expect(out.timeoutMs).toBe(60_000)
    // Unspecified fields fall back to defaults
    expect(out.maxTokens).toBe(DEFAULT_GOAL_CONFIG.maxTokens)
    expect(out.maxJudgeFailures).toBe(DEFAULT_GOAL_CONFIG.maxJudgeFailures)
  })

  it("overrides win over settings", () => {
    const settings = { goals: { maxTurns: 50 } } as unknown as AppSettings
    const out = resolveGoalConfig(settings, { maxTurns: 10 })
    expect(out.maxTurns).toBe(10)
  })

  it("resolves maxBudgetUsd from override > defaults, undefined when neither set", () => {
    expect(resolveGoalConfig(null).maxBudgetUsd).toBeUndefined()
    const fromDefaults = { goals: { maxBudgetUsd: 5 } } as unknown as AppSettings
    expect(resolveGoalConfig(fromDefaults).maxBudgetUsd).toBe(5)
    expect(resolveGoalConfig(fromDefaults, { maxBudgetUsd: 2 }).maxBudgetUsd).toBe(2)
  })

  it("preserves inlineStopCondition from overrides", () => {
    const out = resolveGoalConfig(null, { inlineStopCondition: "or after 2h" })
    expect(out.inlineStopCondition).toBe("or after 2h")
  })

  it("merges judge + pacing fields from settings (ADR-0019 Phase 2)", () => {
    const settings = {
      goals: {
        judgeModel: "claude-haiku-4-5",
        judgeProvider: "anthropic",
        judgeTemperature: 0.2,
        judgeMaxTokens: 120,
        manualContinue: true,
        continuationIntervalMs: 5_000,
        quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
      },
    } as unknown as AppSettings
    const out = resolveGoalConfig(settings)
    expect(out.judgeModel).toBe("claude-haiku-4-5")
    expect(out.judgeProvider).toBe("anthropic")
    expect(out.judgeTemperature).toBe(0.2)
    expect(out.judgeMaxTokens).toBe(120)
    expect(out.manualContinue).toBe(true)
    expect(out.continuationIntervalMs).toBe(5_000)
    expect(out.quietHours).toEqual({ from: "22:00", to: "07:00", tz: "UTC" })
  })

  it("per-goal overrides win over settings for judge/pacing fields", () => {
    const settings = { goals: { judgeModel: "haiku" } } as unknown as AppSettings
    const out = resolveGoalConfig(settings, { judgeModel: "opus", manualContinue: true })
    expect(out.judgeModel).toBe("opus")
    expect(out.manualContinue).toBe(true)
  })
})

describe("GoalRuntime.createGoal", () => {
  it("creates a fresh row with active status and a generationId", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_a", rawObjective: "write a haiku" })
    expect(goal.status).toBe("active")
    expect(goal.generationId).toMatch(/^[0-9a-f]{8}-/)
    expect(goal.turnsUsed).toBe(0)
    expect(goal.tokensUsed).toBe(0)
  })

  it("redacts the objective into safeObjective", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({
      sessionId: "ses_a",
      rawObjective: "ping alice@example.com",
    })
    expect(goal.rawObjective).toBe("ping alice@example.com")
    expect(goal.safeObjective).toContain("<EMAIL_001>")
    expect(goal.redactionMapEnc).not.toBe("")
  })

  it("logs a goal_created event", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const events = await listGoalEvents(goal.id)
    expect(events.some((e) => e.kind === "goal_created")).toBe(true)
  })

  it("auto-terminates an existing open goal before creating a new one", async () => {
    const rt = getGoalRuntime()
    const first = await rt.createGoal({ sessionId: "ses_a", rawObjective: "first" })
    expect(first.status).toBe("active")
    const second = await rt.createGoal({ sessionId: "ses_a", rawObjective: "second" })
    expect(second.id).not.toBe(first.id)
    const firstAfter = await rt.getActiveGoalForSession("ses_a")
    expect(firstAfter?.id).toBe(second.id)
    const firstEvents = await listGoalEvents(first.id)
    expect(firstEvents.some((e) => e.kind === "user_stopped")).toBe(true)
  })

  it("creates a paused goal when startPaused is true", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({
      sessionId: "ses_a",
      rawObjective: "x",
      startPaused: true,
    })
    expect(goal.status).toBe("paused")
  })

  it("applies caller config overrides", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({
      sessionId: "ses_a",
      rawObjective: "x",
      config: { maxTurns: 5 },
    })
    expect(goal.config.maxTurns).toBe(5)
  })
})

// ── v49 — /goal × IM guardrail (inbox-optimization plan) ──────────────
//
// Goals targeting an IM-bound session must check the conversation
// override for `allowGoalDriving`. Off → throw GoalImBlocked + audit
// `goal.blocked.im`. On → audit `goal.started.im` and proceed.
// Non-IM sessions ignore the field entirely.
describe("GoalRuntime.createGoal — IM guardrail", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoalImBlocked } = require("./runtime") as {
    GoalImBlocked: new (...a: unknown[]) => Error
  }

  async function seedImSession(overrides?: { allowGoalDriving?: boolean }): Promise<void> {
    const db = getDb()
    const now = Date.now()
    await db.sessions.put({
      id: "ses_im",
      title: "TG chat",
      modelId: "claude-sonnet-4-6",
      providerId: "anthropic",
      systemPrompt: "",
      kind: "direct",
      platformBinding: {
        platform: "telegram",
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:42",
      },
      createdAt: now,
      updatedAt: now,
    } as unknown as Parameters<typeof db.sessions.put>[0])

    if (overrides && typeof overrides.allowGoalDriving === "boolean") {
      await db.conversationOverrides.put({
        id: "co-im",
        conversationKey: "telegram:tg-1:42",
        sessionId: "ses_im",
        allowGoalDriving: overrides.allowGoalDriving,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  it("throws GoalImBlocked + writes audit when IM session has no override", async () => {
    await seedImSession()
    const rt = getGoalRuntime()
    await expect(
      rt.createGoal({ sessionId: "ses_im", rawObjective: "auto-reply spam" })
    ).rejects.toBeInstanceOf(GoalImBlocked)

    const audit = await getDb().connectorAudit.where("kind").equals("goal.blocked.im").toArray()
    expect(audit).toHaveLength(1)
    expect(audit[0].adapterId).toBe("tg-1")
    expect(audit[0].conversationKey).toBe("telegram:tg-1:42")
    expect(audit[0].reason).toBe("allow_goal_driving_off")
  })

  it("throws when override exists but allowGoalDriving is false", async () => {
    await seedImSession({ allowGoalDriving: false })
    const rt = getGoalRuntime()
    await expect(rt.createGoal({ sessionId: "ses_im", rawObjective: "x" })).rejects.toBeInstanceOf(
      GoalImBlocked
    )
  })

  it("allows the goal + writes audit when override opts in", async () => {
    await seedImSession({ allowGoalDriving: true })
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_im", rawObjective: "summarise channel" })
    expect(goal.status).toBe("active")

    const audit = await getDb().connectorAudit.where("kind").equals("goal.started.im").toArray()
    expect(audit).toHaveLength(1)
    expect(audit[0].adapterId).toBe("tg-1")
  })

  it("non-IM sessions are not gated", async () => {
    // No platformBinding — the guard short-circuits and the goal starts.
    const rt = getGoalRuntime()
    await expect(
      rt.createGoal({ sessionId: "ses_direct", rawObjective: "fine" })
    ).resolves.toMatchObject({ status: "active" })
    // No audit rows for IM kinds.
    const blocked = await getDb().connectorAudit.where("kind").equals("goal.blocked.im").count()
    const started = await getDb().connectorAudit.where("kind").equals("goal.started.im").count()
    expect(blocked + started).toBe(0)
  })
})

describe("GoalRuntime — pause/resume/stop transitions", () => {
  it("pauseGoal: active → paused, rotates generationId, logs event", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const paused = await rt.pauseGoal(g.id)
    expect(paused?.status).toBe("paused")
    expect(paused?.generationId).not.toBe(g.generationId)
    const events = await listGoalEvents(g.id)
    expect(events.some((e) => e.kind === "user_paused")).toBe(true)
  })

  it("pauseGoal is a no-op when status is not active", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x", startPaused: true })
    const out = await rt.pauseGoal(g.id)
    expect(out?.status).toBe("paused")
    // event count unchanged (still just goal_created)
    const events = await listGoalEvents(g.id)
    expect(events.filter((e) => e.kind === "user_paused")).toHaveLength(0)
  })

  it("resumeGoal: paused → active", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x", startPaused: true })
    const resumed = await rt.resumeGoal(g.id)
    expect(resumed?.status).toBe("active")
    expect(resumed?.generationId).not.toBe(g.generationId)
    const events = await listGoalEvents(g.id)
    expect(events.some((e) => e.kind === "user_resumed")).toBe(true)
  })

  it("resumeGoal is a no-op when status is not paused", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await rt.resumeGoal(g.id)
    expect(out?.status).toBe("active")
  })

  it("stopGoal: any non-terminal → stopped, fires abort", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const ac = new AbortController()
    rt.registerAbortController(g.id, ac)
    const stopped = await rt.stopGoal(g.id)
    expect(stopped?.status).toBe("stopped")
    expect(stopped?.endedAt).toBeGreaterThan(0)
    expect(ac.signal.aborted).toBe(true)
    // Completion linkage (ADR-0019 Phase 2) fires on the terminal transition.
    expect(onGoalTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: g.id, status: "stopped" })
    )
  })

  it("stopGoal is a no-op for terminal goals", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await rt.stopGoal(g.id)
    const second = await rt.stopGoal(g.id)
    expect(second?.status).toBe("stopped")
  })

  it("preemptGoal: active → preempted with exit_triggered event", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await rt.preemptGoal(g.id)
    expect(out?.status).toBe("preempted")
    const events = await listGoalEvents(g.id)
    const exitEvent = events.find((e) => e.kind === "exit_triggered")
    expect(exitEvent).toBeDefined()
    if (exitEvent?.payload.kind === "exit_triggered") {
      expect(exitEvent.payload.exit).toBe("preempted")
    }
    expect(onGoalTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: g.id, status: "preempted" })
    )
  })

  it("returns null for missing goal ids on every transition", async () => {
    const rt = getGoalRuntime()
    expect(await rt.pauseGoal("missing")).toBeNull()
    expect(await rt.resumeGoal("missing")).toBeNull()
    expect(await rt.stopGoal("missing")).toBeNull()
    expect(await rt.preemptGoal("missing")).toBeNull()
  })
})

describe("GoalRuntime.updateObjective", () => {
  it("rotates generationId + logs objective_updated + returns update prompt", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "old" })
    const out = await rt.updateObjective(g.id, "new objective text")
    expect(out).not.toBeNull()
    if (!out) return
    expect(out.goal.generationId).not.toBe(g.generationId)
    expect(out.goal.safeObjective).toBe("new objective text")
    expect(out.updatePrompt).toMatch(/<untrusted_objective>/)
    expect(out.updatePrompt).toContain("new objective text")
    const events = await listGoalEvents(g.id)
    expect(events.some((e) => e.kind === "objective_updated")).toBe(true)
  })

  it("resets judgeFailureCount when updating objective", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "old" })
    // manually bump failure count via the runtime's internal CRUD
    const { updateGoal } = await import("@/lib/db/goals")
    await updateGoal(g.id, { judgeFailureCount: 2 })
    const out = await rt.updateObjective(g.id, "new objective text")
    expect(out?.goal.judgeFailureCount).toBe(0)
  })

  it("returns null when the new objective is identical (no-op)", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "same" })
    const out = await rt.updateObjective(g.id, "same")
    expect(out).toBeNull()
  })

  it("returns null for missing or terminal goals", async () => {
    const rt = getGoalRuntime()
    expect(await rt.updateObjective("missing", "x")).toBeNull()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await rt.stopGoal(g.id)
    expect(await rt.updateObjective(g.id, "new")).toBeNull()
  })
})

describe("GoalRuntime.updateConfig", () => {
  it("patches config without rotating generationId", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const patched = await rt.updateConfig(g.id, { maxTurns: 50 })
    expect(patched?.config.maxTurns).toBe(50)
    expect(patched?.generationId).toBe(g.generationId)
    const events = await listGoalEvents(g.id)
    expect(events.some((e) => e.kind === "config_updated")).toBe(true)
  })

  it("returns null for missing goals; no-op for terminal ones", async () => {
    const rt = getGoalRuntime()
    expect(await rt.updateConfig("missing", { maxTurns: 5 })).toBeNull()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await rt.stopGoal(g.id)
    const out = await rt.updateConfig(g.id, { maxTurns: 5 })
    expect(out?.status).toBe("stopped")
    expect(out?.config.maxTurns).not.toBe(5)
  })
})

describe("GoalRuntime — abort controller registry", () => {
  it("unregister callback removes the registration", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const ac = new AbortController()
    const unreg = rt.registerAbortController(g.id, ac)
    unreg()
    // Pause should NOT abort an already-unregistered controller
    await rt.pauseGoal(g.id)
    expect(ac.signal.aborted).toBe(false)
  })

  it("re-registering the same goal replaces the prior controller", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const ac1 = new AbortController()
    rt.registerAbortController(g.id, ac1)
    const ac2 = new AbortController()
    rt.registerAbortController(g.id, ac2)
    await rt.stopGoal(g.id)
    expect(ac2.signal.aborted).toBe(true)
    // ac1 was overwritten — it never gets aborted by this stop
    expect(ac1.signal.aborted).toBe(false)
  })
})

describe("GoalRuntime — pass-through readers + delete", () => {
  it("getActiveGoalForSession / listGoalsBySession honour session boundaries", async () => {
    const rt = getGoalRuntime()
    await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await rt.createGoal({ sessionId: "ses_b", rawObjective: "y" })
    expect(await rt.getActiveGoalForSession("ses_a")).toBeDefined()
    const list = await rt.listGoalsBySession("ses_a")
    expect(list.every((g) => g.sessionId === "ses_a")).toBe(true)
  })

  it("deleteGoal fires the abort controller", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const ac = new AbortController()
    rt.registerAbortController(g.id, ac)
    await rt.deleteGoal(g.id)
    expect(ac.signal.aborted).toBe(true)
    const { getGoal } = await import("@/lib/db/goals")
    expect(await getGoal(g.id)).toBeUndefined()
  })
})

describe("GoalRuntime — subgoals", () => {
  function client(complete: jest.Mock) {
    return { complete }
  }

  it("generateSubgoals decomposes, persists, and logs an event", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_a", rawObjective: "ship it" })
    const complete = jest.fn().mockResolvedValue('{"steps": ["Plan", "Build", "Verify"]}')
    const updated = await rt.generateSubgoals(goal.id, client(complete))
    expect(updated?.subgoals?.map((s) => s.text)).toEqual(["Plan", "Build", "Verify"])
    expect(updated?.subgoalsGeneratedAt).toBeGreaterThan(0)
    const events = await listGoalEvents(goal.id)
    const ev = events.find((e) => e.kind === "subgoals_generated")
    expect(ev?.payload).toMatchObject({ kind: "subgoals_generated", count: 3 })
  })

  it("generateSubgoals fails OPEN — keeps the prior checklist on empty output", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_a", rawObjective: "ship it" })
    await rt.generateSubgoals(goal.id, client(jest.fn().mockResolvedValue('{"steps": ["A"]}')))
    const after = await rt.generateSubgoals(goal.id, client(jest.fn().mockResolvedValue("garbage")))
    expect(after?.subgoals?.map((s) => s.text)).toEqual(["A"])
  })

  it("returns null when the goal is missing", async () => {
    const rt = getGoalRuntime()
    expect(await rt.generateSubgoals("nope", client(jest.fn()))).toBeNull()
  })

  it("toggleSubgoal flips a single step's done flag", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_a", rawObjective: "ship it" })
    const withSubs = await rt.generateSubgoals(
      goal.id,
      client(jest.fn().mockResolvedValue('{"steps": ["A", "B"]}'))
    )
    const targetId = withSubs!.subgoals![0].id
    const toggled = await rt.toggleSubgoal(goal.id, targetId)
    expect(toggled?.subgoals?.find((s) => s.id === targetId)?.done).toBe(true)
    const back = await rt.toggleSubgoal(goal.id, targetId)
    expect(back?.subgoals?.find((s) => s.id === targetId)?.done).toBe(false)
  })

  it("clearSubgoals empties the checklist", async () => {
    const rt = getGoalRuntime()
    const goal = await rt.createGoal({ sessionId: "ses_a", rawObjective: "ship it" })
    await rt.generateSubgoals(goal.id, client(jest.fn().mockResolvedValue('{"steps": ["A"]}')))
    const cleared = await rt.clearSubgoals(goal.id)
    expect(cleared?.subgoals).toEqual([])
  })
})

describe("GoalRuntime — singleton lifecycle", () => {
  it("getGoalRuntime() returns the same instance", () => {
    const a = getGoalRuntime()
    const b = getGoalRuntime()
    expect(a).toBe(b)
  })

  it("__resetGoalRuntimeForTesting forces a fresh instance", () => {
    const a = getGoalRuntime()
    __resetGoalRuntimeForTesting()
    const b = getGoalRuntime()
    expect(a).not.toBe(b)
  })
})

describe("resolveGoalConfig — promise gate + adaptive pacing", () => {
  it("merges maxPromiseDenials and adaptivePacing from settings", () => {
    const settings = {
      goals: { maxPromiseDenials: 5, adaptivePacing: true },
    } as unknown as AppSettings
    const out = resolveGoalConfig(settings)
    expect(out.maxPromiseDenials).toBe(5)
    expect(out.adaptivePacing).toBe(true)
  })

  it("takes completionPromise from overrides only (never a global default)", () => {
    const settings = {
      goals: { completionPromise: "GLOBAL TOKEN" },
    } as unknown as AppSettings
    expect(resolveGoalConfig(settings).completionPromise).toBeUndefined()
    expect(resolveGoalConfig(settings, { completionPromise: "PER GOAL" }).completionPromise).toBe(
      "PER GOAL"
    )
  })

  it("per-goal overrides win for the new fields", () => {
    const settings = {
      goals: { maxPromiseDenials: 5, adaptivePacing: true },
    } as unknown as AppSettings
    const out = resolveGoalConfig(settings, { maxPromiseDenials: 2, adaptivePacing: false })
    expect(out.maxPromiseDenials).toBe(2)
    expect(out.adaptivePacing).toBe(false)
  })
})

describe("GoalRuntime.updateObjective — promise gate reset", () => {
  it("clears awaitingPromise and promiseDenialCount on objective change", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "old objective" })
    const { updateGoal: patchGoal, getGoal: readGoal } = await import("@/lib/db/goals")
    await patchGoal(g.id, { awaitingPromise: true, promiseDenialCount: 2 })
    const out = await rt.updateObjective(g.id, "completely new objective")
    expect(out).not.toBeNull()
    const updated = await readGoal(g.id)
    expect(updated?.awaitingPromise).toBe(false)
    expect(updated?.promiseDenialCount).toBe(0)
  })
})

describe("GoalRuntime.recordPacingDecision", () => {
  it("stamps nextContinuationAt + source and logs pacing_decided on defer", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const untilMs = Date.now() + 120_000
    await rt.recordPacingDecision(
      g.id,
      { kind: "defer", untilMs, reason: "model_suggested" },
      300_000
    )
    const { getGoal: readGoal } = await import("@/lib/db/goals")
    const updated = await readGoal(g.id)
    expect(updated?.nextContinuationAt).toBe(untilMs)
    expect(updated?.nextContinuationSource).toBe("model_suggested")
    const events = await listGoalEvents(g.id)
    const pacing = events.find((e) => e.kind === "pacing_decided")
    expect(pacing).toBeDefined()
    if (pacing?.payload.kind !== "pacing_decided") throw new Error("payload mismatch")
    expect(pacing.payload.source).toBe("model_suggested")
    expect(pacing.payload.untilMs).toBe(untilMs)
    expect(pacing.payload.suggestedMs).toBe(300_000)
  })

  it("clears the stamp on send without logging an event", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await rt.recordPacingDecision(
      g.id,
      { kind: "defer", untilMs: Date.now() + 1_000, reason: "interval" },
      undefined
    )
    await rt.recordPacingDecision(g.id, { kind: "send" })
    const { getGoal: readGoal } = await import("@/lib/db/goals")
    const updated = await readGoal(g.id)
    expect(updated?.nextContinuationAt).toBeUndefined()
    expect(updated?.nextContinuationSource).toBeUndefined()
    const events = await listGoalEvents(g.id)
    expect(events.filter((e) => e.kind === "pacing_decided")).toHaveLength(1)
  })

  it("is a no-op for hold and never throws on a missing goal", async () => {
    const rt = getGoalRuntime()
    const g = await rt.createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await rt.recordPacingDecision(g.id, { kind: "hold", reason: "manual" })
    const { getGoal: readGoal } = await import("@/lib/db/goals")
    expect((await readGoal(g.id))?.nextContinuationAt).toBeUndefined()
    await expect(rt.recordPacingDecision("missing-goal", { kind: "send" })).resolves.toBeUndefined()
  })
})
