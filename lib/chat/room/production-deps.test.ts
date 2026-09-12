/**
 * The production deps are the one path no runner test exercises (every test
 * hands in fakes), so this pins that each seam reaches the module the hook
 * always imported, and that the two lazy imports are guarded.
 */

const ipc = {
  sendPrompt: jest.fn(async () => undefined),
  interruptSession: jest.fn(async () => undefined),
  closeSession: jest.fn(async () => undefined),
  approveTool: jest.fn(async () => undefined),
}
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...args: unknown[]) => ipc.sendPrompt(...(args as [])),
  interruptSession: (...args: unknown[]) => ipc.interruptSession(...(args as [])),
  closeSession: (...args: unknown[]) => ipc.closeSession(...(args as [])),
  approveTool: (...args: unknown[]) => ipc.approveTool(...(args as [])),
}))
jest.mock("@/lib/claude/build-options", () => ({ resolveSendOptions: jest.fn() }))
jest.mock("@/lib/memory/run-turn-memory", () => ({ runTurnMemory: jest.fn(async () => "mem") }))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: jest.fn(async () => "memory-deps"),
}))
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: jest.fn(async () => "twin-deps"),
}))
jest.mock("@/lib/rag/safe-embedding", () => ({
  generateSafeEmbedding: jest.fn(async () => ({ embedding: [1] })),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => "client"),
}))
jest.mock("@/lib/ai/generation/run-title-task", () => ({ runTitleTask: jest.fn(async () => "t") }))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn(), persistMessages: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  touchSession: jest.fn(),
  updateSession: jest.fn(),
}))
jest.mock("@/lib/db/characters", () => ({ listCharactersByIds: jest.fn() }))
const recordResultUsage = jest.fn(async () => ({ recorded: true }))
jest.mock("@/lib/db/session-usage", () => ({
  recordResultUsage: (...args: unknown[]) => recordResultUsage(...(args as [])),
}))
jest.mock("@/lib/db/session-state", () => ({ bumpUnread: jest.fn() }))
jest.mock("@/lib/db/teams", () => ({ getTeam: jest.fn() }))
const isAtCapacity = jest.fn(() => true)
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({ isAtCapacity }),
}))
const runWithExecutionLease = jest.fn(async (_req: unknown, run: () => Promise<unknown>) => run())
jest.mock("@/lib/execution/admit", () => ({
  runWithExecutionLease: (...args: unknown[]) =>
    runWithExecutionLease(...(args as [unknown, () => Promise<unknown>])),
}))
jest.mock("@/lib/execution/slot-key", () => ({ slotKeyForTurn: jest.fn(() => "slot") }))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: jest.fn(async () => "/cwd"),
}))
jest.mock("@/lib/execution/chat-lease", () => ({
  releaseChatLease: jest.fn(),
  acquireChatLease: jest.fn(async () => undefined),
}))
jest.mock("@/lib/policy/action-review/chat-tool-channel", () => ({
  recordChatToolApprovalDecision: jest.fn(),
}))
jest.mock("@/lib/usage/compaction-metrics", () => ({ pendingRecoveryPhase: jest.fn(() => 2) }))
const resolveProviderAttemptOptions = jest.fn(async () => ({ concurrentLimit: 3 }))
const applyProviderAttemptLimits = jest.fn(() => ({}))
jest.mock("@/lib/claude/provider-attempt-options", () => ({
  resolveProviderAttemptOptions: (...args: unknown[]) =>
    resolveProviderAttemptOptions(...(args as [])),
  applyProviderAttemptLimits: (...args: unknown[]) => applyProviderAttemptLimits(...(args as [])),
}))
const applySdkSubagentBridge = jest.fn()
jest.mock("@/lib/claude/sdk-subagent-bridge", () => ({
  applySdkSubagentBridge: (...args: unknown[]) => applySdkSubagentBridge(...(args as [])),
}))

import { createProductionRoomDeps } from "./production-deps"

beforeEach(() => {
  jest.clearAllMocks()
})

it("forwards the sidecar seam verbatim", async () => {
  const deps = createProductionRoomDeps()
  await deps.ipc.sendPrompt("sub", "hi", { model: "m" } as never)
  await deps.ipc.interruptSession("sub")
  await deps.ipc.closeSession("sub")
  await deps.ipc.approveTool("sub", "req", "allow")
  expect(ipc.sendPrompt).toHaveBeenCalledWith("sub", "hi", { model: "m" })
  expect(ipc.interruptSession).toHaveBeenCalledWith("sub")
  expect(ipc.closeSession).toHaveBeenCalledWith("sub")
  expect(ipc.approveTool).toHaveBeenCalledWith("sub", "req", "allow")
})

it("binds the Dexie readers and writers the hook always used", async () => {
  const deps = createProductionRoomDeps()
  const messages = jest.requireMock("@/lib/db/messages")
  const sessions = jest.requireMock("@/lib/db/sessions")
  expect(deps.db.listMessages).toBe(messages.listMessages)
  expect(deps.db.persistMessages).toBe(messages.persistMessages)
  expect(deps.db.getSession).toBe(sessions.getSession)
  expect(deps.db.touchSession).toBe(sessions.touchSession)
  expect(deps.db.updateSession).toBe(sessions.updateSession)
  expect(deps.db.getTeam).toBe(jest.requireMock("@/lib/db/teams").getTeam)
  expect(deps.db.bumpUnread).toBe(jest.requireMock("@/lib/db/session-state").bumpUnread)
  expect(deps.db.listCharactersByIds).toBe(
    jest.requireMock("@/lib/db/characters").listCharactersByIds
  )
  // The usage row's return value is not part of the seam.
  const input = { sessionId: "r", messageId: "m", characterId: "c", result: {} }
  await expect(deps.db.recordResultUsage(input)).resolves.toBeUndefined()
  expect(recordResultUsage).toHaveBeenCalledWith(input)
})

it("routes admission through the broker, the lease helper and the slot key", async () => {
  const deps = createProductionRoomDeps()
  expect(deps.execution.isAtCapacity("ai-turn", "room-1")).toBe(true)
  expect(isAtCapacity).toHaveBeenCalledWith("ai-turn", "room-1")
  const request = { kind: "team", label: "l", sessionId: "room-1", exempt: true } as const
  await expect(deps.execution.runWithExecutionLease(request, async () => "ran")).resolves.toBe(
    "ran"
  )
  expect(runWithExecutionLease).toHaveBeenCalledWith(request, expect.any(Function))
  expect(deps.execution.slotKeyForTurn({ executionContext: undefined, effectiveCwd: null })).toBe(
    "slot"
  )
  await expect(deps.execution.resolveEffectiveCwdForSession({} as never)).resolves.toBe("/cwd")
  await deps.execution.acquireChatLease({
    sessionId: "room-1",
    label: "l",
    kind: "team",
    slotKey: undefined,
    onCancel: () => {},
  })
  expect(jest.requireMock("@/lib/execution/chat-lease").acquireChatLease).toHaveBeenCalled()
  deps.execution.releaseChatLease("room-1")
  expect(jest.requireMock("@/lib/execution/chat-lease").releaseChatLease).toHaveBeenCalledWith(
    "room-1"
  )
})

it("loads the provider attempt options and the subagent bridge lazily", async () => {
  const deps = createProductionRoomDeps()
  await expect(deps.ai.resolveProviderAttemptOptions("openai", {} as never)).resolves.toEqual({
    concurrentLimit: 3,
  })
  deps.ai.applySdkSubagentBridge({ type: "assistant" } as never, "room-1")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(applySdkSubagentBridge).toHaveBeenCalledWith({ type: "assistant" }, "room-1")
})

it("passes the Room fallback model and previous output cap to runtime limit resolution", async () => {
  const deps = createProductionRoomDeps()
  const settings = {} as never
  const previous = {
    modelParams: { maxOutputTokens: 256 },
    compaction: { enabled: true, contextWindow: 200000 },
  } as never
  await deps.ai.resolveProviderAttemptOptions("example:api", settings, "selected-model", previous)
  expect(resolveProviderAttemptOptions).toHaveBeenCalledWith(
    "example:api",
    settings,
    undefined,
    false,
    "selected-model"
  )
  expect(applyProviderAttemptLimits).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "example:api",
      model: "selected-model",
      compaction: { enabled: true, contextWindow: 200000 },
    }),
    settings,
    256
  )
})

it("never lets a bridge failure escape the room loop", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  applySdkSubagentBridge.mockImplementationOnce(() => {
    throw new Error("bridge down")
  })
  const deps = createProductionRoomDeps()
  expect(() => deps.ai.applySdkSubagentBridge({} as never, "room-1")).not.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(warn).toHaveBeenCalledWith("sdkSubagentBridge (room) failed", expect.any(Error))
  warn.mockRestore()
})

it("binds the per-turn AI helpers and the recovery phase", async () => {
  const deps = createProductionRoomDeps()
  await expect(deps.ai.tryBuildTwinDeps()).resolves.toBe("twin-deps")
  await expect(deps.ai.tryBuildMemoryDeps({}, undefined)).resolves.toBe("memory-deps")
  await expect(
    deps.ai.generateSafeEmbedding("q", { profileId: "p", purpose: "query" } as never)
  ).resolves.toEqual({ embedding: [1] })
  await expect(deps.ai.runTurnMemory("room-1", {} as never)).resolves.toBe("mem")
  expect(deps.ai.buildUtilityLlmClient({} as never)).toBe("client")
  await expect(deps.ai.runTitleTask({})).resolves.toBe("t")
  expect(deps.ai.pendingRecoveryPhase([])).toBe(2)
  expect(deps.ai.resolveSendOptions).toBe(
    jest.requireMock("@/lib/claude/build-options").resolveSendOptions
  )
  expect(deps.ai.recordChatToolApprovalDecision).toBe(
    jest.requireMock("@/lib/policy/action-review/chat-tool-channel").recordChatToolApprovalDecision
  )
})

it("writes synchronously under test unless a delay is asked for", () => {
  expect(createProductionRoomDeps().persistDelayMs).toBe(0)
  expect(createProductionRoomDeps({ persistDelayMs: 40 }).persistDelayMs).toBe(40)
  const deps = createProductionRoomDeps()
  expect(typeof deps.now()).toBe("number")
  expect(deps.newTurnId()).not.toBe(deps.newTurnId())
})
