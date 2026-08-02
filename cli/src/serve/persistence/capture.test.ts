import { encodeKey } from "./canonical"
import {
  installTransactionCapture,
  type CaptureCoreLike,
  type CaptureDexieLike,
  type CaptureMutateRequest,
  type CaptureMutateResponse,
  type CaptureTableLike,
} from "./capture"
import type { DurabilityMutation } from "./types"

/** A DBCore transaction stand-in with real listener ordering. */
class FakeTransaction {
  private readonly listeners = new Map<string, Array<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

interface FakeTableOptions {
  /** `undefined` models an outbound (out-of-line) primary key. */
  keyPath?: string
  /** Keys DBCore generates, consumed in order (auto-increment tables). */
  generated?: unknown[]
  /** Indices whose mutation DBCore reports as failed. */
  failures?: number[]
  /** Keys a `deleteRange` should resolve to. */
  rangeKeys?: unknown[]
}

function fakeTable(
  name: string,
  opts: FakeTableOptions = {}
): CaptureTableLike & {
  calls: CaptureMutateRequest[]
} {
  const generated = [...(opts.generated ?? [])]
  const calls: CaptureMutateRequest[] = []
  return {
    name,
    calls,
    schema: {
      primaryKey: opts.keyPath
        ? { extractKey: (value) => (value as Record<string, unknown>)[opts.keyPath!] }
        : {},
    },
    async mutate(req: CaptureMutateRequest): Promise<CaptureMutateResponse> {
      calls.push(req)
      const results = (req.values ?? []).map(
        (value, index) =>
          req.keys?.[index] ??
          (opts.keyPath ? (value as Record<string, unknown>)[opts.keyPath] : generated.shift())
      )
      const failures: Record<number, unknown> = {}
      for (const index of opts.failures ?? []) failures[index] = new Error("boom")
      return { results, failures }
    },
    async query() {
      return { result: opts.rangeKeys ?? [] }
    },
  }
}

function harness(
  tables: Record<string, CaptureTableLike>,
  opts: { database?: string; excludeTables?: string[] } = {}
): {
  core: CaptureCoreLike
  commits: DurabilityMutation[][]
  capture: ReturnType<typeof installTransactionCapture>
} {
  const commits: DurabilityMutation[][] = []
  let created: CaptureCoreLike | null = null
  const down: CaptureCoreLike = {
    table: (name: string) => tables[name],
    transaction: () => new FakeTransaction(),
  }
  const db: CaptureDexieLike = {
    use(middleware) {
      created = middleware.create(down)
      return undefined
    },
  }
  const capture = installTransactionCapture(db, {
    database: opts.database ?? "CogniaDB",
    excludeTables: opts.excludeTables,
    onCommit: (mutations) => commits.push(mutations),
  })
  return { core: created!, commits, capture }
}

describe("installTransactionCapture", () => {
  it("records inbound-key puts synchronously and emits one commit per transaction", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    const table = core.table("sessions")

    await table.mutate({ type: "put", trans, values: [{ id: "a" }, { id: "b" }] })
    expect(commits).toHaveLength(0)

    trans.dispatch("complete")
    expect(commits).toEqual([
      [
        { database: "CogniaDB", table: "sessions", key: encodeKey("a"), value: { id: "a" } },
        { database: "CogniaDB", table: "sessions", key: encodeKey("b"), value: { id: "b" } },
      ],
    ])
  })

  it("records explicit keys when DBCore is handed them", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions") })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, keys: [7], values: [{ v: 1 }] })
    trans.dispatch("complete")
    expect(commits[0][0].key).toBe(encodeKey(7))
  })

  it("records deletions as null values", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "delete", trans, keys: ["a"] })
    trans.dispatch("complete")
    expect(commits[0]).toEqual([
      { database: "CogniaDB", table: "sessions", key: encodeKey("a"), value: null },
    ])
  })

  it("expands deleteRange into explicit key deletions", async () => {
    const table = fakeTable("sessions", { keyPath: "id", rangeKeys: ["a", "b"] })
    const { core, commits } = harness({ sessions: table })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "deleteRange", trans, range: {} })
    trans.dispatch("complete")
    expect(commits[0].map((m) => m.key)).toEqual([encodeKey("a"), encodeKey("b")])
    expect(commits[0].every((m) => m.value === null)).toBe(true)
  })

  it("asks DBCore for generated keys and records them", async () => {
    const table = fakeTable("logs", { generated: [1, 2] })
    const { core, commits } = harness({ logs: table })
    const trans = core.transaction(["logs"], "readwrite") as unknown as FakeTransaction
    await core.table("logs").mutate({ type: "add", trans, values: [{ v: "x" }, { v: "y" }] })
    trans.dispatch("complete")
    expect(table.calls[0].wantResults).toBe(true)
    expect(commits[0].map((m) => m.key)).toEqual([encodeKey(1), encodeKey(2)])
  })

  it("skips mutations DBCore reported as failed", async () => {
    const table = fakeTable("logs", { generated: [1, 2], failures: [0] })
    const { core, commits } = harness({ logs: table })
    const trans = core.transaction(["logs"], "readwrite") as unknown as FakeTransaction
    await core.table("logs").mutate({ type: "add", trans, values: [{ v: "x" }, { v: "y" }] })
    trans.dispatch("complete")
    expect(commits[0]).toHaveLength(1)
    expect(commits[0][0].key).toBe(encodeKey(2))
  })

  it("emits nothing for an aborted transaction", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "a" }] })
    trans.dispatch("abort")
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("emits nothing for an errored transaction", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "a" }] })
    trans.dispatch("error")
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("emits nothing for a read-only transaction", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readonly") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "a" }] })
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("keeps separate transactions in separate commits", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const first = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    const second = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans: first, values: [{ id: "a" }] })
    await core.table("sessions").mutate({ type: "put", trans: second, values: [{ id: "b" }] })
    second.dispatch("complete")
    first.dispatch("complete")
    expect(commits.map((c) => c[0].key)).toEqual([encodeKey("b"), encodeKey("a")])
  })

  it("leaves excluded tables entirely uninstrumented", async () => {
    const excluded = fakeTable("runs", { keyPath: "id" })
    const { core, commits } = harness({ runs: excluded }, { excludeTables: ["runs"] })
    const trans = core.transaction(["runs"], "readwrite") as unknown as FakeTransaction
    await core.table("runs").mutate({ type: "put", trans, values: [{ id: "a" }] })
    trans.dispatch("complete")
    expect(commits).toEqual([])
    expect(excluded.calls[0].wantResults).toBeUndefined()
  })

  it("records nothing while suppressed, and resumes afterwards", async () => {
    const { core, commits, capture } = harness({
      sessions: fakeTable("sessions", { keyPath: "id" }),
    })
    await capture.suppress(async () => {
      const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
      await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "restored" }] })
      trans.dispatch("complete")
      expect(capture.isSuppressed()).toBe(true)
    })
    expect(commits).toEqual([])
    expect(capture.isSuppressed()).toBe(false)

    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "live" }] })
    trans.dispatch("complete")
    expect(commits).toHaveLength(1)
  })

  it("releases suppression even when the body throws", async () => {
    const { capture } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    await expect(
      capture.suppress(async () => {
        throw new Error("restore failed")
      })
    ).rejects.toThrow("restore failed")
    expect(capture.isSuppressed()).toBe(false)
  })

  it("emits no commit for a transaction that mutated nothing", () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("instruments versionchange transactions too", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "versionchange") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "a" }] })
    trans.dispatch("complete")
    expect(commits).toHaveLength(1)
  })

  it("defaults to instrumenting every table when no exclusions are given", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "a" }] })
    trans.dispatch("complete")
    expect(commits).toHaveLength(1)
  })

  it("tolerates a mutate request with no values", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans })
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("tolerates a delete request with no keys", async () => {
    const { core, commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "delete", trans })
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("records nothing when DBCore returns neither results nor a known key", async () => {
    const table = fakeTable("logs", { generated: [] })
    const { core, commits } = harness({ logs: table })
    const trans = core.transaction(["logs"], "readwrite") as unknown as FakeTransaction
    await core.table("logs").mutate({ type: "add", trans, values: [{ v: "x" }] })
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("reads failures reported as an array as well as a record", async () => {
    const table: CaptureTableLike = {
      name: "logs",
      schema: { primaryKey: {} },
      async mutate() {
        return { results: [1, 2], failures: [new Error("boom")] }
      },
      async query() {
        return { result: [] }
      },
    }
    const { core, commits } = harness({ logs: table })
    const trans = core.transaction(["logs"], "readwrite") as unknown as FakeTransaction
    await core.table("logs").mutate({ type: "add", trans, values: [{ v: "x" }, { v: "y" }] })
    trans.dispatch("complete")
    expect(commits[0].map((m) => m.key)).toEqual([encodeKey(2)])
  })

  it("tolerates a range query that returns no result array", async () => {
    const table: CaptureTableLike = {
      name: "sessions",
      schema: { primaryKey: {} },
      async mutate() {
        return {}
      },
      async query() {
        return {} as { result: unknown[] }
      },
    }
    const { core, commits } = harness({ sessions: table })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "deleteRange", trans, range: {} })
    trans.dispatch("complete")
    expect(commits).toEqual([])
  })

  it("drops a pending commit when suppression starts before the complete event", async () => {
    const { core, commits, capture } = harness({
      sessions: fakeTable("sessions", { keyPath: "id" }),
    })
    const trans = core.transaction(["sessions"], "readwrite") as unknown as FakeTransaction
    await core.table("sessions").mutate({ type: "put", trans, values: [{ id: "a" }] })
    await capture.suppress(async () => {
      trans.dispatch("complete")
    })
    expect(commits).toEqual([])
  })

  it("tolerates a transaction object with no addEventListener", async () => {
    const bare = {}
    const { commits } = harness({ sessions: fakeTable("sessions", { keyPath: "id" }) })
    const down: CaptureCoreLike = {
      table: () => fakeTable("sessions", { keyPath: "id" }),
      transaction: () => bare,
    }
    let core: CaptureCoreLike | null = null
    installTransactionCapture(
      {
        use(mw) {
          core = mw.create(down)
          return undefined
        },
      },
      { database: "CogniaDB", onCommit: () => commits.push([]) }
    )
    expect(() => core!.transaction(["sessions"], "readwrite")).not.toThrow()
  })
})
