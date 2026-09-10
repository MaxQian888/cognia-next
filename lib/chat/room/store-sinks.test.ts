const chatState = {
  sessions: {
    "room-1": {
      messages: [{ id: "m1" }],
      steerQueue: [{ id: "s1", text: "later" }],
    },
  } as Record<string, { messages: unknown[]; steerQueue: unknown[] }>,
  referencedPaths: [{ absolute: "/a", isDir: false, extra: "dropped" }],
  setSessionStatus: jest.fn(),
  setSessionError: jest.fn(),
  setSessionDiagnostic: jest.fn(),
  replaceSessionMessages: jest.fn(),
  setSessionActiveBranch: jest.fn(),
  enqueueSteer: jest.fn(),
  clearSteerQueue: jest.fn(),
  pushApproval: jest.fn(),
  clearApproval: jest.fn(),
}
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => chatState } }))

const settingsState = {
  settings: { alwaysAllowTools: ["Read"] } as { alwaysAllowTools: string[] } | null,
  toggleAlwaysAllow: jest.fn(async () => undefined),
}
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: () => settingsState } }))

const uiState = {
  setMemberStatus: jest.fn(),
  setMemberActivity: jest.fn(),
  clearMemberStatusFor: jest.fn(),
  isStopRequested: jest.fn(() => true),
  requestStopMember: jest.fn(),
  clearStopRequest: jest.fn(),
  clearStopRequestsFor: jest.fn(),
}
jest.mock("@/stores/ui", () => ({ useUIStore: { getState: () => uiState } }))

const steerRuntime = {
  appendSteerMessage: jest.fn(),
  isSessionOpen: jest.fn(() => true),
  maybeDrainSteer: jest.fn(),
  sessionStatusOf: jest.fn(() => "streaming"),
  steerArmed: new Set<string>(),
}
jest.mock("@/hooks/chat/steer-runtime", () => ({
  appendSteerMessage: (...args: unknown[]) => steerRuntime.appendSteerMessage(...(args as [])),
  isSessionOpen: (...args: unknown[]) => steerRuntime.isSessionOpen(...(args as [])),
  maybeDrainSteer: (...args: unknown[]) => steerRuntime.maybeDrainSteer(...(args as [])),
  sessionStatusOf: (...args: unknown[]) => steerRuntime.sessionStatusOf(...(args as [])),
  get steerArmed() {
    return steerRuntime.steerArmed
  },
}))

const attachRegistry = {
  armApprovalBackstop: jest.fn(),
  clearApprovalBackstops: jest.fn(),
  isSessionAttached: jest.fn(() => false),
}
jest.mock("@/lib/companion/remote-attach-registry", () => ({
  armApprovalBackstop: (...args: unknown[]) => attachRegistry.armApprovalBackstop(...(args as [])),
  clearApprovalBackstops: (...args: unknown[]) =>
    attachRegistry.clearApprovalBackstops(...(args as [])),
  isSessionAttached: (...args: unknown[]) => attachRegistry.isSessionAttached(...(args as [])),
}))

const notifyRemoteNeedsInput = jest.fn(async () => undefined)
jest.mock("@/lib/companion/needs-input-notifier", () => ({
  notifyRemoteNeedsInput: (...args: unknown[]) => notifyRemoteNeedsInput(...(args as [])),
}))

import { createStoreRoomSinks } from "./store-sinks"
import { clearComposerTyping, noteComposerTyping } from "@/stores/chat/composer-typing-store"

const permission = {
  type: "permission_request",
  sessionId: "room-1::char::a::t1",
  requestId: "req-1",
  toolName: "Bash",
} as never

beforeEach(() => {
  jest.clearAllMocks()
  attachRegistry.isSessionAttached.mockReturnValue(false)
  settingsState.settings = { alwaysAllowTools: ["Read"] }
})

it("reads and writes session status and diagnostics through the chat store", () => {
  const sinks = createStoreRoomSinks()
  expect(sinks.status.get("room-1")).toBe("streaming")
  sinks.status.set("room-1", "idle")
  sinks.status.setError("room-1", null)
  sinks.diagnostic("room-1", { code: "x" } as never)
  expect(chatState.setSessionStatus).toHaveBeenCalledWith("room-1", "idle")
  expect(chatState.setSessionError).toHaveBeenCalledWith("room-1", null)
  expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith("room-1", { code: "x" })
})

it("exposes the live message slice and commits through the pane-aware replace", () => {
  const sinks = createStoreRoomSinks()
  expect(sinks.messages.read("room-1")).toEqual([{ id: "m1" }])
  expect(sinks.messages.read("nope")).toBeUndefined()
  sinks.messages.commit("room-1", [])
  sinks.messages.setActiveBranch("room-1", "g", "m")
  expect(chatState.replaceSessionMessages).toHaveBeenCalledWith("room-1", [])
  expect(chatState.setSessionActiveBranch).toHaveBeenCalledWith("room-1", "g", "m")
  expect(sinks.messages.isOpen("room-1")).toBe(true)
  expect(steerRuntime.isSessionOpen).toHaveBeenCalledWith("room-1")
})

it("shares the steer queue, its armed set and the drain with direct chat", () => {
  const sinks = createStoreRoomSinks()
  expect(sinks.steer.queue("room-1")).toEqual([{ id: "s1", text: "later" }])
  expect(sinks.steer.queue("nope")).toEqual([])
  sinks.steer.enqueue("room-1", { id: "s2", text: "x" } as never)
  sinks.steer.clear("room-1")
  sinks.steer.appendMessage("room-1", { id: "u" } as never)
  const replay = jest.fn()
  sinks.steer.drain("room-1", replay)
  expect(chatState.enqueueSteer).toHaveBeenCalledWith("room-1", { id: "s2", text: "x" })
  expect(chatState.clearSteerQueue).toHaveBeenCalledWith("room-1")
  expect(steerRuntime.appendSteerMessage).toHaveBeenCalledWith("room-1", { id: "u" })
  expect(steerRuntime.maybeDrainSteer).toHaveBeenCalledWith("room-1", replay)
  expect(sinks.steer.armed).toBe(steerRuntime.steerArmed)
})

it("routes member status and stop requests to the UI store", () => {
  const sinks = createStoreRoomSinks()
  sinks.members.setStatus("room-1", "a", "thinking")
  sinks.members.setActivity("room-1", "a", "Read · foo.ts")
  sinks.members.clearFor("room-1")
  expect(sinks.members.isStopRequested("room-1", "a")).toBe(true)
  sinks.members.requestStop("room-1", "b")
  expect(uiState.requestStopMember).toHaveBeenCalledWith("room-1", "b")
  sinks.members.clearStopRequest("room-1", "a")
  sinks.members.clearStopRequestsFor("room-1")
  expect(uiState.setMemberStatus).toHaveBeenCalledWith("room-1", "a", "thinking")
  expect(uiState.setMemberActivity).toHaveBeenCalledWith("room-1", "a", "Read · foo.ts")
  expect(uiState.clearMemberStatusFor).toHaveBeenCalledWith("room-1")
  expect(uiState.clearStopRequest).toHaveBeenCalledWith("room-1", "a")
  expect(uiState.clearStopRequestsFor).toHaveBeenCalledWith("room-1")
})

it("pushes and clears approvals on the chat store", () => {
  const sinks = createStoreRoomSinks()
  sinks.approvals.push({ requestId: "req-1" } as never)
  sinks.approvals.clear("req-1")
  expect(chatState.pushApproval).toHaveBeenCalledWith({ requestId: "req-1" })
  expect(chatState.clearApproval).toHaveBeenCalledWith("req-1")
})

it("does not route a decision remotely when nobody is attached to the room", () => {
  const sinks = createStoreRoomSinks()
  const deny = jest.fn(async () => undefined)
  expect(sinks.approvals.routeRemote("room-1", permission, deny)).toBe(false)
  expect(attachRegistry.armApprovalBackstop).not.toHaveBeenCalled()
  expect(notifyRemoteNeedsInput).not.toHaveBeenCalled()
})

it("hands the decision to the attached device, arms a backstop deny and wakes it by ids only", async () => {
  attachRegistry.isSessionAttached.mockReturnValue(true)
  const sinks = createStoreRoomSinks()
  const deny = jest.fn(async () => undefined)
  expect(sinks.approvals.routeRemote("room-1", permission, deny)).toBe(true)
  expect(attachRegistry.isSessionAttached).toHaveBeenCalledWith("room-1")
  // The backstop is keyed by the member sub-session that owns the request.
  expect(attachRegistry.armApprovalBackstop).toHaveBeenCalledWith(
    "room-1::char::a::t1",
    "req-1",
    expect.any(Function)
  )
  expect(notifyRemoteNeedsInput).toHaveBeenCalledWith({ sessionId: "room-1", requestId: "req-1" })
  expect(deny).not.toHaveBeenCalled()

  const fire = attachRegistry.armApprovalBackstop.mock.calls[0][2] as () => void
  fire()
  await Promise.resolve()
  expect(deny).toHaveBeenCalledWith("auto-denied: remote approval timed out")
})

it("still reports the decision as routed when the wake-up push fails", () => {
  attachRegistry.isSessionAttached.mockReturnValue(true)
  notifyRemoteNeedsInput.mockRejectedValueOnce(new Error("no push"))
  const sinks = createStoreRoomSinks()
  expect(sinks.approvals.routeRemote("room-1", permission, jest.fn())).toBe(true)
})

it("stands the backstop down on the member's next event", () => {
  const sinks = createStoreRoomSinks()
  sinks.approvals.onEvent?.("room-1::char::a::t1")
  expect(attachRegistry.clearApprovalBackstops).toHaveBeenCalledWith("room-1::char::a::t1")
})

it("reads settings, the always-allow list and the referenced paths without extra fields", async () => {
  const sinks = createStoreRoomSinks()
  expect(sinks.settings.read()).toEqual({ alwaysAllowTools: ["Read"] })
  expect(sinks.settings.alwaysAllowTools()).toEqual(["Read"])
  await sinks.settings.toggleAlwaysAllow("Bash", true)
  expect(settingsState.toggleAlwaysAllow).toHaveBeenCalledWith("Bash", true)
  expect(sinks.referencedPaths()).toEqual([{ absolute: "/a", isDir: false }])

  settingsState.settings = null
  expect(sinks.settings.read()).toBeUndefined()
  expect(sinks.settings.alwaysAllowTools()).toEqual([])
})

it("reads the composer's typing signal for the room (ADR-0177 batch 3)", () => {
  const sinks = createStoreRoomSinks()
  expect(sinks.human.lastTypedAt("room-1")).toBeNull()
  noteComposerTyping("room-1", 4_200)
  expect(sinks.human.lastTypedAt("room-1")).toBe(4_200)
  clearComposerTyping("room-1")
  expect(sinks.human.lastTypedAt("room-1")).toBeNull()
})
