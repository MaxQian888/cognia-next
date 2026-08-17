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

  it("re-notifies subscribers when a registered session's info is refreshed (ADR-0131)", () => {
    let infoListener: (() => void) | undefined
    const off = jest.fn()
    const live = {
      id: "live",
      info: { id: "live" },
      onInfo: jest.fn((cb: () => void) => {
        infoListener = cb
        return () => {
          off()
          infoListener = undefined
        }
      }),
    } as unknown as BaseTerminalSession
    const listener = jest.fn()
    subscribeLiveSessions(listener)

    registerLiveSession(live)
    expect(listener).toHaveBeenCalledTimes(1)
    infoListener?.()
    expect(listener).toHaveBeenCalledTimes(2)

    // Re-registering the same id replaces the previous info subscription.
    registerLiveSession(live)
    expect(off).toHaveBeenCalledTimes(1)

    unregisterLiveSession("live")
    expect(off).toHaveBeenCalledTimes(2)
    // A stale info callback after unregister must not notify.
    infoListener?.()
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it("tolerates handles without onInfo (test doubles, legacy classes)", () => {
    expect(() => registerLiveSession(session("bare"))).not.toThrow()
    expect(getLiveSession("bare")).toBeDefined()
  })
})
