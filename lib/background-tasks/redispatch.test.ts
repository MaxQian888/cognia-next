import {
  redispatchBackgroundRun,
  captureBackgroundDispatchRecovery,
  startBackgroundTaskRecovery,
} from "./redispatch"
import type { BackgroundTaskJournalRecord } from "./registry-core"

const mockExecutionEnvironment = jest.fn(() => ({
  isTauri: false,
  isHeadlessHost: false,
  pairedHost: false,
}))
jest.mock("@/lib/ai/agent/execution/host-environment", () => ({
  resolveAgentExecutionEnvironment: () => mockExecutionEnvironment(),
}))
const mockTauri = jest.fn(() => false)
const mockNativeSettings = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri() }))
jest.mock("@/lib/claude/settings", () => ({
  readClaudeEffectiveSettings: () => mockNativeSettings(),
}))
const mockHookPlugins = jest.fn((): string[] => [])
jest.mock("@/lib/plugin/registries/hook-registry", () => ({
  listEnabledHookPlugins: () => mockHookPlugins(),
}))
let mockDb = { name: "account-db" }
const mockSettings = jest.fn(
  async (): Promise<{
    subagentNesting: { tokenBudget: number }
    backgroundTasks?: { autoResumeInterrupted: boolean; maxAutoResumeAttempts?: number }
  }> => ({ subagentNesting: { tokenBudget: 0 } })
)
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDb }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => mockSettings() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(async () => ({ id: "chat-1" })) }))
jest.mock("@/lib/device/device-identity", () => ({ getDeviceId: jest.fn(async () => "host-1") }))

const getDispatchableSubagentDef = jest.fn()
const resolveCaller = jest.fn(async () => ({
  parentDepth: 0,
  maxDepth: 2,
  parentChain: [],
  budgetRoot: "dispatch:chat-1",
}))
const startDispatchRun = jest.fn(async () => ({ runId: "new-run", text: "started" }))
const updateBackgroundTaskRecord = jest.fn(async () => undefined)

jest.mock("@/lib/claude/agents/subagents", () => ({
  getDispatchableSubagentDef: (...args: unknown[]) => getDispatchableSubagentDef(...(args as [])),
}))
jest.mock("@/lib/claude/agents/dispatch-run", () => ({
  resolveCaller: (...args: unknown[]) => resolveCaller(...(args as [])),
  startDispatchRun: (...args: unknown[]) => startDispatchRun(...(args as [])),
}))
const mockInterrupt = jest.fn(async (): Promise<BackgroundTaskJournalRecord[]> => [])
const mockPrune = jest.fn(async () => 0)
const mockRecoverDirect = jest.fn(async () => 0)
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  interruptRendererBackgroundTasksOnBoot: () => mockInterrupt(),
}))
jest.mock("@/lib/execution/direct-chat-run", () => ({
  recoverStaleDirectChatExecutionRuns: () => mockRecoverDirect(),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  BACKGROUND_TASK_LEASE_TTL_MS: 60_000,
  pruneBackgroundTaskRecords: () => mockPrune(),
  updateBackgroundTaskRecord: (...args: unknown[]) => updateBackgroundTaskRecord(...(args as [])),
}))

function record(over: Partial<BackgroundTaskJournalRecord> = {}): BackgroundTaskJournalRecord {
  return {
    runId: "orig-1",
    kind: "subagent",
    subagentId: "explore",
    prompt: "look around",
    sessionId: "chat-1",
    host: "renderer",
    status: "interrupted",
    startedAt: 1000,
    settledAt: 2000,
    mode: "background",
    toolsEnabled: false,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTauri.mockReturnValue(false)
  mockHookPlugins.mockReturnValue([])
  mockExecutionEnvironment.mockReturnValue({
    isTauri: false,
    isHeadlessHost: false,
    pairedHost: false,
  })
  getDispatchableSubagentDef.mockReturnValue({ id: "explore" })
})

describe("redispatchBackgroundRun", () => {
  it("re-dispatches with the original subagent/prompt/tool flag as a background run", async () => {
    const outcome = await redispatchBackgroundRun(record(), { kind: "manual" })

    expect(outcome).toEqual({ ok: true, runId: "new-run" })
    expect(resolveCaller).toHaveBeenCalledWith("chat-1")
    expect(startDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subagentId: "explore",
        prompt: "look around",
        toolsEnabled: false,
        background: true,
        parentSessionId: "chat-1",
        resumeOfRunId: "orig-1",
        resumeAttempt: 0, // manual resets the chain
      })
    )
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith("orig-1", {
      resumedByRunId: "new-run",
    })
  })

  it("parks legacy interrupted work without persisted replay evidence", async () => {
    const outcome = await redispatchBackgroundRun(record({ resumeAttempt: 1 }), { kind: "auto" })
    expect(outcome).toMatchObject({ ok: false, reason: "recovery-required" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("caps auto chains at maxAutoResumeAttempts (crash-loop guard)", async () => {
    const outcome = await redispatchBackgroundRun(record({ resumeAttempt: 2 }), {
      kind: "auto",
      maxAutoResumeAttempts: 2,
    })
    expect(outcome).toMatchObject({ ok: false, reason: "attempt-cap" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("manual re-run ignores the attempt cap (explicit user intent)", async () => {
    const outcome = await redispatchBackgroundRun(record({ resumeAttempt: 5 }), {
      kind: "manual",
    })
    expect(outcome).toEqual({ ok: true, runId: "new-run" })
    expect(startDispatchRun).toHaveBeenCalledWith(expect.objectContaining({ resumeAttempt: 0 }))
  })

  it("refuses runs that are still running", async () => {
    const outcome = await redispatchBackgroundRun(record({ status: "running" }), {
      kind: "manual",
    })
    expect(outcome).toMatchObject({ ok: false, reason: "still-running" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("is a structured no-op when the subagent def no longer exists", async () => {
    getDispatchableSubagentDef.mockReturnValue(undefined)
    const outcome = await redispatchBackgroundRun(record(), { kind: "manual" })
    expect(outcome).toMatchObject({ ok: false, reason: "missing-subagent" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("defaults toolsEnabled to true for legacy rows without the flag", async () => {
    const legacy = record()
    delete (legacy as Partial<BackgroundTaskJournalRecord>).toolsEnabled
    await redispatchBackgroundRun(legacy, { kind: "manual" })
    expect(startDispatchRun).toHaveBeenCalledWith(expect.objectContaining({ toolsEnabled: true }))
  })

  it("survives a failed provenance write", async () => {
    updateBackgroundTaskRecord.mockRejectedValueOnce(new Error("db down"))
    await expect(redispatchBackgroundRun(record(), { kind: "manual" })).resolves.toEqual({
      ok: true,
      runId: "new-run",
    })
  })
})

async function recoverable() {
  return captureBackgroundDispatchRecovery({
    sessionId: "chat-1",
    executionSessionId: "child-session",
    caller: (await resolveCaller()) as never,
    target: { id: "explore" } as never,
    toolsEnabled: false,
  })
}

describe("verified background recovery", () => {
  it("restarts a dispatched tool-free run with its original child session and caller", async () => {
    const recovery = { ...(await recoverable()), phase: "dispatched" as const }
    const result = await redispatchBackgroundRun(record({ recovery, resumeAttempt: 1 }), {
      kind: "auto",
    })
    expect(result).toEqual({ ok: true, runId: "new-run" })
    expect(startDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeAttempt: 2,
        recovery: expect.objectContaining({ executionSessionId: "child-session" }),
        caller: recovery.caller,
      })
    )
  })

  it("parks enabled tools and external runtimes even when a forged no-effects hint exists", async () => {
    const recovery = { ...(await recoverable()), phase: "dispatched" as const }
    for (const overrides of [
      { toolsEnabled: true },
      { recovery: { ...recovery, target: { ...recovery.target, externalPresetId: "claude" } } },
      { recovery: { ...recovery, sideEffect: "non-idempotent" as const } },
    ]) {
      expect(
        await redispatchBackgroundRun(record({ recovery, ...overrides }), { kind: "auto" })
      ).toMatchObject({ ok: false, reason: "recovery-required" })
    }
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("parks changes to the definition and finite budgets", async () => {
    const recovery = await recoverable()
    getDispatchableSubagentDef
      .mockReturnValueOnce({ id: "explore", prompt: "new policy" })
      .mockReturnValueOnce({ id: "explore", prompt: "new policy" })
    expect(await redispatchBackgroundRun(record({ recovery }), { kind: "auto" })).toMatchObject({
      ok: false,
      reason: "recovery-required",
    })
    mockSettings.mockResolvedValueOnce({ subagentNesting: { tokenBudget: 100 } })
    expect(await redispatchBackgroundRun(record({ recovery }), { kind: "auto" })).toMatchObject({
      ok: false,
      reason: "recovery-required",
    })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("returns structured failure rather than claiming a failed admission succeeded", async () => {
    startDispatchRun.mockResolvedValueOnce({
      runId: "new-run",
      text: "failed",
      error: "disk full",
    } as never)
    expect(await redispatchBackgroundRun(record(), { kind: "manual" })).toMatchObject({
      ok: false,
      reason: "dispatch-failed",
    })
    expect(updateBackgroundTaskRecord).not.toHaveBeenCalled()
  })
})

it("does not treat arbitrary native lifecycle hooks as tool-free replay", async () => {
  mockTauri.mockReturnValue(true)
  mockNativeSettings.mockResolvedValue({
    user: { hooks: { SubagentStart: [{ command: "mutate" }] } },
  })
  expect((await recoverable()).sideEffect).toBe("non-idempotent")
  mockNativeSettings.mockRejectedValue(new Error("hook settings unreadable"))
  expect((await recoverable()).sideEffect).toBe("non-idempotent")
})

it.each(["SessionStart", "UserPromptSubmit", "Stop"])(
  "parks native %s commands for automatic recovery",
  async (event) => {
    mockTauri.mockReturnValue(true)
    mockNativeSettings.mockResolvedValue({
      project: { hooks: { [event]: [{ hooks: [{ type: "command", command: "mutate" }] }] } },
    })
    const recovery = { ...(await recoverable()), phase: "dispatched" as const }
    expect(recovery.sideEffect).toBe("non-idempotent")
    expect(await redispatchBackgroundRun(record({ recovery }), { kind: "auto" })).toMatchObject({
      ok: false,
      reason: "recovery-required",
    })
    expect(startDispatchRun).not.toHaveBeenCalled()
  }
)

it("parks enabled plugin hook contributions instead of assuming they are observational", async () => {
  mockHookPlugins.mockReturnValue(["plugin-with-hooks"])
  const recovery = { ...(await recoverable()), phase: "dispatched" as const }
  expect(recovery.sideEffect).toBe("non-idempotent")
  expect(await redispatchBackgroundRun(record({ recovery }), { kind: "auto" })).toMatchObject({
    ok: false,
    reason: "recovery-required",
  })
})

it("preserves the explicit model on manual rerun", async () => {
  await redispatchBackgroundRun(record({ model: "selected-model" }), { kind: "manual" })
  expect(startDispatchRun).toHaveBeenCalledWith(
    expect.objectContaining({ model: "selected-model" })
  )
})

it("recovers an accepted internal tool-capable admission but parks the same run after dispatch", async () => {
  const recovery = await captureBackgroundDispatchRecovery({
    sessionId: "chat-1",
    executionSessionId: "child-session",
    caller: (await resolveCaller()) as never,
    target: { id: "explore" } as never,
    toolsEnabled: true,
  })
  expect(recovery.sideEffect).toBe("non-idempotent")
  expect(
    await redispatchBackgroundRun(record({ recovery, toolsEnabled: true }), { kind: "auto" })
  ).toEqual({ ok: true, runId: "new-run" })
  startDispatchRun.mockClear()
  expect(
    await redispatchBackgroundRun(
      record({ recovery: { ...recovery, phase: "dispatched" }, toolsEnabled: true }),
      { kind: "auto" }
    )
  ).toMatchObject({ ok: false, reason: "recovery-required" })
  expect(startDispatchRun).not.toHaveBeenCalled()
})

it("recovers accepted hook-enabled work because hooks have not been dispatched", async () => {
  mockHookPlugins.mockReturnValue(["plugin-with-hooks"])
  const recovery = await recoverable()
  expect(recovery.sideEffect).toBe("non-idempotent")
  expect(await redispatchBackgroundRun(record({ recovery }), { kind: "auto" })).toEqual({
    ok: true,
    runId: "new-run",
  })
})

it("parks cross-account rows and expired deadlines without starting work", async () => {
  const recovery = await recoverable()
  expect(
    await redispatchBackgroundRun(
      record({ recovery: { ...recovery, namespaceId: "another-account" } }),
      { kind: "auto" }
    )
  ).toMatchObject({ ok: false, reason: "recovery-required" })
  expect(
    await redispatchBackgroundRun(
      record({
        recovery: { ...recovery, caller: { ...recovery.caller, deadlineMs: Date.now() - 1 } },
      }),
      { kind: "auto" }
    )
  ).toMatchObject({ ok: false, reason: "recovery-required" })
  expect(startDispatchRun).not.toHaveBeenCalled()
})

it("parks dispatched remote-host work when native hooks were never inspected", async () => {
  mockExecutionEnvironment.mockReturnValue({
    isTauri: false,
    isHeadlessHost: false,
    pairedHost: true,
  })
  const recovery = await recoverable()
  expect(recovery.sideEffect).toBe("non-idempotent")
  expect(
    await redispatchBackgroundRun(record({ recovery: { ...recovery, phase: "dispatched" } }), {
      kind: "auto",
    })
  ).toMatchObject({ ok: false, reason: "recovery-required" })
  expect(startDispatchRun).not.toHaveBeenCalled()
})

it("never auto-recovers cancelled work but allows an explicit new manual rerun", async () => {
  const cancelled = record({ recovery: await recoverable(), cancelRequestedAt: 10 })
  expect(await redispatchBackgroundRun(cancelled, { kind: "auto" })).toMatchObject({
    ok: false,
    reason: "recovery-required",
  })
  expect(startDispatchRun).not.toHaveBeenCalled()
  expect(await redispatchBackgroundRun(cancelled, { kind: "manual" })).toMatchObject({ ok: true })
  expect(startDispatchRun).toHaveBeenCalledWith(
    expect.not.objectContaining({ recovery: expect.anything() })
  )
})

describe("background owner recovery maintenance", () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    jest.useFakeTimers()
    mockDb = { name: "account-db" }
    mockInterrupt.mockReset().mockResolvedValue([])
    mockPrune.mockReset().mockResolvedValue(0)
    mockRecoverDirect.mockReset().mockResolvedValue(0)
    mockSettings.mockResolvedValue({
      subagentNesting: { tokenBudget: 0 },
      backgroundTasks: { autoResumeInterrupted: true },
    })
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    jest.useRealTimers()
  })
  const flush = async () => {
    for (let index = 0; index < 80; index += 1) await Promise.resolve()
  }

  it("checks again when an initially live owner expires, and prunes only at boot", async () => {
    const recovery = await recoverable()
    const onResumed = jest.fn()
    mockInterrupt
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        record({ recovery }),
        record({ kind: "plugin-agent" }),
        record({ mode: "foreground" }),
      ])
    stop = startBackgroundTaskRecovery({ onResumed })
    await flush()
    expect(startDispatchRun).not.toHaveBeenCalled()
    expect(mockPrune).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(20_000)
    expect(startDispatchRun).toHaveBeenCalledTimes(1)
    expect(onResumed).toHaveBeenCalledWith(1)
    expect(mockRecoverDirect).toHaveBeenCalledTimes(1)
    expect(mockPrune).toHaveBeenCalledTimes(1)
  })

  it("does not overlap ticks and does not schedule after stopping an in-flight check", async () => {
    let resolve!: (rows: BackgroundTaskJournalRecord[]) => void
    mockInterrupt.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    stop = startBackgroundTaskRecovery()
    await flush()
    await jest.advanceTimersByTimeAsync(120_000)
    expect(mockInterrupt).toHaveBeenCalledTimes(1)
    stop()
    resolve([record({ recovery: await recoverable() })])
    await flush()
    await jest.advanceTimersByTimeAsync(120_000)
    expect(mockInterrupt).toHaveBeenCalledTimes(1)
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("refuses a pending check after the database namespace changes", async () => {
    let resolve!: (rows: BackgroundTaskJournalRecord[]) => void
    mockInterrupt.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    stop = startBackgroundTaskRecovery()
    await flush()
    const recovery = await recoverable()
    mockDb = { name: "other-target" }
    resolve([record({ recovery })])
    await flush()
    await jest.advanceTimersByTimeAsync(120_000)
    expect(startDispatchRun).not.toHaveBeenCalled()
    expect(mockInterrupt).toHaveBeenCalledTimes(1)
  })

  it("retries a failed check without an unhandled rejection", async () => {
    mockInterrupt.mockRejectedValueOnce(new Error("database busy"))
    stop = startBackgroundTaskRecovery()
    await flush()
    await jest.advanceTimersByTimeAsync(20_000)
    expect(mockInterrupt).toHaveBeenCalledTimes(2)
  })

  it("honors disabled auto recovery and the existing attempt cap", async () => {
    mockSettings.mockResolvedValue({
      subagentNesting: { tokenBudget: 0 },
      backgroundTasks: { autoResumeInterrupted: false },
    })
    const recovery = await recoverable()
    mockInterrupt.mockResolvedValue([record({ recovery, resumeAttempt: 2 })])
    stop = startBackgroundTaskRecovery()
    await flush()
    expect(startDispatchRun).not.toHaveBeenCalled()
    mockSettings.mockResolvedValue({
      subagentNesting: { tokenBudget: 0 },
      backgroundTasks: { autoResumeInterrupted: true },
    })
    await jest.advanceTimersByTimeAsync(20_000)
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("refuses dispatch when stopped during caller resolution", async () => {
    const recovery = await recoverable()
    mockInterrupt.mockResolvedValue([record({ recovery })])
    let resolve!: (caller: Awaited<ReturnType<typeof resolveCaller>>) => void
    resolveCaller.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    stop = startBackgroundTaskRecovery()
    await flush()
    stop()
    resolve({ parentDepth: 0, maxDepth: 2, parentChain: [], budgetRoot: "dispatch:chat-1" })
    await flush()
    expect(startDispatchRun).not.toHaveBeenCalled()
  })
})
