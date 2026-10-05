import "fake-indexeddb/auto"

import { revokeDevice } from "../enrollment/manage"
import type { FakeSyncServer } from "../testing/fake-sync-server"
import { __clearAccountSyncKeyCache } from "../vault-store"
import {
  REVOKED_CLOSE_CODE,
  accountSyncLockName,
  startAccountSyncEngine,
  type AccountSyncEngine,
  type AccountSyncEngineDeps,
  type EngineStatus,
  type LockManagerLike,
  type SocketLike,
} from "./engine"
import { disarm } from "./join"
import { closeAll, syncedDevices, type SyncDevice } from "./test-support"
import type { AccountSyncCaptureState } from "./types"

beforeEach(() => __clearAccountSyncKeyCache())

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "Plan", createdAt: 1, updatedAt: 1, ...extra }) as never

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null
  onmessage: SocketLike["onmessage"] = null
  onclose: SocketLike["onclose"] = null
  onerror: SocketLike["onerror"] = null
  readonly sent: string[] = []
  closed = false
  constructor(readonly url: string) {
    setTimeout(() => {
      if (!this.closed) this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000) {
    if (this.closed) return
    this.closed = true
    this.onclose?.({ code })
  }
  receive(message: unknown) {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) })
  }
}

/** Sockets the engines open, told about every push the fake server stores. */
function socketHub(server: FakeSyncServer) {
  const sockets: FakeSocket[] = []
  let running = true
  void (async () => {
    while (running) {
      await server.nextPush()
      await Promise.resolve()
      for (const socket of sockets)
        socket.receive({ type: "ops", lastSeq: server.batches.at(-1)?.lastSeq })
    }
  })()
  return {
    sockets,
    open: (url: string) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    live: () => sockets.filter((socket) => !socket.closed),
    dispose: () => {
      running = false
    },
  }
}

/** Exclusive Web Locks, in request order. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<void>>()
  return {
    request(name, { signal }, callback) {
      const before = tails.get(name) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      tails.set(
        name,
        before.then(() => held)
      )
      return before.then(async () => {
        if (signal.aborted) {
          release()
          throw new DOMException("aborted", "AbortError")
        }
        try {
          await callback()
        } finally {
          release()
        }
      })
    },
  }
}

const FAST = {
  pushDebounceMs: 5,
  pushMaxDelayMs: 40,
  pingMs: 20,
  longPollWaitS: 1,
  retryMs: () => 20,
}

async function engineFor(
  device: SyncDevice,
  overrides: Partial<AccountSyncEngineDeps> = {}
): Promise<{ engine: AccountSyncEngine; statuses: EngineStatus[]; applied: string[][] }> {
  const statuses: EngineStatus[] = []
  const applied: string[][] = []
  const engine = startAccountSyncEngine({
    context: device.context,
    device: await device.keys(),
    db: device.db,
    locks: null,
    openSocket: null,
    delays: FAST,
    onStatus: (status) => statuses.push(status),
    onApplied: (tables) => applied.push([...tables]),
    ...overrides,
  })
  return { engine, statuses, applied }
}

const running = (engine: AccountSyncEngine) => engine.status().kind === "running"

describe("startAccountSyncEngine", () => {
  it("carries a write to the other device over the live socket", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const hub = socketHub(server)
    const first = await engineFor(a, { openSocket: hub.open })
    const second = await engineFor(b, { openSocket: hub.open })
    await until(() => hub.live().length === 2)
    await until(() => {
      const status = second.engine.status()
      return status.kind === "running" && status.live === "socket"
    })

    await a.db.sessions.put(session("s1"))
    await until(async () => (await b.db.sessions.get("s1")) !== undefined)
    expect(second.applied.flat()).toContain("sessions")
    await until(() => {
      const status = first.engine.status()
      return status.kind === "running" && status.pending === 0 && status.lastSyncedAt !== null
    })
    // The socket is kept alive.
    await until(() => hub.live()[0]!.sent.includes("ping"))

    first.engine.stop()
    second.engine.stop()
    expect(hub.live()).toHaveLength(0)
    expect(first.engine.status()).toEqual({ kind: "stopped" })
    hub.dispose()
    closeAll(devices)
  })

  it("long-polls without a socket, and falls back to polling when the socket drops", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const hub = socketHub(server)
    const first = await engineFor(a)
    const second = await engineFor(b, { openSocket: hub.open })
    await until(() => running(first.engine) && hub.live().length === 1)
    expect(first.engine.status()).toMatchObject({ live: "poll" })

    hub.live()[0]!.close(1006)
    await until(() => (second.engine.status() as { live?: string }).live === "poll")
    await b.db.sessions.put(session("from-b"))
    await until(async () => (await a.db.sessions.get("from-b")) !== undefined)
    await a.db.sessions.put(session("from-a"))
    await until(async () => (await b.db.sessions.get("from-a")) !== undefined)
    // And the socket comes back.
    await until(() => (second.engine.status() as { live?: string }).live === "socket")

    first.engine.stop()
    second.engine.stop()
    hub.dispose()
    closeAll(devices)
  })

  it("believes a removal only from the list, then disarms and stops", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const hub = socketHub(server)
    const second = await engineFor(b, { openSocket: hub.open })
    await until(() => hub.live().length === 1)

    // A server claiming the removal is not enough: the engine reconnects.
    hub.live()[0]!.close(REVOKED_CLOSE_CODE)
    await until(() => (second.engine.status() as { live?: string }).live === "poll")
    await until(() => (second.engine.status() as { live?: string }).live === "socket")
    expect(await b.db.accountSyncState.get("capture")).toBeDefined()
    expect(second.engine.status().kind).toBe("running")

    await revokeDevice(a.context, await a.keys(), (await b.keys()).deviceId)
    hub.live()[0]?.close(REVOKED_CLOSE_CODE)
    await until(() => second.engine.status().kind === "removed")
    expect(await b.db.accountSyncState.get("capture")).toBeUndefined()
    expect(await b.context.vault.loadDeviceKeys()).toBeNull()
    expect(hub.live()).toHaveLength(0)
    hub.dispose()
    closeAll(devices)
  })

  it("lets one window per database lead, and the next take over when it stops", async () => {
    const { devices } = await syncedDevices(["a"])
    const a = devices[0] as SyncDevice
    const locks = fakeLocks()
    const first = await engineFor(a, { locks })
    const second = await engineFor(a, { locks })
    await until(() => running(first.engine))
    expect(second.engine.status()).toEqual({ kind: "follower" })
    expect(accountSyncLockName(a.db)).toBe(`cognia-account-sync:${a.db.name}`)

    first.engine.stop()
    await until(() => running(second.engine))
    second.engine.stop()
    closeAll(devices)
  })

  it("asks when both sides hold data, and joins as chosen after the backup", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await a.db.sessions.put(session("from-a"))
    await a.round()
    await disarm(b.db)
    await b.db.sessions.put(session("from-b"))
    const backup = jest.fn(async () => undefined)
    const { engine, statuses } = await engineFor(b)
    await until(() => engine.status().kind === "join-choice")
    expect(engine.status()).toMatchObject({ local: { total: 1 }, remoteSeq: 1 })
    expect(backup).not.toHaveBeenCalled()

    // A cancelled backup changes nothing and leaves the choice open.
    await expect(
      engine.join("merge", async () => {
        throw new Error("cancelled")
      })
    ).rejects.toThrow("cancelled")
    expect(engine.status().kind).toBe("join-choice")
    expect(await b.db.accountSyncState.get("capture")).toBeUndefined()

    await engine.join("merge", backup)
    await until(() => running(engine))
    expect(backup).toHaveBeenCalledTimes(1)
    expect(statuses.some((status) => status.kind === "seeding")).toBe(true)
    await until(async () => (await b.db.sessions.get("from-a")) !== undefined)
    await until(
      async () => (await a.round()).applied > 0 || (await a.db.sessions.get("from-b")) !== undefined
    )
    expect(await a.db.sessions.get("from-b")).toBeDefined()
    await expect(engine.join("merge", backup)).rejects.toThrow("no join choice is pending")
    engine.stop()
    closeAll(devices)
  })

  it("seeds on its own when the account is still empty", async () => {
    const { server, devices } = await syncedDevices(["a"])
    const a = devices[0] as SyncDevice
    await disarm(a.db)
    await a.db.sessions.bulkPut([session("s1"), session("s2")])
    const { engine } = await engineFor(a)
    await until(() => server.batches.length > 0)
    expect(server.batches.flatMap((batch) => batch.ops)).toHaveLength(2)
    engine.stop()
    closeAll(devices)
  })

  it("stops both directions for a class switched off, and catches up when it is on again", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const first = await engineFor(a)
    const second = await engineFor(b)
    await until(() => running(first.engine) && running(second.engine))

    await second.engine.setClasses({ content: false, settings: true })
    expect(second.engine.status()).toMatchObject({ classes: { content: false, settings: true } })
    await a.db.sessions.put(session("while-off"))
    await b.db.sessions.put(session("b-while-off"))
    await until(async () => (await a.db.accountSyncOutbox.count()) === 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await b.db.sessions.get("while-off")).toBeUndefined()
    expect(await a.db.sessions.get("b-while-off")).toBeUndefined()

    await second.engine.setClasses({ content: true, settings: true })
    expect(
      ((await b.db.accountSyncState.get("capture")) as AccountSyncCaptureState).classes.content
    ).toBe(true)
    await until(async () => (await b.db.sessions.get("while-off")) !== undefined)
    await until(async () => (await a.db.sessions.get("b-while-off")) !== undefined)
    first.engine.stop()
    second.engine.stop()
    closeAll(devices)
  })

  it("passes a list change on, so the enrollment view looks again", async () => {
    const { server, devices } = await syncedDevices(["a"])
    const a = devices[0] as SyncDevice
    const hub = socketHub(server)
    const onRegistryChanged = jest.fn()
    const { engine } = await engineFor(a, { openSocket: hub.open, onRegistryChanged })
    await until(() => hub.live().length === 1 && running(engine))
    hub.live()[0]!.receive({ type: "registry", head: { seq: 9, hash: "h" } })
    await until(() => onRegistryChanged.mock.calls.length === 1)
    engine.stop()
    hub.dispose()
    closeAll(devices)
  })
})
