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
import { TerminalSession } from "./session"
import { SshTerminalSession } from "./ssh-session"
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

/**
 * Reattach receives the whole listing entry, not just an id — it has to read
 * `kind` to decide between a local `TerminalSession` and an
 * `SshTerminalSession` that keeps the host-key verdict.
 */
type ReattachFn = (listed: SessionInfo, resumeAfter: number) => Promise<TerminalSession>
const fakeReattach = (listed: SessionInfo): Promise<TerminalSession> =>
  Promise.resolve({ info: listed } as unknown as TerminalSession)

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
    expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), 0)
    expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), 0)
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
    expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: "alive" }), 0)
    expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: "legacy" }), 0)
    expect(reattach).not.toHaveBeenCalledWith(expect.objectContaining({ id: "dead" }), 0)
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

  it("reports an unusable transport instead of silently restoring nothing", async () => {
    // Defensive `default:` arms in both switches. A chain entry the module does
    // not know about must surface as a host error, not as a quiet empty restore
    // — the dock would otherwise show no tabs and no explanation.
    mockTransportChain = ["bluetooth" as unknown as "ws"]
    const store: TestStore & { setHostState?: jest.Mock } = {
      ...makeStore(),
      setHostState: jest.fn(),
    }

    const res = await rehydrateTerminals({ store })

    expect(res).toEqual({ restored: 0, failed: 0 })
    expect(store.setHostState).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("transport unavailable")
    )
  })

  it("counts a per-session reattach that no transport can serve", async () => {
    mockTransportChain = ["bluetooth" as unknown as "ws"]
    const store = makeStore()

    const res = await rehydrateTerminals({ store, list: jest.fn(async () => [info("a")]) })

    expect(res).toEqual({ restored: 0, failed: 1 })
    expect(store.registerSession).not.toHaveBeenCalled()
  })

  it("rebuilds an SSH session through the SSH class, not the generic one", async () => {
    // Exercises the real `reattachToActiveHost` (no injected `reattach`), which
    // is where the transport-and-kind decision actually lives. Rebuilding SSH
    // as a plain `TerminalSession` still moves bytes, so only this assertion
    // catches the fingerprint being silently dropped.
    const store = makeStore()
    const sshInfo: SessionInfo = { ...info("ssh-a"), kind: "ssh", profileId: "ssh-1" }
    const sshReattach = jest
      .spyOn(SshTerminalSession, "reattach")
      .mockResolvedValue({ info: sshInfo } as unknown as SshTerminalSession)
    const localReattach = jest
      .spyOn(TerminalSession, "reattach")
      .mockResolvedValue({ info: info("local-a") } as unknown as TerminalSession)

    await rehydrateTerminals({
      store,
      list: jest.fn(async () => [sshInfo, info("local-a")]),
    })

    expect(sshReattach).toHaveBeenCalledWith(expect.objectContaining({ kind: "ssh" }), 0)
    expect(localReattach).toHaveBeenCalledWith("local-a", 0)
  })

  it("carries SSH identity onto the restored row", async () => {
    // Without `kind` and `profileId` the restored tab is indistinguishable
    // from a local shell called "ssh", and nothing can map it back to the
    // host profile it came from.
    const store = makeStore()
    const sshInfo: SessionInfo = {
      ...info("ssh-a"),
      kind: "ssh",
      profileId: "ssh-1",
      hostId: "host-1",
      shell: "ssh deploy@prod.example.com",
      sshHostKeyStatus: "verified",
      sshHostKeyFingerprint: "SHA256:abc",
    }
    const reattach = jest.fn(fakeReattach) as unknown as ReattachFn

    await rehydrateTerminals({ store, list: jest.fn(async () => [sshInfo]), reattach })

    expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ kind: "ssh" }), 0)
    expect(store.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ssh-a",
        kind: "ssh",
        profileId: "ssh-1",
        hostId: "host-1",
      })
    )
  })

  it("counts per-session failures without aborting the rest", async () => {
    const store = makeStore()
    const list = jest.fn(async () => [info("ok"), info("bad")])
    const reattach = jest.fn((listed: SessionInfo) =>
      listed.id === "bad" ? Promise.reject(new Error("gone")) : fakeReattach(listed)
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
