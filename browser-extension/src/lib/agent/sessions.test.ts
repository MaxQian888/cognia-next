import { memoryStorageArea } from "./storage-area"
import {
  AGENT_SESSIONS_KEY,
  SESSION_IDLE_TTL_MS,
  SessionStore,
  newSession,
  sessionForTab,
  sweepSessions,
  withTab,
  withoutTab,
} from "./sessions"

describe("agent sessions", () => {
  it("adds tabs, remembers which it opened, and makes the newest active", () => {
    let session = newSession("s", 1)
    session = withTab(session, 10, { owned: false, windowId: 3 })
    session = withTab(session, 11, { owned: true, windowId: 4 })
    session = withTab(session, 11, { owned: true })
    expect(session).toMatchObject({
      tabIds: [10, 11],
      ownedTabIds: [11],
      activeTabId: 11,
      windowId: 3,
    })
  })

  it("falls back to the last remaining tab when the active one closes", () => {
    let session = withTab(withTab(newSession("s", 1), 10, { owned: false }), 11, { owned: true })
    session = withoutTab(session, 11)
    expect(session).toMatchObject({ tabIds: [10], ownedTabIds: [], activeTabId: 10 })
    session = withoutTab(session, 10)
    expect(session.activeTabId).toBeNull()
  })

  it("finds the session that holds a tab and sweeps idle ones", () => {
    const busy = {
      ...withTab(newSession("busy", 1), 5, { owned: true }),
      lastActivityAt: SESSION_IDLE_TTL_MS,
    }
    const idle = { ...newSession("idle", 0), lastActivityAt: 0 }
    expect(sessionForTab({ busy, idle }, 5)?.id).toBe("busy")
    expect(sessionForTab({ busy, idle }, 6)).toBeNull()
    expect(Object.keys(sweepSessions({ busy, idle }, SESSION_IDLE_TTL_MS + 1))).toEqual(["busy"])
  })

  it("serializes concurrent updates so neither is lost", async () => {
    const area = memoryStorageArea()
    const store = new SessionStore(area)
    await Promise.all([
      store.updateSession("a", 10, (session) => withTab(session, 1, { owned: true })),
      store.updateSession("b", 10, (session) => withTab(session, 2, { owned: true })),
      store.updateSession("a", 11, (session) => ({ ...session, takeover: true })),
    ])
    const all = await store.all()
    expect(Object.keys(all).sort()).toEqual(["a", "b"])
    expect(all.a).toMatchObject({ tabIds: [1], takeover: true, lastActivityAt: 11 })
    await store.remove("a")
    expect(
      Object.keys((await area.get<Record<string, unknown>>(AGENT_SESSIONS_KEY)) ?? {})
    ).toEqual(["b"])
  })

  it("keeps a paused session through unrelated idle sweeps until an explicit resume", async () => {
    const store = new SessionStore(memoryStorageArea())
    await store.updateSession("paused", 0, (session) => ({ ...session, takeover: true }))
    await store.updateSession("other", SESSION_IDLE_TTL_MS + 1, (session) => session)
    expect(await store.get("paused")).toMatchObject({ takeover: true })
    await store.updateSession("paused", SESSION_IDLE_TTL_MS + 2, (session) => ({
      ...session,
      takeover: false,
    }))
    await store.updateSession("other", 2 * SESSION_IDLE_TTL_MS + 3, (session) => session)
    expect(await store.get("paused")).toBeNull()
  })
})
