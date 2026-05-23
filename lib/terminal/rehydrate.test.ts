/**
 * @jest-environment jsdom
 */

jest.mock("./session-registry", () => ({ registerLiveSession: jest.fn() }))
jest.mock("./spawn-orchestrator", () => ({ wireSessionToStore: jest.fn() }))

import { rehydrateTerminals } from "./rehydrate"
import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import type { SessionInfo } from "./types"
import type { TerminalSession } from "./session"

function info(id: string): SessionInfo {
  return { id, projectId: "p", extensionId: null, origin: "local", shell: "/bin/bash" }
}

function makeStore(): TerminalStoreLike {
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
  }
}

type ReattachFn = typeof TerminalSession.reattach
const fakeReattach = (id: string): Promise<TerminalSession> =>
  Promise.resolve({ info: info(id) } as unknown as TerminalSession)

beforeEach(() => {
  ;(registerLiveSession as jest.Mock).mockClear()
  ;(wireSessionToStore as jest.Mock).mockClear()
})

describe("rehydrateTerminals", () => {
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
  })

  it("returns zero when listing throws (no sessions / not Tauri)", async () => {
    const res = await rehydrateTerminals({
      store: makeStore(),
      list: jest.fn(async () => {
        throw new Error("invoke unavailable")
      }),
    })
    expect(res).toEqual({ restored: 0, failed: 0 })
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
  })

  it("does nothing when there are no alive sessions", async () => {
    const res = await rehydrateTerminals({ store: makeStore(), list: jest.fn(async () => []) })
    expect(res).toEqual({ restored: 0, failed: 0 })
    expect(registerLiveSession).not.toHaveBeenCalled()
  })
})
