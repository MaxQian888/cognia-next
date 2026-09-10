/** @jest-environment node */

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import type { HeadlessRuntimeContext } from "../types"

const handleEvent = jest.fn()
jest.mock("@/lib/chat/room/runner-host", () => ({
  getHostRoomRunner: () => ({ handleEvent: (...args: unknown[]) => handleEvent(...(args as [])) }),
}))

let sidecarHandler: ((evt: unknown) => void) | null = null
const unlisten = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: async (handler: (evt: unknown) => void) => {
    sidecarHandler = handler
    return unlisten
  },
}))

const publishHostEvent = jest.fn(async () => undefined)
jest.mock("@/lib/companion/host-event-publisher", () => ({
  publishHostEvent: (...args: unknown[]) => publishHostEvent(...(args as [])),
}))

type UiState = { memberStatus: Record<string, string>; memberActivity: Record<string, string> }
type Listener = (state: UiState) => void
let uiState: UiState = { memberStatus: {}, memberActivity: {} }
const listeners = new Set<Listener>()
jest.mock("@/stores/ui", () => ({
  useUIStore: {
    getState: () => uiState,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
}))
const setMemberStatus = (memberStatus: Record<string, string>) => {
  uiState = { ...uiState, memberStatus }
  for (const listener of listeners) listener(uiState)
}
const setMemberActivity = (memberActivity: Record<string, string>) => {
  uiState = { ...uiState, memberActivity }
  for (const listener of listeners) listener(uiState)
}

// Importing the module is what registers the runtime, and this suite imports
// nothing else that registers one, so the registry holds exactly this entry.
import { diffMemberStatus, ROOM_MEMBER_STATUS_TOPIC } from "./room-runner"

function context(): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_headless",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => `translated:${key}`,
    log: jest.fn(),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  sidecarHandler = null
  listeners.clear()
  uiState = { memberStatus: {}, memberActivity: {} }
})

it("registers on the brain and feeds every sidecar frame to the host runner", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  expect(result.failed).toEqual([])
  expect(result.started).toEqual(["room-runner"])
  const frame = { type: "event", sessionId: "room-1::char::a::t1", event: {} }
  sidecarHandler?.(frame)
  expect(handleEvent).toHaveBeenCalledWith(frame)
  await result.stop()
})

it("publishes member status changes as host events, including the clear at the turn's end", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  setMemberStatus({ "room-1::a": "thinking" })
  setMemberActivity({ "room-1::a": "Read · foo.ts" })
  setMemberStatus({ "room-1::a": "thinking", "room-1::b": "errored" })
  setMemberActivity({})
  setMemberStatus({})
  const frame = (characterId: string, status: string, activity: string | null) => [
    ROOM_MEMBER_STATUS_TOPIC,
    { sessionId: "room-1", characterId, status, activity },
  ]
  expect(publishHostEvent.mock.calls).toEqual([
    frame("a", "thinking", null),
    frame("a", "thinking", "Read · foo.ts"),
    frame("b", "errored", null),
    frame("a", "thinking", null),
    frame("a", "idle", null),
    frame("b", "idle", null),
  ])
  await result.stop()
})

it("ignores store updates that did not touch member status", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  for (const listener of listeners) listener(uiState)
  expect(publishHostEvent).not.toHaveBeenCalled()
  await result.stop()
})

it("logs and carries on when a publish fails", async () => {
  const ctx = context()
  publishHostEvent.mockRejectedValueOnce(new Error("bridge down"))
  const result = await bootstrapHeadlessRuntimes(ctx)
  setMemberStatus({ "room-1::a": "thinking" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(ctx.log).toHaveBeenCalledWith("warn", "room member status publish failed: bridge down")
  await result.stop()
})

it("stops listening to both the sidecar and the store on teardown", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  expect(listeners.size).toBe(1)
  await result.stop()
  expect(unlisten).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(0)
})

describe("diffMemberStatus", () => {
  const snap = (status: Record<string, string>, activity: Record<string, string> = {}) =>
    ({ status, activity }) as Parameters<typeof diffMemberStatus>[0]

  it("splits on the last separator so a room id with one inside survives", () => {
    expect(diffMemberStatus(snap({}), snap({ "a::b::c": "thinking" }))).toEqual([
      { sessionId: "a::b", characterId: "c", status: "thinking", activity: null },
    ])
  })

  it("drops keys it cannot split and reports unchanged members not at all", () => {
    expect(
      diffMemberStatus(
        snap({ "room::a": "idle", junk: "thinking" }),
        snap({ "room::a": "idle", "::x": "idle" })
      )
    ).toEqual([])
  })

  it("publishes a change of tool on its own, and clears it with the status", () => {
    expect(
      diffMemberStatus(
        snap({ "room::a": "thinking" }, { "room::a": "Read · a.ts" }),
        snap({ "room::a": "thinking" }, { "room::a": "Bash · pnpm test" })
      )
    ).toEqual([
      { sessionId: "room", characterId: "a", status: "thinking", activity: "Bash · pnpm test" },
    ])
    expect(
      diffMemberStatus(snap({ "room::a": "thinking" }, { "room::a": "Read · a.ts" }), snap({}))
    ).toEqual([{ sessionId: "room", characterId: "a", status: "idle", activity: null }])
  })
})
