/**
 * `next-intl` ships ESM Jest does not transform, and `getRuntimeTranslator`
 * has its own suite. The translator is replaced by one that reads the real
 * `goal` bundle of the locale under test, so these cases assert that every
 * key the command uses resolves in both locales and what the transcript shows.
 */
import en from "@/i18n/messages/en/goal.json"
import zh from "@/i18n/messages/zh-CN/goal.json"
import type { SlashContext } from "../builtin"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { GoalEventKind } from "@/types/goal"
import { dispatchGoalSubcommand } from "./goal"

let mockLocale: "en" | "zh-CN" = "en"
/** Every key the command resolved, so a test can prove none fell back. */
const mockMissing: string[] = []
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async (namespace?: string) => {
    expect(namespace).toBe("goal")
    const locale = mockLocale
    const bundle = (locale === "en" ? en : zh) as unknown as Record<string, unknown>
    const lookup = (key: string): unknown =>
      key.split(".").reduce<unknown>((node, seg) => {
        return node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined
      }, bundle)
    // The ICU subset these messages use: `'<'` quoting, `{x}`, `{x, number}`,
    // `{x, time, medium}` and an English `one`/`other` plural.
    return (key: string, values: Record<string, unknown> = {}) => {
      const message = lookup(key)
      if (typeof message !== "string") {
        mockMissing.push(key)
        return `goal.${key}`
      }
      return message
        .replace(
          /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g,
          (_m, name: string, one: string, other: string) =>
            (values[name] === 1 ? one : other).replace("#", String(values[name]))
        )
        .replace(/\{(\w+), number\}/g, (_m, name: string) =>
          new Intl.NumberFormat(locale).format(values[name] as number)
        )
        .replace(/\{(\w+), time, medium\}/g, (_m, name: string) =>
          new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(values[name] as Date)
        )
        .replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]))
        .replace(/'([<{}])'/g, "$1")
    }
  },
}))

// useSettingsStore is touched by /goal create — mock the store to return null
// settings so the runtime defaults kick in deterministically.
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: null }),
  },
}))

// The desktop by default; the paired-phone cases flip `isNativeMobile` and
// answer the Companion RPCs from `mockCall`.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isNativeMobile: jest.fn(() => false),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))

import { isNativeMobile } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri/transport-instance"

const isNativeMobileMock = isNativeMobile as jest.Mock
const mockCall = transport.call as jest.Mock

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  mockLocale = "en"
  mockMissing.length = 0
  isNativeMobileMock.mockReturnValue(false)
  mockCall.mockReset()
  await dbFixture.restore()
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

afterAll(dbFixture.dispose)
afterEach(() => {
  // A key absent from the bundle renders as `goal.<key>` in the transcript.
  expect(mockMissing).toEqual([])
})

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

describe("dispatchGoalSubcommand — localized replies", () => {
  /** Compile-time complete: a new event kind fails typecheck until listed. */
  const EVENT_KINDS = Object.keys({
    goal_created: true,
    objective_updated: true,
    turn_started: true,
    turn_completed: true,
    judge_evaluated: true,
    judge_parse_failed: true,
    exit_triggered: true,
    user_paused: true,
    user_resumed: true,
    user_stopped: true,
    config_updated: true,
    subgoals_generated: true,
    promise_requested: true,
    promise_confirmed: true,
    promise_denied: true,
    pacing_decided: true,
    acceptance_requested: true,
    acceptance_resolved: true,
    verification_requested: true,
    verification_started: true,
    verification_passed: true,
    verification_failed: true,
    verification_error: true,
    verification_disabled: true,
  } satisfies Record<GoalEventKind, true>)

  it("carries the same command keys in both locales", () => {
    expect(Object.keys(zh.commands).sort()).toEqual(Object.keys(en.commands).sort())
  })

  it("labels every goal event kind in both locales", () => {
    for (const kind of EVENT_KINDS) {
      expect(en.activity.kinds).toHaveProperty(kind)
      expect(zh.activity.kinds).toHaveProperty(kind)
    }
  })

  it("en: guard and usage replies render the full copy", async () => {
    expect((await dispatchGoalSubcommand(ctx({ activeSessionId: null })))?.system).toBe(
      "Start a chat session first — `/goal` operates inside an active session."
    )
    expect((await dispatchGoalSubcommand(ctx({ chatStatus: "streaming" })))?.system).toBe(
      "The current turn is still streaming — `/goal` waits for the response to finish before changing the active goal."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "create" })))?.system).toBe(
      "Usage: `/goal <what you want to accomplish>`. Example: `/goal write a haiku about winter`."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "status" })))?.system).toBe(
      "No active goal in this session. Start one with `/goal <what you want to accomplish>`."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "update" })))?.system).toBe(
      "Usage: `/goal update <new objective>`."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "update x" })))?.system).toBe(
      "No active goal — create one first with `/goal <text>`."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "resume" })))?.system).toBe(
      "No goal to resume."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "stop" })))?.system).toBe(
      "No active goal to stop."
    )
  })

  it("en: created card, budgets and hint", async () => {
    const out = await dispatchGoalSubcommand(ctx({ args: "ship it" }))
    const goal = await getGoalRuntime().getActiveGoalForSession("ses_a")
    const lines = out!.system!.split("\n")
    expect(lines[0]).toBe(
      `🎯 **Goal active** — ${goal!.config.maxTurns} turns budget, ${new Intl.NumberFormat("en").format(Math.round(goal!.config.maxTokens / 1000))}k token budget.`
    )
    expect(lines[2]).toBe("> ship it")
    expect(lines[4]).toBe(
      "The agent will continue toward this goal automatically. Pause with `/goal pause` · stop with `/goal stop` · update with `/goal update <new text>`."
    )
  })

  it("en: status card labels recent activity instead of printing raw kinds", async () => {
    const g = await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await getGoalRuntime().pauseGoal(g.id)
    const md = (await dispatchGoalSubcommand(ctx({ args: "status" })))!.system!
    expect(md).toMatch(/^🎯 \*\*⏸️ PAUSED\*\* — 0\/\d+ turns · 0 tokens · 0m elapsed$/m)
    expect(md).toContain("**Recent activity:**")
    expect(md).toMatch(/^- \*\*Paused\*\* at .+$/m)
    expect(md).toMatch(/^- \*\*Goal created\*\* at .+$/m)
    expect(md).not.toMatch(/`user_paused`/)
  })

  it("en: stop pluralizes the turn count and pause on a paused goal names its status", async () => {
    const g = await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    await getGoalRuntime().pauseGoal(g.id)
    expect((await dispatchGoalSubcommand(ctx({ args: "pause" })))?.system).toBe(
      "Goal is already paused — nothing to pause."
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "stop" })))?.system).toBe(
      "Goal stopped after 0 turns."
    )
  })

  it("zh-CN: every reply path renders Chinese copy", async () => {
    mockLocale = "zh-CN"
    expect((await dispatchGoalSubcommand(ctx({ activeSessionId: null })))?.system).toBe(
      "请先开始一个聊天会话——`/goal` 在活跃会话内运行。"
    )
    expect((await dispatchGoalSubcommand(ctx({ chatStatus: "streaming" })))?.system).toBe(
      "当前回合仍在流式输出——`/goal` 会等回复结束后再更改活跃目标。"
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "create" })))?.system).toBe(
      "用法：`/goal <你想完成的事>`。示例：`/goal 写一首关于冬天的俳句`。"
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "status" })))?.system).toBe(
      "该会话没有活跃目标。用 `/goal <你想完成的事>` 开始一个。"
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "pause" })))?.system).toBe(
      "没有可暂停的活跃目标。"
    )

    const created = (await dispatchGoalSubcommand(ctx({ args: "写一首诗" })))!.system!
    expect(created).toMatch(/^🎯 \*\*目标已激活\*\* — \d+ 回合预算，[\d,]+k token 预算。$/m)
    expect(created).toContain("用 `/goal update <新内容>` 更新。")

    expect((await dispatchGoalSubcommand(ctx({ args: "resume" })))?.system).toBe("目标已在进行中。")
    const paused = (await dispatchGoalSubcommand(ctx({ args: "pause" })))!.system!
    expect(paused).toMatch(/^目标已暂停——已用 0\/\d+ 回合。用 `\/goal resume` 恢复。$/)
    expect((await dispatchGoalSubcommand(ctx({ args: "pause" })))?.system).toBe(
      "目标已处于「已暂停」状态——无需暂停。"
    )

    const status = (await dispatchGoalSubcommand(ctx({ args: "status" })))!.system!
    expect(status).toMatch(/^🎯 \*\*⏸️ 已暂停\*\* — 0\/\d+ 回合 · 0 tokens · 已用 0 分钟$/m)
    expect(status).toContain("**近期活动：**")
    expect(status).toMatch(/^- .+ \*\*已暂停\*\*$/m)
    expect(status).toMatch(/^- .+ \*\*创建目标\*\*$/m)
    expect(status).not.toMatch(/[A-Za-z]{4,} (turns|elapsed|activity)/)

    expect((await dispatchGoalSubcommand(ctx({ args: "resume" })))?.system).toBe(
      "目标已恢复。循环将在下一回合继续。"
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "update 写一首诗" })))?.system).toBe(
      "目标未变更（与当前目标相同），或该目标已无法修改。"
    )
    const updated = (await dispatchGoalSubcommand(ctx({ args: "update 写两首诗" })))!.system!
    expect(updated).toBe("目标已更新。模型将在下一回合获知此变更。\n\n> 写两首诗")
    expect((await dispatchGoalSubcommand(ctx({ args: "stop" })))?.system).toBe(
      "目标已停止，共用 0 回合。"
    )
  })
})

describe("dispatchGoalSubcommand — on a paired phone", () => {
  const DESKTOP_GOAL = {
    id: "g-desk",
    sessionId: "ses_a",
    rawObjective: "ship the release",
    safeObjective: "ship the release",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 3,
    tokensUsed: 1200,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen",
    createdAt: 0,
    updatedAt: 0,
  }

  /** The desktop's answers, by command; `allowed` is the remote-control grant. */
  function desktop(
    answers: Record<string, unknown> = {},
    { allowed = true }: { allowed?: boolean } = {}
  ) {
    mockCall.mockImplementation(async (command: string) => {
      if (command === "companion_can_control") return { allowed }
      if (command in answers) {
        const answer = answers[command]
        if (answer instanceof Error) throw answer
        return answer
      }
      throw new Error(`unexpected ${command}`)
    })
  }

  function commandsCalled(): string[] {
    return mockCall.mock.calls.map(([command]) => command as string)
  }

  beforeEach(() => {
    isNativeMobileMock.mockReturnValue(true)
  })

  it("status reads the desktop's open goal, never this device's mirror", async () => {
    // A stale local mirror row must not answer for the desktop.
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "stale mirror" })
    desktop({ goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] } })
    const out = await dispatchGoalSubcommand(ctx({ args: "status" }))
    expect(out?.system).toContain("ACTIVE")
    expect(out?.system).toContain("3/20 turns")
    expect(out?.system).toContain("> ship the release")
    // Nothing of this goal's event log has synced yet, so no activity section.
    expect(out?.system).not.toContain("Recent activity")
    expect(mockCall).toHaveBeenCalledWith("goal_status", { sessionId: "ses_a" })
    // A read needs no grant.
    expect(commandsCalled()).not.toContain("companion_can_control")
  })

  it("status lists recent activity from the synced goal event log", async () => {
    // What `syncGoalEvents` writes into the phone's mirror of the desktop log.
    const { applyGoalEventRows } = await import("@/lib/sync/handlers/goals")
    await applyGoalEventRows([
      {
        id: "ev-created",
        goalId: DESKTOP_GOAL.id,
        kind: "goal_created",
        ts: 1_000,
        payload: {
          kind: "goal_created",
          safeObjective: "ship the release",
          config: DESKTOP_GOAL.config as never,
        },
      },
      {
        id: "ev-judge",
        goalId: DESKTOP_GOAL.id,
        kind: "judge_evaluated",
        ts: 2_000,
        payload: {
          kind: "judge_evaluated",
          done: false,
          reason: "tests still red",
          judgeTokens: 9,
        },
      },
      // Another goal's history stays out of this card.
      {
        id: "ev-other",
        goalId: "g-other",
        kind: "user_paused",
        ts: 3_000,
        payload: { kind: "user_paused" },
      },
    ])
    desktop({ goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] } })
    const md = (await dispatchGoalSubcommand(ctx({ args: "status" })))!.system!
    expect(md).toContain("**Recent activity:**")
    const activity = md.split("\n").filter((line) => line.startsWith("- **"))
    expect(activity).toHaveLength(2)
    // Newest first, labelled rather than printed as raw kinds.
    expect(activity[0]).toMatch(/^- \*\*Judge verdict\*\* at /)
    expect(activity[1]).toMatch(/^- \*\*Goal created\*\* at /)
    // Still a single read of the desktop: the log is local.
    expect(commandsCalled()).toEqual(["goal_status"])
  })

  it("status falls back to the desktop's paused goal, and says when there is none", async () => {
    const paused = { ...DESKTOP_GOAL, status: "paused" }
    desktop({
      goal_status: { activeGoal: null, goals: [{ ...DESKTOP_GOAL, status: "completed" }, paused] },
    })
    expect((await dispatchGoalSubcommand(ctx({ args: "status" })))?.system).toContain("PAUSED")
    desktop({ goal_status: { activeGoal: null, goals: [] } })
    expect((await dispatchGoalSubcommand(ctx({ args: "show" })))?.system).toMatch(/No active goal/)
  })

  it("creates the goal on the desktop over goal_create", async () => {
    desktop({ goal_create: { goal: { ...DESKTOP_GOAL, safeObjective: "write a haiku" } } })
    const out = await dispatchGoalSubcommand(ctx({ args: "write a haiku" }))
    expect(out?.system).toMatch(/Goal active/)
    expect(out?.system).toContain("> write a haiku")
    expect(mockCall).toHaveBeenCalledWith("goal_create", {
      sessionId: "ses_a",
      rawObjective: "write a haiku",
    })
    expect(await getGoalRuntime().getActiveGoalForSession("ses_a")).toBeUndefined()
  })

  it.each([
    ["pause", "goal_pause", DESKTOP_GOAL, /Goal paused — 3\/20 turns used/],
    ["resume", "goal_resume", { ...DESKTOP_GOAL, status: "paused" }, /Goal resumed/],
    ["stop", "goal_stop", DESKTOP_GOAL, /Goal stopped after 3 turns/],
  ] as const)("%s goes over %s for the desktop's goal", async (verb, command, open, reply) => {
    desktop({
      goal_status: { activeGoal: open.status === "active" ? open : null, goals: [open] },
      [command]: { goal: { ...open, status: verb === "resume" ? "active" : "paused" } },
    })
    const out = await dispatchGoalSubcommand(ctx({ args: verb }))
    expect(out?.system).toMatch(reply)
    expect(mockCall).toHaveBeenCalledWith(command, { goalId: "g-desk" })
  })

  it("update re-aims the desktop's goal and tells an applied update from a refused one", async () => {
    desktop({
      goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] },
      goal_update: {
        goal: { ...DESKTOP_GOAL, safeObjective: "ship v2" },
        updatePrompt: "The objective changed.",
      },
    })
    const out = await dispatchGoalSubcommand(ctx({ args: "update ship v2" }))
    expect(out?.system).toMatch(/Objective updated/)
    expect(out?.system).toContain("> ship v2")
    expect(out?.dispatchPrompt).toBe("The objective changed.")
    expect(mockCall).toHaveBeenCalledWith("goal_update", {
      goalId: "g-desk",
      rawObjective: "ship v2",
    })

    // The desktop answers the stored row when it refused; no prompt, no update.
    desktop({
      goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] },
      goal_update: { goal: DESKTOP_GOAL },
    })
    expect(
      (await dispatchGoalSubcommand(ctx({ args: "update ship the release" })))?.system
    ).toMatch(/Objective unchanged/)
  })

  it("refuses every write without the remote-control grant, before calling it", async () => {
    desktop(
      { goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] } },
      { allowed: false }
    )
    for (const args of ["pause", "stop", "update new text", "a new goal"]) {
      const out = await dispatchGoalSubcommand(ctx({ args }))
      expect(out?.system).toMatch(/needs remote control/)
    }
    expect(commandsCalled()).not.toEqual(
      expect.arrayContaining(["goal_pause", "goal_stop", "goal_update", "goal_create"])
    )
  })

  it("answers an unreachable desktop with the remote failure reply", async () => {
    desktop({ goal_status: new Error("offline") })
    expect((await dispatchGoalSubcommand(ctx({ args: "status" })))?.system).toBe(
      "Couldn't reach the desktop — try again."
    )
    desktop({
      goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] },
      goal_pause: new Error("403"),
    })
    expect((await dispatchGoalSubcommand(ctx({ args: "pause" })))?.system).toBe(
      "Couldn't reach the desktop — try again."
    )
  })

  it("zh-CN: the remote refusal and failure replies are localized", async () => {
    mockLocale = "zh-CN"
    desktop(
      { goal_status: { activeGoal: DESKTOP_GOAL, goals: [DESKTOP_GOAL] } },
      { allowed: false }
    )
    expect((await dispatchGoalSubcommand(ctx({ args: "stop" })))?.system).toMatch(/远程控制/)
    desktop({ goal_status: new Error("offline") })
    expect((await dispatchGoalSubcommand(ctx({ args: "status" })))?.system).toBe(
      "无法连接桌面端——请重试。"
    )
  })

  it("the desktop path never touches the Companion transport", async () => {
    isNativeMobileMock.mockReturnValue(false)
    await dispatchGoalSubcommand(ctx({ args: "write a haiku" }))
    await dispatchGoalSubcommand(ctx({ args: "pause" }))
    expect(mockCall).not.toHaveBeenCalled()
    expect((await getGoalRuntime().getOpenGoalForSession("ses_a"))?.status).toBe("paused")
  })
})
