import "fake-indexeddb/auto"
import type { AppSettings } from "@/lib/claude/types"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { listGoalEvents } from "@/lib/db/goals"
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

  it("preserves inlineStopCondition from overrides", () => {
    const out = resolveGoalConfig(null, { inlineStopCondition: "or after 2h" })
    expect(out.inlineStopCondition).toBe("or after 2h")
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
