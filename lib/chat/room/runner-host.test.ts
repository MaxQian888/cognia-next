import type { ClaudeEvent } from "@cognia/agent-config-types"

const runnerInstances: Array<{ handleEvent: jest.Mock; dispose: jest.Mock; deps: unknown }> = []
jest.mock("./runner", () => ({
  RoomRunner: class {
    handleEvent = jest.fn()
    dispose = jest.fn()
    constructor(readonly deps: unknown) {
      runnerInstances.push(this as never)
    }
  },
}))

const baseDeps = () => ({
  ipc: { sendPrompt: jest.fn() },
  db: {
    getSession: jest.fn(),
    persistMessages: jest.fn(async () => "persisted"),
    bumpUnread: jest.fn(async () => "bumped"),
    recordResultUsage: jest.fn(async () => "recorded"),
  },
  execution: { isAtCapacity: jest.fn() },
  ai: { resolveSendOptions: jest.fn(), applySdkSubagentBridge: jest.fn(() => "bridged") },
  now: () => 1,
  newTurnId: () => "t",
  persistDelayMs: 0,
})
const createProductionRoomDepsMock = jest.fn(baseDeps)
jest.mock("./production-deps", () => ({
  createProductionRoomDeps: () => createProductionRoomDepsMock(),
}))

const statusBySession = new Map<string, string>()
const createStoreRoomSinksMock = jest.fn(() => ({
  status: {
    get: (id: string) => statusBySession.get(id) ?? "idle",
    set: jest.fn((id: string, status: string) => statusBySession.set(id, status)),
    setError: jest.fn(),
  },
}))
jest.mock("./store-sinks", () => ({
  createStoreRoomSinks: () => createStoreRoomSinksMock(),
}))

import {
  COMPANION_IDLE_GRACE_MS,
  CompanionRoomProjector,
  __resetRoomRunnersForTests,
  createCompanionProjectionDeps,
  getCompanionRoomProjector,
  getHostRoomRunner,
} from "./runner-host"
import type { RoomRunner } from "./runner"
import type { RoomRunnerDeps } from "./runner-deps"

const SUB_A = "room-1::char::a::t1"
const SUB_B = "room-1::char::b::t1"
const evt = (type: ClaudeEvent["type"], sessionId: string): ClaudeEvent =>
  ({ type, sessionId, event: { type: "assistant" }, error: null }) as never

beforeEach(() => {
  jest.useFakeTimers()
  runnerInstances.length = 0
  statusBySession.clear()
  createProductionRoomDepsMock.mockClear()
  createStoreRoomSinksMock.mockClear()
  __resetRoomRunnersForTests()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("getHostRoomRunner", () => {
  it("builds one runner per process from the production deps and the store sinks", () => {
    const first = getHostRoomRunner()
    expect(getHostRoomRunner()).toBe(first)
    expect(createProductionRoomDepsMock).toHaveBeenCalledTimes(1)
    expect(createStoreRoomSinksMock).toHaveBeenCalledTimes(1)
  })

  it("disposes and forgets the runner when tests reset it", () => {
    const first = getHostRoomRunner()
    __resetRoomRunnersForTests()
    expect(runnerInstances[0].dispose).toHaveBeenCalled()
    expect(getHostRoomRunner()).not.toBe(first)
  })
})

describe("createCompanionProjectionDeps", () => {
  it("makes every durable write a no-op and leaves the rest intact", async () => {
    const base = baseDeps() as unknown as RoomRunnerDeps
    const deps = createCompanionProjectionDeps(base)
    await expect(deps.db.persistMessages("room-1", [])).resolves.toBeUndefined()
    await expect(deps.db.bumpUnread("room-1")).resolves.toBeUndefined()
    await expect(
      deps.db.recordResultUsage({ sessionId: "r", messageId: "m", characterId: "c", result: {} })
    ).resolves.toBeUndefined()
    expect(deps.ai.applySdkSubagentBridge({} as never, "room-1")).toBeUndefined()
    expect((base.db.persistMessages as jest.Mock).mock.calls).toHaveLength(0)
    // Reads and the sidecar seam stay the production ones.
    expect(deps.db.getSession).toBe(base.db.getSession)
    expect(deps.ipc).toBe(base.ipc)
    expect(deps.ai.resolveSendOptions).toBe(base.ai.resolveSendOptions)
  })
})

describe("CompanionRoomProjector", () => {
  function projector(grace = 100) {
    const sinks = createStoreRoomSinksMock() as never
    const runner = { handleEvent: jest.fn(), dispose: jest.fn() } as unknown as RoomRunner
    return { projector: new CompanionRoomProjector(runner, sinks, grace), runner }
  }

  it("forwards every event to the runner", () => {
    const { projector: p, runner } = projector()
    const e = evt("event", SUB_A)
    p.handleEvent(e)
    p.handleEvent(evt("event", "plain-session"))
    expect(runner.handleEvent).toHaveBeenNthCalledWith(1, e)
    expect(runner.handleEvent).toHaveBeenCalledTimes(2)
  })

  it("derives the room status from member events: first opens, last closes after the grace", () => {
    const { projector: p } = projector(100)
    p.handleEvent(evt("event", SUB_A))
    expect(statusBySession.get("room-1")).toBe("streaming")
    p.handleEvent(evt("session_ended", SUB_A))
    jest.advanceTimersByTime(99)
    expect(statusBySession.get("room-1")).toBe("streaming")
    jest.advanceTimersByTime(1)
    expect(statusBySession.get("room-1")).toBe("idle")
  })

  it("keeps the room busy while any member is still running", () => {
    const { projector: p } = projector(100)
    p.handleEvent(evt("event", SUB_A))
    p.handleEvent(evt("permission_request", SUB_B))
    p.handleEvent(evt("session_ended", SUB_A))
    jest.advanceTimersByTime(500)
    expect(statusBySession.get("room-1")).toBe("streaming")
    p.handleEvent(evt("session_ended", SUB_B))
    jest.advanceTimersByTime(100)
    expect(statusBySession.get("room-1")).toBe("idle")
  })

  it("lets the next member start inside the grace without a flicker to idle", () => {
    const { projector: p } = projector(100)
    p.handleEvent(evt("event", SUB_A))
    p.handleEvent(evt("session_ended", SUB_A))
    jest.advanceTimersByTime(50)
    p.handleEvent(evt("event", SUB_B))
    jest.advanceTimersByTime(100)
    expect(statusBySession.get("room-1")).toBe("streaming")
  })

  it("marks a room busy as soon as the host accepted a send", () => {
    const { projector: p } = projector(100)
    p.markSending("room-1")
    expect(statusBySession.get("room-1")).toBe("streaming")
    // A pending idle timer from the previous turn must not close the new one.
    p.handleEvent(evt("event", SUB_A))
    p.handleEvent(evt("session_ended", SUB_A))
    p.markSending("room-1")
    jest.advanceTimersByTime(200)
    expect(statusBySession.get("room-1")).toBe("streaming")
  })

  it("ignores events that are not member sub-sessions", () => {
    const { projector: p } = projector(100)
    p.handleEvent(evt("event", "direct-chat"))
    expect(statusBySession.has("direct-chat")).toBe(false)
  })

  it("does not overwrite a status the store already moved elsewhere", () => {
    const { projector: p } = projector(100)
    p.handleEvent(evt("event", SUB_A))
    statusBySession.set("room-1", "error")
    p.handleEvent(evt("session_ended", SUB_A))
    jest.advanceTimersByTime(100)
    expect(statusBySession.get("room-1")).toBe("error")
  })

  it("disposes its timers and the runner", () => {
    const { projector: p, runner } = projector(100)
    p.handleEvent(evt("event", SUB_A))
    p.handleEvent(evt("session_ended", SUB_A))
    p.dispose()
    jest.advanceTimersByTime(100)
    expect(statusBySession.get("room-1")).toBe("streaming")
    expect(runner.dispose).toHaveBeenCalled()
  })
})

describe("getCompanionRoomProjector", () => {
  it("is one projector over a runner whose persistence is inert", async () => {
    const first = getCompanionRoomProjector()
    expect(getCompanionRoomProjector()).toBe(first)
    const deps = runnerInstances[0].deps as RoomRunnerDeps
    await expect(deps.db.persistMessages("room-1", [])).resolves.toBeUndefined()
    expect(COMPANION_IDLE_GRACE_MS).toBe(1500)
  })
})
