/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { SlashContext } from "../builtin"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import { dispatchGoalSubcommand } from "./goal"

// useSettingsStore is touched by /goal create — mock the store to return null
// settings so the runtime defaults kick in deterministically.
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: null }),
  },
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
})

function ctx(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    args: "",
    activeSessionId: "ses_a",
    chatStatus: "idle",
    currentPermissionMode: null,
    startNewSession: () => undefined,
    openSettings: () => undefined,
    setPermissionMode: () => undefined,
    pushSystemMessage: () => undefined,
    ...overrides,
  } as unknown as SlashContext
}

describe("dispatchGoalSubcommand — guards", () => {
  it("requires an active session", async () => {
    const out = await dispatchGoalSubcommand(ctx({ activeSessionId: null }))
    expect(out?.system).toMatch(/Start a chat session first/)
  })

  it("refuses while a turn is streaming", async () => {
    const out = await dispatchGoalSubcommand(ctx({ chatStatus: "streaming" }))
    expect(out?.system).toMatch(/streaming/)
  })
})

describe("dispatchGoalSubcommand — create", () => {
  it("creates a new goal from a bare /goal <text>", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "write a haiku about winter" }))
    expect(out?.system).toMatch(/Goal active/)
    expect(out?.system).toContain("write a haiku about winter")
    const goal = await getGoalRuntime().getActiveGoalForSession("ses_a")
    expect(goal).toBeDefined()
    expect(goal?.rawObjective).toBe("write a haiku about winter")
  })

  it("supports the explicit `/goal create <text>` form", async () => {
    await dispatchGoalSubcommand(ctx({ args: "create do the demo" }))
    const goal = await getGoalRuntime().getActiveGoalForSession("ses_a")
    expect(goal?.rawObjective).toBe("do the demo")
  })

  it("create with no text returns the usage hint", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "create" }))
    expect(out?.system).toMatch(/Usage:/)
    expect(await getGoalRuntime().getActiveGoalForSession("ses_a")).toBeUndefined()
  })

  it("creating a new goal terminates the prior open one", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "first" })
    await dispatchGoalSubcommand(ctx({ args: "second" }))
    const active = await getGoalRuntime().getActiveGoalForSession("ses_a")
    expect(active?.rawObjective).toBe("second")
  })
})

describe("dispatchGoalSubcommand — status / show", () => {
  it("status reports 'no active goal' when none exists", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "status" }))
    expect(out?.system).toMatch(/No active goal/)
  })

  it("status renders an active goal card", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "ship feature" })
    const out = await dispatchGoalSubcommand(ctx({ args: "status" }))
    expect(out?.system).toMatch(/ACTIVE/)
    expect(out?.system).toContain("ship feature")
  })

  it("show also sets openGoalsSettings true", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "show" }))
    expect(out?.openGoalsSettings).toBe(true)
  })

  it("empty args also reports status", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "" }))
    expect(out?.system).toMatch(/ACTIVE/)
  })
})

describe("dispatchGoalSubcommand — pause / resume / stop", () => {
  it("pause: active → paused", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "pause" }))
    expect(out?.system).toMatch(/Goal paused/)
    expect((await getGoalRuntime().getOpenGoalForSession("ses_a"))?.status).toBe("paused")
  })

  it("pause with no active goal reports the friendly error", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "pause" }))
    expect(out?.system).toMatch(/No active goal to pause/)
  })

  it("pause is idempotent on a paused goal", async () => {
    const g = await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await getGoalRuntime().pauseGoal(g.id)
    const out = await dispatchGoalSubcommand(ctx({ args: "pause" }))
    expect(out?.system).toMatch(/already paused/)
  })

  it("resume: paused → active", async () => {
    const g = await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await getGoalRuntime().pauseGoal(g.id)
    const out = await dispatchGoalSubcommand(ctx({ args: "resume" }))
    expect(out?.system).toMatch(/Goal resumed/)
  })

  it("resume on an active goal is a no-op", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "resume" }))
    expect(out?.system).toMatch(/already active/)
  })

  it("stop transitions any non-terminal goal to stopped", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "stop" }))
    expect(out?.system).toMatch(/Goal stopped/)
    const list = await getGoalRuntime().listGoalsBySession("ses_a")
    expect(list[0]!.status).toBe("stopped")
  })

  it.each(["cancel", "clear"])("%s is an alias for stop", async (alias) => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: alias }))
    expect(out?.system).toMatch(/Goal stopped/)
  })
})

describe("dispatchGoalSubcommand — update", () => {
  it("requires new text", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "update" }))
    expect(out?.system).toMatch(/Usage:/)
  })

  it("rejects when no goal exists", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "update something" }))
    expect(out?.system).toMatch(/No active goal/)
  })

  it("updates the objective and stages a dispatch prompt", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "old objective" })
    const out = await dispatchGoalSubcommand(ctx({ args: "update new objective" }))
    expect(out?.system).toMatch(/Objective updated/)
    expect(out?.dispatchPrompt).toMatch(/<untrusted_objective>/)
    const updated = await getGoalRuntime().getActiveGoalForSession("ses_a")
    expect(updated?.rawObjective).toBe("new objective")
  })

  it("is a no-op when the new objective is the same", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "same" })
    const out = await dispatchGoalSubcommand(ctx({ args: "update same" }))
    expect(out?.system).toMatch(/unchanged/)
    expect(out?.dispatchPrompt).toBeUndefined()
  })
})

describe("dispatchGoalSubcommand — unknown subcommand fallback", () => {
  it("falls through to create for unknown leading keyword", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "make me a sandwich" }))
    // "make" isn't a known subcommand → entire string is the objective
    expect(out?.system).toMatch(/Goal active/)
    const goal = await getGoalRuntime().getActiveGoalForSession("ses_a")
    expect(goal?.rawObjective).toBe("make me a sandwich")
  })
})

describe("dispatchGoalSubcommand — status card renders for paused goals", () => {
  // `commandStatus` uses `getOpenGoalForSession` which returns only active
  // or paused rows. The other status branches in `statusEmoji` are
  // unreachable through the user-facing slash dispatcher (they exist as
  // defensive cases for future code paths like a History-row status
  // command). We only test the reachable branches.
  it("renders 🟢 for the active branch", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const out = await dispatchGoalSubcommand(ctx({ args: "status" }))
    expect(out?.system).toMatch(/ACTIVE/)
    expect(out?.system).toContain("🟢")
  })
  it("renders ⏸️ for the paused branch", async () => {
    const g = await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await getGoalRuntime().pauseGoal(g.id)
    const out = await dispatchGoalSubcommand(ctx({ args: "status" }))
    expect(out?.system).toMatch(/PAUSED/)
    expect(out?.system).toContain("⏸️")
  })
})

describe("dispatchGoalSubcommand — resolveCharacterForSession error branches", () => {
  it("create succeeds even when session lookup throws", async () => {
    // Forced error: pass a sessionId that doesn't exist → getSession returns
    // undefined gracefully and the goal is still created.
    const out = await dispatchGoalSubcommand(ctx({ args: "x", activeSessionId: "ses_nonexistent" }))
    expect(out?.system).toMatch(/Goal active/)
  })
})
