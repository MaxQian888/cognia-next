import {
  __resetOfferedHostStateActionsForTesting,
  HostStateActionNotOfferedError,
  hostStateActionOffered,
  offeredHostStateActionsVersion,
  publishOfferedHostStateActions,
  refreshOfferedHostStateActions,
  retractOfferedHostStateActions,
  subscribeOfferedHostStateActions,
} from "./host-state-offered-actions"

beforeEach(() => __resetOfferedHostStateActionsForTesting())

describe("offered HostState actions", () => {
  it("reads as offered when nothing is known", () => {
    expect(hostStateActionOffered("turn.steer", "target-a")).toBe(true)
    expect(hostStateActionOffered("turn.steer", undefined)).toBe(true)
    publishOfferedHostStateActions("target-a", undefined)
    // A Host that names no restriction restricts nothing.
    expect(hostStateActionOffered("turn.steer", "target-a")).toBe(true)
  })

  it("follows the Host's list for its own target only", () => {
    publishOfferedHostStateActions("target-a", ["session.rename", "message.enqueue"])
    expect(hostStateActionOffered("message.enqueue", "target-a")).toBe(true)
    expect(hostStateActionOffered("turn.steer", "target-a")).toBe(false)
    expect(hostStateActionOffered("turn.steer", "target-b")).toBe(true)
    expect(hostStateActionOffered("turn.steer", null)).toBe(true)
  })

  it("keeps the answer until the last installer for a target stops", () => {
    publishOfferedHostStateActions("target-a", ["session.rename"])
    publishOfferedHostStateActions("target-a", ["session.rename"])
    retractOfferedHostStateActions("target-a")
    expect(hostStateActionOffered("turn.steer", "target-a")).toBe(false)
    retractOfferedHostStateActions("target-a")
    expect(hostStateActionOffered("turn.steer", "target-a")).toBe(true)
    // A stray retract is harmless.
    retractOfferedHostStateActions("target-a")
  })

  it("refreshes an installed answer and notifies only on a change", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeOfferedHostStateActions(listener)
    // No installed sync: a refresh records nothing.
    refreshOfferedHostStateActions("target-a", ["session.rename"])
    expect(listener).not.toHaveBeenCalled()

    publishOfferedHostStateActions("target-a", ["session.rename"])
    expect(listener).toHaveBeenCalledTimes(1)
    const version = offeredHostStateActionsVersion()
    refreshOfferedHostStateActions("target-a", ["session.rename"])
    expect(offeredHostStateActionsVersion()).toBe(version)
    refreshOfferedHostStateActions("target-a", ["session.rename", "turn.steer"])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(hostStateActionOffered("turn.steer", "target-a")).toBe(true)
    unsubscribe()
    retractOfferedHostStateActions("target-a")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("names the refused kind on its error", () => {
    const error = new HostStateActionNotOfferedError("session.workspace")
    expect(error).toMatchObject({
      code: "host_state_action_not_offered",
      kind: "session.workspace",
    })
    expect(error.message).toBe("host_state_action_not_offered:session.workspace")
  })
})
