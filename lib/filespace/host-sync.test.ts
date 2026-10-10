import type { ChatSession } from "@cognia/agent-config-types"

import type { Transport } from "@/lib/tauri/transport-types"

import { createFileShareHostSync, type FileShareHostSyncDeps } from "./host-sync"
import { DEFAULT_FILE_SHARING_POLICY } from "./policy"

function status(patch: Record<string, unknown> = {}) {
  return {
    active: true,
    accountId: "acct-1",
    sessionsWithGrants: ["s1"],
    ...patch,
  }
}

function setup(accountId: string | null = "acct-1") {
  const call = jest.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (name === "file_share_activate" || name === "file_share_status") return status()
    return {}
  })
  const transport = { call } as unknown as Transport
  let account = accountId
  const deps: FileShareHostSyncDeps = {
    target: { transport },
    accountId: () => account,
    loadPolicy: jest.fn(async () => ({
      policy: { ...DEFAULT_FILE_SHARING_POLICY, allowProtocolCredentials: true },
      local: DEFAULT_FILE_SHARING_POLICY,
      org: {
        orgId: "org-1",
        policy: { ...DEFAULT_FILE_SHARING_POLICY, revision: 7 },
      },
    })),
    getSession: jest.fn(async (id: string) => ({ id }) as ChatSession),
    loadSpace: jest.fn(async (sessionId: string) => ({
      space: { sessionId, status: "available" as const, hostId: "local", mounts: [] },
      dexie: { uploads: [], artifacts: [] },
    })),
  }
  return {
    call,
    deps,
    sync: createFileShareHostSync(deps),
    setAccount: (next: string | null) => {
      account = next
    },
  }
}

const names = (call: jest.Mock) => call.mock.calls.map(([name]) => name)

describe("createFileShareHostSync", () => {
  it("activates the account, then pushes the policy and the granted conversations", async () => {
    const { call, sync } = setup()
    await sync.activate()
    expect(names(call)).toEqual(["file_share_activate", "file_share_policy_set", "file_space_sync"])
    expect(call.mock.calls[0]![1]).toEqual({ accountId: "acct-1" })
    expect(call.mock.calls[1]![1]).toEqual({
      push: {
        policy: expect.objectContaining({ allowProtocolCredentials: true }),
        orgId: "org-1",
        orgRevision: 7,
      },
    })
    expect(call.mock.calls[2]![1]).toEqual({
      sessions: [{ sessionId: "s1", state: "active", mounts: [], assets: [] }],
    })
  })

  it("locks the host and pushes nothing else without an account", async () => {
    const { call, sync } = setup(null)
    await sync.activate()
    expect(names(call)).toEqual(["file_share_activate"])
    expect(call.mock.calls[0]![1]).toEqual({ accountId: null })
  })

  it("re-activates when the host lost the account, else refreshes", async () => {
    const { call, sync } = setup()
    await sync.refresh()
    expect(names(call)).toEqual(["file_share_status", "file_share_policy_set", "file_space_sync"])

    call.mockClear()
    call.mockImplementationOnce(async () => status({ active: false, accountId: null }))
    await sync.refresh()
    expect(names(call)[0]).toBe("file_share_status")
    expect(names(call)[1]).toBe("file_share_activate")
  })

  it("does nothing on refresh while locked", async () => {
    const { call, sync } = setup(null)
    await sync.refresh()
    expect(call).not.toHaveBeenCalled()
  })

  it("skips a conversation whose table cannot be built and pushes the rest", async () => {
    const { call, deps, sync } = setup()
    ;(deps.getSession as jest.Mock).mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("idb closed")
      return { id } as ChatSession
    })
    const log = jest.fn()
    const logged = createFileShareHostSync({ ...deps, log })
    await logged.syncSessions(["bad", "s2"])
    expect(call).toHaveBeenLastCalledWith("file_space_sync", {
      sessions: [{ sessionId: "s2", state: "active", mounts: [], assets: [] }],
    })
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("bad"))
    void sync
  })

  it("pushes a changed conversation at once, but only one the host has grants for", async () => {
    const { call, deps, sync } = setup()
    // "s1" was just deleted: there is no row, so its table says so.
    ;(deps.getSession as jest.Mock).mockImplementation(async (id: string) =>
      id === "s1" ? undefined : ({ id } as ChatSession)
    )
    await sync.sessionsChanged(["s1", "ungranted"])
    expect(names(call)).toEqual(["file_share_status", "file_space_sync"])
    expect(call.mock.calls[1]![1]).toEqual({
      sessions: [{ sessionId: "s1", state: "deleted", mounts: [], assets: [] }],
    })

    call.mockClear()
    await sync.sessionsChanged(["ungranted"])
    expect(names(call)).toEqual(["file_share_status"])
  })

  it("pushes no lifecycle change while locked or to a host serving another account", async () => {
    const locked = setup(null)
    await locked.sync.sessionsChanged(["s1"])
    expect(locked.call).not.toHaveBeenCalled()

    const { call, sync } = setup()
    call.mockImplementationOnce(async () => status({ accountId: "acct-2" }))
    await sync.sessionsChanged(["s1"])
    expect(names(call)).toEqual(["file_share_status"])
  })

  it("runs one call at a time so an account switch cannot interleave", async () => {
    const { call, sync, setAccount } = setup()
    const order: string[] = []
    call.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      order.push(`${name}:${String(args?.accountId ?? "")}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
      return status()
    })
    const first = sync.activate()
    setAccount("acct-2")
    const second = sync.activate()
    await Promise.all([first, second])
    const activations = order.filter((entry) => entry.startsWith("file_share_activate"))
    expect(activations).toEqual(["file_share_activate:acct-2", "file_share_activate:acct-2"])
    // The second activation started only after the first finished its pushes.
    expect(order.indexOf("file_share_activate:acct-2", 1)).toBeGreaterThan(
      order.indexOf("file_space_sync:")
    )
  })

  it("starts with an activation and refreshes on its interval until stopped", async () => {
    jest.useFakeTimers()
    try {
      const { call, sync } = setup()
      const stop = sync.start({ intervalMs: 1000 })
      await jest.advanceTimersByTimeAsync(0)
      expect(names(call)[0]).toBe("file_share_activate")
      call.mockClear()
      await jest.advanceTimersByTimeAsync(1000)
      expect(names(call)[0]).toBe("file_share_status")
      stop()
      call.mockClear()
      await jest.advanceTimersByTimeAsync(5000)
      expect(call).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("logs a failed activation instead of throwing out of start", async () => {
    const { call, deps } = setup()
    call.mockRejectedValue(new Error("host down"))
    const log = jest.fn()
    const stop = createFileShareHostSync({ ...deps, log }).start({ intervalMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("host down"))
    stop()
  })
})
