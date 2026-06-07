import "fake-indexeddb/auto"
import type { SlashContext } from "../builtin"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: null }),
  },
}))

const schedulerMock = {
  createTask: jest.fn(),
  pauseTask: jest.fn().mockResolvedValue(true),
  resumeTask: jest.fn().mockResolvedValue(true),
  deleteTask: jest.fn().mockResolvedValue(true),
}
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

import { __resetLoopRuntimeForTesting, getLoopRuntime } from "@/lib/loop/runtime"
import { dispatchLoopSubcommand } from "./loop"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetLoopRuntimeForTesting()
  __resetGoalRuntimeForTesting()
  schedulerMock.createTask.mockReset().mockResolvedValue({ id: "task_1" })
  schedulerMock.pauseTask.mockReset().mockResolvedValue(true)
  schedulerMock.resumeTask.mockReset().mockResolvedValue(true)
  schedulerMock.deleteTask.mockReset().mockResolvedValue(true)
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

describe("dispatchLoopSubcommand — guards + usage", () => {
  it("requires an active session", async () => {
    const out = await dispatchLoopSubcommand(ctx({ activeSessionId: null }))
    expect(out?.system).toMatch(/Start a chat session first/)
  })

  it("bare /loop shows usage", async () => {
    const out = await dispatchLoopSubcommand(ctx({ args: "" }))
    expect(out?.system).toMatch(/Usage:/)
  })

  it("mutating subcommands refuse while streaming; status does not", async () => {
    const blocked = await dispatchLoopSubcommand(
      ctx({ args: "do the thing", chatStatus: "streaming" })
    )
    expect(blocked?.system).toMatch(/streaming/)
    const status = await dispatchLoopSubcommand(ctx({ args: "status", chatStatus: "streaming" }))
    expect(status?.system).toMatch(/No loop in this session/)
  })
})

describe("dispatchLoopSubcommand — create", () => {
  it("creates a self-paced loop from a bare prompt", async () => {
    const out = await dispatchLoopSubcommand(ctx({ args: "summarize new commits" }))
    expect(out?.system).toMatch(/Loop active/)
    expect(out?.system).toMatch(/self-paced/)
    const loop = await getLoopRuntime().getActiveLoopForSession("ses_a")
    expect(loop?.mode).toBe("self_paced")
    expect(loop?.rawPrompt).toBe("summarize new commits")
  })

  it("fires the kickoff listener for a self-paced create", async () => {
    const kicked = jest.fn()
    const unsub = getLoopRuntime().onKickoff(kicked)
    await dispatchLoopSubcommand(ctx({ args: "do the thing" }))
    expect(kicked).toHaveBeenCalledTimes(1)
    expect(kicked.mock.calls[0][0].sessionId).toBe("ses_a")
    unsub()
  })

  it("creates an interval loop from a leading interval token", async () => {
    const out = await dispatchLoopSubcommand(ctx({ args: "5m check the deploy" }))
    expect(out?.system).toMatch(/every 5m/)
    const loop = await getLoopRuntime().getActiveLoopForSession("ses_a")
    expect(loop?.mode).toBe("interval")
    expect(loop?.intervalMs).toBe(5 * 60_000)
    expect(schedulerMock.createTask).toHaveBeenCalledTimes(1)
  })

  it("an interval token without a prompt returns usage", async () => {
    const out = await dispatchLoopSubcommand(ctx({ args: "5m" }))
    expect(out?.system).toMatch(/needs a prompt/)
    expect(await getLoopRuntime().getActiveLoopForSession("ses_a")).toBeUndefined()
  })

  it("a non-interval first token becomes part of a self-paced prompt", async () => {
    await dispatchLoopSubcommand(ctx({ args: "5x check things" }))
    const loop = await getLoopRuntime().getActiveLoopForSession("ses_a")
    expect(loop?.mode).toBe("self_paced")
    expect(loop?.rawPrompt).toBe("5x check things")
  })

  it("surfaces the goal conflict as a friendly card", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "obj" })
    const out = await dispatchLoopSubcommand(ctx({ args: "do the thing" }))
    expect(out?.system).toMatch(/active `\/goal`/)
    expect(await getLoopRuntime().getActiveLoopForSession("ses_a")).toBeUndefined()
  })
})

describe("dispatchLoopSubcommand — lifecycle subcommands", () => {
  it("status renders the loop card", async () => {
    await dispatchLoopSubcommand(ctx({ args: "summarize" }))
    const out = await dispatchLoopSubcommand(ctx({ args: "status" }))
    expect(out?.system).toMatch(/ACTIVE/)
    expect(out?.system).toMatch(/0\/100 iterations/)
  })

  it("list renders every loop in the session", async () => {
    await dispatchLoopSubcommand(ctx({ args: "first" }))
    await dispatchLoopSubcommand(ctx({ args: "second" }))
    const out = await dispatchLoopSubcommand(ctx({ args: "list" }))
    expect(out?.system).toMatch(/Loops in this session/)
    expect(out?.system).toContain("second")
    expect(out?.system).toContain("first")
  })

  it("pause / resume / stop round-trip", async () => {
    await dispatchLoopSubcommand(ctx({ args: "work" }))
    const paused = await dispatchLoopSubcommand(ctx({ args: "pause" }))
    expect(paused?.system).toMatch(/paused/i)
    expect((await getLoopRuntime().getOpenLoopForSession("ses_a"))?.status).toBe("paused")
    const resumed = await dispatchLoopSubcommand(ctx({ args: "resume" }))
    expect(resumed?.system).toMatch(/resumed/i)
    expect((await getLoopRuntime().getOpenLoopForSession("ses_a"))?.status).toBe("active")
    const stopped = await dispatchLoopSubcommand(ctx({ args: "stop" }))
    expect(stopped?.system).toMatch(/stopped/i)
    expect(await getLoopRuntime().getOpenLoopForSession("ses_a")).toBeUndefined()
  })

  it("lifecycle subcommands report when nothing is open", async () => {
    expect((await dispatchLoopSubcommand(ctx({ args: "pause" })))?.system).toMatch(/No loop/)
    expect((await dispatchLoopSubcommand(ctx({ args: "resume" })))?.system).toMatch(/No loop/)
    expect((await dispatchLoopSubcommand(ctx({ args: "stop" })))?.system).toMatch(/No loop/)
  })
})
