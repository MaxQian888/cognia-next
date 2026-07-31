/**
 * @jest-environment jsdom
 */

jest.mock("./session-registry", () => ({ registerLiveSession: jest.fn() }))
jest.mock("./spawn-orchestrator", () => ({ wireSessionToStore: jest.fn() }))
let mockTransportChain: Array<"tauri-channel" | "ws" | "webrtc"> = ["tauri-channel"]
jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockTransportChain,
}))

import { rehydrateTerminals } from "./rehydrate"
import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import type { SessionInfo } from "./types"
import type { TerminalSession } from "./session"
import { RemoteTerminalSession } from "./transport-ws"

function info(id: string): SessionInfo {
  return { id, projectId: "p", extensionId: null, origin: "local", shell: "/bin/bash" }
}

type TestStore = TerminalStoreLike & { restorePersistedLayout: jest.Mock }

function makeStore(): TestStore {
  return {
    registerSession: jest.fn(),
    removeSession: jest.fn(),
    setSessionStatus: jest.fn(),
    setSessionExit: jest.fn(),
    setSessionCwd: jest.fn(),
    pushPrompt: jest.fn(),
    closePrompt: jest.fn(),
    pushCommand: jest.fn(),
    sessions: {},
    restorePersistedLayout: jest.fn(),
  }
}

type ReattachFn = typeof TerminalSession.reattach
const fakeReattach = (id: string): Promise<TerminalSession> =>
  Promise.resolve({ info: info(id) } as unknown as TerminalSession)

beforeEach(() => {
  mockTransportChain = ["tauri-channel"]
  ;(registerLiveSession as jest.Mock).mockClear()
  ;(wireSessionToStore as jest.Mock).mockClear()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("rehydrateTerminals", () => {
  it("falls from LAN to WAN when restoring mobile host sessions", async () => {
    mockTransportChain = ["ws", "webrtc"]
    const store = makeStore()
    const remoteInfo = { ...info("remote-a"), origin: "remote" as const }
    const remoteSession = { info: remoteInfo } as unknown as TerminalSession
    jest.spyOn(RemoteTerminalSession, "listLan").mockRejectedValue(new Error("LAN offline"))
    jest.spyOn(RemoteTerminalSession, "listWan").mockResolvedValue([remoteInfo])
    jest.spyOn(RemoteTerminalSession, "reattachLan").mockRejectedValue(new Error("LAN offline"))
    jest
      .spyOn(RemoteTerminalSession, "reattachWan")
      .mockResolvedValue(remoteSession as unknown as RemoteTerminalSession)

    await expect(rehydrateTerminals({ store })).resolves.toEqual({ restored: 1, failed: 0 })
    expect(RemoteTerminalSession.listLan).toHaveBeenCalledTimes(1)
    expect(RemoteTerminalSession.listWan).toHaveBeenCalledTimes(1)
    expect(RemoteTerminalSession.reattachWan).toHaveBeenCalledWith("remote-a", 0)
  })

  it("restores each alive session: row + reattach + register + wire", async () => {
    const store = makeStore()
    const list = jest.fn(async () => [info("a"), info("b")])
    const reattach = jest.fn(fakeReattach) as unknown as ReattachFn

    const res = await rehydrateTerminals({ store, list, reattach })

    expect(res).toEqual({ restored: 2, failed: 0 })
    expect(store.registerSession).toHaveBeenCalledTimes(2)
    expect(reattach).toHaveBeenCalledWith("a", 0)
    expect(reattach).toHaveBeenCalledWith("b", 0)
    expect(registerLiveSession).toHaveBeenCalledTimes(2)
    expect(wireSessionToStore).toHaveBeenCalledTimes(2)
    expect(store.restorePersistedLayout).toHaveBeenCalledTimes(1)
  })

  it("skips sessions whose shell already exited", async () => {
    // Rust keeps exited sessions listed so scrollback survives; restoring one
    // would give the user a tab with no PTY behind it.
    const store = makeStore()
    const list = jest.fn(async () => [
      info("alive"),
      { ...info("dead"), alive: false },
      { ...info("legacy"), alive: undefined },
    ])
    const reattach = jest.fn(fakeReattach) as unknown as ReattachFn

    const res = await rehydrateTerminals({ store, list, reattach })

    // The legacy row (transport predating the flag) is still restored.
    expect(res).toEqual({ restored: 2, failed: 0 })
    expect(reattach).toHaveBeenCalledWith("alive", 0)
    expect(reattach).toHaveBeenCalledWith("legacy", 0)
    expect(reattach).not.toHaveBeenCalledWith("dead", 0)
  })

  it("restores layout only after every surviving PTY row is registered", async () => {
    const order: string[] = []
    const store = makeStore()
    ;(store.registerSession as jest.Mock).mockImplementation((session: SessionInfo) =>
      order.push(`register:${session.id}`)
    )
    store.restorePersistedLayout.mockImplementation(() => order.push("restore-layout"))

    await rehydrateTerminals({
      store,
      list: jest.fn(async () => [info("a"), info("b")]),
      reattach: jest.fn(fakeReattach) as unknown as ReattachFn,
    })

    expect(order).toEqual(["register:a", "register:b", "restore-layout"])
  })

  it("registers the live session before the store row so the instance can attach", async () => {
    const order: string[] = []
    const store = makeStore()
    ;(store.registerSession as jest.Mock).mockImplementation(() => order.push("store"))
    ;(registerLiveSession as jest.Mock).mockImplementation(() => order.push("live"))
    const list = jest.fn(async () => [info("a")])
    const reattach = jest.fn(fakeReattach) as unknown as ReattachFn

    await rehydrateTerminals({ store, list, reattach })

    // The dock mounts the TerminalInstance off the store row; its setup effect
    // reads getLiveSession() once, so the live registry must be populated first.
    expect(order).toEqual(["live", "store"])
  })

  it("does not add a store row when reattach fails", async () => {
    const store = makeStore()
    const list = jest.fn(async () => [info("bad")])
    const reattach = jest.fn(() => Promise.reject(new Error("gone"))) as unknown as ReattachFn

    const res = await rehydrateTerminals({ store, list, reattach })

    expect(res).toEqual({ restored: 0, failed: 1 })
    expect(store.registerSession).not.toHaveBeenCalled()
  })

  it("returns zero when listing throws (no sessions / not Tauri)", async () => {
    const store = makeStore()
    const res = await rehydrateTerminals({
      store,
      list: jest.fn(async () => {
        throw new Error("invoke unavailable")
      }),
    })
    expect(res).toEqual({ restored: 0, failed: 0 })
    expect(store.restorePersistedLayout).not.toHaveBeenCalled()
  })

  it("counts per-session failures without aborting the rest", async () => {
    const store = makeStore()
    const list = jest.fn(async () => [info("ok"), info("bad")])
    const reattach = jest.fn((id: string) =>
      id === "bad" ? Promise.reject(new Error("gone")) : fakeReattach(id)
    ) as unknown as ReattachFn

    const res = await rehydrateTerminals({ store, list, reattach })

    expect(res).toEqual({ restored: 1, failed: 1 })
    expect(registerLiveSession).toHaveBeenCalledTimes(1)
    expect(store.restorePersistedLayout).toHaveBeenCalledTimes(1)
  })

  it("clears stale reload metadata when no PTY sessions survived", async () => {
    const store = makeStore()
    const res = await rehydrateTerminals({ store, list: jest.fn(async () => []) })
    expect(res).toEqual({ restored: 0, failed: 0 })
    expect(registerLiveSession).not.toHaveBeenCalled()
    expect(store.restorePersistedLayout).toHaveBeenCalledTimes(1)
  })
})
