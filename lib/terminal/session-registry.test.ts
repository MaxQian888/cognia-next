import type { BaseTerminalSession } from "./base-session"
import {
  __clearLiveSessionsForTesting,
  getLiveSession,
  listLiveSessions,
  registerLiveSession,
  subscribeLiveSessions,
  unregisterLiveSession,
} from "./session-registry"

function session(id: string): BaseTerminalSession {
  return { id, info: { id } } as unknown as BaseTerminalSession
}

describe("session-registry", () => {
  beforeEach(() => __clearLiveSessionsForTesting())

  it("registers, lists, and unregisters live sessions", () => {
    const first = session("first")
    const second = session("second")

    registerLiveSession(first)
    registerLiveSession(second)

    expect(getLiveSession("first")).toBe(first)
    expect(listLiveSessions()).toEqual([first, second])

    unregisterLiveSession("first")
    expect(getLiveSession("first")).toBeUndefined()
    expect(listLiveSessions()).toEqual([second])
  })

  it("notifies subscribers for register and unregister", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeLiveSessions(listener)

    registerLiveSession(session("one"))
    unregisterLiveSession("one")
    unsubscribe()
    registerLiveSession(session("ignored"))

    expect(listener).toHaveBeenCalledTimes(2)
  })
})
